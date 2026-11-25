import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import {
  AiSuggestionSchema,
  BOT_COMMENT_MARKER,
  encodeAiBundleBlock,
  isTrustedBotComment,
  lintPromptDraft,
  sanitizeBotCommentMarkers,
  type AiSuggestion,
  type PromptMeta,
  type SiteConfig,
} from '@prompt-pages/shared';
import { discoverAndValidateContent, loadSiteConfig } from './utils.js';

export { BOT_COMMENT_MARKER, encodeAiBundleBlock };

const MAX_GITHUB_COMMENT_CHARS = 65_000;
const COMMENT_BODY_SOFT_LIMIT = 56_000;

async function generateAiSuggestion(
  meta: PromptMeta,
  thumbFilePath: string,
  existingTags: string[],
  siteConfig: SiteConfig,
): Promise<AiSuggestion | null> {
  const apiKey = process.env.AI_API_KEY?.trim();
  if (!apiKey) return null;

  const baseUrl = (process.env.AI_BASE_URL || 'https://api.openai.com/v1').replace(/\/+$/, '');
  const model = process.env.AI_MODEL || 'gpt-4o-mini';
  const useVision = process.env.AI_VISION !== 'false';

  const systemPrompt = [
    '你是一个 AI 绘画 Prompt 社区的审校助手。',
    '请根据用户投稿的作品信息与图片，返回一个严格 JSON 对象（不要使用 markdown 代码块）：',
    '{',
    '  "suggestedTags": string[], // 优先从已有标准标签库中挑选 2-5 个最贴合的标签，保留准确的模型标签，缺失时最多新增 1 个简洁中文标签',
    '  "nsfwRisk": boolean, // 是否疑似包含成人/敏感/恐怖内容',
    '  "nsfwReason": string, // 若 nsfwRisk 为 true 则简述原因，否则为空字符串',
    '  "suggestedCategory": "gallery" | "template", // 若包含明显可替换参数或适合作为复用模板则选 template',
    '  "normalizedPrompt": string, // 在不改变原意前提下整理断行与标点，如明显适合模板化可将可变主体改为 {{变量名}}；若原 Prompt 已很规范则返回空字符串',
    '  "summary": string // 一句中文审校说明',
    '}',
  ].join('\n');

  const userText = [
    `标题: ${meta.title}`,
    `当前分类: ${meta.category}`,
    `当前标签: ${meta.tags.join(', ') || '(无)'}`,
    `描述: ${meta.description || '(无)'}`,
    `Prompt:\n${meta.prompt}`,
    `站点现有标准标签库: ${existingTags.join(', ')}`,
    `敏感标签列表: ${siteConfig.sensitiveTags.join(', ')}`,
  ].join('\n\n');

  const userContent: Array<Record<string, unknown>> = [{ type: 'text', text: userText }];
  if (useVision && fs.existsSync(thumbFilePath) && !fs.lstatSync(thumbFilePath).isSymbolicLink()) {
    const bytes = fs.readFileSync(thumbFilePath);
    const mime = thumbFilePath.endsWith('.gif')
      ? 'image/gif'
      : thumbFilePath.endsWith('.png')
        ? 'image/png'
        : thumbFilePath.endsWith('.jpg') || thumbFilePath.endsWith('.jpeg')
          ? 'image/jpeg'
          : 'image/webp';
    userContent.push({
      type: 'image_url',
      image_url: { url: `data:${mime};base64,${bytes.toString('base64')}` },
    });
  }

  try {
    const resp = await fetch(`${baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model,
        temperature: 0.2,
        response_format: { type: 'json_object' },
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userContent },
        ],
      }),
    });

    if (!resp.ok) {
      console.warn(`[pr-preview] AI API 请求失败 (${resp.status}): ${await resp.text()}`);
      return null;
    }

    const data = (await resp.json()) as {
      choices?: Array<{ message?: { content?: string } }>;
    };
    const rawContent = data.choices?.[0]?.message?.content?.trim();
    if (!rawContent) return null;

    const cleaned = rawContent.replace(/^```json\s*/i, '').replace(/```$/, '').trim();
    const parsed = JSON.parse(cleaned) as Record<string, unknown>;

    return AiSuggestionSchema.parse({
      suggestedTags: Array.isArray(parsed.suggestedTags) ? parsed.suggestedTags : [],
      nsfwRisk: Boolean(parsed.nsfwRisk),
      nsfwReason:
        typeof parsed.nsfwReason === 'string' && parsed.nsfwReason ? parsed.nsfwReason : undefined,
      suggestedCategory:
        parsed.suggestedCategory === 'gallery' || parsed.suggestedCategory === 'template'
          ? parsed.suggestedCategory
          : undefined,
      normalizedPrompt:
        typeof parsed.normalizedPrompt === 'string' && parsed.normalizedPrompt.trim()
          ? parsed.normalizedPrompt.trim()
          : undefined,
      summary:
        typeof parsed.summary === 'string' && parsed.summary.trim()
          ? parsed.summary.trim()
          : undefined,
      model,
      generatedAt: new Date().toISOString(),
    });
  } catch (err) {
    console.warn(`[pr-preview] AI 审校建议生成跳过: ${(err as Error).message}`);
    return null;
  }
}

function renderItemSection(
  repo: string,
  headSha: string,
  item: {
    relativeContentPath: string;
    meta: PromptMeta;
    warnings: Array<{ code: string; message: string }>;
    aiSuggestion: AiSuggestion | null;
  },
): string {
  const { meta, relativeContentPath, warnings, aiSuggestion } = item;
  const rawBase = `https://raw.githubusercontent.com/${repo}/${headSha}/${relativeContentPath}`;
  const lines: string[] = [];

  lines.push(`### ${meta.title} (\`${meta.id}\`)`);
  lines.push('');
  lines.push('| 字段 | 内容 |');
  lines.push('| :--- | :--- |');
  lines.push(`| **分类** | \`${meta.category}\` |`);
  lines.push(
    `| **署名** | ${meta.author.name || '匿名'}${meta.author.github ? ` (@${meta.author.github})` : ''} |`,
  );
  lines.push(
    `| **标签** | ${meta.tags.length > 0 ? meta.tags.map((t) => `\`${t}\``).join(' ') : '*(无)*'} |`,
  );
  lines.push(`| **尺寸** | ${meta.media.width} × ${meta.media.height} (${meta.media.mimeType}) |`);
  if (meta.description) {
    lines.push(`| **备注** | ${meta.description.replaceAll('\n', ' ')} |`);
  }
  lines.push('');
  lines.push(`![主图预览](${rawBase}/${meta.media.thumb})`);
  lines.push('');

  if (meta.refs.length > 0) {
    lines.push('**参考图布局：**');
    meta.refs.forEach((ref, idx) => {
      if (ref.kind === 'placeholder') {
        lines.push(`- #${idx + 1}: 占位符 \`{{${ref.label}}}\``);
      } else {
        lines.push(`- #${idx + 1}: ![ref-${idx}](${rawBase}/${ref.file})`);
      }
    });
    lines.push('');
  }

  lines.push('**Prompt：**');
  lines.push('~~~~text');
  lines.push(meta.prompt);
  lines.push('~~~~');
  lines.push('');

  if (warnings.length > 0) {
    lines.push('**⚠️ 规则规范提醒：**');
    for (const w of warnings) {
      lines.push(`- ${w.message}`);
    }
    lines.push('');
  }

  if (aiSuggestion) {
    lines.push('**🤖 AI 审校建议：**');
    if (aiSuggestion.summary) lines.push(`- 说明：${aiSuggestion.summary}`);
    if (aiSuggestion.suggestedTags.length > 0) {
      lines.push(`- 推荐标签：${aiSuggestion.suggestedTags.map((t) => `\`${t}\``).join(' ')}`);
    }
    if (aiSuggestion.suggestedCategory && aiSuggestion.suggestedCategory !== meta.category) {
      lines.push(`- 建议分类：\`${aiSuggestion.suggestedCategory}\``);
    }
    if (aiSuggestion.nsfwRisk) {
      lines.push(`- ⚠️ **疑似敏感内容**：${aiSuggestion.nsfwReason || '建议人工复核并标记 NSFW'}`);
    }
    if (aiSuggestion.normalizedPrompt) {
      lines.push('<details><summary>查看 AI 规范化 Prompt 建议</summary>');
      lines.push('');
      lines.push('~~~~text');
      lines.push(aiSuggestion.normalizedPrompt);
      lines.push('~~~~');
      lines.push('</details>');
    }
    lines.push('');
  }

  return lines.join('\n');
}

