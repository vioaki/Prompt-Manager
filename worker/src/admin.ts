import { z } from 'zod';
import {
  MAX_TOTAL_UPLOAD_BYTES,
  PromptMetaSchema,
  SubmitPayloadSchema,
  normalizeTags,
  type PromptMeta,
  type RefItem,
} from '@prompt-pages/shared';
import { authenticateRequest } from './auth.js';
import type { Env, SessionUser } from './env.js';
import {
  GitHubApiError,
  buildGitHubNoreplyAuthor,
  closePrAndDeleteBranch,
  commitMutationsToRef,
  findContentDirByIdOnRef,
  getBranchHeadSha,
  getReviewedItemFiles,
  hasValidatedHead,
  getPendingSubmissionPrDetail,
  listDirectoryFilesOnBranch,
  listPendingPrSummaries,
  mergePrPreservingAuthor,
  readMetaOnBranch,
  updateSiteConfigOnMain,
  type FileMutation,
} from './github.js';
import { readAndValidateImageFile, readUploadForm } from './submit.js';

async function requireAdmin(
  request: Request,
  env: Env,
): Promise<{ user: SessionUser } | { response: Response }> {
  const user = await authenticateRequest(request, env);
  if (!user) {
    return { response: Response.json({ error: '请先登录 GitHub' }, { status: 401 }) };
  }
  if (!user.isAdmin) {
    return { response: Response.json({ error: '无管理员权限' }, { status: 403 }) };
  }
  return { user };
}

function isNonFastForwardConflict(err: unknown): boolean {
  return err instanceof GitHubApiError && (err.status === 409 || err.status === 422);
}

async function buildItemUpdateMutations(params: {
  form: FormData;
  existingMeta: PromptMeta;
  existingDirFiles: string[];
  contentDir: string;
}): Promise<{ updatedMeta: PromptMeta; mutations: FileMutation[] }> {
  const { form, existingMeta, existingDirFiles, contentDir } = params;
  const payloadRaw = form.get('payload');
  if (typeof payloadRaw !== 'string') {
    throw new Error('缺少 payload');
  }
  const payload = SubmitPayloadSchema.parse(JSON.parse(payloadRaw));

  const mutations: FileMutation[] = [];
  let totalBytes = 0;
  let nextMedia = { ...existingMeta.media };
  const keptFiles = new Set<string>();

  const mainEntry = form.get('main');
  if (mainEntry instanceof File && mainEntry.size > 0) {
    const mainImg = await readAndValidateImageFile(mainEntry, '新主图');
    totalBytes += mainImg.bytes.byteLength;
    const mainFile = `main${mainImg.ext}`;
    mutations.push({ path: `${contentDir}/${mainFile}`, content: mainImg.bytes });

    const thumbEntry = form.get('thumb');
    let thumbFile = mainFile;
    if (thumbEntry instanceof File && thumbEntry.size > 0) {
      const thumbImg = await readAndValidateImageFile(thumbEntry, '新缩略图');
      totalBytes += thumbImg.bytes.byteLength;
      thumbFile = `thumb${thumbImg.ext}`;
      mutations.push({ path: `${contentDir}/${thumbFile}`, content: thumbImg.bytes });
    }

    nextMedia = {
      main: mainFile,
      thumb: thumbFile,
      mimeType: mainImg.mime,
      width: payload.mainWidth,
      height: payload.mainHeight,
    };
  }
  keptFiles.add(nextMedia.main);
  keptFiles.add(nextMedia.thumb);

  const refs: RefItem[] = [];
  const usedRefNumbers = new Set<number>();
  for (const entry of payload.refLayout) {
    if (entry.kind === 'existing-image') {
      const m = /^ref-(\d+)\./.exec(entry.file);
      if (m) usedRefNumbers.add(Number.parseInt(m[1], 10));
    }
  }
  const nextRefIndex = () => {
    let i = 0;
    while (usedRefNumbers.has(i)) i++;
    usedRefNumbers.add(i);
    return i;
  };

  for (const entry of payload.refLayout) {
    if (entry.kind === 'placeholder') {
      refs.push({ kind: 'placeholder', label: entry.label || 'User' });
    } else if (entry.kind === 'existing-image') {
      if (!existingDirFiles.includes(`${contentDir}/${entry.file}`) ||
          !existingMeta.refs.some((ref) => ref.kind === 'image' && ref.file === entry.file)) {
        throw new Error('保留的参考图已不存在，请刷新后重新编辑');
      }
      keptFiles.add(entry.file);
      refs.push({ kind: 'image', file: entry.file });
    } else if (entry.kind === 'new-image') {
      const refFile = form.get(entry.field);
      if (!(refFile instanceof File)) {
        throw new Error(`缺少新参考图字段 ${entry.field}`);
      }
      const validated = await readAndValidateImageFile(refFile, '新增参考图');
      totalBytes += validated.bytes.byteLength;
      if (totalBytes > MAX_TOTAL_UPLOAD_BYTES) {
        throw new Error('单次更新上传体积过大');
      }
      const filename = `ref-${nextRefIndex()}${validated.ext}`;
      mutations.push({ path: `${contentDir}/${filename}`, content: validated.bytes });
      keptFiles.add(filename);
      refs.push({ kind: 'image', file: filename });
    }
  }

  const previousMedia = new Set([existingMeta.media.main, existingMeta.media.thumb]);
  for (const ref of existingMeta.refs) {
    if (ref.kind === 'image') previousMedia.add(ref.file);
  }
  for (const file of previousMedia) {
    const path = `${contentDir}/${file}`;
    if (!keptFiles.has(file) && existingDirFiles.includes(path)) {
      mutations.push({ path, content: null });
    }
  }

  const trimmedAuthorName = payload.anonymous ? '' : payload.authorName.trim();
  const updatedMeta = PromptMetaSchema.parse({
    ...existingMeta,
    title: payload.title,
    category: payload.category,
    prompt: payload.prompt,
    description: payload.description,
    tags: normalizeTags(payload.tags).tags,
    author: {
      name: trimmedAuthorName,
      github: payload.anonymous || !trimmedAuthorName ? null : existingMeta.author.github,
    },
    media: nextMedia,
    refs,
  });

  if (JSON.stringify(updatedMeta) !== JSON.stringify(existingMeta)) {
    mutations.push({
      path: `${contentDir}/meta.json`,
      content: JSON.stringify(updatedMeta, null, 2) + '\n',
    });
  }

  return { updatedMeta, mutations };
}

