import { ArrowUp, Check, Copy, Images } from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import type { CatalogItem } from '@prompt-pages/shared';

interface MasonryGridProps {
  items: CatalogItem[];
  onSelect: (item: CatalogItem) => void;
  onSelectTag: (tag: string) => void;
}

const PAGE_STEP = 48;

function getColumnCount(width: number): number {
  if (width >= 1536) return 6;
  if (width >= 1280) return 5;
  if (width >= 1024) return 4;
  if (width >= 768) return 3;
  if (width >= 640) return 2;
  return 1;
}

function MasonryCard({
  item,
  onSelect,
  onSelectTag,
}: {
  item: CatalogItem;
  onSelect: (item: CatalogItem) => void;
  onSelectTag: (tag: string) => void;
}) {
  const [loaded, setLoaded] = useState(false);
  const [copied, setCopied] = useState(false);
  const imgRef = useRef<HTMLImageElement | null>(null);

  useEffect(() => {
    if (imgRef.current?.complete) {
      setLoaded(true);
    }
  }, [item.media.thumbUrl]);

  const isGif = item.media.mimeType === 'image/gif';

  const handleQuickCopy = async (e: React.MouseEvent) => {
    e.stopPropagation();
    try {
      await navigator.clipboard.writeText(item.prompt);
      setCopied(true);
      setTimeout(() => setCopied(false), 1400);
    } catch {
      // ignore clipboard errors
    }
  };

  return (
    <article className="gallery-item group">
      <div
        role="button"
        tabIndex={0}
        onClick={() => onSelect(item)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            onSelect(item);
          }
        }}
        style={{
          aspectRatio: `${item.media.width} / ${item.media.height}`,
        }}
        className="art-frame w-full"
      >
        <img
          ref={imgRef}
          src={item.media.thumbUrl}
          alt={item.title}
          loading="lazy"
          decoding="async"
          onLoad={() => setLoaded(true)}
          onError={() => setLoaded(true)}
          className={`art-frame-img ${loaded ? 'opacity-100' : 'opacity-0'}`}
        />

        <div className="art-frame-scrim" />

        {isGif && (
          <span className="pointer-events-none absolute top-2 right-2 rounded bg-black/35 backdrop-blur-md px-1.5 py-0.5 text-[10px] font-normal text-white/95">
            GIF
          </span>
        )}

        {/* Subtle hover-only quick copy button */}
        <button
          type="button"
          onClick={handleQuickCopy}
          title={copied ? '已复制 Prompt' : '快速复制 Prompt'}
          aria-label="快速复制 Prompt"
          className={`absolute bottom-2.5 right-2.5 inline-flex h-8 w-8 items-center justify-center rounded-full backdrop-blur-md ring-1 ring-white/15 transition-all duration-300 ease-out cursor-pointer ${
            copied
              ? 'opacity-100 translate-y-0 bg-emerald-500/90 text-white'
              : 'opacity-0 translate-y-1.5 group-hover:opacity-100 group-hover:translate-y-0 bg-black/45 hover:bg-black/70 text-white'
          }`}
        >
          {copied ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />}
        </button>
      </div>

      <div className="mt-3 px-1">
        <h3
          onClick={() => onSelect(item)}
          className="text-[0.95rem] font-semibold leading-snug tracking-[-0.01em] truncate cursor-pointer text-[var(--text-primary)]"
        >
          {item.title}
        </h3>

        <div className="mt-1.5 flex items-start justify-between gap-2">
          {item.author.name ? (
            <span className="text-[0.8rem] text-[var(--text-secondary)] truncate shrink-0 max-w-[42%] pt-0.5">
              {item.author.name}
            </span>
          ) : null}

          <div
            className={`flex flex-wrap gap-1.5 min-w-0 flex-1 ${
              item.author.name ? 'justify-end' : 'justify-start'
            }`}
          >
            {item.tags.slice(0, 3).map((tag) => (
              <button
                key={tag}
                type="button"
                onClick={(e) => {
                  e.stopPropagation();
                  onSelectTag(tag);
                }}
                className="mini-tag cursor-pointer"
              >
                {tag}
              </button>
            ))}
            {item.tags.length > 3 && (
              <span className="text-[0.72rem] text-[var(--text-secondary)] px-0.5 self-center">
                +{item.tags.length - 3}
              </span>
            )}
          </div>
        </div>
      </div>
    </article>
  );
}

