import {
  PromptMetaSchema,
  SiteConfigSchema,
  findTrustedAiSuggestionForItem,
  type AiSuggestion,
  type PromptMeta,
  type SiteConfig,
} from '@prompt-pages/shared';
import { base64ToBytes, bytesToBase64, signJwtRs256 } from './crypto.js';
import type { Env, SessionUser } from './env.js';

const CONTENT_ITEM_FILE_RE = /^(content\/\d{4}\/[a-z0-9][a-z0-9-]{2,118}[a-z0-9])\/([^/]+)$/;

export interface FileMutation {
  path: string;
  content: Uint8Array | string | null; // null deletes file from tree
}

export interface CommitAuthorIdentity {
  name: string;
  email: string;
}

export class GitHubApiError extends Error {
  status: number;

  constructor(message: string, status: number) {
    super(message);
    this.name = 'GitHubApiError';
    this.status = status;
  }
}

export function encodeGitRefPath(ref: string): string {
  return ref
    .split('/')
    .map((segment) => encodeURIComponent(segment))
    .join('/');
}

function encodeRepoPath(filePath: string): string {
  return filePath
    .split('/')
    .map((segment) => encodeURIComponent(segment))
    .join('/');
}

export function buildGitHubNoreplyAuthor(
  user: Pick<SessionUser, 'id' | 'login' | 'name'>,
): CommitAuthorIdentity {
  return {
    name: user.name?.trim() || user.login,
    email: `${user.id}+${user.login}@users.noreply.github.com`,
  };
}

const APP_TOKEN_REFRESH_MARGIN_MS = 5 * 60 * 1000;
const APP_TOKEN_DEFAULT_TTL_MS = 55 * 60 * 1000;

let cachedAppToken: { cacheKey: string; token: string; expiresAtMs: number } | null = null;
let pendingAppToken: { cacheKey: string; promise: Promise<string> } | null = null;

export function clearRepoWriteTokenCache(): void {
  cachedAppToken = null;
  pendingAppToken = null;
}

async function getRepoWriteToken(env: Env): Promise<string> {
  if (env.GITHUB_APP_ID && env.GITHUB_APP_INSTALLATION_ID && env.GITHUB_APP_PRIVATE_KEY) {
    const cacheKey = `${env.GITHUB_APP_ID}:${env.GITHUB_APP_INSTALLATION_ID}`;
    const nowMs = Date.now();
    if (
      cachedAppToken &&
      cachedAppToken.cacheKey === cacheKey &&
      cachedAppToken.expiresAtMs - APP_TOKEN_REFRESH_MARGIN_MS > nowMs
    ) {
      return cachedAppToken.token;
    }

    if (pendingAppToken && pendingAppToken.cacheKey === cacheKey) {
      return pendingAppToken.promise;
    }

    const promise = (async () => {
      const now = Math.floor(Date.now() / 1000);
      const appJwt = await signJwtRs256(
        { iat: now - 60, exp: now + 540, iss: env.GITHUB_APP_ID },
        env.GITHUB_APP_PRIVATE_KEY!,
      );
      const resp = await fetch(
        `https://api.github.com/app/installations/${env.GITHUB_APP_INSTALLATION_ID}/access_tokens`,
        {
          method: 'POST',
          headers: {
            Accept: 'application/vnd.github+json',
            Authorization: `Bearer ${appJwt}`,
            'User-Agent': 'prompt-manager-pages-worker',
          },
        },
      );
      if (!resp.ok) {
        throw new GitHubApiError(
          `获取 GitHub App Installation Token 失败 (${resp.status}): ${await resp.text()}`,
          resp.status,
        );
      }
      const data = (await resp.json()) as { token: string; expires_at?: string };
      const parsedExp = data.expires_at ? Date.parse(data.expires_at) : Number.NaN;
      const expiresAtMs = Number.isFinite(parsedExp)
        ? parsedExp
        : Date.now() + APP_TOKEN_DEFAULT_TTL_MS;
      cachedAppToken = { cacheKey, token: data.token, expiresAtMs };
      return data.token;
    })();

    pendingAppToken = { cacheKey, promise };
    try {
      return await promise;
    } finally {
      if (pendingAppToken?.promise === promise) {
        pendingAppToken = null;
      }
    }
  }

  if (env.GITHUB_BOT_TOKEN) {
    return env.GITHUB_BOT_TOKEN;
  }

  throw new Error('未配置仓库写入凭据 (请配置 GITHUB_APP_* 或 GITHUB_BOT_TOKEN)');
}

