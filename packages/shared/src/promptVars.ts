export type PromptSegment =
  | { type: 'text'; value: string }
  | { type: 'var'; name: string; raw: string };

const VAR_REGEX = /\{\{([^{}]+?)\}\}/g;

export function splitPromptSegments(prompt: string): PromptSegment[] {
  const segments: PromptSegment[] = [];
  let lastIndex = 0;

  for (const match of prompt.matchAll(VAR_REGEX)) {
    const index = match.index ?? 0;
    if (index > lastIndex) {
      segments.push({ type: 'text', value: prompt.slice(lastIndex, index) });
    }
    const name = match[1].trim();
    if (name) {
      segments.push({ type: 'var', name, raw: match[0] });
    } else {
      segments.push({ type: 'text', value: match[0] });
    }
    lastIndex = index + match[0].length;
  }

  if (lastIndex < prompt.length) {
    segments.push({ type: 'text', value: prompt.slice(lastIndex) });
  }

  return segments;
}

export function extractPromptVariables(prompt: string): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const seg of splitPromptSegments(prompt)) {
    if (seg.type === 'var' && !seen.has(seg.name)) {
      seen.add(seg.name);
      result.push(seg.name);
    }
  }
  return result;
}

export function renderPromptWithVars(
  prompt: string,
  values: Record<string, string>,
): string {
  return splitPromptSegments(prompt)
    .map((seg) => {
      if (seg.type === 'text') return seg.value;
      const replacement = values[seg.name];
      return replacement !== undefined && replacement.length > 0
        ? replacement
        : seg.raw;
    })
    .join('');
}
