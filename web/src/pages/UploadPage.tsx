import { CheckCircle2, ExternalLink, GitPullRequest, Github } from 'lucide-react';
import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { Navbar } from '../components/Navbar';
import { PromptForm, type PromptFormInitialValues } from '../components/PromptForm';
import { useAuth } from '../hooks/useAuth';
import { useCatalog } from '../hooks/useCatalog';
import { submitPromptPr } from '../utils/apiClient';

export function UploadPage() {
  const { user, token, workerApiUrl, login } = useAuth();
  const { catalog } = useCatalog();
  const [submitting, setSubmitting] = useState(false);
  const [submittedPr, setSubmittedPr] = useState<{
    id: string;
    prNumber: number;
    prUrl: string;
  } | null>(null);

  const initialValues = useMemo<PromptFormInitialValues>(
    () => ({
      title: '',
      category: 'gallery',
      prompt: '',
      description: '',
      tags: [],
      authorName: user?.name || user?.login || '',
      anonymous: false,
      refs: [],
    }),
    [user?.login, user?.name],
  );

  const handleSubmit = async (formData: FormData) => {
    if (!token || !workerApiUrl) {
      throw new Error('请先登录 GitHub');
    }
    setSubmitting(true);
    try {
      const res = await submitPromptPr(workerApiUrl, token, formData);
      setSubmittedPr({ id: res.id, prNumber: res.prNumber, prUrl: res.prUrl });
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="min-h-screen pt-16">
      <Navbar />

      <main className="mx-auto max-w-[820px] px-4 sm:px-6 py-10">
        <div className="text-center mb-8">
          <h1 className="art-heading">发布新作品</h1>
          <p className="mt-2 text-sm text-[var(--text-secondary)]">
            Share your creation with the library.
          </p>
        </div>

        {submittedPr ? (
          <div className="glass-panel p-8 text-center space-y-5">
            <CheckCircle2 className="mx-auto h-12 w-12 text-emerald-500" />
            <div>
              <h2 className="text-xl font-bold">PR #{submittedPr.prNumber} 已提交</h2>
              <p className="mt-1.5 text-sm text-[var(--text-secondary)]">
                审核合并后将自动发布上线。
              </p>
            </div>
            <div className="flex flex-wrap items-center justify-center gap-3 pt-1">
              <a
                href={submittedPr.prUrl}
                target="_blank"
                rel="noreferrer"
                className="inline-flex items-center gap-2 rounded-full bg-[var(--text-primary)] px-6 py-2.5 text-sm font-semibold text-[var(--bg-color)] hover:opacity-90"
              >
                <GitPullRequest className="h-4 w-4" />
                <span>查看 PR #{submittedPr.prNumber}</span>
                <ExternalLink className="h-3.5 w-3.5" />
              </a>
              <button
                type="button"
                onClick={() => setSubmittedPr(null)}
                className="rounded-full bg-[var(--btn-bg)] px-5 py-2.5 text-sm font-medium hover:bg-[var(--btn-hover-bg)] cursor-pointer"
              >
                继续上传
              </button>
              <Link
                to="/"
                className="rounded-full px-5 py-2.5 text-sm font-medium text-[var(--text-secondary)] hover:text-[var(--text-primary)]"
              >
                返回画廊
              </Link>
            </div>
          </div>
        ) : !user ? (
          <div className="glass-panel p-8 sm:p-10 text-center space-y-5">
            <div className="mx-auto flex h-14 w-14 items-center justify-center rounded-full bg-[var(--btn-bg)] text-[var(--text-primary)]">
              <Github className="h-7 w-7" />
            </div>
            <div className="space-y-1.5 max-w-sm mx-auto">
              <h2 className="text-lg font-bold">登录 GitHub 上传作品</h2>
              <p className="text-xs text-[var(--text-secondary)] leading-relaxed">
                仅请求基础身份权限，上传将以你的名义发起 Pull Request。
              </p>
            </div>

            {workerApiUrl ? (
              <button
                type="button"
                onClick={() => login('/upload')}
                className="inline-flex items-center gap-2 rounded-full bg-[var(--text-primary)] px-7 py-2.5 text-sm font-semibold text-[var(--bg-color)] hover:opacity-90 transition-opacity cursor-pointer"
              >
                <Github className="h-4 w-4" />
                <span>使用 GitHub 登录</span>
              </button>
            ) : (
              <p className="text-xs text-[var(--text-secondary)]">
                暂未配置 <code>workerApiUrl</code>，部署 Worker 后启用。
              </p>
            )}
          </div>
        ) : (
          <div className="glass-panel p-6 sm:p-8">
            <PromptForm
              mode="submit"
              initialValues={initialValues}
              suggestedTagsPool={catalog?.tags.map((t) => t.name) ?? []}
              submitLabel="发布作品"
              submitting={submitting}
              onSubmit={handleSubmit}
            />
          </div>
        )}
      </main>
    </div>
  );
}