async function ghFetchWithResponse<T>(
  env: Env,
  apiPath: string,
  init: RequestInit = {},
): Promise<{ data: T; headers: Headers }> {
  const token = await getRepoWriteToken(env);
  const resp = await fetch(`https://api.github.com${apiPath}`, {
    ...init,
    headers: {
      Accept: 'application/vnd.github+json',
      Authorization: `Bearer ${token}`,
      'User-Agent': 'prompt-manager-pages-worker',
      'X-GitHub-Api-Version': '2022-11-28',
      ...(init.body ? { 'Content-Type': 'application/json' } : {}),
      ...init.headers,
    },
  });
  if (!resp.ok) {
    const text = await resp.text();
    throw new GitHubApiError(
      `GitHub API ${init.method || 'GET'} ${apiPath} 失败 (${resp.status}): ${text}`,
      resp.status,
    );
  }
  if (resp.status === 204) {
    return { data: undefined as T, headers: resp.headers };
  }
  return { data: (await resp.json()) as T, headers: resp.headers };
}

async function ghFetch<T>(
  env: Env,
  apiPath: string,
  init: RequestInit = {},
): Promise<T> {
  const { data } = await ghFetchWithResponse<T>(env, apiPath, init);
  return data;
}

export async function getBranchHeadSha(env: Env, branch: string): Promise<string> {
  const refData = await ghFetch<{ object: { sha: string } }>(
    env,
    `/repos/${env.GITHUB_OWNER}/${env.GITHUB_REPO}/git/ref/heads/${encodeGitRefPath(branch)}`,
  );
  return refData.object.sha;
}

async function createBlob(env: Env, content: Uint8Array | string): Promise<string> {
  const owner = env.GITHUB_OWNER;
  const repo = env.GITHUB_REPO;
  // Base64 alphabet [A-Za-z0-9+/=] never needs JSON escaping; skip scanning multi-MB strings in JSON.stringify
  const bodyJson =
    typeof content === 'string'
      ? JSON.stringify({ content, encoding: 'utf-8' })
      : `{"content":"${bytesToBase64(content)}","encoding":"base64"}`;
  const res = await ghFetch<{ sha: string }>(
    env,
    `/repos/${owner}/${repo}/git/blobs`,
    { method: 'POST', body: bodyJson },
  );
  return res.sha;
}

export async function commitMutationsToRef(params: {
  env: Env;
  baseBranch: string;
  targetBranch: string;
  createNewBranch: boolean;
  expectedParentSha?: string;
  mutations: FileMutation[];
  message: string;
  author: CommitAuthorIdentity;
}): Promise<{ commitSha: string; branch: string }> {
  const {
    env,
    baseBranch,
    targetBranch,
    createNewBranch,
    expectedParentSha,
    mutations,
    message,
    author,
  } = params;
  const owner = env.GITHUB_OWNER;
  const repo = env.GITHUB_REPO;

  const parentCommitSha = expectedParentSha || (await getBranchHeadSha(env, baseBranch));

  const parentCommit = await ghFetch<{ tree: { sha: string } }>(
    env,
    `/repos/${owner}/${repo}/git/commits/${parentCommitSha}`,
  );
  const baseTreeSha = parentCommit.tree.sha;

  const treeEntries = await Promise.all(
    mutations.map(async (m) => {
      if (m.content === null) {
        return {
          path: m.path,
          mode: '100644' as const,
          type: 'blob' as const,
          sha: null,
        };
      }
      const blobSha = await createBlob(env, m.content);
      return {
        path: m.path,
        mode: '100644' as const,
        type: 'blob' as const,
        sha: blobSha,
      };
    }),
  );

  const newTree = await ghFetch<{ sha: string }>(
    env,
    `/repos/${owner}/${repo}/git/trees`,
    {
      method: 'POST',
      body: JSON.stringify({
        base_tree: baseTreeSha,
        tree: treeEntries,
      }),
    },
  );

  const newCommit = await ghFetch<{ sha: string }>(
    env,
    `/repos/${owner}/${repo}/git/commits`,
    {
      method: 'POST',
      body: JSON.stringify({
        message,
        tree: newTree.sha,
        parents: [parentCommitSha],
        author: {
          name: author.name,
          email: author.email,
          date: new Date().toISOString(),
        },
      }),
    },
  );

  if (createNewBranch) {
    await ghFetch(env, `/repos/${owner}/${repo}/git/refs`, {
      method: 'POST',
      body: JSON.stringify({
        ref: `refs/heads/${targetBranch}`,
        sha: newCommit.sha,
      }),
    });
  } else {
    await ghFetch(
      env,
      `/repos/${owner}/${repo}/git/refs/heads/${encodeGitRefPath(targetBranch)}`,
      {
        method: 'PATCH',
        body: JSON.stringify({ sha: newCommit.sha, force: false }),
      },
    );
  }

  return { commitSha: newCommit.sha, branch: targetBranch };
}

