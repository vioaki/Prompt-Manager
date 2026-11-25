import {
  Check,
  Clipboard,
  CloudDownload,
  Code2,
  EyeOff,
  FileJson,
  Github,
  Images,
  Plus,
  Save,
  ShieldCheck,
  Users,
} from 'lucide-react';
import { useEffect, useState } from 'react';
import { Navbar } from '../components/Navbar';
import { useAuth } from '../hooks/useAuth';
import { useCatalog } from '../hooks/useCatalog';
import { updateSiteConfig } from '../utils/apiClient';

function CopyEndpointRow({
  method,
  url,
}: {
  method: 'GET';
  url: string;
}) {
  const [copied, setCopied] = useState(false);

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(url);
      setCopied(true);
      setTimeout(() => setCopied(false), 1600);
    } catch {
      // ignore clipboard permission errors
    }
  };

  return (
    <div className="input-glass px-3.5 py-2.5 flex items-center gap-3">
      <span className="rounded-md bg-[var(--text-secondary)]/20 px-2 py-0.5 text-[11px] font-bold text-[var(--text-primary)] shrink-0">
        {method}
      </span>
      <code className="flex-1 min-w-0 font-mono text-xs sm:text-[13px] font-medium break-all text-[var(--text-primary)]">
        {url}
      </code>
      <button
        type="button"
        onClick={handleCopy}
        title="复制接口地址"
        className="shrink-0 p-1.5 rounded-lg text-[var(--text-secondary)] hover:text-[var(--accent-color)] hover:bg-[var(--btn-bg)] transition-colors cursor-pointer"
      >
        {copied ? <Check className="h-4 w-4 text-emerald-500" /> : <Clipboard className="h-4 w-4" />}
      </button>
    </div>
  );
}

const RESPONSE_EXAMPLE = `{
  "code": 200,
  "message": "success",
  "meta": {
    "page": 1,
    "per_page": 500,
    "total_items": 663,
    "total_pages": 2,
    "has_next": true,
    "next_url": "https://<worker>/api/gallery?page=2&per_page=500&sort=date",
    "server_timestamp": 1764000000
  },
  "data": [
    {
      "id": "20251205-item-0650",
      "title": "拍立得",
      "author": "39c5bb",
      "type": "img2img",
      "category": "template",
      "media_type": "image",
      "file_path": "https://vioaki.github.io/Prompt-Manager-Pages/media/20251205-item-0650/main.webp",
      "thumbnail_path": "https://vioaki.github.io/Prompt-Manager-Pages/media/20251205-item-0650/thumb.webp",
      "prompt": "据提供的个人图片创建偶像风格的拍立得照片，人物名字是 {{userText}}",
      "description": "输入角色图片和角色名",
      "tags": ["banana", "复古", "肖像"],
      "refs": [
        {
          "id": 1,
          "file_path": "{{userText}}",
          "is_placeholder": true,
          "position": 0
        }
      ],
      "heat_score": 0,
      "created_at": "2025-12-05T15:23:22Z"
    }
  ]
}`;