export function buildPreviewCommentMarkdown(params: {
  repo: string;
  headSha: string;
  changedItems: Array<{
    relativeContentPath: string;
    meta: PromptMeta;
    warnings: Array<{ code: string; message: string }>;
    aiSuggestion: AiSuggestion | null;
  }>;
  validationErrors: Array<{ path: string; message: string }>;
  maxCommentLength?: number;
}): { commentMarkdown: string; fullMarkdown: string; truncated: boolean } {
  const maxLen = params.maxCommentLength ?? MAX_GITHUB_COMMENT_CHARS;
  const headerLines: string[] = ['## 🎨 Prompt 投稿自动审校报告', ''];

  if (params.validationErrors.length > 0) {
    headerLines.push('### ❌ 校验未通过');
    for (const err of params.validationErrors) {
      headerLines.push(`- \`${err.path}\`: ${err.message}`);
    }
    headerLines.push('');
  } else {
    headerLines.push('✅ Schema 与媒体文件完整性校验通过。', '');
  }

  const headerText = sanitizeBotCommentMarkers(headerLines.join('\n'));
  const footerText = [
    '---',
    '指令：`/tags +标签 -旧标签` · `/category template|gallery` · `/apply-ai`',
  ].join('\n');

  const bundleItems: Record<string, AiSuggestion> = {};
  for (const item of params.changedItems) {
    if (item.aiSuggestion) {
      bundleItems[item.meta.id] = item.aiSuggestion;
    }
  }
  const bundleBlock =
    Object.keys(bundleItems).length > 0
      ? encodeAiBundleBlock({ headSha: params.headSha, items: bundleItems })
      : '';

  const renderedSections = params.changedItems.map((item) =>
    sanitizeBotCommentMarkers(renderItemSection(params.repo, params.headSha, item)),
  );

  const fullVisible = [headerText, ...renderedSections, footerText].join('\n');
  const fullMarkdown = bundleBlock
    ? `${BOT_COMMENT_MARKER}\n${fullVisible}\n${bundleBlock}`
    : `${BOT_COMMENT_MARKER}\n${fullVisible}`;

  if (fullMarkdown.length <= maxLen) {
    return { commentMarkdown: fullMarkdown, fullMarkdown, truncated: false };
  }

  // Fit as many complete item sections as possible under GitHub's 65,536-char comment cap
  const reservedTail =
    footerText.length +
    (bundleBlock ? bundleBlock.length + 2 : 0) +
    180;
  const bodyBudget = Math.max(2000, Math.min(COMMENT_BODY_SOFT_LIMIT, maxLen - reservedTail));

  const keptSections: string[] = [];
  let usedLen = BOT_COMMENT_MARKER.length + 1 + headerText.length + 1;
  let omitted = 0;

  for (const sec of renderedSections) {
    if (usedLen + sec.length + 1 <= bodyBudget) {
      keptSections.push(sec);
      usedLen += sec.length + 1;
    } else {
      omitted += 1;
    }
  }

  const notice = `> ⚠️ 本次变更共 ${params.changedItems.length} 件作品，超出单条评论长度上限，已折叠其余 ${omitted || params.changedItems.length} 件预览；完整报告请查看本次 Action 的 Job Summary。\n`;
  let candidate = `${BOT_COMMENT_MARKER}\n${headerText}\n${keptSections.join('\n')}\n${notice}\n${footerText}`;
  if (bundleBlock && candidate.length + bundleBlock.length + 1 <= maxLen) {
    candidate = `${candidate}\n${bundleBlock}`;
  } else if (candidate.length > maxLen) {
    candidate = candidate.slice(0, maxLen - 32) + '\n\n*(内容已截断)*';
  }

  return { commentMarkdown: candidate, fullMarkdown, truncated: true };
}