export async function createSubmissionPullRequest(params: {
  env: Env;
  user: SessionUser;
  meta: PromptMeta;
  contentDir: string;
  files: FileMutation[];
}): Promise<{ prNumber: number; prUrl: string; branch: string; commitSha: string }> {
  const { env, user, meta, contentDir, files } = params;
  const defaultBranch = env.GITHUB_DEFAULT_BRANCH || 'main';
  const branch = `submit/${meta.id}`;
  const author = buildGitHubNoreplyAuthor(user);

  const { commitSha } = await commitMutationsToRef({
    env,
    baseBranch: defaultBranch,
    targetBranch: branch,
    createNewBranch: true,
    mutations: files,
    message: `feat(prompt): add "${meta.title}" (${meta.id})`,
    author,
  });

  const prBody = [
    `Submitted by @${user.login}`,
    '',
    `- **ID**: \`${meta.id}\``,
    `- **Title**: ${meta.title}`,
    `- **Category**: \`${meta.category}\``,
    `- **Author**: ${meta.author.name || '匿名'}`,
    `- **Tags**: ${meta.tags.length > 0 ? meta.tags.map((t) => `\`${t}\``).join(', ') : '(无)'}`,
    `- **Path**: \`${contentDir}\``,
  ].join('\n');

  const pr = await ghFetch<{ number: number; html_url: string }>(
    env,
    `/repos/${env.GITHUB_OWNER}/${env.GITHUB_REPO}/pulls`,
    {
      method: 'POST',
      body: JSON.stringify({
        title: `feat(prompt): ${meta.title} (@${user.login})`,
        head: branch,
        base: defaultBranch,
        body: prBody,
      }),
    },
  );

  return {
    prNumber: pr.number,
    prUrl: pr.html_url,
    branch,
    commitSha,
  };
}

export interface PendingPrSummary {
  prNumber: number;
  prUrl: string;
  prTitle: string;
  branch: string;
  baseBranch: string;
  headSha: string;
  headRepoFullName: string;
  isCrossRepo: boolean;
  createdAt: string;
  submittedBy: string;
  userAvatarUrl: string;
  draft: boolean;
}

export interface PendingPrReviewDetail extends PendingPrSummary {
  reviewableInApp: boolean;
  inAppBlockReason?: string;
  changedFiles: string[];
  contentDir: string | null;
  meta: PromptMeta | null;
  mediaBaseUrl: string | null;
  aiSuggestion: AiSuggestion | null;
}

interface GitHubPullRecord {
  number: number;
  state?: string;
  draft?: boolean;
  html_url: string;
  title: string;
  body: string | null;
  created_at: string;
  changed_files?: number;
  user: { login: string; avatar_url?: string };
  base?: { ref: string };
  head: {
    ref: string;
    sha: string;
    repo?: { full_name: string } | null;
  };
}

