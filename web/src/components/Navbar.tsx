import {
  Filter,
  Github,
  Grid2x2,
  Info,
  LogOut,
  Monitor,
  Moon,
  Plus,
  ShieldCheck,
  Sparkles,
  Sun,
  X,
} from 'lucide-react';
import { useState } from 'react';
import { Link, useLocation } from 'react-router-dom';
import { useAuth } from '../hooks/useAuth';
import { useTheme, type ThemeMode } from '../hooks/useTheme';

const THEME_CYCLE: Record<
  ThemeMode,
  { next: ThemeMode; label: string; nextLabel: string; Icon: typeof Sun }
> = {
  system: { next: 'light', label: '跟随系统', nextLabel: '浅色模式', Icon: Monitor },
  light: { next: 'dark', label: '浅色模式', nextLabel: '深色模式', Icon: Sun },
  dark: { next: 'system', label: '深色模式', nextLabel: '跟随系统', Icon: Moon },
};

export function Navbar({ onOpenMobileFilter }: { onOpenMobileFilter?: () => void }) {
  const { pathname } = useLocation();
  const { mode, setMode } = useTheme();
  const { user, workerApiUrl, login, logout } = useAuth();
  const [showWorkerHint, setShowWorkerHint] = useState(false);

  const currentTheme = THEME_CYCLE[mode];
  const ThemeIcon = currentTheme.Icon;

  const isGallery = pathname === '/' || pathname.startsWith('/item/');
  const isTemplates = pathname === '/templates' || pathname.startsWith('/templates/item/');
  const isUpload = pathname === '/upload';
  const isReview = pathname === '/review';
  const isAbout = pathname === '/about';

  const handleLoginClick = () => {
    if (!workerApiUrl) {
      setShowWorkerHint(true);
      return;
    }
    login(pathname === '/' ? '/upload' : pathname);
  };

  return (
    <>
      <header className="apple-navbar fixed top-0 left-0 right-0 z-40">
        <div className="flex h-full w-full items-center justify-between gap-2 px-4 sm:px-6">
          <nav className="flex items-center gap-1 overflow-x-auto py-1">
            <Link to="/" className={`nav-pill-link ${isGallery ? 'active' : ''}`}>
              <Grid2x2 className="h-4 w-4" />
              <span>画廊</span>
            </Link>
            <Link to="/templates" className={`nav-pill-link ${isTemplates ? 'active' : ''}`}>
              <Sparkles className="h-4 w-4" />
              <span>模板</span>
            </Link>
            {onOpenMobileFilter && (
              <button
                type="button"
                onClick={onOpenMobileFilter}
                className="nav-pill-link md:hidden cursor-pointer"
              >
                <Filter className="h-4 w-4" />
                <span>筛选</span>
              </button>
            )}
            <Link to="/upload" className={`nav-pill-link ${isUpload ? 'active' : ''}`}>
              <Plus className="h-4 w-4" />
              <span>上传</span>
            </Link>
            <Link to="/about" className={`nav-pill-link ${isAbout ? 'active' : ''}`}>
              <Info className="h-4 w-4" />
              <span>关于</span>
            </Link>
          </nav>

          <div className="flex items-center gap-2 shrink-0">
            {/* Single-icon 3-mode theme cycler (System -> Light -> Dark) */}
            <button
              type="button"
              onClick={() => setMode(currentTheme.next)}
              title={`主题：${currentTheme.label}（点击切换为${currentTheme.nextLabel}）`}
              aria-label={`当前${currentTheme.label}，点击切换为${currentTheme.nextLabel}`}
              className="inline-flex h-8 w-8 items-center justify-center rounded-full bg-[var(--btn-bg)] text-[var(--text-primary)] hover:bg-[var(--btn-hover-bg)] active:scale-95 transition-all cursor-pointer"
            >
              <ThemeIcon className="h-4 w-4" />
            </button>

            {user?.isAdmin && (
              <Link
                to="/review"
                title="审校台"
                className={`inline-flex h-8 w-8 items-center justify-center rounded-full transition-all ${
                  isReview
                    ? 'bg-[var(--text-primary)] text-[var(--bg-color)] shadow-sm'
                    : 'bg-[var(--btn-bg)] text-[var(--text-primary)] hover:bg-[var(--btn-hover-bg)]'
                }`}
              >
                <ShieldCheck className="h-4 w-4" />
              </Link>
            )}

            {user ? (
              <div className="flex items-center gap-2 rounded-full bg-[var(--btn-bg)] pl-1.5 pr-2.5 py-1">
                <img
                  src={user.avatarUrl}
                  alt={user.login}
                  className="h-6 w-6 rounded-full object-cover"
                />
                <span className="hidden sm:inline text-xs font-medium max-w-[96px] truncate">
                  {user.login}
                </span>
                <button
                  type="button"
                  onClick={logout}
                  title="退出登录"
                  className="text-[var(--text-secondary)] hover:text-red-500 transition-colors cursor-pointer"
                >
                  <LogOut className="h-3.5 w-3.5" />
                </button>
              </div>
            ) : (
              <button
                type="button"
                onClick={handleLoginClick}
                className="inline-flex h-8 items-center gap-1.5 rounded-full bg-[var(--text-primary)] px-3.5 text-xs font-semibold text-[var(--bg-color)] hover:opacity-90 transition-opacity cursor-pointer"
              >
                <Github className="h-3.5 w-3.5" />
                <span>登录</span>
              </button>
            )}
          </div>
        </div>
      </header>

      {/* Graceful guide modal when Worker API is not configured yet */}
      {showWorkerHint && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 backdrop-blur-xs p-4"
          onClick={() => setShowWorkerHint(false)}
        >
          <div
            className="animate-modal relative w-full max-w-md rounded-2xl p-6 shadow-2xl border border-[var(--border-subtle)]"
            style={{ backgroundColor: 'var(--modal-bg)' }}
            onClick={(e) => e.stopPropagation()}
          >
            <button
              type="button"
              onClick={() => setShowWorkerHint(false)}
              aria-label="关闭"
              className="absolute top-4 right-4 rounded-full p-1 text-[var(--text-secondary)] hover:bg-[var(--btn-bg)] cursor-pointer"
            >
              <X className="h-4 w-4" />
            </button>

            <div className="flex items-center gap-2.5 mb-3">
              <div className="flex h-9 w-9 items-center justify-center rounded-full bg-[var(--btn-bg)]">
                <Github className="h-5 w-5" />
              </div>
              <h3 className="text-base font-bold">启用 GitHub 登录</h3>
            </div>

            <p className="text-xs leading-relaxed text-[var(--text-secondary)]">
              尚未配置 Cloudflare Worker，完成后即可使用 GitHub 登录与在线提交 PR：
            </p>

            <ol className="mt-3 space-y-2 text-xs text-[var(--text-primary)] list-decimal pl-4">
              <li>
                按 <code className="rounded bg-[var(--btn-bg)] px-1 py-0.5">worker/README.md</code> 部署 Worker（本地调试可运行 <code className="rounded bg-[var(--btn-bg)] px-1 py-0.5">pnpm worker:dev</code>）；
              </li>
              <li>
                将地址写入 <code className="rounded bg-[var(--btn-bg)] px-1 py-0.5">site.config.json</code> 的 <code className="rounded bg-[var(--btn-bg)] px-1 py-0.5">workerApiUrl</code>（或环境变量 <code className="rounded bg-[var(--btn-bg)] px-1 py-0.5">VITE_WORKER_API_URL</code>）。
              </li>
            </ol>

            <div className="mt-5 flex justify-end">
              <button
                type="button"
                onClick={() => setShowWorkerHint(false)}
                className="rounded-full bg-[var(--text-primary)] px-5 py-1.5 text-xs font-semibold text-[var(--bg-color)] hover:opacity-90 cursor-pointer"
              >
                知道了
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