export async function handleAdminListPrs(request: Request, env: Env): Promise<Response> {
  const auth = await requireAdmin(request, env);
  if ('response' in auth) return auth.response;

  const reqUrl = new URL(request.url);
  const page = Number.parseInt(reqUrl.searchParams.get('page') || '1', 10);
  const perPage = Number.parseInt(reqUrl.searchParams.get('per_page') || '20', 10);

  const result = await listPendingPrSummaries(
    env,
    Number.isFinite(page) ? page : 1,
    Number.isFinite(perPage) ? perPage : 20,
  );
  return Response.json(result);
}

export async function handleAdminGetPr(
  request: Request,
  env: Env,
  prNumber: number,
): Promise<Response> {
  const auth = await requireAdmin(request, env);
  if ('response' in auth) return auth.response;

  const detail = await getPendingSubmissionPrDetail(env, prNumber, { includeAiSuggestion: true });
  if (!detail) {
    return Response.json({ error: `未找到开放中的 PR #${prNumber}` }, { status: 404 });
  }
  return Response.json({ pr: detail });
}

export async function handleAdminApprovePr(
  request: Request,
  env: Env,
  prNumber: number,
): Promise<Response> {
  const auth = await requireAdmin(request, env);
  if ('response' in auth) return auth.response;

  const contentType = request.headers.get('Content-Type') || '';
  const isMultipart = contentType.includes('multipart/form-data');

  let form: FormData | null = null;
  let expectedHeadSha = (request.headers.get('X-Expected-Head-Sha') || '').trim();

  if (isMultipart) {
    try {
      const input = await readUploadForm(request);
      if (input instanceof Response) return input;
      form = input;
      const shaField = form.get('expectedHeadSha');
      if (typeof shaField === 'string' && shaField.trim()) {
        expectedHeadSha = shaField.trim();
      }
    } catch {
      return Response.json({ error: '无效的表单请求体' }, { status: 400 });
    }
  } else if (contentType.includes('application/json')) {
    try {
      const body = (await request.json()) as { expectedHeadSha?: unknown } | null;
      if (body && typeof body === 'object' && typeof body.expectedHeadSha === 'string') {
        expectedHeadSha = body.expectedHeadSha.trim();
      }
    } catch {
      return Response.json({ error: '无效的 JSON 请求体' }, { status: 400 });
    }
  }

  if (!expectedHeadSha) {
    return Response.json({ error: '缺少已审阅提交指纹 expectedHeadSha，请刷新审校台重试' }, { status: 400 });
  }

  const target = await getPendingSubmissionPrDetail(env, prNumber, { includeAiSuggestion: false });
  if (!target) {
    return Response.json({ error: `未找到开放中的 PR #${prNumber}` }, { status: 404 });
  }
  if (!target.reviewableInApp || !target.contentDir || !target.meta) {
    return Response.json(
      { error: target.inAppBlockReason || '该 PR 不符合站内单作品审校范围，请前往 GitHub 处理' },
      { status: 400 },
    );
  }
  if (target.headSha !== expectedHeadSha) {
    return Response.json(
      { error: '该 PR 已有新提交，请刷新重新审阅后再批准' },
      { status: 409 },
    );
  }

  const defaultBranch = env.GITHUB_DEFAULT_BRANCH || 'main';

  if (form) {
    if (
      target.isCrossRepo ||
      target.branch === defaultBranch ||
      !target.branch.startsWith('submit/')
    ) {
      return Response.json(
        { error: '该 PR 分支不支持通过审校台直接改写，请点击直接合并或在 GitHub 上处理' },
        { status: 400 },
      );
    }

    try {
      const existingFiles = await listDirectoryFilesOnBranch(env, target.contentDir, target.headSha);
      const { updatedMeta, mutations } = await buildItemUpdateMutations({
        form,
        existingMeta: target.meta,
        existingDirFiles: existingFiles,
        contentDir: target.contentDir,
      });

      if (mutations.length > 0) {
        const { commitSha } = await commitMutationsToRef({
          env,
          baseBranch: target.branch,
          targetBranch: target.branch,
          createNewBranch: false,
          expectedParentSha: target.headSha,
          mutations,
          message: `chore(review): normalize "${updatedMeta.title}" before merge`,
          author: buildGitHubNoreplyAuthor(auth.user),
        });
        return Response.json({ merged: false, saved: true, headSha: commitSha, prNumber }, { status: 202 });
      }
    } catch (err) {
      if (isNonFastForwardConflict(err)) {
        return Response.json(
          { error: 'PR 分支在审校期间已发生变动，请刷新后重新审阅' },
          { status: 409 },
        );
      }
      return Response.json({ error: (err as Error).message }, { status: 400 });
    }
  }

  if (!(await hasValidatedHead(env, target))) {
    return Response.json({ error: '当前提交尚未通过 PR 内容检查，请查看 Actions，待检查通过后再次批准' }, { status: 412 });
  }
  try {
    await mergePrPreservingAuthor({
      env,
      prNumber: target.prNumber,
      branch: target.branch,
      expectedHeadSha: target.headSha,
      isCrossRepo: target.isCrossRepo,
      commitTitle: `Merge pull request #${target.prNumber}: ${target.meta.title}`,
    });
  } catch (err) {
    if (err instanceof GitHubApiError && err.status === 405) {
      return Response.json({ error: 'GitHub 尚不允许合并，请查看必需检查和分支保护后重试' }, { status: 412 });
    }
    if (err instanceof GitHubApiError && err.status === 409) {
      return Response.json(
        { error: '合并冲突或 PR 已出现新提交，请刷新后重新审阅' },
        { status: 409 },
      );
    }
    throw err;
  }

  return Response.json({ merged: true, prNumber: target.prNumber, mergedSha: target.headSha });
}