function toPrSummary(env: Env, pr: GitHubPullRecord): PendingPrSummary {
  const upstreamFullName = `${env.GITHUB_OWNER}/${env.GITHUB_REPO}`;
  const headRepoFullName = pr.head.repo?.full_name || '';
  const isCrossRepo = headRepoFullName.toLowerCase() !== upstreamFullName.toLowerCase();
  const submitMatch = /by @([a-zA-Z0-9-]+)/.exec(pr.body || '');
  const submittedBy = submitMatch?.[1] || pr.user.login;

  return {
    prNumber: pr.number,
    prUrl: pr.html_url,
    prTitle: pr.title,
    branch: pr.head.ref,
    baseBranch: pr.base?.ref || env.GITHUB_DEFAULT_BRANCH || 'main',
    headSha: pr.head.sha,
    headRepoFullName,
    isCrossRepo,
    createdAt: pr.created_at,
    submittedBy,
    userAvatarUrl: pr.user.avatar_url || '',
    draft: Boolean(pr.draft),
  };
}

/**
 * Fetch ONLY PR summaries (1 upstream subrequest per page) so large queues
 * never hit Cloudflare Workers' 50-subrequest limit or silently drop PRs.
 */
export async function listPendingPrSummaries(
  env: Env,
  page = 1,
  perPage = 20,
): Promise<{ prs: PendingPrSummary[]; page: number; perPage: number; hasNext: boolean }> {
  const safePage = Math.max(1, Math.floor(page));
  const safePerPage = Math.min(50, Math.max(1, Math.floor(perPage)));
  const owner = env.GITHUB_OWNER;
  const repo = env.GITHUB_REPO;

  const { data: prs, headers } = await ghFetchWithResponse<GitHubPullRecord[]>(
    env,
    `/repos/${owner}/${repo}/pulls?state=open&per_page=${safePerPage}&page=${safePage}`,
  );

  const linkHeader = headers.get('Link') || '';
  const hasNext = linkHeader.includes('rel="next"');

  return {
    prs: prs.map((pr) => toPrSummary(env, pr)),
    page: safePage,
    perPage: safePerPage,
    hasNext,
  };
}

/**
 * Lazily inspect ONE PR in full detail and verify whether it is strictly a
 * single-item content PR targeting the default branch (safe for in-app merge).
 */
