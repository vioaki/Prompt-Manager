import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react';
import type { CatalogIndex, CatalogItem, Contributor, PromptMeta, SiteConfig } from '@prompt-pages/shared';

interface CatalogContextValue {
  catalog: CatalogIndex | null;
  contributors: Contributor[];
  loading: boolean;
  error: string | null;
  showSensitive: boolean;
  setShowSensitive: (next: boolean) => void;
  sensitiveTagSet: Set<string>;
  isItemSensitive: (item: CatalogItem) => boolean;
  patchSiteConfigLocally: (site: SiteConfig) => void;
  updateItemLocally: (id: string, meta: PromptMeta, sourceRevision: string) => void;
  removeItemLocally: (id: string) => void;
  reload: () => Promise<void>;
}

const CatalogContext = createContext<CatalogContextValue | null>(null);
const SENSITIVE_STORAGE_KEY = 'pm_show_sensitive';

export function CatalogProvider({ children }: { children: ReactNode }) {
  const [catalog, setCatalog] = useState<CatalogIndex | null>(null);
  const [contributors, setContributors] = useState<Contributor[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [showSensitive, setShowSensitiveState] = useState<boolean>(() => {
    try {
      return localStorage.getItem(SENSITIVE_STORAGE_KEY) === '1';
    } catch {
      return false;
    }
  });

  const reload = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [indexResp, contribResp] = await Promise.all([
        fetch('data/index.json'),
        fetch('data/contributors.json').catch(() => null),
      ]);
      if (!indexResp.ok) {
        throw new Error(`加载画廊数据失败 (${indexResp.status})`);
      }
      const indexData = (await indexResp.json()) as CatalogIndex;
      setCatalog(indexData);
      document.title = indexData.site.title || 'Prompt Manager';

      if (contribResp && contribResp.ok) {
        const contribData = (await contribResp.json()) as { contributors?: Contributor[] };
        setContributors(contribData.contributors || []);
      }
    } catch (err) {
      setError((err as Error).message || '加载失败');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void reload();
  }, [reload]);

  const setShowSensitive = useCallback((next: boolean) => {
    setShowSensitiveState(next);
    try {
      localStorage.setItem(SENSITIVE_STORAGE_KEY, next ? '1' : '0');
    } catch {
      // ignore
    }
  }, []);

  const sensitiveTagSet = useMemo(
    () => new Set(catalog?.site.sensitiveTags ?? []),
    [catalog?.site.sensitiveTags],
  );

  const sensitiveTagLowerSet = useMemo(() => {
    const set = new Set<string>();
    for (const tag of catalog?.site.sensitiveTags ?? []) {
      set.add(tag.trim().toLowerCase());
    }
    return set;
  }, [catalog?.site.sensitiveTags]);

  const isItemSensitive = useCallback(
    (item: CatalogItem) => item.tags.some((t) => sensitiveTagLowerSet.has(t.trim().toLowerCase())),
    [sensitiveTagLowerSet],
  );

  const patchSiteConfigLocally = useCallback((site: SiteConfig) => {
    setCatalog((prev) => {
      if (!prev) return prev;
      const sSet = new Set(site.sensitiveTags);
      return {
        ...prev,
        site,
        tags: prev.tags.map((t) => ({ ...t, isSensitive: sSet.has(t.name) })),
      };
    });
  }, []);

  const updateItemLocally = useCallback((id: string, meta: PromptMeta, sourceRevision: string) => {
    setCatalog((prev) => {
      if (!prev) return prev;
      const items = prev.items.map((item) => {
        if (item.id !== id) return item;
        return {
          ...item,
          sourceRevision,
          title: meta.title,
          category: meta.category,
          prompt: meta.prompt,
          description: meta.description,
          tags: meta.tags,
          author: meta.author,
          media: {
            mainUrl: `media/${meta.id}/${meta.media.main}`,
            thumbUrl: `media/${meta.id}/${meta.media.thumb}`,
            width: meta.media.width,
            height: meta.media.height,
            mimeType: meta.media.mimeType,
          },
          refs: meta.refs.map((r) =>
            r.kind === 'placeholder'
              ? { kind: 'placeholder' as const, label: r.label }
              : { kind: 'image' as const, url: `media/${meta.id}/${r.file}` },
          ),
        };
      });

      const counts = new Map<string, number>();
      for (const item of items) {
        for (const t of item.tags) {
          counts.set(t, (counts.get(t) ?? 0) + 1);
        }
      }
      const sSet = new Set(prev.site.sensitiveTags);
      const tags = Array.from(counts.entries())
        .map(([name, count]) => ({ name, count, isSensitive: sSet.has(name) }))
        .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name, 'zh-CN'));

      return { ...prev, items, tags };
    });
  }, []);

  const removeItemLocally = useCallback((id: string) => {
    setCatalog((prev) => {
      if (!prev) return prev;
      return {
        ...prev,
        items: prev.items.filter((i) => i.id !== id),
      };
    });
  }, []);

  return (
    <CatalogContext.Provider
      value={{
        catalog,
        contributors,
        loading,
        error,
        showSensitive,
        setShowSensitive,
        sensitiveTagSet,
        isItemSensitive,
        patchSiteConfigLocally,
        updateItemLocally,
        removeItemLocally,
        reload,
      }}
    >
      {children}
    </CatalogContext.Provider>
  );
}

export function useCatalog() {
  const ctx = useContext(CatalogContext);
  if (!ctx) throw new Error('useCatalog must be used inside CatalogProvider');
  return ctx;
}
