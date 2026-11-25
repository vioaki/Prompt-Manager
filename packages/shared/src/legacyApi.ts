import type { CatalogItem, PromptCategory } from './schema.js';

export interface LegacyApiRef {
  id: number;
  file_path: string;
  is_placeholder: boolean;
  position: number;
}

export interface LegacyApiItem {
  id: string;
  title: string;
  author: string;
  prompt: string;
  description: string;
  type: string;
  category: string;
  media_type: 'image' | 'gif';
  file_path: string;
  thumbnail_path: string;
  tags: string[];
  refs: LegacyApiRef[];
  heat_score: number;
  created_at: string;
}

export interface LegacyApiMeta {
  page: number;
  per_page: number;
  total_items: number;
  total_pages: number;
  has_next: boolean;
  next_url: string | null;
}

export interface LegacyApiResponse {
  code: 200;
  message: 'success';
  meta: LegacyApiMeta;
  data: LegacyApiItem[];
}

export interface LegacyQueryOptions {
  category: PromptCategory;
  page?: number;
  perPage?: number | null;
  q?: string;
  tag?: string;
  sort?: string;
  mediaBaseUrl: string;
  endpointUrl: string;
  rng?: () => number;
}

const DEFAULT_PER_PAGE = 500;
const HARD_LIMIT = 10_000;

function joinAbsoluteUrl(baseUrl: string, relativeOrAbsolute: string): string {
  if (/^https?:\/\//i.test(relativeOrAbsolute)) {
    return relativeOrAbsolute;
  }
  const cleanBase = baseUrl.replace(/\/+$/, '');
  const cleanPath = relativeOrAbsolute.replace(/^\/+/, '');
  return `${cleanBase}/${cleanPath}`;
}

export function toLegacyApiItem(item: CatalogItem, mediaBaseUrl: string): LegacyApiItem {
  const mediaType: 'image' | 'gif' =
    item.media.mimeType === 'image/gif' ? 'gif' : 'image';

  return {
    id: item.id,
    title: item.title,
    author: item.author.name,
    prompt: item.prompt,
    description: item.description,
    type: 'img2img',
    category: item.category,
    media_type: mediaType,
    file_path: joinAbsoluteUrl(mediaBaseUrl, item.media.mainUrl),
    thumbnail_path: joinAbsoluteUrl(mediaBaseUrl, item.media.thumbUrl),
    tags: item.tags,
    refs: item.refs.map((r, index) => ({
      id: index + 1,
      file_path:
        r.kind === 'placeholder'
          ? '{{userText}}'
          : joinAbsoluteUrl(mediaBaseUrl, r.url),
      is_placeholder: r.kind === 'placeholder',
      position: index,
    })),
    heat_score: 0,
    created_at: item.createdAt,
  };
}

export function queryLegacyApi(
  items: CatalogItem[],
  options: LegacyQueryOptions,
): LegacyApiResponse {
  const page = Math.max(1, Number.isFinite(options.page) ? Math.floor(options.page!) : 1);
  let perPage: number;
  if (options.perPage === -1) {
    perPage = HARD_LIMIT;
  } else if (options.perPage !== undefined && options.perPage !== null && Number.isFinite(options.perPage) && options.perPage > 0) {
    perPage = Math.min(Math.floor(options.perPage), HARD_LIMIT);
  } else {
    perPage = DEFAULT_PER_PAGE;
  }

  const q = (options.q ?? '').trim().toLowerCase();
  const tag = (options.tag ?? '').trim();
  const sort = (options.sort ?? 'date').trim().toLowerCase();

  let filtered = items.filter((item) => item.category === options.category);

  if (tag) {
    filtered = filtered.filter((item) => item.tags.includes(tag));
  }

  if (q) {
    filtered = filtered.filter(
      (item) =>
        item.title.toLowerCase().includes(q) ||
        item.prompt.toLowerCase().includes(q) ||
        item.author.name.toLowerCase().includes(q),
    );
  }

  const ordered = [...filtered];
  if (sort === 'random') {
    const rand = options.rng ?? Math.random;
    for (let i = ordered.length - 1; i > 0; i--) {
      const j = Math.floor(rand() * (i + 1));
      [ordered[i], ordered[j]] = [ordered[j], ordered[i]];
    }
  } else {
    ordered.sort((a, b) =>
      b.createdAt > a.createdAt ? 1 : b.createdAt < a.createdAt ? -1 : 0,
    );
  }

  const totalItems = ordered.length;
  const totalPages = totalItems === 0 ? 0 : Math.ceil(totalItems / perPage);
  const start = (page - 1) * perPage;
  const slice = ordered.slice(start, start + perPage);
  const hasNext = page < totalPages;

  let nextUrl: string | null = null;
  if (hasNext) {
    const url = new URL(options.endpointUrl);
    url.searchParams.set('page', String(page + 1));
    url.searchParams.set('per_page', String(perPage));
    if (q) url.searchParams.set('q', options.q!.trim());
    if (tag) url.searchParams.set('tag', tag);
    url.searchParams.set('sort', sort || 'date');
    nextUrl = url.toString();
  }

  return {
    code: 200,
    message: 'success',
    meta: {
      page,
      per_page: perPage,
      total_items: totalItems,
      total_pages: totalPages,
      has_next: hasNext,
      next_url: nextUrl,
    },
    data: slice.map((item) => toLegacyApiItem(item, options.mediaBaseUrl)),
  };
}
