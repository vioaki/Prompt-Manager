export function slugifyTitle(title: string): string {
  const ascii = title
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48)
    .replace(/-+$/, '');

  return ascii.length >= 2 ? ascii : 'prompt';
}

export function formatUtcDateStamp(date: Date = new Date()): string {
  const y = date.getUTCFullYear();
  const m = String(date.getUTCMonth() + 1).padStart(2, '0');
  const d = String(date.getUTCDate()).padStart(2, '0');
  return `${y}${m}${d}`;
}

export function randomHexSuffix(length = 6): string {
  const bytes = new Uint8Array(Math.ceil(length / 2));
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0'))
    .join('')
    .slice(0, length);
}

export function createPromptId(
  title: string,
  date: Date = new Date(),
  suffix: string = randomHexSuffix(6),
): string {
  const dateStamp = formatUtcDateStamp(date);
  const slug = slugifyTitle(title);
  const cleanSuffix = suffix.toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 12) || '000000';
  return `${dateStamp}-${slug}-${cleanSuffix}`;
}

export function getContentDirRelativePath(id: string, createdAtIso: string): string {
  const yearMatch = /^(\d{4})/.exec(createdAtIso);
  const year = yearMatch ? yearMatch[1] : String(new Date().getUTCFullYear());
  return `content/${year}/${id}`;
}
