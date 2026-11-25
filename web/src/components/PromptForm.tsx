import {
  DndContext,
  PointerSensor,
  closestCenter,
  useSensor,
  useSensors,
  type DragEndEvent,
} from '@dnd-kit/core';
import {
  SortableContext,
  arrayMove,
  rectSortingStrategy,
  useSortable,
} from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import {
  AlertTriangle,
  GripVertical,
  ImagePlus,
  Sparkles,
  UploadCloud,
  UserRoundPlus,
  X,
} from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import {
  MAX_REFS,
  MAX_TOTAL_UPLOAD_BYTES,
  MAX_TAGS,
  extractPromptVariables,
  lintPromptDraft,
  normalizeTags,
  type PromptCategory,
  type SubmitRefLayoutEntry,
} from '@prompt-pages/shared';
import {
  compressMainImage,
  compressRefImage,
  formatBytes,
  type CompressedMediaBundle,
} from '../utils/imageCompress';

export type FormRefItem =
  | { uid: string; kind: 'placeholder'; label: string }
  | { uid: string; kind: 'existing-image'; file: string; previewUrl: string }
  | { uid: string; kind: 'new-image'; file: File; previewUrl: string };

export interface PromptFormInitialValues {
  title: string;
  category: PromptCategory;
  prompt: string;
  description: string;
  tags: string[];
  authorName: string;
  anonymous: boolean;
  existingMainUrl?: string;
  existingWidth?: number;
  existingHeight?: number;
  refs: FormRefItem[];
}

export interface PromptFormExternalPatch {
  seq: number;
  addTags?: string[];
  category?: PromptCategory;
  prompt?: string;
}

interface PromptFormProps {
  mode: 'submit' | 'review' | 'edit';
  initialValues: PromptFormInitialValues;
  externalPatch?: PromptFormExternalPatch | null;
  suggestedTagsPool: string[];
  submitLabel: string;
  submitting: boolean;
  onSubmit: (formData: FormData) => Promise<void>;
  onCancel?: () => void;
}

function SortableRefCard({
  item,
  index,
  onRemove,
}: {
  item: FormRefItem;
  index: number;
  onRemove: () => void;
}) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: item.uid,
  });

  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.5 : 1,
  };

  return (
    <div
      ref={setNodeRef}
      style={style}
      className="group relative h-24 w-24 rounded-xl overflow-hidden border border-[var(--border-subtle)] bg-[var(--sidebar-bg)] shadow-xs select-none"
    >
      <div
        {...attributes}
        {...listeners}
        className="absolute bottom-1.5 left-1.5 z-10 inline-flex items-center gap-0.5 rounded-full bg-black/60 backdrop-blur-md px-2 py-0.5 text-[10px] font-semibold text-white cursor-grab active:cursor-grabbing"
      >
        <GripVertical className="h-2.5 w-2.5" />
        <span>{index + 1}</span>
      </div>
      <button
        type="button"
        onClick={onRemove}
        title="移除"
        className="absolute top-1.5 right-1.5 z-10 inline-flex h-5 w-5 items-center justify-center rounded-full bg-black/60 text-white hover:bg-[#ff3b30] transition-colors cursor-pointer"
      >
        <X className="h-3 w-3" />
      </button>

      {item.kind === 'placeholder' ? (
        <div className="flex h-full w-full flex-col items-center justify-center border-2 border-dashed border-[var(--text-secondary)]/30 rounded-xl text-[var(--text-secondary)]">
          <UserRoundPlus className="h-5 w-5 mb-1 opacity-70" />
          <span className="text-[11px] font-semibold">{`{{${item.label}}}`}</span>
        </div>
      ) : (
        <img
          src={item.previewUrl}
          alt={`ref-${index}`}
          className="h-full w-full object-cover pointer-events-none"
        />
      )}
    </div>
  );
}