export async function handleAdminClosePr(
  request: Request,
  env: Env,
  prNumber: number,
): Promise<Response> {
  const auth = await requireAdmin(request, env);
  if ('response' in auth) return auth.response;

  const target = await getPendingSubmissionPrDetail(env, prNumber, { includeAiSuggestion: false });
  if (!target) {
    return Response.json({ error: `未找到开放中的 PR #${prNumber}` }, { status: 404 });
  }

  await closePrAndDeleteBranch(env, target.prNumber, target.branch, target.isCrossRepo);
  return Response.json({ closed: true, prNumber: target.prNumber });
}

async function loadReviewedItem(request: Request, env: Env, id: string) {
  const reviewed = request.headers.get('X-Expected-Head-Sha') || '';
  if (!/^[a-f0-9]{40}$/.test(reviewed)) {
    return Response.json({ error: '缺少有效的作品版本，请刷新已部署站点后重试' }, { status: 428 });
  }
  const defaultBranch = env.GITHUB_DEFAULT_BRANCH || 'main';
  const baseCommitSha = await getBranchHeadSha(env, defaultBranch);
  const contentDir = await findContentDirByIdOnRef(env, id, baseCommitSha);
  if (!contentDir) {
    return Response.json({ error: `未找到作品 ${id}` }, { status: 404 });
  }

  const existingFiles = await getReviewedItemFiles(env, contentDir, baseCommitSha, reviewed);
  if (!existingFiles) return Response.json({ error: '作品已更新，请重新加载后再操作' }, { status: 409 });
  if (!existingFiles.includes(`${contentDir}/meta.json`)) {
    return Response.json({ error: `作品目录缺少 meta.json (${id})` }, { status: 409 });
  }

  return { defaultBranch, baseCommitSha, contentDir, existingFiles };
}

