import { Clock, Search, Shuffle, X } from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate, useParams, useSearchParams } from 'react-router-dom';
import type { CatalogItem, PromptCategory } from '@prompt-pages/shared';
import { DetailModal } from '../components/DetailModal';
import { MasonryGrid } from '../components/MasonryGrid';
import { Navbar } from '../components/Navbar';
import { PromptForm, type PromptFormInitialValues } from '../components/PromptForm';
import { Sidebar } from '../components/Sidebar';
import { useAuth } from '../hooks/useAuth';
import { useCatalog } from '../hooks/useCatalog';
import { deletePublishedItem, updatePublishedItem } from '../utils/apiClient';

interface GalleryPageProps {
  categoryFilter?: PromptCategory;
}

export function GalleryPage({ categoryFilter }: GalleryPageProps) {
  const { id: routeItemId } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  const {
    catalog,
    loading,
    error,
    showSensitive,
    isItemSensitive,
    updateItemLocally,
    removeItemLocally,
  } = useCatalog();
  const { user, token, workerApiUrl } = useAuth();

  const [mobileFilterOpen, setMobileFilterOpen] = useState(false);
  const [sort, setSort] = useState<'date' | 'random'>('date');
  const [randomSeed, setRandomSeed] = useState(0);
  const [editingItem, setEditingItem] = useState<CatalogItem | null>(null);
  const [savingEdit, setSavingEdit] = useState(false);
  const [toast, setToast] = useState<string | null>(null);
  const searchInputRef = useRef<HTMLInputElement | null>(null);

  const activeTag = searchParams.get('tag') || '';
  const searchQuery = searchParams.get('q') || '';

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (routeItemId || editingItem) return;
      const target = e.target as HTMLElement | null;
      const inInput =
        target &&
        (target.tagName === 'INPUT' ||
          target.tagName === 'TEXTAREA' ||
          target.isContentEditable);
      if (e.key === '/' && !inInput && !e.metaKey && !e.ctrlKey && !e.altKey) {
        e.preventDefault();
        searchInputRef.current?.focus();
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [routeItemId, editingItem]);

  const updateQuery = (patch: { tag?: string; q?: string }) => {
    const next = new URLSearchParams(searchParams);
    if (patch.tag !== undefined) {
      if (patch.tag) next.set('tag', patch.tag);
      else next.delete('tag');
    }
    if (patch.q !== undefined) {
      if (patch.q) next.set('q', patch.q);
      else next.delete('q');
    }
    setSearchParams(next, { replace: true });
  };

  // Preserve legacy web semantics:
  // - Gallery home shows all items (gallery + template)
  // - Templates page shows only category === 'template'
  const scopedItems = useMemo(() => {
    if (!catalog) return [];
    return catalog.items.filter((item) => {
      if (categoryFilter && item.category !== categoryFilter) return false;
      if (!showSensitive && isItemSensitive(item)) return false;
      return true;
    });
  }, [catalog, categoryFilter, showSensitive, isItemSensitive]);

  const sidebarTags = useMemo(() => {
    if (!catalog) return [];
    const counts = new Map<string, number>();
    for (const item of scopedItems) {
      for (const t of item.tags) {
        counts.set(t, (counts.get(t) ?? 0) + 1);
      }
    }
    const sensitiveLowerSet = new Set(
      catalog.site.sensitiveTags.map((t) => t.trim().toLowerCase()),
    );
    return Array.from(counts.entries())
      .filter(([name]) => showSensitive || !sensitiveLowerSet.has(name.trim().toLowerCase()))
      .map(([name, count]) => ({
        name,
        count,
        isSensitive: sensitiveLowerSet.has(name.trim().toLowerCase()),
      }))
      .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name, 'zh-CN'));
  }, [catalog, scopedItems, showSensitive]);

  const filteredItems = useMemo(() => {
    const q = searchQuery.trim().toLowerCase();
    const list = scopedItems.filter((item) => {
      if (activeTag && !item.tags.includes(activeTag)) return false;
      if (q) {
        const hay = `${item.title}\n${item.prompt}\n${item.description}\n${item.author.name}\n${item.tags.join(' ')}`.toLowerCase();
        if (!hay.includes(q)) return false;
      }
      return true;
    });

    if (sort === 'random') {
      const copy = [...list];
      let seed = randomSeed || 1;
      for (let i = copy.length - 1; i > 0; i--) {
        seed = (seed * 1664525 + 1013904223) >>> 0;
        const j = seed % (i + 1);
        [copy[i], copy[j]] = [copy[j], copy[i]];
      }
      return copy;
    }

    return list;
  }, [scopedItems, activeTag, searchQuery, sort, randomSeed]);

  const selectedItem = useMemo(() => {
    if (!routeItemId || !catalog) return null;
    return catalog.items.find((i) => i.id === routeItemId) ?? null;
  }, [routeItemId, catalog]);

  const selectedIndex = useMemo(() => {
    if (!selectedItem) return -1;
    return filteredItems.findIndex((i) => i.id === selectedItem.id);
  }, [filteredItems, selectedItem]);

  const prevItem = selectedIndex > 0 ? filteredItems[selectedIndex - 1] : null;
  const nextItem =
    selectedIndex >= 0 && selectedIndex < filteredItems.length - 1
      ? filteredItems[selectedIndex + 1]
      : null;

  const editingInitialValues = useMemo<PromptFormInitialValues | null>(() => {
    if (!editingItem) return null;
    return {
      title: editingItem.title,
      category: editingItem.category,
      prompt: editingItem.prompt,
      description: editingItem.description,
      tags: editingItem.tags,
      authorName: editingItem.author.name,
      anonymous: !editingItem.author.name,
      existingMainUrl: editingItem.media.mainUrl,
      existingWidth: editingItem.media.width,
      existingHeight: editingItem.media.height,
      refs: editingItem.refs.map((r, idx) =>
        r.kind === 'placeholder'
          ? { uid: `ex_ph_${idx}`, kind: 'placeholder', label: r.label }
          : {
              uid: `ex_img_${idx}`,
              kind: 'existing-image',
              file: r.url.split('/').pop() || `ref-${idx}.webp`,
              previewUrl: r.url,
            },
      ),
    };
  }, [editingItem]);

  const handleOpenItem = (item: CatalogItem, replace = false) => {
    const queryStr = searchParams.toString();
    const prefix = categoryFilter === 'template' ? '/templates/item' : '/item';
    navigate(`${prefix}/${item.id}${queryStr ? `?${queryStr}` : ''}`, { replace });
  };

  const handleCloseItem = () => {
    const queryStr = searchParams.toString();
    const base = categoryFilter === 'template' ? '/templates' : '/';
    navigate(`${base}${queryStr ? `?${queryStr}` : ''}`, { replace: true });
  };

  const handleAdminDelete = async (item: CatalogItem) => {
    if (!token || !workerApiUrl) throw new Error('未登录管理员账号');
    await deletePublishedItem(workerApiUrl, token, item.id, item.sourceRevision);
    removeItemLocally(item.id);
    setToast(`已删除「${item.title}」，稍后自动部署生效。`);
    setTimeout(() => setToast(null), 5000);
  };

  const handleAdminSaveEdit = async (formData: FormData) => {
    if (!editingItem || !token || !workerApiUrl) throw new Error('未登录管理员账号');
    setSavingEdit(true);
    try {
      const res = await updatePublishedItem(workerApiUrl, token, editingItem.id, formData, editingItem.sourceRevision);
      updateItemLocally(editingItem.id, res.meta, res.commitSha);
      setEditingItem(null);
      setToast('修改已提交到 main 分支，稍后自动部署生效。');
      setTimeout(() => setToast(null), 5000);
    } finally {
      setSavingEdit(false);
    }
  };

  return (
    <div className="min-h-screen pt-16">
      <Navbar onOpenMobileFilter={() => setMobileFilterOpen(true)} />

      <div className="flex w-full min-h-[calc(100vh-4rem)]">
        <Sidebar
          tags={sidebarTags}
          activeTag={activeTag}
          onSelectTag={(t) => updateQuery({ tag: t })}
          mobileOpen={mobileFilterOpen}
          onCloseMobile={() => setMobileFilterOpen(false)}
        />

        <main className="flex-1 min-w-0 px-5 sm:px-10 pt-8 pb-16 overflow-x-hidden">
          {toast && (
            <div className="mb-6 rounded-2xl border border-emerald-500/25 bg-emerald-500/10 px-4 py-3 text-sm text-emerald-700 dark:text-emerald-300 flex items-center justify-between">
              <span>{toast}</span>
              <button type="button" onClick={() => setToast(null)} className="cursor-pointer">
                <X className="h-4 w-4" />
              </button>
            </div>
          )}

          {/* Header (faithful to original screenshot_gallery.png) */}
          <div className="flex flex-wrap items-end justify-between gap-4 mb-8">
            <div>
              <h1 className="art-heading">
                {activeTag || (categoryFilter === 'template' ? 'Templates' : 'Collection')}
              </h1>
              {!loading && (
                <p className="mt-1 text-sm text-[var(--text-secondary)]">
                  {filteredItems.length} pieces of art
                </p>
              )}
            </div>

            <div className="w-full sm:w-auto flex flex-col items-end gap-3">
              <div className="relative w-full sm:w-[340px]">
                <Search className="pointer-events-none absolute left-3.5 top-1/2 -translate-y-1/2 h-4 w-4 text-[var(--text-secondary)] opacity-70" />
                <input
                  ref={searchInputRef}
                  type="text"
                  value={searchQuery}
                  onChange={(e) => updateQuery({ q: e.target.value })}
                  onKeyDown={(e) => {
                    if (e.key === 'Escape') {
                      if (searchQuery) updateQuery({ q: '' });
                      searchInputRef.current?.blur();
                    }
                  }}
                  placeholder="Search..."
                  className="w-full rounded-full py-2 pl-10 pr-9 text-sm shadow-sm outline-none transition-all border border-[var(--border-subtle)] focus:border-[var(--accent-color)]"
                  style={{
                    backgroundColor: 'var(--sidebar-bg)',
                    color: 'var(--text-primary)',
                  }}
                />
                {searchQuery ? (
                  <button
                    type="button"
                    onClick={() => updateQuery({ q: '' })}
                    className="absolute right-3 top-1/2 -translate-y-1/2 text-[var(--text-secondary)] hover:text-[var(--text-primary)] cursor-pointer"
                  >
                    <X className="h-3.5 w-3.5" />
                  </button>
                ) : (
                  <kbd className="pointer-events-none hidden sm:inline-flex absolute right-3 top-1/2 -translate-y-1/2 h-5 min-w-[20px] items-center justify-center rounded border border-[var(--border-subtle)] bg-[var(--btn-bg)] px-1 font-mono text-[10px] text-[var(--text-secondary)] opacity-70">
                    /
                  </kbd>
                )}
              </div>

              <div className="segmented-control shadow-xs">
                <button
                  type="button"
                  onClick={() => setSort('date')}
                  className={`segmented-btn ${sort === 'date' ? 'active' : ''}`}
                >
                  <Clock className="h-3.5 w-3.5" />
                  <span>最新</span>
                </button>
                <button
                  type="button"
                  onClick={() => {
                    setSort('random');
                    setRandomSeed(Date.now());
                  }}
                  className={`segmented-btn ${sort === 'random' ? 'active' : ''}`}
                >
                  <Shuffle className="h-3.5 w-3.5" />
                  <span>随机</span>
                </button>
              </div>
            </div>
          </div>

          {error ? (
            <div className="rounded-2xl border border-red-500/30 bg-red-500/10 p-6 text-center text-sm text-red-600 dark:text-red-400">
              {error}
            </div>
          ) : loading ? (
            <div className="columns-1 sm:columns-2 md:columns-3 xl:columns-5 2xl:columns-6 gap-6">
              {Array.from({ length: 12 }).map((_, i) => (
                <div
                  key={i}
                  className="break-inside-avoid mb-7 rounded-2xl animate-pulse"
                  style={{
                    backgroundColor: 'var(--placeholder-bg)',
                    height: `${200 + (i % 4) * 55}px`,
                  }}
                />
              ))}
            </div>
          ) : (
            <MasonryGrid
              items={filteredItems}
              onSelect={handleOpenItem}
              onSelectTag={(t) => updateQuery({ tag: t })}
            />
          )}
        </main>
      </div>

      {/* Detail Modal */}
      {selectedItem && (
        <DetailModal
          item={selectedItem}
          onClose={handleCloseItem}
          onSelectTag={(t) => updateQuery({ tag: t })}
          onPrev={prevItem ? () => handleOpenItem(prevItem, true) : undefined}
          onNext={nextItem ? () => handleOpenItem(nextItem, true) : undefined}
          onAdminEdit={user?.isAdmin ? (item) => setEditingItem(item) : undefined}
          onAdminDelete={user?.isAdmin ? handleAdminDelete : undefined}
        />
      )}

      {/* Admin Edit Modal */}
      {editingItem && editingInitialValues && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/55 backdrop-blur-xs p-3 sm:p-6"
          onClick={() => setEditingItem(null)}
        >
          <div
            className="animate-modal w-full max-w-3xl max-h-[90vh] overflow-y-auto rounded-3xl p-6 sm:p-8 shadow-2xl"
            style={{ backgroundColor: 'var(--modal-bg)' }}
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center justify-between mb-6">
              <h2 className="text-xl font-bold">编辑作品</h2>
              <button
                type="button"
                onClick={() => setEditingItem(null)}
                className="rounded-full p-1.5 text-[var(--text-secondary)] hover:bg-[var(--btn-bg)] cursor-pointer"
              >
                <X className="h-5 w-5" />
              </button>
            </div>
            <PromptForm
              mode="edit"
              initialValues={editingInitialValues}
              suggestedTagsPool={catalog?.tags.map((t) => t.name) ?? []}
              submitLabel="保存更改"
              submitting={savingEdit}
              onSubmit={handleAdminSaveEdit}
              onCancel={() => setEditingItem(null)}
            />
          </div>
        </div>
      )}
    </div>
  );
}
