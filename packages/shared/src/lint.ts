import { extractPromptVariables } from './promptVars.js';
import type { PromptCategory } from './schema.js';

export interface LintWarning {
  code:
    | 'FULLWIDTH_BRACES'
    | 'DUPLICATE_TAG'
    | 'TEMPLATE_CATEGORY_HINT'
    | 'TRAILING_WHITESPACE';
  message: string;
}

export interface TagNormalizationResult {
  tags: string[];
  removedDuplicates: string[];
}

export function normalizeTags(rawTags: string[]): TagNormalizationResult {
  const seenLower = new Set<string>();
  const tags: string[] = [];
  const removedDuplicates: string[] = [];

  for (const raw of rawTags) {
    const trimmed = raw.trim();
    if (!trimmed) continue;
    const dedupKey = trimmed.toLowerCase();
    if (seenLower.has(dedupKey)) {
      removedDuplicates.push(trimmed);
      continue;
    }
    seenLower.add(dedupKey);
    tags.push(trimmed);
  }

  return { tags, removedDuplicates };
}

export interface LintInput {
  prompt: string;
  category: PromptCategory;
  tags: string[];
}

export function lintPromptDraft(
  input: LintInput,
): { warnings: LintWarning[]; normalizedTags: string[] } {
  const warnings: LintWarning[] = [];
  const norm = normalizeTags(input.tags);

  if (norm.removedDuplicates.length > 0) {
    warnings.push({
      code: 'DUPLICATE_TAG',
      message: `存在重复标签：${norm.removedDuplicates.join(', ')}`,
    });
  }

  if (/｛｛.+?｝｝/.test(input.prompt)) {
    warnings.push({
      code: 'FULLWIDTH_BRACES',
      message: '检测到全角占位符 ｛｛变量｝｝，建议改为半角 {{变量}} 以启用动态表单填充',
    });
  }

  const vars = extractPromptVariables(input.prompt);
  if (vars.length > 0 && input.category === 'gallery') {
    warnings.push({
      code: 'TEMPLATE_CATEGORY_HINT',
      message: `检测到动态变量 (${vars.join(', ')})，建议将分类设为 "template"`,
    });
  }

  if (input.prompt !== input.prompt.trim()) {
    warnings.push({
      code: 'TRAILING_WHITESPACE',
      message: 'Prompt 首尾存在多余空白字符',
    });
  }

  return { warnings, normalizedTags: norm.tags };
}
