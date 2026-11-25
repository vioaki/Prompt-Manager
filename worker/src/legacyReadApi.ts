import {
  queryLegacyApi,
  type CatalogItem,
  type PromptCategory,
} from '@prompt-pages/shared';
import type { Env } from './env.js';

const textEncoder = new TextEncoder();
const FEED_CACHE_TTL_MS = 60_000;
const MAX_RESPONSE_CACHE_KEYS = 24;

interface CachedResponse {
  etag: string;
  dataBytes: Uint8Array;
  meta: Record<string, unknown>;
}

interface CachedFeed {
  items: CatalogItem[];
  expiresAtMs: number;
  responses: Map<string, CachedResponse>;
}

const feedCache = new Map<string, CachedFeed>();

const fullResponses = new Map<string, { response: CachedResponse | null; expiresAt: number }>();

async function loadFullResponse(env: Env, category: PromptCategory): Promise<CachedResponse | null> {
  const base = env.PAGES_BASE_URL.replace(/\/+$/, '');
  const url = base + '/api/' + (category === 'gallery' ? 'gallery' : 'templates') + '.all.jsonl';
  const hit = fullResponses.get(url);
  if (hit && hit.expiresAt > Date.now()) return hit.response;
  const resp = await fetch(url, { cf: { cacheTtl: 60, cacheEverything: true } } as RequestInit);
  let response: CachedResponse | null = null;
  if (resp.ok) {
    const bytes = new Uint8Array(await resp.arrayBuffer());
    const end = bytes.subarray(0, 4096).indexOf(10);
    if (end > 0 && bytes[end + 1] === 0x5b) {
      // Older static hosts may serve their HTML fallback with status 200.
      try {
        const header = JSON.parse(new TextDecoder().decode(bytes.subarray(0, end)));
        if (header?.mediaBaseUrl === base && header.meta && typeof header.etag === 'string') {
          response = { meta: header.meta, etag: header.etag, dataBytes: bytes.subarray(end + 1) };
        }
      } catch { /* Fall back to the category feed. */ }
    }
  }
  fullResponses.set(url, { response, expiresAt: Date.now() + FEED_CACHE_TTL_MS });
  return response;
}

export function clearLegacyApiCache(): void {
  feedCache.clear();
  fullResponses.clear();
}

function isCatalogItemArray(value: unknown): value is CatalogItem[] {
  return Array.isArray(value);
}

async function loadCategoryFeed(env: Env, category: PromptCategory): Promise<CachedFeed> {
  const base = env.PAGES_BASE_URL.replace(/\/+$/, '');
  const cacheKey = `${base}::${category}`;
  const now = Date.now();
  const existing = feedCache.get(cacheKey);
  if (existing && existing.expiresAtMs > now) {
    return existing;
  }

  // Prefer the pre-split category feed (smaller JSON -> lower CPU on Workers)
  const feedPath = category === 'template' ? 'api/templates.json' : 'api/gallery.json';
  const feedUrl = `${base}/${feedPath}`;
  let resp = await fetch(feedUrl, {
    cf: { cacheTtl: 60, cacheEverything: true },
  } as RequestInit);

  if (resp.status === 404) {
    resp = await fetch(`${base}/data/index.json`, {
      cf: { cacheTtl: 60, cacheEverything: true },
    } as RequestInit);
  }

  if (!resp.ok) {
    throw new Error(`拉取静态索引失败 (${resp.status})`);
  }

  const raw = (await resp.json()) as { items?: unknown };
  if (!raw || !isCatalogItemArray(raw.items)) {
    throw new Error('静态索引格式异常: 缺少 items 数组');
  }

  const entry: CachedFeed = {
    items: raw.items,
    expiresAtMs: now + FEED_CACHE_TTL_MS,
    responses: new Map(),
  };
  feedCache.set(cacheKey, entry);
  return entry;
}