export function AboutPage() {
  const { catalog, contributors, showSensitive, setShowSensitive, patchSiteConfigLocally } =
    useCatalog();
  const { user, token, workerApiUrl } = useAuth();

  const [copiedJson, setCopiedJson] = useState(false);
  const [adminSensitiveTags, setAdminSensitiveTags] = useState<string[]>([]);
  const [newSensitiveInput, setNewSensitiveInput] = useState('');
  const [savingConfig, setSavingConfig] = useState(false);
  const [configMsg, setConfigMsg] = useState<string | null>(null);

  useEffect(() => {
    if (!catalog) return;
    setAdminSensitiveTags(catalog.site.sensitiveTags);
  }, [catalog]);

  const toggleAdminSensitiveTag = (tag: string) => {
    setAdminSensitiveTags((prev) =>
      prev.includes(tag) ? prev.filter((t) => t !== tag) : [...prev, tag],
    );
  };

  const handleSaveAdminConfig = async () => {
    if (!token || !workerApiUrl) return;
    setSavingConfig(true);
    setConfigMsg(null);
    try {
      const res = await updateSiteConfig(workerApiUrl, token, {
        sensitiveTags: adminSensitiveTags,
      });
      patchSiteConfigLocally(res.site);
      setConfigMsg('已更新 site.config.json，约 1 分钟后生效。');
    } catch (err) {
      setConfigMsg(`保存失败: ${(err as Error).message}`);
    } finally {
      setSavingConfig(false);
    }
  };

  const allKnownTags = Array.from(
    new Set([...(catalog?.tags.map((t) => t.name) ?? []), ...adminSensitiveTags]),
  );

  const workerBase = (workerApiUrl || 'https://<your-worker>.workers.dev').replace(/\/+$/, '');
  const pagesBase = `${window.location.origin}${window.location.pathname
    .replace(/\/index\.html$/i, '')
    .replace(/\/+$/, '')}`;

  return (
    <div className="min-h-screen pt-16">
      <Navbar />

      <main className="mx-auto max-w-[820px] px-4 sm:px-6 py-10 space-y-6">
        {/* Hero (faithful to original about.html) */}
        <section className="text-center pb-2">
          <div
            className="mx-auto mb-4 inline-flex h-20 w-20 items-center justify-center rounded-[22px] shadow-sm"
            style={{ background: 'linear-gradient(135deg, #e0eafc 0%, #cfdef3 100%)' }}
          >
            <Images className="h-9 w-9 text-[#0071e3] opacity-85" />
          </div>
          <h1 className="text-2xl font-bold tracking-tight">
            {catalog?.site.title || 'Prompt Manager'}
          </h1>
          <p className="mt-1 text-sm text-[var(--text-secondary)]">
            {catalog?.site.subtitle || 'Community AI Art Prompt & Workflow Library'}
          </p>

          <div className="mt-4 flex flex-wrap justify-center gap-2.5">
            {catalog?.site.repo && (
              <a
                href={`https://github.com/${catalog.site.repo}`}
                target="_blank"
                rel="noreferrer"
                className="inline-flex items-center gap-2 rounded-full bg-[var(--text-primary)] px-5 py-2 text-xs font-semibold text-[var(--bg-color)] hover:opacity-90 transition-opacity"
              >
                <Github className="h-4 w-4" />
                <span>GitHub Repository</span>
              </a>
            )}
            {catalog?.site.engineRepo && (
              <a
                href={`https://github.com/${catalog.site.engineRepo}/tree/${catalog.site.engineRef}`}
                target="_blank"
                rel="noreferrer"
                className="inline-flex items-center gap-1.5 rounded-full bg-[var(--btn-bg)] px-4 py-2 text-xs font-semibold text-[var(--text-primary)] hover:bg-[var(--btn-hover-bg)] transition-colors"
              >
                <Code2 className="h-4 w-4" />
                <span>Engine Source</span>
              </a>
            )}
          </div>
        </section>

        {/* Visitor Sensitive Toggle (concise, no hardcoded tag list) */}
        {(catalog?.site.allowPublicSensitiveToggle || user?.isAdmin) && (
          <section className="glass-panel p-5 sm:p-6 flex items-center justify-between gap-4">
            <div className="flex items-center gap-3.5">
              <div className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full bg-amber-500/12 text-amber-500">
                <EyeOff className="h-5 w-5" />
              </div>
              <div>
                <h2 className="text-[0.95rem] font-bold">敏感内容展示 (NSFW)</h2>
                <p className="text-xs text-[var(--text-secondary)] mt-0.5">
                  开启后，画廊将显示被标记为敏感的作品。
                </p>
              </div>
            </div>

            <button
              type="button"
              role="switch"
              aria-checked={showSensitive}
              onClick={() => setShowSensitive(!showSensitive)}
              className={`relative inline-flex h-7 w-12 shrink-0 items-center rounded-full transition-colors cursor-pointer ${
                showSensitive ? 'bg-[#ff3b30]' : 'bg-black/15 dark:bg-white/20'
              }`}
            >
              <span
                className={`inline-block h-5 w-5 transform rounded-full bg-white shadow-sm transition-transform ${
                  showSensitive ? 'translate-x-6' : 'translate-x-1'
                }`}
              />
            </button>
          </section>
        )}

        {/* Contributors (concise) */}
        {contributors.length > 0 && (
          <section className="glass-panel p-5 sm:p-6 space-y-3.5">
            <div className="flex items-center gap-2">
              <Users className="h-4 w-4 text-[var(--text-secondary)]" />
              <h2 className="text-[0.95rem] font-bold">贡献者</h2>
              <span className="rounded-full bg-[var(--btn-bg)] px-2 py-0.5 text-[11px] font-medium text-[var(--text-secondary)]">
                {contributors.length}
              </span>
            </div>
            <div className="flex flex-wrap gap-2.5">
              {contributors.map((c) => (
                <a
                  key={c.login}
                  href={c.profileUrl}
                  target="_blank"
                  rel="noreferrer"
                  className="inline-flex items-center gap-2 rounded-full bg-[var(--btn-bg)] pr-3 pl-1 py-1 text-xs font-medium hover:bg-[var(--btn-hover-bg)] transition-colors"
                >
                  <img
                    src={c.avatarUrl}
                    alt={c.login}
                    className="h-6 w-6 rounded-full object-cover"
                  />
                  <span>{c.login}</span>
                </a>
              ))}
            </div>
          </section>
        )}

        {/* Detailed Developer API Documentation */}
        <section className="glass-panel p-5 sm:p-7 space-y-6">
          <div>
            <h2 className="text-lg font-bold">开发者接口 (API)</h2>
            <p className="mt-1 text-xs sm:text-sm text-[var(--text-secondary)] leading-relaxed">
              提供纯静态全量 JSON 文件供 GitHub Pages 直连读取，同时通过 Worker 提供兼容旧版协议的 RESTful 只读接口（支持分页、筛选与 ETag 缓存）。
            </p>
          </div>

          {/* 1. Static Pages JSON */}
          <div className="space-y-3 pb-6 border-b border-[var(--border-subtle)]">
            <div className="flex items-center gap-2.5">
              <div className="flex h-8 w-8 items-center justify-center rounded-full bg-emerald-500/12 text-emerald-600 dark:text-emerald-400">
                <FileJson className="h-4 w-4" />
              </div>
              <h3 className="text-sm font-bold text-emerald-600 dark:text-emerald-400">
                纯静态全量 JSON (GitHub Pages 直连)
              </h3>
            </div>
            <p className="text-xs text-[var(--text-secondary)]">
              无需经过 Worker，适合客户端一次性拉取全量数据并在本地过滤（结构为 <code>{'{ schemaVersion, generatedAt, total, items }'}</code>）。
            </p>
            <div className="space-y-2.5">
              <CopyEndpointRow method="GET" url={`${pagesBase}/api/gallery.json`} />
              <CopyEndpointRow method="GET" url={`${pagesBase}/api/templates.json`} />
            </div>
          </div>

          {/* 2. Dynamic Worker Read API (Legacy Compatible) */}
          <div className="space-y-4">
            <div className="flex flex-wrap items-center gap-2.5">
              <div className="flex h-8 w-8 items-center justify-center rounded-full bg-[#0071e3]/12 text-[var(--accent-color)]">
                <CloudDownload className="h-4 w-4" />
              </div>
              <h3 className="text-sm font-bold text-[var(--accent-color)]">
                动态筛选读取 (Worker API · 兼容旧版)
              </h3>
              {!workerApiUrl && (
                <span className="rounded-full bg-[var(--btn-bg)] px-2.5 py-0.5 text-[11px] font-medium text-[var(--text-secondary)]">
                  需配置 workerApiUrl
                </span>
              )}
            </div>

            <div className="space-y-3">
              <div>
                <div className="text-[11px] font-bold uppercase tracking-wider text-[var(--text-secondary)] mb-1.5">
                  1. 画廊数据 (Gallery List)
                </div>
                <CopyEndpointRow method="GET" url={`${workerBase}/api/gallery`} />
              </div>

              <div>
                <div className="text-[11px] font-bold uppercase tracking-wider text-[var(--text-secondary)] mb-1.5">
                  2. 模板数据 (Templates List)
                </div>
                <CopyEndpointRow method="GET" url={`${workerBase}/api/templates`} />
              </div>
            </div>

            {/* Query Params Table */}
            <div className="pt-2">
              <div className="text-[11px] font-bold uppercase tracking-wider text-[var(--text-secondary)] mb-2">
                通用筛选参数 (Query Parameters)
              </div>
              <div className="input-glass overflow-x-auto">
                <table className="w-full text-left text-xs">
                  <thead>
                    <tr className="border-b border-[var(--border-subtle)] bg-[var(--btn-bg)]">
                      <th className="py-2.5 pl-3.5 pr-3 font-semibold w-24">参数名</th>
                      <th className="py-2.5 px-3 font-semibold w-16">类型</th>
                      <th className="py-2.5 px-3 font-semibold w-16">默认值</th>
                      <th className="py-2.5 pl-3 pr-3.5 font-semibold">描述与示例</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-[var(--border-subtle)] text-[var(--text-secondary)]">
                    <tr>
                      <td className="py-2.5 pl-3.5 pr-3 font-mono font-semibold text-[var(--text-primary)]">per_page</td>
                      <td className="py-2.5 px-3">Int</td>
                      <td className="py-2.5 px-3">500</td>
                      <td className="py-2.5 pl-3 pr-3.5">
                        每页数量。传 <code className="px-1 rounded bg-[var(--btn-bg)] text-[var(--text-primary)]">-1</code> 开启无限模式（获取全部，上限 10000）。
                      </td>
                    </tr>
                    <tr>
                      <td className="py-2.5 pl-3.5 pr-3 font-mono font-semibold text-[var(--text-primary)]">page</td>
                      <td className="py-2.5 px-3">Int</td>
                      <td className="py-2.5 px-3">1</td>
                      <td className="py-2.5 pl-3 pr-3.5">
                        分页页码，配合返回的 <code>meta.next_url</code> 可自动翻页。
                      </td>
                    </tr>
                    <tr>
                      <td className="py-2.5 pl-3.5 pr-3 font-mono font-semibold text-[var(--text-primary)]">q</td>
                      <td className="py-2.5 px-3">String</td>
                      <td className="py-2.5 px-3">-</td>
                      <td className="py-2.5 pl-3 pr-3.5">
                        关键词搜索（匹配标题、Prompt、作者），例：<code>?q=cyberpunk</code>
                      </td>
                    </tr>
                    <tr>
                      <td className="py-2.5 pl-3.5 pr-3 font-mono font-semibold text-[var(--text-primary)]">tag</td>
                      <td className="py-2.5 px-3">String</td>
                      <td className="py-2.5 px-3">-</td>
                      <td className="py-2.5 pl-3 pr-3.5">
                        精确标签筛选，例：<code>?tag=二次元</code>
                      </td>
                    </tr>
                    <tr>
                      <td className="py-2.5 pl-3.5 pr-3 font-mono font-semibold text-[var(--text-primary)]">sort</td>
                      <td className="py-2.5 px-3">String</td>
                      <td className="py-2.5 px-3">date</td>
                      <td className="py-2.5 pl-3 pr-3.5">
                        排序方式：<code>date</code>（最新）、<code>random</code>（随机）；传 <code>hot</code> 自动回退按最新排序。
                      </td>
                    </tr>
                  </tbody>
                </table>
              </div>
            </div>

            {/* Response Example */}
            <div className="pt-2">
              <div className="text-[11px] font-bold uppercase tracking-wider text-[var(--text-secondary)] mb-2">
                响应结构 (Response Example)
              </div>
              <div className="relative rounded-xl bg-[#161618] border border-white/10 p-4 text-xs">
                <button
                  type="button"
                  onClick={async () => {
                    try {
                      await navigator.clipboard.writeText(RESPONSE_EXAMPLE);
                      setCopiedJson(true);
                      setTimeout(() => setCopiedJson(false), 1800);
                    } catch {
                      // ignore clipboard permission errors
                    }
                  }}
                  className="absolute top-3 right-3 rounded-lg bg-white/10 px-2.5 py-1 text-[11px] font-medium text-white/85 hover:bg-white/20 transition-colors cursor-pointer"
                >
                  {copiedJson ? 'Copied!' : 'Copy JSON'}
                </button>
                <pre className="m-0 overflow-x-auto max-h-80 font-mono text-[12px] leading-relaxed text-[#a5d6ff]">
                  {RESPONSE_EXAMPLE}
                </pre>
              </div>
            </div>

            {/* ETag Caching */}
            <div className="input-glass p-4 space-y-2.5 text-xs text-[var(--text-secondary)]">
              <div className="font-bold text-[var(--text-primary)]">ETag / 304 缓存校验</div>
              <p className="leading-relaxed">
                非随机排序请求自动返回响应头 <code className="text-[var(--accent-color)]">ETag</code>。客户端后续轮询携带{' '}
                <code className="text-[var(--accent-color)]">If-None-Match</code>，数据未变动时直接返回{' '}
                <strong className="text-emerald-600 dark:text-emerald-400">304 Not Modified</strong>（空响应体），节省带宽。
              </p>
            </div>
          </div>
        </section>

        {/* Admin Config Panel */}
        {user?.isAdmin && (
          <section className="glass-panel p-5 sm:p-6 space-y-5 border-[var(--accent-color)]/30">
            <div className="flex items-center justify-between gap-2">
              <div className="flex items-center gap-2">
                <ShieldCheck className="h-5 w-5 text-[var(--accent-color)]" />
                <h2 className="text-sm font-bold">敏感标签管理</h2>
              </div>
              <button
                type="button"
                disabled={savingConfig}
                onClick={handleSaveAdminConfig}
                className="inline-flex items-center gap-1.5 rounded-full bg-[var(--accent-color)] px-4 py-1.5 text-xs font-semibold text-white hover:opacity-90 disabled:opacity-50 cursor-pointer"
              >
                <Save className="h-3.5 w-3.5" />
                <span>{savingConfig ? '保存中...' : '保存'}</span>
              </button>
            </div>

            {configMsg && (
              <div className="rounded-xl bg-[#0071e3]/10 px-3.5 py-2 text-xs text-[var(--accent-color)]">
                {configMsg}
              </div>
            )}

            <div className="space-y-2">
              <div className="text-xs font-semibold text-[var(--text-secondary)]">敏感标签</div>
              <div className="flex flex-wrap gap-1.5">
                {allKnownTags.map((tag) => {
                  const checked = adminSensitiveTags.includes(tag);
                  return (
                    <button
                      key={tag}
                      type="button"
                      onClick={() => toggleAdminSensitiveTag(tag)}
                      className={`rounded-full px-3 py-1 text-xs font-medium transition-colors cursor-pointer ${
                        checked
                          ? 'bg-red-500/18 text-red-600 dark:text-red-300 ring-1 ring-red-500/40'
                          : 'bg-[var(--btn-bg)] text-[var(--text-secondary)] hover:text-[var(--text-primary)]'
                      }`}
                    >
                      {tag}
                    </button>
                  );
                })}
              </div>

              <div className="flex gap-2 pt-1">
                <input
                  type="text"
                  value={newSensitiveInput}
                  onChange={(e) => setNewSensitiveInput(e.target.value)}
                  placeholder="新增敏感标签..."
                  className="flex-1 rounded-xl bg-[var(--btn-bg)] px-3 py-1.5 text-xs outline-none"
                />
                <button
                  type="button"
                  onClick={() => {
                    const v = newSensitiveInput.trim();
                    if (v && !adminSensitiveTags.includes(v)) {
                      setAdminSensitiveTags((prev) => [...prev, v]);
                    }
                    setNewSensitiveInput('');
                  }}
                  className="inline-flex items-center gap-1 rounded-xl bg-[var(--btn-bg)] px-3 py-1.5 text-xs font-semibold hover:bg-[var(--btn-hover-bg)] cursor-pointer"
                >
                  <Plus className="h-3.5 w-3.5" />
                  <span>添加</span>
                </button>
              </div>
            </div>
          </section>
        )}
      </main>
    </div>
  );
}
