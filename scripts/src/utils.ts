import fs from 'node:fs';
import path from 'node:path';
import {
  ALLOWED_IMAGE_EXTENSIONS,
  MAX_GIF_BYTES,
  MAX_IMAGE_BYTES,
  PromptMetaSchema,
  SiteConfigSchema,
  type AllowedMediaMimeType,
  type PromptMeta,
  type SiteConfig,
} from '@prompt-pages/shared';

export interface DiscoveredEntry {
  dirPath: string;
  relativeDir: string;
  metaPath: string;
  meta: PromptMeta;
}

export function detectImageMimeFromBytes(buf: Uint8Array): AllowedMediaMimeType | null {
  if (buf.length < 12) return null;
  if (
    buf[0] === 0x52 &&
    buf[1] === 0x49 &&
    buf[2] === 0x46 &&
    buf[3] === 0x46 &&
    buf[8] === 0x57 &&
    buf[9] === 0x45 &&
    buf[10] === 0x42 &&
    buf[11] === 0x50
  ) {
    return 'image/webp';
  }
  if (
    buf[0] === 0x47 &&
    buf[1] === 0x49 &&
    buf[2] === 0x46 &&
    buf[3] === 0x38 &&
    (buf[4] === 0x37 || buf[4] === 0x39) &&
    buf[5] === 0x61
  ) {
    return 'image/gif';
  }
  if (
    buf[0] === 0x89 &&
    buf[1] === 0x50 &&
    buf[2] === 0x4e &&
    buf[3] === 0x47 &&
    buf[4] === 0x0d &&
    buf[5] === 0x0a &&
    buf[6] === 0x1a &&
    buf[7] === 0x0a
  ) {
    return 'image/png';
  }
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) {
    return 'image/jpeg';
  }
  return null;
}

export function resolvePaths() {
  const repoRoot = path.resolve(import.meta.dirname, '../..');
  const explicitContentDir = process.env.CONTENT_DIR?.trim();
  const contentDir = path.resolve(
    explicitContentDir || path.join(repoRoot, 'content'),
  );
  if (explicitContentDir && !fs.existsSync(contentDir)) {
    throw new Error(`指定的 CONTENT_DIR 不存在: ${contentDir}`);
  }
  const siteConfigPath = path.resolve(
    process.env.SITE_CONFIG_PATH || path.join(repoRoot, 'site.config.json'),
  );
  const webPublicDir = path.resolve(
    process.env.WEB_PUBLIC_DIR || path.join(repoRoot, 'web', 'public'),
  );
  return { repoRoot, contentDir, siteConfigPath, webPublicDir };
}

export function loadSiteConfig(siteConfigPath: string): SiteConfig {
  const raw = fs.readFileSync(siteConfigPath, 'utf-8');
  return SiteConfigSchema.parse(JSON.parse(raw));
}

export interface ValidationIssue {
  path: string;
  message: string;
}

function walkMetaFilesSafe(
  rootDir: string,
  dir: string,
  metaFiles: string[],
  errors: ValidationIssue[],
): void {
  if (!fs.existsSync(dir)) return;
  const dirStat = fs.lstatSync(dir);
  if (dirStat.isSymbolicLink() || !dirStat.isDirectory()) {
    errors.push({
      path: path.relative(rootDir, dir).replaceAll(path.sep, '/') || '.',
      message: '内容目录不允许使用符号链接',
    });
    return;
  }

  const entries = fs.readdirSync(dir, { withFileTypes: true });
  if (!entries.some((entry) => entry.name === 'meta.json') &&
      entries.some((entry) => entry.isFile() && ALLOWED_IMAGE_EXTENSIONS.some((ext) => entry.name.toLowerCase().endsWith(ext)))) {
    errors.push({ path: path.relative(rootDir, dir) || '.', message: '媒体所在作品目录缺少 meta.json' });
  }
  for (const entry of entries) {
    if (entry.name.startsWith('.')) continue;
    const full = path.join(dir, entry.name);
    const rel = path.relative(rootDir, full).replaceAll(path.sep, '/');
    const lstat = fs.lstatSync(full);
    if (lstat.isSymbolicLink()) {
      errors.push({
        path: rel,
        message: `不允许符号链接: ${entry.name}`,
      });
      continue;
    }
    if (lstat.isDirectory()) {
      walkMetaFilesSafe(rootDir, full, metaFiles, errors);
    } else if (lstat.isFile() && entry.name === 'meta.json') {
      metaFiles.push(full);
    }
  }
}