export async function handleAdminUpdateItem(
  request: Request,
  env: Env,
  id: string,
): Promise<Response> {
  const auth = await requireAdmin(request, env);
  if ('response' in auth) return auth.response;

  const form = await readUploadForm(request);
  if (form instanceof Response) return form;

  const item = await loadReviewedItem(request, env, id);
  if (item instanceof Response) return item;
  const { defaultBranch, baseCommitSha, contentDir, existingFiles } = item;
  const existingMeta = await readMetaOnBranch(env, `${contentDir}/meta.json`, baseCommitSha);

  let updatedMeta: PromptMeta;
  let mutations: FileMutation[];
  try {
    const built = await buildItemUpdateMutations({
      form,
      existingMeta,
      existingDirFiles: existingFiles,
      contentDir,
    });
    updatedMeta = built.updatedMeta;
    mutations = built.mutations;
  } catch (err) {
    return Response.json({ error: (err as Error).message }, { status: 400 });
  }

  if (mutations.length === 0) return Response.json({ updated: true, id, commitSha: baseCommitSha, meta: updatedMeta });
  try {
    const { commitSha } = await commitMutationsToRef({
      env,
      baseBranch: defaultBranch,
      targetBranch: defaultBranch,
      createNewBranch: false,
      expectedParentSha: baseCommitSha,
      mutations,
      message: `chore(content): edit "${updatedMeta.title}" (${id})`,
      author: buildGitHubNoreplyAuthor(auth.user),
    });

    return Response.json({ updated: true, id, commitSha, meta: updatedMeta });
  } catch (err) {
    if (isNonFastForwardConflict(err)) {
      return Response.json(
        { error: '主分支内容在编辑期间已更新，请刷新页面后重试' },
        { status: 409 },
      );
    }
    throw err;
  }
}

export async function handleAdminDeleteItem(
  request: Request,
  env: Env,
  id: string,
): Promise<Response> {
  const auth = await requireAdmin(request, env);
  if ('response' in auth) return auth.response;

  const item = await loadReviewedItem(request, env, id);
  if (item instanceof Response) return item;
  const { defaultBranch, baseCommitSha, existingFiles } = item;

  const mutations: FileMutation[] = existingFiles.map((path) => ({ path, content: null }));

  try {
    const { commitSha } = await commitMutationsToRef({
      env,
      baseBranch: defaultBranch,
      targetBranch: defaultBranch,
      createNewBranch: false,
      expectedParentSha: baseCommitSha,
      mutations,
      message: `chore(content): delete prompt ${id}`,
      author: buildGitHubNoreplyAuthor(auth.user),
    });

    return Response.json({ deleted: true, id, commitSha });
  } catch (err) {
    if (isNonFastForwardConflict(err)) {
      return Response.json(
        { error: '主分支内容在删除期间已更新，请刷新页面后重试' },
        { status: 409 },
      );
    }
    throw err;
  }
}

const UpdateConfigSchema = z.object({
  sensitiveTags: z.array(z.string().trim().min(1).max(40)).optional(),
  allowPublicSensitiveToggle: z.boolean().optional(),
});

export async function handleAdminUpdateConfig(request: Request, env: Env): Promise<Response> {
  const auth = await requireAdmin(request, env);
  if ('response' in auth) return auth.response;

  let patch;
  try {
    patch = UpdateConfigSchema.parse(await request.json());
  } catch (err) {
    return Response.json({ error: `配置格式错误: ${(err as Error).message}` }, { status: 400 });
  }

  try {
    const updated = await updateSiteConfigOnMain({
      env,
      admin: auth.user,
      patch,
    });
    return Response.json({ updated: true, site: updated });
  } catch (err) {
    if (isNonFastForwardConflict(err)) {
      return Response.json(
        { error: '站点配置在保存期间已被更新，请刷新后重试' },
        { status: 409 },
      );
    }
    throw err;
  }
}
