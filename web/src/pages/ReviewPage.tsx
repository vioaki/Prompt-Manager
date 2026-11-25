import {
  AlertTriangle,
  CheckCircle2,
  ChevronLeft,
  ChevronRight,
  ExternalLink,
  GitPullRequest,
  Loader2,
  RefreshCw,
  ShieldAlert,
  Sparkles,
  XCircle,
} from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Navbar } from '../components/Navbar';
import {
  PromptForm,
  type PromptFormExternalPatch,
  type PromptFormInitialValues,
} from '../components/PromptForm';
import { useAuth } from '../hooks/useAuth';
import { useCatalog } from '../hooks/useCatalog';
import {
  ApiError,
  approvePendingPr,
  closePendingPr,
  fetchPendingPrDetail,
  fetchPendingPrs,
  type PendingPrReviewDetail,
  type PendingPrSummary,
} from '../utils/apiClient';

const PER_PAGE = 20;

export function ReviewPage() {
  const { user, token, workerApiUrl, login } = useAuth();
  const { catalog } = useCatalog();

  const [page, setPage] = useState(1);
  const [hasNext, setHasNext] = useState(false);
  const [prs, setPrs] = useState<PendingPrSummary[]>([]);
  const [selectedNumber, setSelectedNumber] = useState<number | null>(null);
  const [activePr, setActivePr] = useState<PendingPrReviewDetail | null>(null);
  const [loadingList, setLoadingList] = useState(false);
  const [loadingDetail, setLoadingDetail] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [detailError, setDetailError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [aiPatch, setAiPatch] = useState<PromptFormExternalPatch | null>(null);
  const patchSeqRef = useRef(0);

  const loadPrList = useCallback(
    async (targetPage = page) => {
      if (!token || !workerApiUrl || !user?.isAdmin) return;
      setLoadingList(true);
      setError(null);
      try {
        const res = await fetchPendingPrs(workerApiUrl, token, targetPage, PER_PAGE);
        setPrs(res.prs);
        setPage(res.page);
        setHasNext(res.hasNext);
        setSelectedNumber((prev) => {
          if (prev && res.prs.some((p) => p.prNumber === prev)) return prev;
          return res.prs[0]?.prNumber ?? null;
        });
      } catch (err) {
        setError((err as Error).message || '加载待审 PR 列表失败');
      } finally {
        setLoadingList(false);
      }
    },
    [page, token, workerApiUrl, user?.isAdmin],
  );

  const [detailVersion, setDetailVersion] = useState(0);
  const refreshDetail = () => setDetailVersion((previous) => previous + 1);

  useEffect(() => {
    void loadPrList(1);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [token, workerApiUrl, user?.isAdmin]);

  useEffect(() => {
    if (!selectedNumber) {
      setActivePr(null);
      setDetailError(null);
      return;
    }
    let cancelled = false;
    setLoadingDetail(true);
    setDetailError(null);
    setAiPatch(null);

    if (!token || !workerApiUrl || !user?.isAdmin) return;
    fetchPendingPrDetail(workerApiUrl, token, selectedNumber)
      .then((res) => {
        if (!cancelled) setActivePr(res.pr);
      })
      .catch((err) => {
        if (!cancelled) {
          setActivePr(null);
          setDetailError((err as Error).message || '加载 PR 详情失败');
        }
      })
      .finally(() => {
        if (!cancelled) setLoadingDetail(false);
      });

    return () => {
      cancelled = true;
    };
  }, [selectedNumber, token, workerApiUrl, user?.isAdmin, detailVersion]);

  const formInitialValues = useMemo<PromptFormInitialValues | null>(() => {
    if (!activePr || !activePr.reviewableInApp || !activePr.meta || !activePr.mediaBaseUrl) {
      return null;
    }
    const { meta, mediaBaseUrl } = activePr;
    return {
      title: meta.title,
      category: meta.category,
      prompt: meta.prompt,
      description: meta.description,
      tags: meta.tags,
      authorName: meta.author.name,
      anonymous: !meta.author.name,
      existingMainUrl: `${mediaBaseUrl}/${meta.media.main}`,
      existingWidth: meta.media.width,
      existingHeight: meta.media.height,
      refs: meta.refs.map((r, idx) =>
        r.kind === 'placeholder'
          ? { uid: `pr_ph_${idx}`, kind: 'placeholder', label: r.label }
          : {
              uid: `pr_img_${idx}`,
              kind: 'existing-image',
              file: r.file,
              previewUrl: `${mediaBaseUrl}/${r.file}`,
            },
      ),
    };
  }, [activePr]);

  const handleApprove = async (formData?: FormData) => {
    if (!activePr || !token || !workerApiUrl) return;
    setBusy(true);
    setNotice(null);
    setError(null);
    try {
      const result = await approvePendingPr(
        workerApiUrl,
        token,
        activePr.prNumber,
        activePr.headSha,
        formData,
      );
      if (!result.merged) {
        setNotice(`修改已保存至 ${result.headSha.slice(0, 7)}，请在内容检查通过后再次批准。`);
        refreshDetail();
        return;
      }
      setNotice(`PR #${activePr.prNumber} 已合并发布。`);
      setPrs((prev) => {
        const next = prev.filter((p) => p.prNumber !== activePr.prNumber);
        setSelectedNumber(next[0]?.prNumber ?? null);
        return next;
      });
      setActivePr(null);
    } catch (err) {
      setError((err as Error).message);
      if (err instanceof ApiError && err.status === 409) {
        // Reload latest commit snapshot so admin re-reviews before approving
        refreshDetail();
      }
      throw err;
    } finally {
      setBusy(false);
    }
  };

  const handleClose = async () => {
    if (!activePr || !token || !workerApiUrl) return;
    if (!window.confirm(`确定拒绝并关闭 PR #${activePr.prNumber} 吗？`)) return;
    setBusy(true);
    setError(null);
    try {
      await closePendingPr(workerApiUrl, token, activePr.prNumber);
      setNotice(`已关闭 PR #${activePr.prNumber}。`);
      setPrs((prev) => {
        const next = prev.filter((p) => p.prNumber !== activePr.prNumber);
        setSelectedNumber(next[0]?.prNumber ?? null);
        return next;
      });
      setActivePr(null);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const canEditBranchInApp = Boolean(
    activePr &&
      activePr.reviewableInApp &&
      !activePr.isCrossRepo &&
      activePr.branch.startsWith('submit/'),
  );

  return (
    <div className="min-h-screen pt-16">
      <Navbar />

      <main className="mx-auto max-w-6xl px-4 sm:px-6 py-8">
        <div className="flex flex-wrap items-center justify-between gap-3 mb-6">
          <h1 className="art-heading">审校台</h1>
          {user?.isAdmin && (
            <button
              type="button"
              onClick={() => void loadPrList(page)}
              disabled={loadingList}
              className="inline-flex items-center gap-1.5 rounded-full bg-[var(--btn-bg)] px-4 py-2 text-xs font-semibold hover:bg-[var(--btn-hover-bg)] cursor-pointer"
            >
              <RefreshCw className={`h-3.5 w-3.5 ${loadingList ? 'animate-spin' : ''}`} />
              <span>刷新 ({prs.length})</span>
            </button>
          )}
        </div>

        {!user ? (
          <div className="glass-panel p-10 text-center space-y-4">
            <ShieldAlert className="mx-auto h-10 w-10 text-amber-500" />
            <p className="text-sm text-[var(--text-secondary)]">请使用管理员 GitHub 账号登录。</p>
            <button
              type="button"
              onClick={() => login('/review')}
              className="rounded-full bg-[var(--text-primary)] px-6 py-2.5 text-sm font-semibold text-[var(--bg-color)] cursor-pointer"
            >
              GitHub 登录
            </button>
          </div>
        ) : !user.isAdmin ? (
          <div className="glass-panel p-10 text-center space-y-2">
            <ShieldAlert className="mx-auto h-10 w-10 text-red-500" />
            <h2 className="text-lg font-bold">无管理员权限</h2>
          </div>
        ) : (
          <>
            {notice && (
              <div className="mb-5 rounded-xl border border-emerald-500/30 bg-emerald-500/10 px-4 py-3 text-sm text-emerald-700 dark:text-emerald-300">
                {notice}
              </div>
            )}
            {error && (
              <div className="mb-5 rounded-xl border border-red-500/30 bg-red-500/10 px-4 py-3 text-sm text-red-600 dark:text-red-400">
                {error}
              </div>
            )}

            {page === 1 && prs.length === 0 && !loadingList ? (
              <div className="glass-panel p-12 text-center space-y-2">
                <CheckCircle2 className="mx-auto h-11 w-11 text-emerald-500 opacity-80" />
                <p className="text-sm text-[var(--text-secondary)]">暂无待审核 PR</p>
              </div>
            ) : (
              <div className="grid grid-cols-1 lg:grid-cols-12 gap-6">
                {/* Left: Paginated PR summary list (1 API call total) */}
                <div className="lg:col-span-4 space-y-2.5">
                  {prs.map((pr) => {
                    const isSelected = pr.prNumber === selectedNumber;
                    return (
                      <button
                        key={pr.prNumber}
                        type="button"
                        onClick={() => setSelectedNumber(pr.prNumber)}
                        className={`w-full flex items-start gap-3 rounded-2xl p-3.5 text-left transition-all cursor-pointer border ${
                          isSelected
                            ? 'border-[var(--accent-color)] bg-[var(--sidebar-bg)] shadow-sm'
                            : 'border-[var(--border-subtle)] bg-[var(--sidebar-bg)]/70 hover:bg-[var(--sidebar-bg)]'
                        }`}
                      >
                        <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-[var(--btn-bg)] text-[var(--text-secondary)] mt-0.5">
                          <GitPullRequest className="h-4 w-4" />
                        </div>
                        <div className="min-w-0 flex-1">
                          <div className="flex items-center justify-between gap-2">
                            <span className="text-xs font-mono text-[var(--text-secondary)]">
                              #{pr.prNumber}
                            </span>
                            {pr.isCrossRepo && (
                              <span className="rounded-full bg-amber-500/15 px-2 py-0.5 text-[10px] font-semibold text-amber-600 dark:text-amber-400">
                                Fork
                              </span>
                            )}
                          </div>
                          <div className="text-sm font-semibold truncate mt-0.5">
                            {pr.prTitle}
                          </div>
                          <div className="text-xs text-[var(--text-secondary)] truncate mt-0.5">
                            @{pr.submittedBy} · {pr.headSha.slice(0, 7)}
                          </div>
                        </div>
                      </button>
                    );
                  })}

                  {(page > 1 || hasNext) && (
                    <div className="flex items-center justify-between pt-2">
                      <button
                        type="button"
                        disabled={page <= 1 || loadingList}
                        onClick={() => void loadPrList(page - 1)}
                        className="inline-flex items-center gap-1 rounded-full bg-[var(--btn-bg)] px-3 py-1.5 text-xs font-medium disabled:opacity-40 cursor-pointer"
                      >
                        <ChevronLeft className="h-3.5 w-3.5" />
                        <span>上一页</span>
                      </button>
                      <span className="text-xs text-[var(--text-secondary)]">第 {page} 页</span>
                      <button
                        type="button"
                        disabled={!hasNext || loadingList}
                        onClick={() => void loadPrList(page + 1)}
                        className="inline-flex items-center gap-1 rounded-full bg-[var(--btn-bg)] px-3 py-1.5 text-xs font-medium disabled:opacity-40 cursor-pointer"
                      >
                        <span>下一页</span>
                        <ChevronRight className="h-3.5 w-3.5" />
                      </button>
                    </div>
                  )}
                </div>

                {/* Right: Lazily-loaded PR Detail */}
                <div className="lg:col-span-8">
                  {loadingDetail ? (
                    <div className="glass-panel p-12 flex flex-col items-center justify-center gap-3 text-[var(--text-secondary)]">
                      <Loader2 className="h-7 w-7 animate-spin text-[var(--accent-color)]" />
                      <span className="text-xs">正在加载 PR #{selectedNumber} 详情...</span>
                    </div>
                  ) : detailError ? (
                    <div className="glass-panel p-8 text-center space-y-3">
                      <AlertTriangle className="mx-auto h-8 w-8 text-red-500" />
                      <p className="text-sm text-red-600 dark:text-red-400">{detailError}</p>
                      {selectedNumber && (
                        <button
                          type="button"
                          onClick={refreshDetail}
                          className="rounded-full bg-[var(--btn-bg)] px-4 py-1.5 text-xs font-semibold hover:bg-[var(--btn-hover-bg)] cursor-pointer"
                        >
                          重试加载
                        </button>
                      )}
                    </div>
                  ) : activePr ? (
                    <div className="glass-panel p-6 space-y-6">
                      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-[var(--border-subtle)] pb-4">
                        <div>
                          <div className="flex items-center gap-2 text-xs text-[var(--text-secondary)]">
                            <span>
                              PR #{activePr.prNumber} · @{activePr.submittedBy} ·{' '}
                              <code className="font-mono">{activePr.headSha.slice(0, 7)}</code>
                            </span>
                            {activePr.isCrossRepo && (
                              <span className="rounded-full bg-amber-500/15 px-2 py-0.5 text-[10px] font-semibold text-amber-600 dark:text-amber-400">
                                Fork PR
                              </span>
                            )}
                          </div>
                          <h2 className="text-lg font-bold mt-0.5">
                            {activePr.meta?.title || activePr.prTitle}
                          </h2>
                        </div>

                        <div className="flex items-center gap-2">
                          <a
                            href={activePr.prUrl}
                            target="_blank"
                            rel="noreferrer"
                            className="inline-flex items-center gap-1 rounded-full bg-[var(--btn-bg)] px-3 py-1.5 text-xs font-medium hover:bg-[var(--btn-hover-bg)]"
                          >
                            <span>GitHub</span>
                            <ExternalLink className="h-3 w-3" />
                          </a>
                          <button
                            type="button"
                            disabled={busy}
                            onClick={handleClose}
                            className="inline-flex items-center gap-1 rounded-full bg-red-500/12 px-3.5 py-1.5 text-xs font-semibold text-red-500 hover:bg-red-500/20 cursor-pointer"
                          >
                            <XCircle className="h-3.5 w-3.5" />
                            <span>拒绝</span>
                          </button>
                        </div>
                      </div>

                      {!activePr.reviewableInApp ? (
                        <div className="space-y-4">
                          <div className="rounded-xl border border-amber-500/30 bg-amber-500/10 p-4 text-xs text-amber-700 dark:text-amber-300 leading-relaxed space-y-2">
                            <div className="font-semibold flex items-center gap-1.5">
                              <AlertTriangle className="h-4 w-4" />
                              <span>该 PR 需在 GitHub 审阅合并</span>
                            </div>
                            <p>{activePr.inAppBlockReason}</p>
                          </div>

                          {activePr.changedFiles.length > 0 && (
                            <div className="space-y-1.5">
                              <div className="text-xs font-semibold text-[var(--text-secondary)]">
                                变更文件（{activePr.changedFiles.length}）
                              </div>
                              <ul className="max-h-56 overflow-y-auto rounded-xl bg-[var(--btn-bg)] p-3 space-y-1 font-mono text-[11px] text-[var(--text-secondary)]">
                                {activePr.changedFiles.map((f) => (
                                  <li key={f} className="truncate">
                                    {f}
                                  </li>
                                ))}
                              </ul>
                            </div>
                          )}

                          <div className="flex justify-end pt-2 border-t border-[var(--border-subtle)]">
                            <a
                              href={`${activePr.prUrl}/files`}
                              target="_blank"
                              rel="noreferrer"
                              className="inline-flex items-center gap-1.5 rounded-full bg-[var(--text-primary)] px-6 py-2.5 text-xs font-semibold text-[var(--bg-color)] hover:opacity-90"
                            >
                              <span>前往 GitHub 查看完整 Diff</span>
                              <ExternalLink className="h-3.5 w-3.5" />
                            </a>
                          </div>
                        </div>
                      ) : (
                        <>
                          {activePr.aiSuggestion && (
                            <div className="rounded-xl bg-[var(--btn-bg)] p-4 space-y-3 text-xs">
                              <div className="flex flex-wrap items-center justify-between gap-2">
                                <span className="inline-flex items-center gap-1.5 font-semibold">
                                  <Sparkles className="h-3.5 w-3.5 text-[var(--accent-color)]" />
                                  AI 建议
                                </span>
                                {canEditBranchInApp && (
                                  <div className="flex flex-wrap gap-1.5">
                                    {activePr.aiSuggestion.suggestedTags.length > 0 && (
                                      <button
                                        type="button"
                                        onClick={() => {
                                          patchSeqRef.current += 1;
                                          setAiPatch({
                                            seq: patchSeqRef.current,
                                            addTags: activePr.aiSuggestion!.suggestedTags,
                                            ...(activePr.aiSuggestion!.suggestedCategory
                                              ? { category: activePr.aiSuggestion!.suggestedCategory }
                                              : {}),
                                          });
                                        }}
                                        className="rounded-full bg-[var(--accent-color)] px-3 py-1 text-white font-semibold hover:opacity-90 cursor-pointer"
                                      >
                                        应用标签/分类
                                      </button>
                                    )}
                                    {activePr.aiSuggestion.normalizedPrompt && (
                                      <button
                                        type="button"
                                        onClick={() => {
                                          patchSeqRef.current += 1;
                                          setAiPatch({
                                            seq: patchSeqRef.current,
                                            prompt: activePr.aiSuggestion!.normalizedPrompt!,
                                          });
                                        }}
                                        className="rounded-full bg-[var(--sidebar-bg)] px-3 py-1 font-semibold hover:bg-[var(--btn-hover-bg)] cursor-pointer"
                                      >
                                        应用规范化 Prompt
                                      </button>
                                    )}
                                  </div>
                                )}
                              </div>

                              {activePr.aiSuggestion.summary && (
                                <p className="text-[var(--text-secondary)]">
                                  {activePr.aiSuggestion.summary}
                                </p>
                              )}
                              {activePr.aiSuggestion.nsfwRisk && (
                                <div className="flex items-center gap-1.5 font-semibold text-amber-600 dark:text-amber-400">
                                  <AlertTriangle className="h-3.5 w-3.5" />
                                  <span>{activePr.aiSuggestion.nsfwReason || '疑似敏感内容'}</span>
                                </div>
                              )}
                              {activePr.aiSuggestion.suggestedTags.length > 0 && (
                                <div className="flex flex-wrap gap-1.5">
                                  {activePr.aiSuggestion.suggestedTags.map((t) => (
                                    <span key={t} className="mini-tag">
                                      {t}
                                    </span>
                                  ))}
                                </div>
                              )}
                            </div>
                          )}

                          {!canEditBranchInApp && activePr.meta && activePr.mediaBaseUrl ? (
                            <div className="space-y-4">
                              <div className="rounded-xl border border-amber-500/30 bg-amber-500/10 p-4 text-xs text-amber-700 dark:text-amber-300 leading-relaxed">
                                该 PR 来自外部 Fork 仓库（<code>{activePr.headRepoFullName}</code>）或非 <code>submit/*</code> 分支。为保护主分支，审校台不支持改写该分支；确认内容无误后可直接合并当前提交（<code>{activePr.headSha.slice(0, 7)}</code>）。
                              </div>
                              <div className="rounded-2xl overflow-hidden bg-black flex justify-center">
                                <img
                                  src={`${activePr.mediaBaseUrl}/${activePr.meta.media.main}`}
                                  alt={activePr.meta.title}
                                  className="max-h-80 object-contain"
                                />
                              </div>
                              <div className="space-y-2 text-xs">
                                <div className="flex flex-wrap gap-1.5">
                                  <span className="mini-tag">{activePr.meta.category}</span>
                                  {activePr.meta.tags.map((t) => (
                                    <span key={t} className="mini-tag">
                                      {t}
                                    </span>
                                  ))}
                                </div>
                                <pre className="prompt-box-apple p-3.5 font-mono text-xs whitespace-pre-wrap break-words max-h-60 overflow-y-auto">
                                  {activePr.meta.prompt}
                                </pre>
                              </div>
                              <div className="flex justify-end pt-2 border-t border-[var(--border-subtle)]">
                                <button
                                  type="button"
                                  disabled={busy}
                                  onClick={() => void handleApprove().catch(() => {})}
                                  className="rounded-full bg-[var(--accent-color)] px-7 py-2.5 text-sm font-semibold text-white shadow-md hover:opacity-92 disabled:opacity-50 cursor-pointer"
                                >
                                  {busy ? '合并中...' : '直接合并发布'}
                                </button>
                              </div>
                            </div>
                          ) : formInitialValues ? (
                            <PromptForm
                              mode="review"
                              initialValues={formInitialValues}
                              externalPatch={aiPatch}
                              suggestedTagsPool={catalog?.tags.map((t) => t.name) ?? []}
                              submitLabel="保存修改或批准当前版本"
                              submitting={busy}
                              onSubmit={handleApprove}
                            />
                          ) : null}
                        </>
                      )}
                    </div>
                  ) : null}
                </div>
              </div>
            )}
          </>
        )}
      </main>
    </div>
  );
}