export async function getPendingSubmissionPrDetail(
  env: Env,
  prNumber: number,
  options: { includeAiSuggestion?: boolean } = {},
): Promise<PendingPrReviewDetail | null> {
  const owner = env.GITHUB_OWNER;
  const repo = env.GITHUB_REPO;
  const defaultBranch = env.GITHUB_DEFAULT_BRANCH || 'main';

  let pr: GitHubPullRecord;
  try {
    pr = await ghFetch<GitHubPullRecord>(env, `/repos/${owner}/${repo}/pulls/${prNumber}`);
  } catch (err) {
    if (err instanceof GitHubApiError && err.status === 404) {
      return null;
    }
    throw err;
  }
  if (pr.state && pr.state !== 'open') {
    return null;
  }

  const summary = toPrSummary(env, pr);

  if (!summary.headRepoFullName || summary.baseBranch !== defaultBranch) {
    return {
      ...summary,
      reviewableInApp: false,
      inAppBlockReason: !summary.headRepoFullName ? 'PR 来源仓库已不可用，请前往 GitHub 审阅。' : `该 PR 目标分支为 "${summary.baseBranch}" 而非默认分支 "${defaultBranch}"，请前往 GitHub 审阅。`,
      changedFiles: [],
      contentDir: null,
      meta: null,
      mediaBaseUrl: null,
      aiSuggestion: null,
    };
  }

  if (typeof pr.changed_files === 'number' && pr.changed_files > 100) {
    return {
      ...summary,
      reviewableInApp: false,
      inAppBlockReason: `该 PR 变更文件数过多（${pr.changed_files} 个），超出单作品审校范围，请前往 GitHub 查看完整 diff。`,
      changedFiles: [],
      contentDir: null,
      meta: null,
      mediaBaseUrl: null,
      aiSuggestion: null,
    };
  }

  const files = await ghFetch<Array<{ filename: string; status: string; previous_filename?: string }>>(
    env,
    `/repos/${owner}/${repo}/pulls/${pr.number}/files?per_page=100`,
  );
  const changedFiles = files.flatMap((f) => f.previous_filename ? [f.previous_filename, f.filename] : [f.filename]);

  if (
    files.some((f) => f.status === 'renamed' && !f.previous_filename) ||
    files.length === 0 ||
    files.length >= 100 ||
    (typeof pr.changed_files === 'number' && files.length !== pr.changed_files)
  ) {
    return {
      ...summary,
      reviewableInApp: false,
      inAppBlockReason: '无法在单页内完整核对该 PR 的全部变更文件，请前往 GitHub 查看完整 diff。',
      changedFiles,
      contentDir: null,
      meta: null,
      mediaBaseUrl: null,
      aiSuggestion: null,
    };
  }

  const touchedDirs = new Set<string>();
  const nonItemFiles: string[] = [];
  for (const filename of changedFiles) {
    const m = CONTENT_ITEM_FILE_RE.exec(filename);
    if (!m) {
      nonItemFiles.push(filename);
    } else {
      touchedDirs.add(m[1]);
    }
  }

  if (nonItemFiles.length > 0 || touchedDirs.size !== 1) {
    const reason =
      nonItemFiles.length > 0
        ? `该 PR 修改了作品目录以外的文件（如 ${nonItemFiles.slice(0, 3).join(', ')}），请前往 GitHub 查看完整 diff 后合并。`
        : `该 PR 同时涉及 ${touchedDirs.size} 个作品目录，审校台仅支持单作品 PR，请前往 GitHub 审阅合并。`;
    return {
      ...summary,
      reviewableInApp: false,
      inAppBlockReason: reason,
      changedFiles,
      contentDir: null,
      meta: null,
      mediaBaseUrl: null,
      aiSuggestion: null,
    };
  }

  const contentDir = Array.from(touchedDirs)[0];
  const expectedDirId = contentDir.split('/').pop()!;
  const metaFile = files.find(
    (f) => f.filename === `${contentDir}/meta.json` && f.status !== 'removed',
  );
  if (!metaFile) {
    return {
      ...summary,
      reviewableInApp: false,
      inAppBlockReason: '该 PR 未包含有效的单作品 meta.json（或包含删除操作），请前往 GitHub 审阅。',
      changedFiles,
      contentDir,
      meta: null,
      mediaBaseUrl: null,
      aiSuggestion: null,
    };
  }

  const metaResp = await ghFetch<{ content: string; encoding: string }>(
    env,
    `/repos/${summary.headRepoFullName}/contents/${encodeRepoPath(metaFile.filename)}?ref=${encodeURIComponent(pr.head.sha)}`,
  );
  const decoded = new TextDecoder().decode(base64ToBytes(metaResp.content));
  const parsedMeta = PromptMetaSchema.safeParse(JSON.parse(decoded));
  if (!parsedMeta.success || parsedMeta.data.id !== expectedDirId) {
    return {
      ...summary,
      reviewableInApp: false,
      inAppBlockReason: 'meta.json 校验未通过或作品 ID 与目录名不一致，请前往 GitHub 核对。',
      changedFiles,
      contentDir,
      meta: null,
      mediaBaseUrl: null,
      aiSuggestion: null,
    };
  }

  let aiSuggestion: AiSuggestion | null = null;
  if (options.includeAiSuggestion ?? true) {
    const comments = await ghFetch<
      Array<{ body?: string | null; user?: { login?: string | null; type?: string | null } | null }>
    >(env, `/repos/${owner}/${repo}/issues/${pr.number}/comments?per_page=50`);
    aiSuggestion = findTrustedAiSuggestionForItem(comments, pr.head.sha, parsedMeta.data.id);
  }

  const submittedBy =
    /by @([a-zA-Z0-9-]+)/.exec(pr.body || '')?.[1] ||
    parsedMeta.data.author.github ||
    pr.user.login;

  return {
    ...summary,
    submittedBy,
    reviewableInApp: true,
    changedFiles,
    contentDir,
    meta: parsedMeta.data,
    mediaBaseUrl: `https://raw.githubusercontent.com/${summary.headRepoFullName}/${pr.head.sha}/${contentDir}`,
    aiSuggestion,
  };
}

interface DirectoryEntry {
  path: string;
  sha: string;
  type: string;
}

async function readDirectoryEntries(
  env: Env,
  dirPath: string,
  ref: string,
): Promise<DirectoryEntry[]> {
  try {
    return await ghFetch<DirectoryEntry[]>(
      env,
      `/repos/${env.GITHUB_OWNER}/${env.GITHUB_REPO}/contents/${encodeRepoPath(dirPath)}?ref=${encodeURIComponent(ref)}`,
    );
  } catch (err) {
    if (err instanceof GitHubApiError && err.status === 404) {
      return [];
    }
    throw err;
  }
}

