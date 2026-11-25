import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import {
  MAX_TAGS,
  PromptMetaSchema,
  extractAiBundleFromComment,
  isTrustedBotComment,
  normalizeTags,
  type AiSuggestion,
  type AiSuggestionBundle,
  type PromptMeta,
} from '@prompt-pages/shared';

export type ParsedPrCommand =
  | { kind: 'tags'; add: string[]; remove: string[] }
  | { kind: 'category'; category: 'gallery' | 'template' }
  | { kind: 'apply-ai' };

export function parsePrCommands(commentBody: string): ParsedPrCommand[] {
  const commands: ParsedPrCommand[] = [];
  for (const rawLine of commentBody.split('\n')) {
    const line = rawLine.trim();
    if (!line.startsWith('/')) continue;

    if (line.startsWith('/tags ')) {
      const tokens = line.slice('/tags '.length).trim().split(/\s+/).filter(Boolean);
      const add: string[] = [];
      const remove: string[] = [];
      for (const tok of tokens) {
        if (tok.startsWith('+') && tok.length > 1) {
          add.push(tok.slice(1));
        } else if (tok.startsWith('-') && tok.length > 1) {
          remove.push(tok.slice(1));
        } else if (!tok.startsWith('+') && !tok.startsWith('-')) {
          add.push(tok);
        }
      }
      if (add.length > 0 || remove.length > 0) {
        commands.push({ kind: 'tags', add, remove });
      }
    } else if (line.startsWith('/category ')) {
      const cat = line.slice('/category '.length).trim().toLowerCase();
      if (cat === 'gallery' || cat === 'template') {
        commands.push({ kind: 'category', category: cat });
      }
    } else if (line === '/apply-ai') {
      commands.push({ kind: 'apply-ai' });
    }
  }
  return commands;
}

export function applyCommandsToMeta(
  meta: PromptMeta,
  commands: ParsedPrCommand[],
  aiSuggestion: AiSuggestion | null,
): { updated: PromptMeta; summary: string[] } {
  let next: PromptMeta = { ...meta, tags: [...meta.tags] };
  const summary: string[] = [];

  for (const cmd of commands) {
    if (cmd.kind === 'tags') {
      const removeLower = new Set(cmd.remove.map((t) => t.toLowerCase()));
      const kept = next.tags.filter((t) => !removeLower.has(t.toLowerCase()));
      const merged = normalizeTags([...kept, ...cmd.add]).tags.slice(0, MAX_TAGS);
      next = { ...next, tags: merged };
      summary.push(`更新标签 -> [${merged.join(', ')}]`);
    } else if (cmd.kind === 'category') {
      next = { ...next, category: cmd.category };
      summary.push(`更新分类 -> ${cmd.category}`);
    } else if (cmd.kind === 'apply-ai') {
      if (!aiSuggestion) {
        summary.push('未找到与当前提交及作品匹配的受信任 AI 建议');
        continue;
      }
      if (aiSuggestion.suggestedTags.length > 0) {
        const merged = normalizeTags(
          [...next.tags, ...aiSuggestion.suggestedTags],
        ).tags.slice(0, MAX_TAGS);
        next = { ...next, tags: merged };
        summary.push(`应用 AI 标签 -> [${merged.join(', ')}]`);
      }
      if (aiSuggestion.suggestedCategory) {
        next = { ...next, category: aiSuggestion.suggestedCategory };
        summary.push(`应用 AI 分类 -> ${aiSuggestion.suggestedCategory}`);
      }
      if (aiSuggestion.normalizedPrompt) {
        next = { ...next, prompt: aiSuggestion.normalizedPrompt };
        summary.push('应用 AI 规范化 Prompt');
      }
    }
  }

  return { updated: PromptMetaSchema.parse(next), summary };
}

async function fetchTrustedAiBundleForSha(
  repo: string,
  prNumber: string,
  token: string,
  expectedHeadSha: string,
): Promise<AiSuggestionBundle | null> {
  const resp = await fetch(
    `https://api.github.com/repos/${repo}/issues/${prNumber}/comments?per_page=100`,
    {
      headers: {
        Accept: 'application/vnd.github+json',
        Authorization: `Bearer ${token}`,
        'User-Agent': 'prompt-manager-pages-bot',
      },
    },
  );
  if (!resp.ok) return null;
  const comments = (await resp.json()) as Array<{
    body?: string | null;
    user?: { login?: string | null; type?: string | null } | null;
  }>;

  for (let i = comments.length - 1; i >= 0; i--) {
    const c = comments[i];
    if (!isTrustedBotComment(c)) continue;
    const bundle = extractAiBundleFromComment(c.body || '');
    if (bundle && bundle.headSha === expectedHeadSha) {
      return bundle;
    }
  }
  return null;
}

async function main() {
  const commentBody = process.env.COMMENT_BODY || '';
  const commands = parsePrCommands(commentBody);
  if (commands.length === 0) {
    console.log('[pr-command] 评论未包含有效斜杠指令，跳过');
    return;
  }

  const dataRepoRoot = path.resolve(process.env.DATA_REPO_ROOT || process.cwd());
  const baseRef = process.env.PR_BASE_REF || 'main';
  const headSha =
    process.env.PR_HEAD_SHA?.trim() ||
    execFileSync('git', ['rev-parse', 'HEAD'], { cwd: dataRepoRoot, encoding: 'utf-8' }).trim();

  const diffOut = execFileSync(
    'git',
    ['diff', '--name-only', `origin/${baseRef}...HEAD`, '--', 'content'],
    { cwd: dataRepoRoot, encoding: 'utf-8' },
  );
  const metaPaths = Array.from(
    new Set(
      diffOut
        .split('\n')
        .map((l) => l.trim())
        .filter((l) => l.endsWith('/meta.json')),
    ),
  );

  if (metaPaths.length === 0) {
    console.log('[pr-command] 当前 PR 未包含可修改的 content/**/meta.json');
    return;
  }

  let aiBundle: AiSuggestionBundle | null = null;
  if (
    commands.some((c) => c.kind === 'apply-ai') &&
    process.env.GITHUB_REPOSITORY &&
    process.env.PR_NUMBER &&
    process.env.GITHUB_TOKEN
  ) {
    aiBundle = await fetchTrustedAiBundleForSha(
      process.env.GITHUB_REPOSITORY,
      process.env.PR_NUMBER,
      process.env.GITHUB_TOKEN,
      headSha,
    );
  }

  const summaries: string[] = [];
  for (const relMetaPath of metaPaths) {
    const absPath = path.join(dataRepoRoot, relMetaPath);
    if (!fs.existsSync(absPath) || fs.lstatSync(absPath).isSymbolicLink()) continue;
    const current = PromptMetaSchema.parse(JSON.parse(fs.readFileSync(absPath, 'utf-8')));
    const itemSuggestion = aiBundle?.items[current.id] ?? null;
    const { updated, summary } = applyCommandsToMeta(
      current,
      commands,
      itemSuggestion,
    );
    fs.writeFileSync(absPath, JSON.stringify(updated, null, 2) + '\n', 'utf-8');
    summaries.push(`${updated.id}: ${summary.join('; ')}`);
  }

  console.log(`[pr-command] 已更新: ${summaries.join(' | ')}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().catch((err) => {
    console.error('[pr-command] 失败:', err);
    process.exit(1);
  });
}
