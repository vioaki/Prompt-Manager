import fs from 'node:fs';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import path from 'node:path';
import {
  normalizeTags,
  queryLegacyApi,
  type CatalogIndex,
  type CatalogItem,
  type Contributor,
  type TagStat,
} from '@prompt-pages/shared';
import { discoverAndValidateContent, loadSiteConfig, resolvePaths } from './utils.js';

async function fetchContributors(
  repo: string,
  entries: CatalogItem[],
): Promise<Contributor[]> {
  const token = process.env.GITHUB_TOKEN || process.env.GH_TOKEN;
  if (token && repo) {
    try {
      const resp = await fetch(
        `https://api.github.com/repos/${repo}/contributors?per_page=100`,
        {
          headers: {
            Accept: 'application/vnd.github+json',
            Authorization: `Bearer ${token}`,
            'User-Agent': 'prompt-manager-pages-builder',
          },
        },
      );
      if (resp.ok) {
        const list = (await resp.json()) as Array<{
          login: string;
          avatar_url: string;
          html_url: string;
          contributions: number;
          type: string;
        }>;
        return list
          .filter((u) => u.type === 'User' && !u.login.endsWith('[bot]'))
          .map((u) => ({
            login: u.login,
            avatarUrl: u.avatar_url,
            profileUrl: u.html_url,
            contributions: u.contributions,
          }));
      }
    } catch (err) {
      console.warn(`[build-content] 拉取 GitHub contributors 失败，回退为本地聚合: ${(err as Error).message}`);
    }
  }

  // Fallback: aggregate from item author.github
  const counts = new Map<string, { name?: string; count: number }>();
  for (const item of entries) {
    const login = item.author.github;
    if (!login) continue;
    const prev = counts.get(login) ?? { name: item.author.name || undefined, count: 0 };
    prev.count += 1;
    counts.set(login, prev);
  }

  return Array.from(counts.entries())
    .sort((a, b) => b[1].count - a[1].count)
    .map(([login, info]) => ({
      login,
      name: info.name,
      avatarUrl: `https://github.com/${login}.png?size=128`,
      profileUrl: `https://github.com/${login}`,
      contributions: info.count,
    }));
}

function cleanDir(dir: string) {
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
}

function copyFileFast(src: string, dest: string) {
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.copyFileSync(src, dest);
}