export async function handleLegacyReadApi(
  request: Request,
  env: Env,
  category: PromptCategory,
): Promise<Response> {
  const reqUrl = new URL(request.url);
  const pageRaw = reqUrl.searchParams.get('page');
  const perPageRaw = reqUrl.searchParams.get('per_page');
  const q = reqUrl.searchParams.get('q') ?? '';
  const tag = reqUrl.searchParams.get('tag') ?? '';
  const sort = reqUrl.searchParams.get('sort') ?? 'date';
  const isRandom = sort.trim().toLowerCase() === 'random';

  const page = pageRaw ? Number.parseInt(pageRaw, 10) : 1;
  const perPage = perPageRaw !== null ? Number.parseInt(perPageRaw, 10) : null;
  const safePage = Number.isNaN(page) ? 1 : page;
  const safePerPage = perPage !== null && !Number.isNaN(perPage) ? perPage : null;

  if (safePage === 1 && safePerPage === -1 && !q.trim() && !tag.trim() && sort.trim().toLowerCase() === 'date') {
    const prepared = await loadFullResponse(env, category);
    if (prepared) return sendLegacyResponse(request, prepared, false);
  }
  const feed = await loadCategoryFeed(env, category);
  const endpointUrl = `${reqUrl.origin}${reqUrl.pathname}`;
  const queryCacheKey = isRandom
    ? ''
    : `${endpointUrl}|p=${safePage}|pp=${safePerPage ?? ''}|q=${q}|t=${tag}|s=${sort}`;

  let cached = queryCacheKey ? feed.responses.get(queryCacheKey) : undefined;
  if (!cached) {
    const payload = queryLegacyApi(feed.items, {
      category,
      page: safePage,
      perPage: safePerPage,
      q,
      tag,
      sort,
      mediaBaseUrl: env.PAGES_BASE_URL,
      endpointUrl,
    });

    // Encode data & stable meta to UTF-8 once to stay well within Cloudflare Workers 10ms CPU budget
    const dataBytes = textEncoder.encode(JSON.stringify(payload.data));
    const metaBytes = textEncoder.encode(JSON.stringify(payload.meta));
    const hashInput = new Uint8Array(metaBytes.byteLength + 1 + dataBytes.byteLength);
    hashInput.set(metaBytes, 0);
    hashInput[metaBytes.byteLength] = 0x7c; // '|'
    hashInput.set(dataBytes, metaBytes.byteLength + 1);
    const digest = await crypto.subtle.digest('SHA-256', hashInput);
    const hex = Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('');
    const etag = `"${hex.slice(0, 32)}"`;

    cached = {
      etag,
      dataBytes,
      meta: payload.meta as unknown as Record<string, unknown>,
    };

    if (queryCacheKey) {
      if (feed.responses.size >= MAX_RESPONSE_CACHE_KEYS) {
        const oldestKey = feed.responses.keys().next().value;
        if (oldestKey !== undefined) feed.responses.delete(oldestKey);
      }
      feed.responses.set(queryCacheKey, cached);
    }
  }

  return sendLegacyResponse(request, cached, isRandom);
}

function sendLegacyResponse(request: Request, cached: CachedResponse, isRandom: boolean): Response {
  const ifNoneMatch = request.headers.get('If-None-Match');
  if (ifNoneMatch && ifNoneMatch.includes(cached.etag) && !isRandom) {
    return new Response(null, {
      status: 304,
      headers: {
        ETag: cached.etag,
        'Cache-Control': 'public, max-age=60',
      },
    });
  }

  const metaWithTimestampJson = JSON.stringify({
    ...cached.meta,
    server_timestamp: Math.floor(Date.now() / 1000),
  });
  const prefixBytes = textEncoder.encode(
    `{"code":200,"message":"success","meta":${metaWithTimestampJson},"data":`,
  );
  const responseBytes = new Uint8Array(prefixBytes.byteLength + cached.dataBytes.byteLength + 1);
  responseBytes.set(prefixBytes, 0);
  responseBytes.set(cached.dataBytes, prefixBytes.byteLength);
  responseBytes[responseBytes.byteLength - 1] = 0x7d; // '}'

  return new Response(responseBytes, {
    status: 200,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      ETag: cached.etag,
      'Cache-Control': isRandom ? 'no-store' : 'public, max-age=60',
    },
  });
}
