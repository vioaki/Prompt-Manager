import { describe, expect, it } from 'vitest';
import {
  PromptMetaSchema,
  extractPromptVariables,
  lintPromptDraft,
  normalizeTags,
  queryLegacyApi,
  renderPromptWithVars,
  createPromptId,
  toLegacyNumericId,
  type CatalogItem,
} from './index.js';

describe('PromptMetaSchema', () => {
  const validMeta = {
    schemaVersion: 1 as const,
    id: '20251205-polaroid-0650',
    title: '拍立得',
    category: 'template' as const,
    prompt: 'Create a polaroid with {{Character}} in {{Style}}',
    description: '输入角色图片与名称',
    tags: ['banana', '肖像'],
    author: { name: '39c5bb', github: null },
    media: {
      main: 'main.webp',
      thumb: 'thumb.webp',
      mimeType: 'image/webp' as const,
      width: 1024,
      height: 1536,
    },
    refs: [
      { kind: 'placeholder' as const, label: 'User' },
      { kind: 'image' as const, file: 'ref-0.webp' },
    ],
    createdAt: '2025-12-05T15:23:22Z',
  };

  it('accepts valid prompt metadata', () => {
    const parsed = PromptMetaSchema.parse(validMeta);
    expect(parsed.id).toBe('20251205-polaroid-0650');
    expect(parsed.refs).toHaveLength(2);
  });

  it('rejects video mime types and path traversal filenames', () => {
    expect(() =>
      PromptMetaSchema.parse({
        ...validMeta,
        media: { ...validMeta.media, mimeType: 'video/mp4' },
      }),
    ).toThrow();

    expect(() =>
      PromptMetaSchema.parse({
        ...validMeta,
        media: { ...validMeta.media, main: '../secret.webp' },
      }),
    ).toThrow();
  });

  it('rejects empty prompt or empty title', () => {
    expect(() => PromptMetaSchema.parse({ ...validMeta, prompt: '   ' })).toThrow();
    expect(() => PromptMetaSchema.parse({ ...validMeta, title: '' })).toThrow();
  });
});

describe('promptVars', () => {
  it('extracts unique variables in order and renders replacements', () => {
    const raw = 'Draw {{ Character }} in {{Style}} with {{Character}} smiling';
    expect(extractPromptVariables(raw)).toEqual(['Character', 'Style']);
    expect(renderPromptWithVars(raw, { Character: 'Miku' })).toBe(
      'Draw Miku in {{Style}} with Miku smiling',
    );
    expect(renderPromptWithVars(raw, { Character: 'Miku', Style: 'cyberpunk' })).toBe(
      'Draw Miku in cyberpunk with Miku smiling',
    );
  });
});

describe('lint & normalizeTags', () => {
  it('trims and deduplicates tags case-insensitively', () => {
    const res = normalizeTags(['banana', ' Banana ', '二次元', '二次元', '  ']);
    expect(res.tags).toEqual(['banana', '二次元']);
    expect(res.removedDuplicates).toEqual(['Banana', '二次元']);
  });

  it('warns on duplicate tags, fullwidth braces, and template variables inside gallery category', () => {
    const { warnings } = lintPromptDraft({
      prompt: 'A portrait of {{Hero}} and ｛｛Style｝｝',
      category: 'gallery',
      tags: ['banana', 'Banana'],
    });

    const codes = warnings.map((w) => w.code);
    expect(codes).toContain('DUPLICATE_TAG');
    expect(codes).toContain('FULLWIDTH_BRACES');
    expect(codes).toContain('TEMPLATE_CATEGORY_HINT');
  });
});

describe('slug', () => {
  it('creates safe prompt ids for both ASCII and CJK titles', () => {
    const date = new Date('2026-11-25T00:00:00Z');
    expect(createPromptId('Cyberpunk Girl!', date, 'ab12cd')).toBe(
      '20261125-cyberpunk-girl-ab12cd',
    );
    expect(createPromptId('手绘信息图卡片', date, 'ef3456')).toBe(
      '20261125-prompt-ef3456',
    );
  });
});