function getChangedContentDirs(dataRepoRoot: string, baseRef: string): string[] {
  try {
    const out = execFileSync(
      'git',
      ['diff', '--name-only', `origin/${baseRef}...HEAD`, '--', 'content'],
      { cwd: dataRepoRoot, encoding: 'utf-8' },
    );
    const dirs = new Set<string>();
    for (const line of out.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      const parts = trimmed.split('/');
      if (parts.length >= 3 && parts[0] === 'content') {
        dirs.add(parts.slice(0, 3).join('/'));
      }
    }
    return Array.from(dirs).sort();
  } catch {
    return [];
  }
}

function writeStepSummaryFallback(markdown: string) {
  const summaryPath = process.env.GITHUB_STEP_SUMMARY;
  if (summaryPath) {
    try {
      fs.appendFileSync(summaryPath, `\n${markdown}\n`, 'utf-8');
    } catch {
      // ignore summary write errors
    }
  }
}

async function upsertPrComment(
  repo: string,
  prNumber: string,
  token: string,
  commentBody: string,
  fullSummaryBody: string,
): Promise<boolean> {
  const headers = {
    Accept: 'application/vnd.github+json',
    Authorization: `Bearer ${token}`,
    'User-Agent': 'prompt-manager-pages-bot',
    'Content-Type': 'application/json',
  };

  const listResp = await fetch(
    `https://api.github.com/repos/${repo}/issues/${prNumber}/comments?per_page=100`,
    { headers },
  );
  if (listResp.status === 403) {
    console.warn('[pr-preview] 无权限读取/写入 PR 评论 (403，可能来自外部 Fork PR)，已降级输出到 Job Summary');
    writeStepSummaryFallback(fullSummaryBody);
    return false;
  }
  if (!listResp.ok) {
    throw new Error(`查询 PR 评论失败: ${listResp.status}`);
  }
  const comments = (await listResp.json()) as Array<{
    id: number;
    body?: string | null;
    user?: { login?: string | null; type?: string | null } | null;
  }>;
  const existing = comments.find((c) => isTrustedBotComment(c));

  const targetUrl = existing
    ? `https://api.github.com/repos/${repo}/issues/comments/${existing.id}`
    : `https://api.github.com/repos/${repo}/issues/${prNumber}/comments`;
  const method = existing ? 'PATCH' : 'POST';

  const writeResp = await fetch(targetUrl, {
    method,
    headers,
    body: JSON.stringify({ body: commentBody }),
  });

  if (writeResp.status === 403 || writeResp.status === 422) {
    console.warn(
      `[pr-preview] 写入 PR 评论受限 (${writeResp.status})，已降级输出完整报告到 Job Summary`,
    );
    writeStepSummaryFallback(fullSummaryBody);
    return false;
  }
  if (!writeResp.ok) {
    throw new Error(`写入 PR 评论失败: ${writeResp.status}`);
  }
  return true;
}

