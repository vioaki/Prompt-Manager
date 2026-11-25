import { z } from 'zod';

export const ALLOWED_MEDIA_MIME_TYPES = [
  'image/webp',
  'image/gif',
  'image/jpeg',
  'image/png',
] as const;

export type AllowedMediaMimeType = (typeof ALLOWED_MEDIA_MIME_TYPES)[number];

export const ALLOWED_IMAGE_EXTENSIONS = [
  '.webp',
  '.gif',
  '.jpg',
  '.jpeg',
  '.png',
] as const;

export const MAX_IMAGE_BYTES = 5 * 1024 * 1024; // 5 MiB
export const MAX_GIF_BYTES = 8 * 1024 * 1024; // 8 MiB
export const MAX_TOTAL_UPLOAD_BYTES = 4 * 1024 * 1024; // Per-request file budget on Workers Free
export const MAX_REFS = 10;
export const MAX_TAGS = 15;
export const MAX_PROMPT_LENGTH = 20_000;

const SAFE_MEDIA_FILENAME_RE = /^[a-z0-9][a-z0-9._-]{0,63}\.(webp|gif|png|jpe?g)$/i;
const SAFE_ID_RE = /^[a-z0-9][a-z0-9-]{2,118}[a-z0-9]$/;

export const PromptCategorySchema = z.enum(['gallery', 'template']);
export type PromptCategory = z.infer<typeof PromptCategorySchema>;

export const RefImageItemSchema = z.object({
  kind: z.literal('image'),
  file: z
    .string()
    .regex(SAFE_MEDIA_FILENAME_RE, '参考图文件名不合法'),
});

export const RefPlaceholderItemSchema = z.object({
  kind: z.literal('placeholder'),
  label: z.string().trim().min(1).max(40).default('User'),
});

export const RefItemSchema = z.discriminatedUnion('kind', [
  RefImageItemSchema,
  RefPlaceholderItemSchema,
]);
export type RefItem = z.infer<typeof RefItemSchema>;

export const PromptAuthorSchema = z.object({
  name: z.string().trim().max(80).default(''),
  github: z
    .string()
    .trim()
    .regex(/^[a-zA-Z0-9-]{1,39}$/, 'GitHub 用户名格式无效')
    .nullable()
    .default(null),
});
export type PromptAuthor = z.infer<typeof PromptAuthorSchema>;

export const PromptMediaSchema = z.object({
  main: z.string().regex(SAFE_MEDIA_FILENAME_RE, '主图文件名不合法'),
  thumb: z.string().regex(SAFE_MEDIA_FILENAME_RE, '缩略图文件名不合法'),
  mimeType: z.enum(ALLOWED_MEDIA_MIME_TYPES),
  width: z.number().int().positive().max(20_000),
  height: z.number().int().positive().max(20_000),
});
export type PromptMedia = z.infer<typeof PromptMediaSchema>;

export const PromptMetaSchema = z.object({
  schemaVersion: z.literal(1),
  id: z.string().regex(SAFE_ID_RE, '作品 ID 仅允许小写字母、数字和短横线'),
  title: z.string().trim().min(1, '标题不能为空').max(200, '标题过长'),
  category: PromptCategorySchema,
  prompt: z
    .string()
    .trim()
    .min(1, 'Prompt 不能为空')
    .max(MAX_PROMPT_LENGTH, `Prompt 不能超过 ${MAX_PROMPT_LENGTH} 字符`),
  description: z.string().trim().max(4000).default(''),
  tags: z
    .array(z.string().trim().min(1).max(40))
    .max(MAX_TAGS, `标签数量不能超过 ${MAX_TAGS} 个`)
    .default([]),
  author: PromptAuthorSchema.default({ name: '', github: null }),
  media: PromptMediaSchema,
  refs: z
    .array(RefItemSchema)
    .max(MAX_REFS, `参考图数量不能超过 ${MAX_REFS} 个`)
    .default([]),
  createdAt: z.string().datetime({ offset: true }),
});
export type PromptMeta = z.infer<typeof PromptMetaSchema>;

