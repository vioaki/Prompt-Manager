import {
  Check,
  Clipboard,
  Pencil,
  RotateCcw,
  Trash2,
  UserRound,
  X,
} from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import {
  extractPromptVariables,
  renderPromptWithVars,
  splitPromptSegments,
  type CatalogItem,
} from '@prompt-pages/shared';
import { useAuth } from '../hooks/useAuth';

interface DetailModalProps {
  item: CatalogItem;
  onClose: () => void;
  onSelectTag: (tag: string) => void;
  onPrev?: () => void;
  onNext?: () => void;
  onAdminEdit?: (item: CatalogItem) => void;
  onAdminDelete?: (item: CatalogItem) => Promise<void>;
}

export function DetailModal({
  item,
  onClose,
  onSelectTag,
  onPrev,
  onNext,
  onAdminEdit,
  onAdminDelete,
}: DetailModalProps) {
  const { user } = useAuth();
  const [varValues, setVarValues] = useState<Record<string, string>>({});
  const [copiedPrompt, setCopiedPrompt] = useState(false);
  const [lightboxUrl, setLightboxUrl] = useState<string | null>(null);
  const [deleting, setDeleting] = useState(false);

  const segments = useMemo(() => splitPromptSegments(item.prompt), [item.prompt]);
  const variables = useMemo(() => extractPromptVariables(item.prompt), [item.prompt]);

  useEffect(() => {
    setVarValues({});
    setCopiedPrompt(false);
  }, [item.id]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        if (lightboxUrl) setLightboxUrl(null);
        else onClose();
        return;
      }
      if (lightboxUrl) return;
      const target = e.target as HTMLElement | null;
      if (
        target &&
        (target.tagName === 'INPUT' ||
          target.tagName === 'TEXTAREA' ||
          target.isContentEditable)
      ) {
        return;
      }
      if (e.key === 'ArrowLeft' && onPrev) {
        e.preventDefault();
        onPrev();
      } else if (e.key === 'ArrowRight' && onNext) {
        e.preventDefault();
        onNext();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('keydown', onKey);
    };
  }, [lightboxUrl, onClose, onPrev, onNext]);

  // Lock background scroll without causing horizontal layout shift
  useEffect(() => {
    const html = document.documentElement;
    const scrollbarWidth = window.innerWidth - html.clientWidth;
    const prevOverflow = html.style.overflow;
    const prevPaddingRight = html.style.paddingRight;
    const prevComp = html.style.getPropertyValue('--scrollbar-comp');

    html.style.overflow = 'hidden';
    if (scrollbarWidth > 0) {
      html.style.paddingRight = `${scrollbarWidth}px`;
      html.style.setProperty('--scrollbar-comp', `${scrollbarWidth}px`);
    }

    return () => {
      html.style.overflow = prevOverflow;
      html.style.paddingRight = prevPaddingRight;
      if (prevComp) html.style.setProperty('--scrollbar-comp', prevComp);
      else html.style.removeProperty('--scrollbar-comp');
    };
  }, []);

  const handleCopyPrompt = async () => {
    const finalPrompt = renderPromptWithVars(item.prompt, varValues);
    try {
      await navigator.clipboard.writeText(finalPrompt);
      setCopiedPrompt(true);
      setTimeout(() => setCopiedPrompt(false), 1800);
    } catch {
      // ignore clipboard permission errors
    }
  };

  const handleDelete = async () => {
    if (!onAdminDelete) return;
    if (!window.confirm('确定永久删除该作品吗？')) return;
    setDeleting(true);
    try {
      await onAdminDelete(item);
      onClose();
    } catch (err) {
      alert(`删除失败: ${(err as Error).message}`);
    } finally {
      setDeleting(false);
    }
  };

  let placeholderCount = 0;

  return (
    <>
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/55 backdrop-blur-xs p-2 sm:p-5"
      onClick={onClose}
    >
      <div
        className="animate-modal relative flex flex-col lg:flex-row w-full max-w-[1140px] lg:h-[85vh] max-h-[92vh] overflow-hidden rounded-[20px] shadow-2xl"
        style={{ backgroundColor: 'var(--modal-bg)' }}
        onClick={(e) => e.stopPropagation()}
      >
        {/* Left: Artwork stage (8/12 width, faithful to original modal) */}
        <div className="relative flex items-center justify-center bg-black lg:w-[66%] min-h-[260px] max-h-[50vh] lg:max-h-none lg:h-full overflow-hidden">
          <button
            type="button"
            onClick={onClose}
            aria-label="关闭"
            className="absolute top-4 right-4 z-10 inline-flex h-8 w-8 items-center justify-center rounded-full bg-black/45 backdrop-blur-md ring-1 ring-white/15 text-white/85 hover:bg-black/70 hover:text-white transition-colors cursor-pointer"
          >
            <X className="h-4 w-4" />
          </button>

          <img
            key={item.id}
            src={item.media.mainUrl}
            alt={item.title}
            onClick={() => setLightboxUrl(item.media.mainUrl)}
            className="max-h-[95%] max-w-[95%] object-contain cursor-zoom-in"
          />
        </div>

        {/* Right: Sidebar panel (4/12 width) */}
        <div
          className="flex flex-col lg:w-[34%] lg:h-full overflow-hidden border-t lg:border-t-0 lg:border-l border-[var(--border-subtle)]"
          style={{ backgroundColor: 'var(--modal-bg)' }}
        >
          <div className="flex-1 overflow-y-auto p-6 space-y-5">
            {/* Title & Author */}
            <div>
              <h2 className="text-xl font-bold leading-snug text-[var(--text-primary)]">
                {item.title}
              </h2>
              {(item.author.name || item.author.github) && (
                <div className="mt-1 text-xs text-[var(--text-secondary)]">
                  {item.author.github ? (
                    <a
                      href={`https://github.com/${item.author.github}`}
                      target="_blank"
                      rel="noreferrer"
                      className="hover:text-[var(--accent-color)] transition-colors"
                    >
                      by {item.author.name || item.author.github}
                    </a>
                  ) : (
                    <span>by {item.author.name}</span>
                  )}
                </div>
              )}
            </div>

            {/* Tags */}
            {item.tags.length > 0 && (
              <div className="flex flex-wrap gap-1.5">
                {item.tags.map((tag) => (
                  <button
                    key={tag}
                    type="button"
                    onClick={() => {
                      onSelectTag(tag);
                      onClose();
                    }}
                    className="mini-tag rounded-full px-3 py-1 cursor-pointer"
                  >
                    {tag}
                  </button>
                ))}
              </div>
            )}

            {/* Description */}
            {item.description && (
              <div>
                <div className="text-[11px] font-bold uppercase tracking-wider text-[var(--text-secondary)] mb-2">
                  Info &amp; Usage
                </div>
                <div
                  className="rounded-xl p-3 text-sm leading-relaxed whitespace-pre-wrap break-words"
                  style={{ backgroundColor: 'var(--btn-bg)', color: 'var(--text-primary)' }}
                >
                  {item.description}
                </div>
              </div>
            )}

            {/* Reference Images */}
            {item.refs.length > 0 && (
              <div>
                <div className="text-[11px] font-bold uppercase tracking-wider text-[var(--text-secondary)] mb-2">
                  参考图
                </div>
                <div className="flex gap-3 overflow-x-auto pb-1">
                  {item.refs.map((ref, idx) => {
                    const isPh = ref.kind === 'placeholder';
                    if (isPh) placeholderCount += 1;
                    const caption = isPh ? `变量 ${placeholderCount}` : `图 ${idx + 1}`;
                    return (
                      <div key={idx} className="flex flex-col items-center shrink-0">
                        <div className="h-14 w-14 rounded-xl overflow-hidden bg-[var(--btn-bg)] border border-[var(--border-subtle)] flex items-center justify-center">
                          {ref.kind === 'placeholder' ? (
                            <div className="flex h-full w-full items-center justify-center border border-dashed border-[var(--text-secondary)]/35 rounded-xl text-[var(--text-secondary)]">
                              <UserRound className="h-5 w-5 opacity-65" />
                            </div>
                          ) : (
                            <img
                              src={ref.url}
                              alt={caption}
                              onClick={() => setLightboxUrl(ref.url)}
                              className="h-full w-full object-cover cursor-zoom-in"
                            />
                          )}
                        </div>
                        <span className="mt-1 text-[11px] text-[var(--text-secondary)]">
                          {caption}
                        </span>
                      </div>
                    );
                  })}
                </div>
              </div>
            )}

            {/* Prompt */}
            <div>
              <div className="flex items-center justify-between mb-2 px-0.5">
                <span className="text-[11px] font-bold uppercase tracking-wider text-[var(--text-secondary)]">
                  Prompt
                </span>
                <button
                  type="button"
                  onClick={handleCopyPrompt}
                  className={`inline-flex items-center gap-1 text-xs font-semibold transition-colors cursor-pointer ${
                    copiedPrompt
                      ? 'text-emerald-500'
                      : 'text-[var(--text-secondary)] hover:text-[var(--accent-color)]'
                  }`}
                >
                  {copiedPrompt ? (
                    <Check className="h-3.5 w-3.5" />
                  ) : (
                    <Clipboard className="h-3.5 w-3.5" />
                  )}
                  <span>{copiedPrompt ? 'Copied' : 'Copy'}</span>
                </button>
              </div>

              <div className="prompt-box-apple p-3.5">
                <code className="block font-mono text-[0.87rem] leading-relaxed whitespace-pre-wrap break-words max-h-[210px] overflow-y-auto text-[var(--text-primary)]">
                  {segments.map((seg, idx) => {
                    if (seg.type === 'text') return <span key={idx}>{seg.value}</span>;
                    const filled = varValues[seg.name];
                    return (
                      <span key={idx} className="prompt-var-highlight">
                        {filled || seg.raw}
                      </span>
                    );
                  })}
                </code>
              </div>

              {/* Variable Inputs (Original clean single-line rows, no loud box) */}
              {variables.length > 0 && (
                <div className="mt-5">
                  <div className="flex items-center justify-between mb-2 px-0.5">
                    <span className="text-[11px] font-bold uppercase tracking-wider text-[var(--text-secondary)]">
                      变量替换
                    </span>
                    {Object.values(varValues).some((v) => v.length > 0) && (
                      <button
                        type="button"
                        onClick={() => setVarValues({})}
                        className="inline-flex items-center gap-1 text-[11px] font-medium text-[var(--text-secondary)] hover:text-[var(--accent-color)] transition-colors cursor-pointer"
                      >
                        <RotateCcw className="h-3 w-3" />
                        <span>重置</span>
                      </button>
                    )}
                  </div>
                  <div className="flex flex-col gap-2">
                    {variables.map((varName) => (
                      <div key={varName} className="var-input-row">
                        <span className="var-label" title={varName}>
                          {varName}
                        </span>
                        <input
                          type="text"
                          value={varValues[varName] || ''}
                          onChange={(e) =>
                            setVarValues((prev) => ({ ...prev, [varName]: e.target.value }))
                          }
                          placeholder="Value"
                          autoComplete="off"
                          className="var-input"
                        />
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </div>
          </div>

          {/* Admin Actions Bar (faithful to original bottom bar) */}
          {user?.isAdmin && (onAdminEdit || onAdminDelete) && (
            <div className="mt-auto shrink-0 border-t border-[var(--border-subtle)] bg-black/[0.015] dark:bg-white/[0.02] py-3">
              <div className="flex items-center justify-center gap-3">
                {onAdminEdit && (
                  <button
                    type="button"
                    onClick={() => onAdminEdit(item)}
                    title="编辑作品"
                    className="btn-circle-icon"
                  >
                    <Pencil className="h-4 w-4" />
                  </button>
                )}
                {onAdminDelete && (
                  <button
                    type="button"
                    disabled={deleting}
                    onClick={handleDelete}
                    title="永久删除"
                    className="btn-circle-icon danger disabled:opacity-50"
                  >
                    <Trash2 className="h-4 w-4" />
                  </button>
                )}
              </div>
            </div>
          )}
        </div>
      </div>

    </div>

    {/* Fullscreen Lightbox (sibling portal layer so clicking never closes the detail modal) */}
    {lightboxUrl && (
      <div
        className="fixed inset-0 z-60 flex items-center justify-center bg-black/92 p-4 cursor-zoom-out"
        onClick={(e) => {
          e.stopPropagation();
          setLightboxUrl(null);
        }}
      >
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            setLightboxUrl(null);
          }}
          aria-label="退出放大预览"
          className="absolute top-5 right-5 inline-flex h-9 w-9 items-center justify-center rounded-full bg-white/15 text-white/90 hover:bg-white/25 transition-colors cursor-pointer"
        >
          <X className="h-5 w-5" />
        </button>
        <img
          src={lightboxUrl}
          alt="放大预览"
          onClick={(e) => {
            e.stopPropagation();
            setLightboxUrl(null);
          }}
          className="max-h-[95vh] max-w-[95vw] object-contain cursor-zoom-out"
        />
      </div>
    )}
    </>
  );
}