export function PromptForm({
  mode,
  initialValues,
  externalPatch,
  suggestedTagsPool,
  submitLabel,
  submitting,
  onSubmit,
  onCancel,
}: PromptFormProps) {
  const [title, setTitle] = useState(initialValues.title);
  const [category, setCategory] = useState<PromptCategory>(initialValues.category);
  const [prompt, setPrompt] = useState(initialValues.prompt);
  const [description, setDescription] = useState(initialValues.description);
  const [tags, setTags] = useState<string[]>(initialValues.tags);
  const [tagInput, setTagInput] = useState('');
  const [authorName, setAuthorName] = useState(initialValues.authorName);
  const [anonymous, setAnonymous] = useState(initialValues.anonymous);
  const [refs, setRefs] = useState<FormRefItem[]>(initialValues.refs);
  const [mainBundle, setMainBundle] = useState<CompressedMediaBundle | null>(null);
  const [compressing, setCompressing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const compressionLock = useRef(false);
  const mainInputRef = useRef<HTMLInputElement | null>(null);
  const refInputRef = useRef<HTMLInputElement | null>(null);
  const blobUrlsRef = useRef<Set<string>>(new Set());
  const lastPatchSeqRef = useRef<number>(0);
  const formVersionRef = useRef<number>(0);
  const unmountedRef = useRef<boolean>(false);

  const trackBlobUrl = (url: string) => {
    if (url.startsWith('blob:')) {
      blobUrlsRef.current.add(url);
    }
  };

  const revokeBlobUrl = (url: string | undefined) => {
    if (url && url.startsWith('blob:')) {
      URL.revokeObjectURL(url);
      blobUrlsRef.current.delete(url);
    }
  };

  const revokeAllBlobUrls = () => {
    for (const url of blobUrlsRef.current) {
      URL.revokeObjectURL(url);
    }
    blobUrlsRef.current.clear();
  };

  useEffect(() => {
    formVersionRef.current += 1;
    compressionLock.current = false;
    revokeAllBlobUrls();
    setTitle(initialValues.title);
    setCategory(initialValues.category);
    setPrompt(initialValues.prompt);
    setDescription(initialValues.description);
    setTags(initialValues.tags);
    setAuthorName(initialValues.authorName);
    setAnonymous(initialValues.anonymous);
    setRefs(initialValues.refs);
    setMainBundle(null);
    setCompressing(false);
    setError(null);
  }, [initialValues]);

  useEffect(() => {
    unmountedRef.current = false;
    return () => {
      unmountedRef.current = true;
      formVersionRef.current += 1;
      revokeAllBlobUrls();
    };
  }, []);

  useEffect(() => {
    if (!externalPatch || externalPatch.seq === lastPatchSeqRef.current) return;
    lastPatchSeqRef.current = externalPatch.seq;
    if (externalPatch.addTags && externalPatch.addTags.length > 0) {
      setTags((prev) =>
        normalizeTags([...prev, ...externalPatch.addTags!]).tags.slice(0, MAX_TAGS),
      );
    }
    if (externalPatch.category) {
      setCategory(externalPatch.category);
    }
    if (externalPatch.prompt !== undefined) {
      setPrompt(externalPatch.prompt);
    }
  }, [externalPatch]);

  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 4 } }));

  const detectedVars = useMemo(() => extractPromptVariables(prompt), [prompt]);
  const lintResult = useMemo(
    () => lintPromptDraft({ prompt, category, tags }),
    [prompt, category, tags],
  );

  const filteredSuggestions = useMemo(() => {
    const existingLower = new Set(tags.map((t) => t.toLowerCase()));
    const q = tagInput.trim().toLowerCase();
    return suggestedTagsPool
      .filter((t) => !existingLower.has(t.toLowerCase()))
      .filter((t) => (!q ? true : t.toLowerCase().includes(q)))
      .slice(0, 14);
  }, [suggestedTagsPool, tags, tagInput]);

  const handleMainFile = async (file: File | undefined) => {
    if (!file || compressionLock.current) return;
    compressionLock.current = true;
    const version = formVersionRef.current;
    setError(null);
    setCompressing(true);
    try {
      const bundle = await compressMainImage(file);
      if (unmountedRef.current || formVersionRef.current !== version) {
        if (bundle.previewUrl.startsWith('blob:')) {
          URL.revokeObjectURL(bundle.previewUrl);
        }
        return;
      }
      trackBlobUrl(bundle.previewUrl);
      setMainBundle((prev) => {
        if (prev) revokeBlobUrl(prev.previewUrl);
        return bundle;
      });
    } catch (err) {
      if (!unmountedRef.current && formVersionRef.current === version) {
        setError((err as Error).message);
      }
    } finally {
      if (!unmountedRef.current && formVersionRef.current === version) {
        compressionLock.current = false;
        setCompressing(false);
      }
    }
  };

  const handleRefFiles = async (fileList: FileList | null) => {
    if (!fileList || fileList.length === 0 || compressionLock.current) return;
    const version = formVersionRef.current;
    setError(null);
    const remaining = MAX_REFS - refs.length;
    if (remaining <= 0) {
      setError(`最多只能添加 ${MAX_REFS} 张参考图`);
      return;
    }
    compressionLock.current = true;
    const files = Array.from(fileList).slice(0, remaining);
    setCompressing(true);
    const createdUrls: string[] = [];
    try {
      const added: FormRefItem[] = [];
      for (const f of files) {
        const compressed = await compressRefImage(f);
        createdUrls.push(compressed.previewUrl);
        if (unmountedRef.current || formVersionRef.current !== version) {
          for (const url of createdUrls) {
            if (url.startsWith('blob:')) URL.revokeObjectURL(url);
          }
          return;
        }
        added.push({
          uid: `ref_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
          kind: 'new-image',
          file: compressed.file,
          previewUrl: compressed.previewUrl,
        });
      }
      for (const url of createdUrls) {
        trackBlobUrl(url);
      }
      setRefs((prev) => [...prev, ...added]);
    } catch (err) {
      for (const url of createdUrls) {
        if (url.startsWith('blob:')) URL.revokeObjectURL(url);
      }
      if (!unmountedRef.current && formVersionRef.current === version) {
        setError((err as Error).message);
      }
    } finally {
      if (!unmountedRef.current && formVersionRef.current === version) {
        compressionLock.current = false;
        setCompressing(false);
      }
    }
  };

  const addTag = (raw: string) => {
    const parts = raw
      .replace(/，/g, ',')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
    if (parts.length === 0) return;
    setTags((prev) => {
      const seen = new Set(prev.map((t) => t.toLowerCase()));
      const next = [...prev];
      for (const p of parts) {
        if (!seen.has(p.toLowerCase()) && next.length < 15) {
          seen.add(p.toLowerCase());
          next.push(p);
        }
      }
      return next;
    });
    setTagInput('');
  };

  const handleDragEnd = (event: DragEndEvent) => {
    const { active, over } = event;
    if (!over || active.id === over.id) return;
    setRefs((prev) => {
      const oldIdx = prev.findIndex((r) => r.uid === active.id);
      const newIdx = prev.findIndex((r) => r.uid === over.id);
      return arrayMove(prev, oldIdx, newIdx);
    });
  };

  const handleFormSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (compressionLock.current || submitting) return;
    setError(null);

    if (mode === 'submit' && !mainBundle) {
      setError('请先上传一张主图（支持 JPG / PNG / WebP / GIF）');
      return;
    }
    if (!title.trim()) {
      setError('请填写作品标题');
      return;
    }
    if (!prompt.trim()) {
      setError('请填写 Prompt 提示词');
      return;
    }

    const formData = new FormData();
    const refLayout: SubmitRefLayoutEntry[] = [];

    let newFileIdx = 0;
    for (const r of refs) {
      if (r.kind === 'placeholder') {
        refLayout.push({ kind: 'placeholder', label: r.label });
      } else if (r.kind === 'existing-image') {
        refLayout.push({ kind: 'existing-image', file: r.file });
      } else {
        const field = `ref_file_${newFileIdx++}`;
        formData.set(field, r.file);
        refLayout.push({ kind: 'new-image', field });
      }
    }

    const finalWidth = mainBundle?.width ?? initialValues.existingWidth ?? 1024;
    const finalHeight = mainBundle?.height ?? initialValues.existingHeight ?? 1024;

    formData.set(
      'payload',
      JSON.stringify({
        title: title.trim(),
        category,
        prompt: prompt.trim(),
        description: description.trim(),
        tags,
        authorName: anonymous ? '' : authorName.trim(),
        anonymous,
        mainWidth: finalWidth,
        mainHeight: finalHeight,
        refLayout,
      }),
    );

    if (mainBundle) {
      formData.set('main', mainBundle.mainFile);
      formData.set('thumb', mainBundle.thumbFile);
    }

    let bytes = 0;
    formData.forEach((field) => {
      if (field instanceof File) bytes += field.size;
    });
    if (bytes > MAX_TOTAL_UPLOAD_BYTES) {
      setError('主图、缩略图和参考图合计不能超过 4 MiB');
      return;
    }
    try {
      await onSubmit(formData);
    } catch (err) {
      setError((err as Error).message || '提交失败');
    }
  };

  const mainPreviewUrl = mainBundle?.previewUrl || initialValues.existingMainUrl || '';

  return (
    <form onSubmit={handleFormSubmit} className="space-y-7">
      {error && (
        <div className="rounded-xl border border-red-500/30 bg-red-500/10 px-4 py-3 text-sm text-red-600 dark:text-red-400">
          {error}
        </div>
      )}

      {/* Category capsule (faithful to screenshot_upload.png) */}
      <div className="flex items-center gap-4">
        <span className="text-xs font-semibold text-[var(--text-secondary)]">发布位置</span>
        <div className="segmented-control">
          {(['gallery', 'template'] as const).map((cat) => (
            <button
              key={cat}
              type="button"
              onClick={() => setCategory(cat)}
              className={`segmented-btn ${category === cat ? 'active' : ''}`}
            >
              {cat === 'gallery' ? '画廊' : '模板'}
            </button>
          ))}
        </div>
      </div>

      {/* Main Image Dropzone */}
      <div>
        <div className="flex items-center justify-between mb-2">
          <div className="flex items-center gap-2">
            <span className="text-sm font-semibold">主作品图</span>
            {mode === 'submit' && (
              <span className="rounded bg-red-500/12 px-1.5 py-0.5 text-[10px] font-semibold text-red-500">
                必填
              </span>
            )}
          </div>
          {mainBundle && (
            <span className="text-xs text-emerald-600 dark:text-emerald-400 font-medium">
              {formatBytes(mainBundle.originalBytes)} → {formatBytes(mainBundle.compressedBytes)} ({mainBundle.width}×{mainBundle.height})
            </span>
          )}
        </div>

        <div
          onDragOver={(e) => e.preventDefault()}
          onDrop={(e) => {
            e.preventDefault();
            void handleMainFile(e.dataTransfer.files[0]);
          }}
          onClick={() => { if (!compressionLock.current) mainInputRef.current?.click(); }}
          className="relative flex min-h-[280px] flex-col items-center justify-center rounded-2xl border-2 border-dashed border-[var(--border-subtle)] bg-[var(--sidebar-bg)] overflow-hidden cursor-pointer hover:border-[var(--accent-color)] transition-colors"
        >
          <input
            ref={mainInputRef}
            type="file"
            accept=".jpg,.jpeg,.png,.webp,.gif"
            className="hidden"
            onChange={(e) => {
              void handleMainFile(e.target.files?.[0]);
              e.target.value = '';
            }}
          />

          {mainPreviewUrl ? (
            <>
              <img
                src={mainPreviewUrl}
                alt="主图预览"
                className="max-h-80 w-full object-contain bg-black"
              />
              <span className="absolute top-3 right-3 rounded-full bg-black/55 backdrop-blur-md px-3.5 py-1 text-xs font-medium text-white">
                更换
              </span>
            </>
          ) : (
            <div className="p-8 text-center">
              <div className="mx-auto mb-4 flex h-16 w-16 items-center justify-center rounded-full bg-[var(--bg-color)] shadow-md text-[var(--accent-color)]">
                <UploadCloud className="h-8 w-8" />
              </div>
              <div className="text-base font-bold">
                {compressing ? '正在压缩并生成缩略图...' : '拖拽或点击上传'}
              </div>
              <p className="mt-1 text-xs text-[var(--text-secondary)]">
                支持 JPG、PNG、WebP、GIF，单次文件总量上限 4 MiB
              </p>
            </div>
          )}
        </div>
      </div>

      {/* Reference Images (optional, always available for multimodal prompts) */}
      <div className="space-y-2.5">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="flex items-center gap-2">
            <span className="text-sm font-semibold">参考图</span>
            <span className="rounded bg-[var(--btn-bg)] px-1.5 py-0.5 text-[10px] text-[var(--text-secondary)]">
              选填 · {refs.length}/{MAX_REFS}
            </span>
          </div>
          <div className="flex items-center gap-2">
            <button
              type="button"
              disabled={compressing || refs.length >= MAX_REFS}
              onClick={() => {
                if (compressionLock.current || refs.length >= MAX_REFS) return;
                setRefs((prev) => [
                  ...prev,
                  {
                    uid: `ph_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
                    kind: 'placeholder',
                    label: 'User',
                  },
                ]);
              }}
              className="inline-flex items-center gap-1.5 rounded-full bg-[var(--btn-bg)] px-3.5 py-1.5 text-xs font-medium text-[var(--text-primary)] hover:bg-[var(--btn-hover-bg)] cursor-pointer"
            >
              <UserRoundPlus className="h-3.5 w-3.5" />
              <span>插入变量</span>
            </button>
            <button
              type="button"
              disabled={compressing || refs.length >= MAX_REFS}
              onClick={() => refInputRef.current?.click()}
              className="inline-flex items-center gap-1.5 rounded-full bg-[var(--sidebar-bg)] border border-[var(--border-subtle)] px-3.5 py-1.5 text-xs font-semibold text-[var(--accent-color)] hover:border-[var(--accent-color)] cursor-pointer"
            >
              <ImagePlus className="h-3.5 w-3.5" />
              <span>添加图片</span>
            </button>
          </div>
        </div>

        <input
          ref={refInputRef}
          type="file"
          multiple
          accept=".jpg,.jpeg,.png,.webp,.gif"
          className="hidden"
          onChange={(e) => {
            void handleRefFiles(e.target.files);
            e.target.value = '';
          }}
        />

        <div
          onDragOver={(e) => e.preventDefault()}
          onDrop={(e) => {
            e.preventDefault();
            void handleRefFiles(e.dataTransfer.files);
          }}
          className="min-h-[112px] rounded-2xl bg-[var(--btn-bg)] p-3.5"
        >
          {refs.length === 0 ? (
            <div className="flex h-20 items-center justify-center text-center text-xs text-[var(--text-secondary)]">
              纯文字提示词可留空；如需参考图可直接拖入，支持拖拽排序
            </div>
          ) : (
            <DndContext
              sensors={sensors}
              collisionDetection={closestCenter}
              onDragEnd={handleDragEnd}
            >
              <SortableContext items={refs.map((r) => r.uid)} strategy={rectSortingStrategy}>
                <div className="flex flex-wrap gap-3">
                  {refs.map((item, idx) => (
                    <SortableRefCard
                      key={item.uid}
                      item={item}
                      index={idx}
                      onRemove={() => {
                        if (item.kind === 'new-image') {
                          revokeBlobUrl(item.previewUrl);
                        }
                        setRefs((prev) => prev.filter((x) => x.uid !== item.uid));
                      }}
                    />
                  ))}
                </div>
              </SortableContext>
            </DndContext>
          )}
        </div>
      </div>

      {/* Title & Author */}
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
        <div>
          <label className="block text-sm font-semibold mb-2">
            标题 <span className="ml-1 rounded bg-red-500/12 px-1.5 py-0.5 text-[10px] text-red-500">必填</span>
          </label>
          <input
            type="text"
            required
            maxLength={200}
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            placeholder="给作品起个名字..."
            className="w-full rounded-xl bg-[var(--btn-bg)] border border-transparent px-4 py-2.5 text-sm outline-none focus:bg-[var(--sidebar-bg)] focus:border-[var(--accent-color)] transition-all"
          />
        </div>

        <div>
          <div className="flex items-center justify-between mb-2">
            <label className="text-sm font-semibold">作者</label>
            <label className="inline-flex items-center gap-1.5 text-xs text-[var(--text-secondary)] cursor-pointer">
              <input
                type="checkbox"
                checked={anonymous}
                onChange={(e) => {
                  setAnonymous(e.target.checked);
                  if (e.target.checked) setAuthorName('');
                }}
                className="rounded accent-[#0071e3]"
              />
              <span>匿名</span>
            </label>
          </div>
          <input
            type="text"
            disabled={anonymous}
            maxLength={80}
            value={anonymous ? '' : authorName}
            onChange={(e) => setAuthorName(e.target.value)}
            placeholder={anonymous ? '匿名' : '留空则保持匿名'}
            className="w-full rounded-xl bg-[var(--btn-bg)] border border-transparent px-4 py-2.5 text-sm outline-none focus:bg-[var(--sidebar-bg)] focus:border-[var(--accent-color)] disabled:opacity-50 transition-all"
          />
          {mode === 'submit' && anonymous && (
            <p className="mt-1.5 text-[11px] text-[var(--text-secondary)]">
              画廊页面不显示署名；PR 与提交记录仍关联当前 GitHub 账号。
            </p>
          )}
        </div>
      </div>

      {/* Prompt */}
      <div>
        <div className="flex items-center justify-between mb-2">
          <label className="text-sm font-semibold">
            Prompt <span className="ml-1 rounded bg-red-500/12 px-1.5 py-0.5 text-[10px] text-red-500">必填</span>
          </label>
          <span className="text-xs text-[var(--text-secondary)]">
            支持 <code>{'{{变量名}}'}</code>
          </span>
        </div>
        <textarea
          required
          rows={5}
          value={prompt}
          onChange={(e) => setPrompt(e.target.value)}
          placeholder="输入提示词..."
          className="w-full rounded-xl bg-[var(--btn-bg)] border border-transparent p-3.5 font-mono text-sm leading-relaxed outline-none focus:bg-[var(--sidebar-bg)] focus:border-[var(--accent-color)] transition-all"
        />

        {detectedVars.length > 0 && (
          <div className="mt-2 flex flex-wrap items-center gap-1.5 text-xs">
            <Sparkles className="h-3.5 w-3.5 text-[var(--accent-color)]" />
            {detectedVars.map((v) => (
              <span key={v} className="prompt-var-highlight">
                {`{{${v}}}`}
              </span>
            ))}
          </div>
        )}
      </div>

      {/* Description */}
      <div>
        <label className="block text-sm font-semibold mb-2">备注</label>
        <textarea
          rows={2}
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          placeholder="关于这个作品的更多说明..."
          className="w-full rounded-xl bg-[var(--btn-bg)] border border-transparent p-3.5 text-sm outline-none focus:bg-[var(--sidebar-bg)] focus:border-[var(--accent-color)] transition-all"
        />
      </div>

      {/* Tags */}
      <div>
        <label className="block text-sm font-semibold mb-2">标签</label>
        <div className="flex flex-wrap items-center gap-2 rounded-xl bg-[var(--btn-bg)] border border-transparent p-2.5 focus-within:bg-[var(--sidebar-bg)] focus-within:border-[var(--accent-color)] transition-all">
          {tags.map((tag) => (
            <span
              key={tag}
              className="inline-flex items-center gap-1.5 rounded-full bg-[var(--sidebar-bg)] border border-[var(--border-subtle)] px-3 py-1 text-xs font-medium"
            >
              <span>{tag}</span>
              <button
                type="button"
                onClick={() => setTags((prev) => prev.filter((t) => t !== tag))}
                className="text-[var(--text-secondary)] hover:text-red-500 cursor-pointer"
              >
                <X className="h-3 w-3" />
              </button>
            </span>
          ))}
          <input
            type="text"
            value={tagInput}
            onChange={(e) => setTagInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.nativeEvent.isComposing || e.keyCode === 229) return;
              if (e.key === 'Enter' || e.key === ',') {
                e.preventDefault();
                addTag(tagInput);
              }
            }}
            onBlur={() => {
              if (tagInput.trim()) addTag(tagInput);
            }}
            placeholder="输入标签后回车..."
            className="flex-1 min-w-[140px] bg-transparent px-1.5 py-1 text-sm outline-none"
          />
        </div>

        {filteredSuggestions.length > 0 && (
          <div className="mt-2.5 flex flex-wrap gap-1.5">
            {filteredSuggestions.map((t) => (
              <button
                key={t}
                type="button"
                onClick={() => addTag(t)}
                className="mini-tag cursor-pointer"
              >
                + {t}
              </button>
            ))}
          </div>
        )}
      </div>

      {/* Lint Warnings */}
      {lintResult.warnings.length > 0 && (
        <div className="rounded-xl border border-amber-500/30 bg-amber-500/8 p-3.5 text-xs space-y-1.5">
          <div className="flex items-center justify-between">
            <span className="inline-flex items-center gap-1.5 font-semibold text-amber-700 dark:text-amber-400">
              <AlertTriangle className="h-3.5 w-3.5" />
              规范建议
            </span>
            {lintResult.normalizedTags.join(',') !== tags.join(',') && (
              <button
                type="button"
                onClick={() => setTags(lintResult.normalizedTags)}
                className="rounded-full bg-amber-500/20 px-2.5 py-0.5 font-semibold text-amber-800 dark:text-amber-300 hover:bg-amber-500/30 cursor-pointer"
              >
                一键规范标签
              </button>
            )}
          </div>
          <ul className="list-disc pl-5 space-y-0.5 text-[var(--text-secondary)]">
            {lintResult.warnings.map((w, i) => (
              <li key={i}>{w.message}</li>
            ))}
          </ul>
        </div>
      )}

      {/* Action bar */}
      <div className="flex items-center justify-end gap-3 pt-4 border-t border-[var(--border-subtle)]">
        {onCancel && (
          <button
            type="button"
            onClick={onCancel}
            className="rounded-full px-6 py-2.5 text-sm font-medium text-[var(--text-secondary)] hover:bg-[var(--btn-bg)] cursor-pointer"
          >
            取消
          </button>
        )}
        <button
          type="submit"
          disabled={submitting || compressing}
          className="rounded-full bg-[var(--accent-color)] px-8 py-2.5 text-sm font-semibold text-white shadow-md hover:opacity-92 disabled:opacity-50 transition-all cursor-pointer"
        >
          {submitting ? '提交中...' : submitLabel}
        </button>
      </div>
    </form>
  );
}
