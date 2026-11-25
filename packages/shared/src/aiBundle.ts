import { z } from 'zod';
import { AiSuggestionSchema, type AiSuggestion } from './schema.js';

export const BOT_COMMENT_MARKER = '<!-- prompt-preview-bot -->';
export const AI_BUNDLE_PREFIX = '<!-- prompt-ai-bundle:';
export const AI_BUNDLE_SUFFIX = ' -->';
export const TRUSTED_ACTIONS_BOT_LOGIN = 'github-actions[bot]';

export const AiSuggestionBundleSchema = z.object({
  headSha: z.string().min(7).max(64),
  items: z.record(z.string().min(1), AiSuggestionSchema),
});

export type AiSuggestionBundle = z.infer<typeof AiSuggestionBundleSchema>;

export function sanitizeBotCommentMarkers(text: string): string {
  return text
    .replaceAll(BOT_COMMENT_MARKER, '[bot-marker]')
    .replaceAll(AI_BUNDLE_PREFIX, '[ai-bundle-marker]')
    .replaceAll('<!-- prompt-ai-suggestion:', '[ai-marker]');
}

export function encodeAiBundleBlock(bundle: AiSuggestionBundle): string {
  const safeJson = JSON.stringify(bundle).replaceAll('-->', '--\\u003e');
  return `${AI_BUNDLE_PREFIX}${safeJson}${AI_BUNDLE_SUFFIX}`;
}

export function extractAiBundleFromComment(body: string): AiSuggestionBundle | null {
  const start = body.lastIndexOf(AI_BUNDLE_PREFIX);
  if (start === -1) return null;
  const jsonStart = start + AI_BUNDLE_PREFIX.length;
  const end = body.indexOf(AI_BUNDLE_SUFFIX, jsonStart);
  if (end === -1) return null;
  try {
    const parsed = JSON.parse(body.slice(jsonStart, end));
    return AiSuggestionBundleSchema.parse(parsed);
  } catch {
    return null;
  }
}

export function isTrustedBotComment(comment: {
  body?: string | null;
  user?: { login?: string | null; type?: string | null } | null;
}): boolean {
  if (!comment.body || !comment.body.startsWith(BOT_COMMENT_MARKER)) {
    return false;
  }
  const login = comment.user?.login?.toLowerCase();
  const type = comment.user?.type;
  return login === TRUSTED_ACTIONS_BOT_LOGIN && type === 'Bot';
}

export function findTrustedAiSuggestionForItem(
  comments: Array<{
    body?: string | null;
    user?: { login?: string | null; type?: string | null } | null;
  }>,
  headSha: string,
  itemId: string,
): AiSuggestion | null {
  for (let i = comments.length - 1; i >= 0; i--) {
    const comment = comments[i];
    if (!isTrustedBotComment(comment)) continue;
    const bundle = extractAiBundleFromComment(comment.body || '');
    if (!bundle) continue;
    if (bundle.headSha !== headSha) continue;
    return bundle.items[itemId] ?? null;
  }
  return null;
}