export async function listDirectoryFilesOnBranch(env: Env, dir: string, ref: string): Promise<string[]> {
  return (await readDirectoryEntries(env, dir, ref)).filter((entry) => entry.type === 'file').map((entry) => entry.path);
}

export async function getReviewedItemFiles(env: Env, dir: string, head: string, reviewed: string): Promise<string[] | null> {
  const current = await readDirectoryEntries(env, dir, head);
  if (reviewed !== head) {
    const before = await readDirectoryEntries(env, dir, reviewed);
    const versions = new Map(before.map((entry) => [entry.path, entry.sha]));
    if (before.length !== current.length || current.some((entry) => versions.get(entry.path) !== entry.sha)) return null;
  }
  return current.filter((entry) => entry.type === 'file').map((entry) => entry.path);
}

export async function readMetaOnBranch(
  env: Env,
  metaPath: string,
  ref: string,
): Promise<PromptMeta> {
  const metaResp = await ghFetch<{ content: string }>(
    env,
    `/repos/${env.GITHUB_OWNER}/${env.GITHUB_REPO}/contents/${encodeRepoPath(metaPath)}?ref=${encodeURIComponent(ref)}`,
  );
  const decoded = new TextDecoder().decode(base64ToBytes(metaResp.content));
  return PromptMetaSchema.parse(JSON.parse(decoded));
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

interface ValidationRun {
  event: string;
  path: string;
  conclusion: string | null;
  head_sha: string;
  head_branch: string;
  head_repository: { full_name: string } | null;
  pull_requests?: Array<{ number: number }>;
}

export async function hasValidatedHead(env: Env, pr: PendingPrSummary): Promise<boolean> {
  const repo = `${env.GITHUB_OWNER}/${env.GITHUB_REPO}`;
  const actions = `/repos/${repo}/actions`;
  const { workflow_runs } = await ghFetch<{ workflow_runs: ValidationRun[] }>(
    env, `${actions}/workflows/pr-preview.yml/runs?event=pull_request&head_sha=${encodeURIComponent(pr.headSha)}&per_page=100`,
  );
  const run = workflow_runs.find((r) =>
    r.head_sha === pr.headSha &&
    r.head_branch === pr.branch &&
    r.head_repository?.full_name.toLowerCase() === pr.headRepoFullName.toLowerCase() &&
    (!r.pull_requests?.length || r.pull_requests.some((pull) => pull.number === pr.prNumber)),
  );
  if (run) return run.conclusion === 'success';
  if (pr.isCrossRepo || !pr.branch.startsWith('submit/')) return false;

  // A slash-command push made with GITHUB_TOKEN may have no pull_request run.
  const name = `validated-pr-${pr.prNumber}-${pr.headSha}`;
  const { artifacts } = await ghFetch<{ artifacts: Array<{
    name: string; expired: boolean; workflow_run?: { id: number; head_branch: string };
  }> }>(env, `${actions}/artifacts?name=${encodeURIComponent(name)}&per_page=100`);
  const receipt = artifacts.find((a) => a.name === name && !a.expired && a.workflow_run?.head_branch === pr.baseBranch);
  if (!receipt?.workflow_run) return false;
  const command = await ghFetch<ValidationRun>(env, `${actions}/runs/${receipt.workflow_run.id}`);
  return command.event === 'issue_comment' && command.path === '.github/workflows/pr-command.yml' &&
    command.conclusion === 'success' && command.head_repository?.full_name.toLowerCase() === repo.toLowerCase();
}

export async function mergePrPreservingAuthor(params: {
  env: Env;
  prNumber: number;
  branch: string;
  expectedHeadSha: string;
  isCrossRepo?: boolean;
  commitTitle?: string;
}): Promise<void> {
  const { env, prNumber, branch, expectedHeadSha, isCrossRepo = false, commitTitle } = params;
  const owner = env.GITHUB_OWNER;
  const repo = env.GITHUB_REPO;

  const mergeInit: RequestInit = {
    method: 'PUT',
    body: JSON.stringify({
      merge_method: 'merge',
      sha: expectedHeadSha,
      ...(commitTitle ? { commit_title: commitTitle } : {}),
    }),
  };

  try {
    await ghFetch(env, `/repos/${owner}/${repo}/pulls/${prNumber}/merge`, mergeInit);
  } catch (err) {
    // Only retry once on 405 (GitHub temporarily recalculating mergeability right after a review commit).
    // NEVER retry on 409 (head SHA mismatch / merge conflict).
    if (err instanceof GitHubApiError && err.status === 405) {
      await sleep(1200);
      await ghFetch(env, `/repos/${owner}/${repo}/pulls/${prNumber}/merge`, mergeInit);
    } else {
      throw err;
    }
  }

  // Best-effort branch cleanup for same-repo submission branches only
  if (!isCrossRepo && branch.startsWith('submit/')) {
    try {
      await ghFetch(
        env,
        `/repos/${owner}/${repo}/git/refs/heads/${encodeGitRefPath(branch)}`,
        { method: 'DELETE' },
      );
    } catch {
      // ignore if already deleted by repo settings
    }
  }
}

export async function closePrAndDeleteBranch(
  env: Env,
  prNumber: number,
  branch: string,
  isCrossRepo = false,
): Promise<void> {
  const owner = env.GITHUB_OWNER;
  const repo = env.GITHUB_REPO;
  await ghFetch(env, `/repos/${owner}/${repo}/pulls/${prNumber}`, {
    method: 'PATCH',
    body: JSON.stringify({ state: 'closed' }),
  });
  if (!isCrossRepo && branch.startsWith('submit/')) {
    try {
      await ghFetch(
        env,
        `/repos/${owner}/${repo}/git/refs/heads/${encodeGitRefPath(branch)}`,
        { method: 'DELETE' },
      );
    } catch {
      // ignore
    }
  }
}

export async function updateSiteConfigOnMain(params: {
  env: Env;
  admin: SessionUser;
  patch: Partial<Pick<SiteConfig, 'sensitiveTags' | 'allowPublicSensitiveToggle'>>;
}): Promise<SiteConfig> {
  const { env, admin, patch } = params;
  const defaultBranch = env.GITHUB_DEFAULT_BRANCH || 'main';
  const baseCommitSha = await getBranchHeadSha(env, defaultBranch);
  const fileResp = await ghFetch<{ content: string }>(
    env,
    `/repos/${env.GITHUB_OWNER}/${env.GITHUB_REPO}/contents/site.config.json?ref=${encodeURIComponent(baseCommitSha)}`,
  );
  const decoded = new TextDecoder().decode(base64ToBytes(fileResp.content));
  const current = SiteConfigSchema.parse(JSON.parse(decoded));
  const updated = SiteConfigSchema.parse({ ...current, ...patch });

  await commitMutationsToRef({
    env,
    baseBranch: defaultBranch,
    targetBranch: defaultBranch,
    createNewBranch: false,
    expectedParentSha: baseCommitSha,
    mutations: [
      { path: 'site.config.json', content: JSON.stringify(updated, null, 2) + '\n' },
    ],
    message: `chore(config): update site settings by @${admin.login}`,
    author: buildGitHubNoreplyAuthor(admin),
  });

  return updated;
}

export async function findContentDirByIdOnRef(
  env: Env,
  id: string,
  ref: string,
): Promise<string | null> {
  const yearMatch = /^(\d{4})/.exec(id);
  if (yearMatch) {
    const candidate = `content/${yearMatch[1]}/${id}`;
    const files = await listDirectoryFilesOnBranch(env, candidate, ref);
    if (files.some((p) => p === `${candidate}/meta.json`)) {
      return candidate;
    }
  }
  const tree = await ghFetch<{ tree: Array<{ path: string; type: string }> }>(
    env,
    `/repos/${env.GITHUB_OWNER}/${env.GITHUB_REPO}/git/trees/${encodeGitRefPath(ref)}?recursive=1`,
  );
  const match = tree.tree.find(
    (entry) => entry.type === 'blob' && entry.path.endsWith(`/${id}/meta.json`),
  );
  return match ? match.path.slice(0, -'/meta.json'.length) : null;
}