async function main() {
  const dataRepoRoot = path.resolve(process.env.DATA_REPO_ROOT || process.cwd());
  const contentDir = path.join(dataRepoRoot, 'content');
  const siteConfigPath = path.join(dataRepoRoot, 'site.config.json');
  const siteConfig = loadSiteConfig(siteConfigPath);

  const { entries, errors } = discoverAndValidateContent(contentDir);
  const validByRelPath = new Map(
    entries.map((entry) => [`content/${entry.relativeDir}`, entry]),
  );
  const existingTags = Array.from(new Set(entries.flatMap((e) => e.meta.tags))).sort();

  const baseRef = process.env.PR_BASE_REF || 'main';
  const changedDirs = getChangedContentDirs(dataRepoRoot, baseRef);
  const changedItems: Array<{
    relativeContentPath: string;
    meta: PromptMeta;
    warnings: Array<{ code: string; message: string }>;
    aiSuggestion: AiSuggestion | null;
  }> = [];

  // Only process entries that PASSED full schema, symlink, and media validation
  for (const rel of changedDirs) {
    const validEntry = validByRelPath.get(rel);
    if (!validEntry) continue;

    const { meta, dirPath } = validEntry;
    const { warnings } = lintPromptDraft({
      prompt: meta.prompt,
      category: meta.category,
      tags: meta.tags,
    });
    const aiSuggestion = await generateAiSuggestion(
      meta,
      path.join(dirPath, meta.media.thumb),
      existingTags,
      siteConfig,
    );
    changedItems.push({
      relativeContentPath: rel,
      meta,
      warnings,
      aiSuggestion,
    });
  }

  const repo = process.env.GITHUB_REPOSITORY || siteConfig.repo;
  const headSha = process.env.PR_HEAD_SHA || 'HEAD';
  const prNumber = process.env.PR_NUMBER;
  const token = process.env.GITHUB_TOKEN;

  const { commentMarkdown, fullMarkdown, truncated } = buildPreviewCommentMarkdown({
    repo,
    headSha,
    changedItems,
    validationErrors: errors,
  });

  if (truncated) {
    writeStepSummaryFallback(fullMarkdown);
  }

  if (prNumber && token) {
    const posted = await upsertPrComment(repo, prNumber, token, commentMarkdown, fullMarkdown);
    if (posted) {
      console.log(`[pr-preview] 已更新 PR #${prNumber} 审校预览评论`);
    }
  } else {
    console.log(commentMarkdown);
  }

  if (errors.length > 0) {
    process.exit(1);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().catch((err) => {
    console.error('[pr-preview] 失败:', err);
    process.exit(1);
  });
}