async function main() {
  const { contentDir, siteConfigPath, webPublicDir } = resolvePaths();
  const siteConfig = loadSiteConfig(siteConfigPath);
  const { entries, errors } = discoverAndValidateContent(contentDir);

  if (errors.length > 0) {
    console.error(`[build-content] 发现 ${errors.length} 个内容校验错误，中止构建:`);
    for (const err of errors) {
      console.error(`  - [${err.path}] ${err.message}`);
    }
    process.exit(1);
  }

  const mediaRoot = path.join(webPublicDir, 'media');
  const dataRoot = path.join(webPublicDir, 'data');
  const apiRoot = path.join(webPublicDir, 'api');
  cleanDir(mediaRoot);
  cleanDir(dataRoot);
  cleanDir(apiRoot);

  let sourceRevision = process.env.CONTENT_REVISION;
  if (!sourceRevision && entries.length) {
    try {
      const git = (args: string[]) => execFileSync('git', args, {
        cwd: contentDir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'],
      }).trim();
      if (!git(['status', '--porcelain', '--', '.'])) sourceRevision = git(['rev-parse', 'HEAD']);
    } catch { /* Standalone content directories can still build a read-only catalog. */ }
  }

  const tagCounts = new Map<string, number>();
  const catalogItems: CatalogItem[] = [];

  for (const { dirPath, relativeDir, meta } of entries) {
    const targetDir = path.join(mediaRoot, meta.id);
    copyFileFast(path.join(dirPath, meta.media.main), path.join(targetDir, meta.media.main));
    if (meta.media.thumb !== meta.media.main) {
      copyFileFast(path.join(dirPath, meta.media.thumb), path.join(targetDir, meta.media.thumb));
    }

    const refs = meta.refs.map((ref) => {
      if (ref.kind === 'placeholder') {
        return { kind: 'placeholder' as const, label: ref.label };
      }
      copyFileFast(path.join(dirPath, ref.file), path.join(targetDir, ref.file));
      return {
        kind: 'image' as const,
        url: `media/${meta.id}/${ref.file}`,
      };
    });

    const canonicalTags = normalizeTags(meta.tags).tags;
    for (const tag of canonicalTags) {
      tagCounts.set(tag, (tagCounts.get(tag) ?? 0) + 1);
    }

    const normalizedContentPath = relativeDir.startsWith('content/')
      ? relativeDir
      : `content/${relativeDir}`;

    catalogItems.push({
      id: meta.id,
      contentPath: normalizedContentPath,
      sourceRevision,
      title: meta.title,
      category: meta.category,
      prompt: meta.prompt,
      description: meta.description,
      tags: canonicalTags,
      author: meta.author,
      media: {
        mainUrl: `media/${meta.id}/${meta.media.main}`,
        thumbUrl: `media/${meta.id}/${meta.media.thumb}`,
        mimeType: meta.media.mimeType,
        width: meta.media.width,
        height: meta.media.height,
      },
      refs,
      createdAt: meta.createdAt,
    });
  }

  catalogItems.sort((a, b) => b.createdAt.localeCompare(a.createdAt));

  const sensitiveLowerSet = new Set(
    siteConfig.sensitiveTags.map((t) => t.trim().toLowerCase()),
  );
  const tags: TagStat[] = Array.from(tagCounts.entries())
    .map(([name, count]) => ({
      name,
      count,
      isSensitive: sensitiveLowerSet.has(name.trim().toLowerCase()),
    }))
    .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name, 'zh-CN'));

  const indexPayload: CatalogIndex = {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    site: siteConfig,
    tags,
    items: catalogItems,
  };

  fs.writeFileSync(
    path.join(dataRoot, 'index.json'),
    JSON.stringify(indexPayload),
    'utf-8',
  );

  // Clean static JSON feeds (new schema)
  const galleryItems = catalogItems.filter((i) => i.category === 'gallery');
  const templateItems = catalogItems.filter((i) => i.category === 'template');
  fs.writeFileSync(
    path.join(apiRoot, 'gallery.json'),
    JSON.stringify({
      schemaVersion: 1,
      generatedAt: indexPayload.generatedAt,
      total: galleryItems.length,
      items: galleryItems,
    }),
    'utf-8',
  );
  fs.writeFileSync(
    path.join(apiRoot, 'templates.json'),
    JSON.stringify({
      schemaVersion: 1,
      generatedAt: indexPayload.generatedAt,
      total: templateItems.length,
      items: templateItems,
    }),
    'utf-8',
  );

  const [owner, repo] = siteConfig.repo.split('/');
  const host = owner.toLowerCase() + '.github.io';
  const mediaBaseUrl = (process.env.PAGES_BASE_URL || ('https://' + host +
    (repo.toLowerCase() === host ? '' : '/' + repo))).replace(/\/+$/, '');
  for (const category of ['gallery', 'template'] as const) {
    const name = category === 'gallery' ? 'gallery' : 'templates';
    const { data, meta } = queryLegacyApi(catalogItems, {
      category, perPage: -1, mediaBaseUrl, endpointUrl: mediaBaseUrl + '/api/' + name,
    });
    if (meta.has_next) continue; // Pagination links depend on the incoming Worker URL.
    const json = JSON.stringify(data);
    const etag = '"' + createHash('sha256').update(JSON.stringify(meta) + '|').update(json).digest('hex').slice(0, 32) + '"';
    fs.writeFileSync(path.join(apiRoot, name + '.all.jsonl'), JSON.stringify({ mediaBaseUrl, meta, etag }) + '\n' + json);
  }

  const contributors = await fetchContributors(siteConfig.repo, catalogItems);
  fs.writeFileSync(
    path.join(dataRoot, 'contributors.json'),
    JSON.stringify({ generatedAt: indexPayload.generatedAt, contributors }),
    'utf-8',
  );

  console.log(
    `[build-content] 构建完成: ${catalogItems.length} 条作品 (${galleryItems.length} 画廊 / ${templateItems.length} 模板), ${tags.length} 个标签, ${contributors.length} 位贡献者`,
  );
}

main().catch((err) => {
  console.error('[build-content] 失败:', err);
  process.exit(1);
});