function validateMediaFile(
  dirPath: string,
  realDirPath: string,
  filename: string,
  expectedMime?: AllowedMediaMimeType,
): string | null {
  const resolved = path.resolve(dirPath, filename);
  if (!resolved.startsWith(path.resolve(dirPath) + path.sep)) {
    return `非法媒体路径越界: ${filename}`;
  }

  let lstat: fs.Stats;
  try {
    lstat = fs.lstatSync(resolved);
  } catch {
    return `缺少媒体文件: ${filename}`;
  }

  if (lstat.isSymbolicLink()) {
    return `媒体文件不允许使用符号链接: ${filename}`;
  }
  if (!lstat.isFile() || lstat.size === 0) {
    return `媒体文件为空或不是普通文件: ${filename}`;
  }

  const realFile = fs.realpathSync(resolved);
  if (!realFile.startsWith(realDirPath + path.sep)) {
    return `媒体文件真实路径越界: ${filename}`;
  }

  const openFlags = fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0);
  const fd = fs.openSync(resolved, openFlags);
  const header = new Uint8Array(16);
  try {
    fs.readSync(fd, header, 0, 16, 0);
  } finally {
    fs.closeSync(fd);
  }

  const detected = detectImageMimeFromBytes(header);
  if (!detected) {
    return `不受支持或损坏的媒体文件头 (仅允许 WebP/GIF/PNG/JPEG): ${filename}`;
  }

  const maxSize = detected === 'image/gif' ? MAX_GIF_BYTES : MAX_IMAGE_BYTES;
  if (lstat.size > maxSize) {
    return `媒体文件过大 (${(lstat.size / (1024 * 1024)).toFixed(2)} MB > ${(maxSize / (1024 * 1024)).toFixed(0)} MB): ${filename}`;
  }

  if (expectedMime && detected !== expectedMime) {
    return `媒体文件实际类型 (${detected}) 与声明 (${expectedMime}) 不一致: ${filename}`;
  }

  return null;
}

export function discoverAndValidateContent(contentDir: string): {
  entries: DiscoveredEntry[];
  errors: ValidationIssue[];
} {
  const metaFiles: string[] = [];
  const errors: ValidationIssue[] = [];
  walkMetaFilesSafe(contentDir, contentDir, metaFiles, errors);
  metaFiles.sort();

  const entries: DiscoveredEntry[] = [];
  const seenIds = new Map<string, string>();
  const realContentDir = fs.existsSync(contentDir) ? fs.realpathSync(contentDir) : contentDir;

  for (const metaPath of metaFiles) {
    const dirPath = path.dirname(metaPath);
    const relativeDir = path.relative(contentDir, dirPath).replaceAll(path.sep, '/');
    const realDirPath = fs.realpathSync(dirPath);

    if (realDirPath !== realContentDir && !realDirPath.startsWith(realContentDir + path.sep)) {
      errors.push({
        path: relativeDir,
        message: '作品目录真实路径越界',
      });
      continue;
    }

    let json: unknown;
    try {
      const metaLstat = fs.lstatSync(metaPath);
      if (metaLstat.isSymbolicLink() || !metaLstat.isFile()) {
        errors.push({ path: relativeDir, message: 'meta.json 不允许使用符号链接' });
        continue;
      }
      json = JSON.parse(fs.readFileSync(metaPath, 'utf-8'));
    } catch (err) {
      errors.push({
        path: relativeDir,
        message: `JSON 解析失败: ${(err as Error).message}`,
      });
      continue;
    }

    const parsed = PromptMetaSchema.safeParse(json);
    if (!parsed.success) {
      for (const issue of parsed.error.issues) {
        errors.push({
          path: relativeDir,
          message: `${issue.path.join('.') || 'meta'}: ${issue.message}`,
        });
      }
      continue;
    }

    const meta = parsed.data;
    if (path.basename(dirPath) !== meta.id) {
      errors.push({
        path: relativeDir,
        message: `作品目录名 "${path.basename(dirPath)}" 与 meta.id "${meta.id}" 不一致`,
      });
      continue;
    }

    const prev = seenIds.get(meta.id);
    if (prev) {
      errors.push({
        path: relativeDir,
        message: `重复作品 ID "${meta.id}" (已存在于 ${prev})`,
      });
      continue;
    }
    seenIds.set(meta.id, relativeDir);

    const mediaErrors: string[] = [];
    const mainErr = validateMediaFile(dirPath, realDirPath, meta.media.main, meta.media.mimeType);
    if (mainErr) mediaErrors.push(mainErr);

    const thumbErr = validateMediaFile(dirPath, realDirPath, meta.media.thumb);
    if (thumbErr) mediaErrors.push(thumbErr);

    for (const ref of meta.refs) {
      if (ref.kind === 'image') {
        const refErr = validateMediaFile(dirPath, realDirPath, ref.file);
        if (refErr) mediaErrors.push(refErr);
      }
    }

    if (mediaErrors.length > 0) {
      for (const msg of mediaErrors) {
        errors.push({ path: relativeDir, message: msg });
      }
      continue;
    }

    entries.push({ dirPath, relativeDir, metaPath, meta });
  }

  return { entries, errors };
}
