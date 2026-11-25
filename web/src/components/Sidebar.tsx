import { Grid2x2, Hash, X } from 'lucide-react';
import type { TagStat } from '@prompt-pages/shared';

interface SidebarProps {
  tags: TagStat[];
  activeTag: string;
  onSelectTag: (tag: string) => void;
  mobileOpen: boolean;
  onCloseMobile: () => void;
}

export function Sidebar({
  tags,
  activeTag,
  onSelectTag,
  mobileOpen,
  onCloseMobile,
}: SidebarProps) {
  const renderList = () => (
    <div className="flex flex-col h-full">
      <div className="px-3.5 mb-6 mt-2">
        <div
          className="text-[1.25rem] font-bold leading-snug tracking-wide"
          style={{ fontFamily: 'Georgia, "Times New Roman", serif', fontStyle: 'italic' }}
        >
          Prompt
          <br />
          Manager
        </div>
      </div>

      <div className="nav-category px-3.5 mb-2">Library</div>
      <button
        type="button"
        onClick={() => {
          onSelectTag('');
          onCloseMobile();
        }}
        className={`nav-item-apple ${!activeTag ? 'active' : ''}`}
      >
        <Grid2x2 className="h-3.5 w-3.5 mr-3 shrink-0" />
        <span>All Photos</span>
      </button>

      <div className="nav-category px-3.5 mt-6 mb-2 flex items-center justify-between">
        <span>Tags</span>
        <span className="rounded-full bg-[var(--btn-bg)] px-2 py-0.5 text-[10px] font-semibold">
          {tags.length}
        </span>
      </div>

      <div className="relative flex-1 min-h-0">
        <div className="sidebar-scroll h-full overflow-y-auto pb-12 space-y-0.5">
          {tags.map((tag) => {
            const isActive = activeTag === tag.name;
            return (
              <button
                key={tag.name}
                type="button"
                onClick={() => {
                  onSelectTag(isActive ? '' : tag.name);
                  onCloseMobile();
                }}
                className={`nav-item-apple ${isActive ? 'active' : ''}`}
              >
                <Hash className="h-3.5 w-3.5 mr-3 opacity-45 shrink-0" />
                <span className="truncate">{tag.name}</span>
              </button>
            );
          })}
        </div>
        <div
          className="pointer-events-none absolute bottom-0 left-0 right-0 h-10"
          style={{
            background: 'linear-gradient(to top, var(--sidebar-bg), transparent)',
          }}
        />
      </div>
    </div>
  );

  return (
    <>
      <aside className="hidden md:block w-[240px] shrink-0 sidebar-apple">
        <div className="sticky top-16 h-[calc(100vh-4rem)] px-4 py-6">{renderList()}</div>
      </aside>

      {mobileOpen && (
        <div className="fixed inset-0 z-50 md:hidden flex">
          <div className="fixed inset-0 bg-black/45 backdrop-blur-xs" onClick={onCloseMobile} />
          <div className="relative z-10 w-72 max-w-[82vw] h-full bg-[var(--sidebar-bg)] px-4 py-6 shadow-2xl">
            <button
              type="button"
              onClick={onCloseMobile}
              aria-label="关闭筛选"
              className="absolute top-4 right-4 rounded-full p-1.5 text-[var(--text-secondary)] hover:bg-[var(--btn-bg)] cursor-pointer"
            >
              <X className="h-5 w-5" />
            </button>
            {renderList()}
          </div>
        </div>
      )}
    </>
  );
}