export function MasonryGrid({ items, onSelect, onSelectTag }: MasonryGridProps) {
  const [visibleCount, setVisibleCount] = useState(PAGE_STEP);
  const [colCount, setColCount] = useState(() =>
    typeof window !== 'undefined' ? getColumnCount(window.innerWidth) : 5,
  );
  const [showBackTop, setShowBackTop] = useState(false);
  const sentinelRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    setVisibleCount(PAGE_STEP);
  }, [items]);

  useEffect(() => {
    const onResize = () => setColCount(getColumnCount(window.innerWidth));
    window.addEventListener('resize', onResize, { passive: true });
    return () => window.removeEventListener('resize', onResize);
  }, []);

  useEffect(() => {
    const onScroll = () => setShowBackTop(window.scrollY > 560);
    window.addEventListener('scroll', onScroll, { passive: true });
    return () => window.removeEventListener('scroll', onScroll);
  }, []);

  useEffect(() => {
    const el = sentinelRef.current;
    if (!el || visibleCount >= items.length) return;
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries[0]?.isIntersecting) {
          setVisibleCount((prev) => Math.min(items.length, prev + PAGE_STEP));
        }
      },
      { rootMargin: '700px' },
    );
    observer.observe(el);
    return () => observer.disconnect();
  }, [items.length, visibleCount]);

  // Balanced shortest-column distribution:
  // Preserves chronological left-to-right reading order at the top
  // and prevents reflow jumps when infinite scroll appends new batches.
  const columns = useMemo(() => {
    const visibleItems = items.slice(0, visibleCount);
    const cols: CatalogItem[][] = Array.from({ length: colCount }, () => []);
    const heights = new Array<number>(colCount).fill(0);

    for (const item of visibleItems) {
      let shortest = 0;
      for (let i = 1; i < colCount; i++) {
        if (heights[i] < heights[shortest]) shortest = i;
      }
      cols[shortest].push(item);
      const ratio = item.media.height / Math.max(1, item.media.width);
      heights[shortest] += Math.min(2.4, Math.max(0.45, ratio)) + 0.34;
    }

    return cols;
  }, [items, visibleCount, colCount]);

  if (items.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center py-24 text-[var(--text-secondary)]">
        <Images className="h-12 w-12 opacity-25 mb-3" />
        <p className="text-sm">No art pieces found.</p>
      </div>
    );
  }

  return (
    <div>
      <div
        className="grid gap-6 items-start"
        style={{ gridTemplateColumns: `repeat(${colCount}, minmax(0, 1fr))` }}
      >
        {columns.map((colItems, colIdx) => (
          <div key={colIdx} className="flex flex-col gap-7 min-w-0">
            {colItems.map((item) => (
              <MasonryCard
                key={item.id}
                item={item}
                onSelect={onSelect}
                onSelectTag={onSelectTag}
              />
            ))}
          </div>
        ))}
      </div>

      {visibleCount < items.length && (
        <div ref={sentinelRef} className="flex justify-center py-10">
          <button
            type="button"
            onClick={() => setVisibleCount((prev) => Math.min(items.length, prev + PAGE_STEP))}
            className="rounded-full px-5 py-2 text-xs font-medium bg-[var(--btn-bg)] text-[var(--text-secondary)] hover:text-[var(--text-primary)] transition-colors cursor-pointer"
          >
            加载更多 ({visibleCount} / {items.length})
          </button>
        </div>
      )}

      {showBackTop && (
        <button
          type="button"
          onClick={() => window.scrollTo({ top: 0, behavior: 'smooth' })}
          aria-label="回到顶部"
          title="回到顶部"
          style={{ right: 'calc(26px + var(--scrollbar-comp, 0px))' }}
          className="fixed bottom-[26px] z-35 flex h-[44px] w-[44px] items-center justify-center rounded-full shadow-lg border border-[var(--border-subtle)] bg-[var(--sidebar-bg)] text-[var(--text-primary)] hover:scale-108 transition-transform cursor-pointer"
        >
          <ArrowUp className="h-4 w-4" />
        </button>
      )}
    </div>
  );
}