describe('queryLegacyApi', () => {
  const sampleItems: CatalogItem[] = [
    {
      id: '20251205-card-0001',
      contentPath: 'content/2025/20251205-card-0001',
      title: '手绘信息图',
      category: 'gallery',
      prompt: 'hand drawn infographic',
      description: 'desc 1',
      tags: ['banana', '信息图'],
      author: { name: 'vioaki', github: 'vioaki' },
      media: {
        mainUrl: 'media/20251205-card-0001/main.webp',
        thumbUrl: 'media/20251205-card-0001/thumb.webp',
        mimeType: 'image/webp',
        width: 800,
        height: 1200,
      },
      refs: [{ kind: 'image', url: 'media/20251205-card-0001/ref-0.webp' }],
      createdAt: '2025-12-05T14:37:45Z',
    },
    {
      id: '20251206-polaroid-0002',
      contentPath: 'content/2025/20251206-polaroid-0002',
      title: '拍立得',
      category: 'template',
      prompt: 'polaroid of {{userText}}',
      description: 'desc 2',
      tags: ['banana'],
      author: { name: '39c5bb', github: null },
      media: {
        mainUrl: 'media/20251206-polaroid-0002/main.gif',
        thumbUrl: 'media/20251206-polaroid-0002/thumb.webp',
        mimeType: 'image/gif',
        width: 600,
        height: 600,
      },
      refs: [{ kind: 'placeholder', label: 'User' }],
      createdAt: '2025-12-06T15:23:22Z',
    },
  ];

  it('filters by category, preserves placeholder {{userText}} format, and builds absolute URLs', () => {
    const res = queryLegacyApi(sampleItems, {
      category: 'template',
      mediaBaseUrl: 'https://vioaki.github.io/Prompt-Manager-Pages',
      endpointUrl: 'https://worker.example.dev/api/templates',
    });

    expect(res.code).toBe(200);
    expect(res.meta.total_items).toBe(1);
    expect(res.data[0].id).toBe(2);
    expect(res.data[0].type).toBe('img2img');
    expect(res.data[0].media_type).toBe('gif');
    expect(res.data[0].file_path).toBe(
      'https://vioaki.github.io/Prompt-Manager-Pages/media/20251206-polaroid-0002/main.gif',
    );
    expect(res.data[0].refs[0]).toEqual({
      id: 1,
      file_path: '{{userText}}',
      is_placeholder: true,
      position: 0,
    });
  });

  it('supports search, tag filter, pagination, and per_page=-1', () => {
    const page1 = queryLegacyApi(sampleItems, {
      category: 'gallery',
      page: 1,
      perPage: 1,
      q: '手绘',
      tag: 'banana',
      mediaBaseUrl: 'https://vioaki.github.io/Prompt-Manager-Pages',
      endpointUrl: 'https://worker.example.dev/api/gallery',
    });
    expect(page1.data).toHaveLength(1);
    expect(page1.data[0].id).toBe(1);
    expect(page1.meta.has_next).toBe(false);
    expect(page1.data[0].refs[0].file_path).toBe(
      'https://vioaki.github.io/Prompt-Manager-Pages/media/20251205-card-0001/ref-0.webp',
    );
  });

  it('maps migrated 4-digit IDs to original integers and new 6-hex IDs to stable unsigned 31-bit ints', () => {
    expect(toLegacyNumericId('20251205-polaroid-0650')).toBe(650);
    expect(toLegacyNumericId('20251205-card-0001')).toBe(1);

    const newA = toLegacyNumericId('20261126-cyberpunk-girl-ab12cd');
    const newB = toLegacyNumericId('20261126-cyberpunk-girl-ef3456');
    const newNumericHex = toLegacyNumericId('20261126-prompt-012345');
    expect(Number.isInteger(newA)).toBe(true);
    expect(newA).toBeGreaterThanOrEqual(100_000);
    expect(newA).toBeLessThan(0x7fffffff);
    expect(toLegacyNumericId('20261126-cyberpunk-girl-ab12cd')).toBe(newA);
    expect(newA).not.toBe(newB);
    expect(newNumericHex).toBeGreaterThanOrEqual(100_000);
  });
});