export const SiteConfigSchema = z.object({
  title: z.string().trim().min(1).max(100).default('Prompt Manager'),
  subtitle: z.string().trim().max(240).default('Community AI Art Prompt & Workflow Library'),
  repo: z.string().trim().regex(/^[a-zA-Z0-9_.-]+\/[a-zA-Z0-9_.-]+$/),
  engineRepo: z.string().trim().regex(/^[a-zA-Z0-9_.-]+\/[a-zA-Z0-9_.-]+$/),
  engineRef: z.string().trim().min(1).max(80).default('pages'),
  workerApiUrl: z.string().trim().default(''),
  sensitiveTags: z.array(z.string().trim().min(1).max(40)).default([]),
  allowPublicSensitiveToggle: z.boolean().default(true),
});
export type SiteConfig = z.infer<typeof SiteConfigSchema>;

export const AiSuggestionSchema = z.object({
  suggestedTags: z.array(z.string().trim().min(1).max(40)).max(MAX_TAGS).default([]),
  nsfwRisk: z.boolean().default(false),
  nsfwReason: z.string().trim().max(500).optional(),
  suggestedCategory: PromptCategorySchema.optional(),
  normalizedPrompt: z.string().trim().max(MAX_PROMPT_LENGTH).optional(),
  summary: z.string().trim().max(1000).optional(),
  model: z.string().trim().max(120).optional(),
  generatedAt: z.string().datetime({ offset: true }),
});
export type AiSuggestion = z.infer<typeof AiSuggestionSchema>;

export const CatalogRefSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('image'), url: z.string() }),
  z.object({ kind: z.literal('placeholder'), label: z.string() }),
]);
export type CatalogRef = z.infer<typeof CatalogRefSchema>;

export const CatalogItemSchema = z.object({
  id: z.string(),
  contentPath: z.string(),
  sourceRevision: z.string().optional(),
  title: z.string(),
  category: PromptCategorySchema,
  prompt: z.string(),
  description: z.string(),
  tags: z.array(z.string()),
  author: PromptAuthorSchema,
  media: z.object({
    mainUrl: z.string(),
    thumbUrl: z.string(),
    mimeType: z.enum(ALLOWED_MEDIA_MIME_TYPES),
    width: z.number().int().positive(),
    height: z.number().int().positive(),
  }),
  refs: z.array(CatalogRefSchema),
  createdAt: z.string(),
});
export type CatalogItem = z.infer<typeof CatalogItemSchema>;

export const TagStatSchema = z.object({
  name: z.string(),
  count: z.number().int().nonnegative(),
  isSensitive: z.boolean(),
});
export type TagStat = z.infer<typeof TagStatSchema>;

export const CatalogIndexSchema = z.object({
  schemaVersion: z.literal(1),
  generatedAt: z.string(),
  site: SiteConfigSchema,
  tags: z.array(TagStatSchema),
  items: z.array(CatalogItemSchema),
});
export type CatalogIndex = z.infer<typeof CatalogIndexSchema>;

export const ContributorSchema = z.object({
  login: z.string(),
  name: z.string().optional(),
  avatarUrl: z.string(),
  profileUrl: z.string(),
  contributions: z.number().int().positive(),
});
export type Contributor = z.infer<typeof ContributorSchema>;

export const SubmitRefLayoutEntrySchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('new-image'), field: z.string().min(1) }),
  z.object({ kind: z.literal('existing-image'), file: z.string().regex(SAFE_MEDIA_FILENAME_RE) }),
  z.object({ kind: z.literal('placeholder'), label: z.string().trim().min(1).max(40).default('User') }),
]);
export type SubmitRefLayoutEntry = z.infer<typeof SubmitRefLayoutEntrySchema>;

export const SubmitPayloadSchema = z.object({
  title: z.string().trim().min(1, '标题不能为空').max(200),
  category: PromptCategorySchema.default('gallery'),
  prompt: z.string().trim().min(1, 'Prompt 不能为空').max(MAX_PROMPT_LENGTH),
  description: z.string().trim().max(4000).default(''),
  tags: z.array(z.string().trim().min(1).max(40)).max(MAX_TAGS).default([]),
  authorName: z.string().trim().max(80).default(''),
  anonymous: z.boolean().default(false),
  mainWidth: z.number().int().positive().max(20_000),
  mainHeight: z.number().int().positive().max(20_000),
  refLayout: z.array(SubmitRefLayoutEntrySchema).max(MAX_REFS).default([]),
});
export type SubmitPayload = z.infer<typeof SubmitPayloadSchema>;
