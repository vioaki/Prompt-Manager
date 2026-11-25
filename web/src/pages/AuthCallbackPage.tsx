import { Loader2 } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { useAuth } from '../hooks/useAuth';
import { useCatalog } from '../hooks/useCatalog';

export function AuthCallbackPage() {
  const [searchParams] = useSearchParams();
  const navigate = useNavigate();
  const { completeLogin, workerApiUrl } = useAuth();
  const { loading: catalogLoading } = useCatalog();
  const [error, setError] = useState<string | null>(null);
  const exchangedTicketRef = useRef<string | null>(null);

  useEffect(() => {
    const ticket = searchParams.get('ticket');
    const next = searchParams.get('next') || '/upload';

    if (!ticket) {
      setError('缺少登录凭证 ticket');
      return;
    }

    if (!workerApiUrl) {
      if (!catalogLoading) {
        setError('未配置 Worker API 地址，无法完成登录');
      }
      return;
    }

    if (exchangedTicketRef.current === ticket) return;
    exchangedTicketRef.current = ticket;

    completeLogin(ticket)
      .then(() => {
        navigate(next.startsWith('/') ? next : '/upload', { replace: true });
      })
      .catch((err) => {
        exchangedTicketRef.current = null;
        setError((err as Error).message || '登录失败');
      });
  }, [catalogLoading, completeLogin, navigate, searchParams, workerApiUrl]);

  return (
    <div className="min-h-screen flex items-center justify-center p-6">
      <div className="glass-panel p-8 max-w-sm w-full text-center space-y-3">
        {error ? (
          <>
            <h1 className="text-lg font-bold text-red-500">登录失败</h1>
            <p className="text-xs text-[var(--text-secondary)]">{error}</p>
            <button
              type="button"
              onClick={() => navigate('/', { replace: true })}
              className="rounded-full bg-[var(--text-primary)] px-5 py-2 text-xs font-semibold text-[var(--bg-color)] cursor-pointer"
            >
              返回首页
            </button>
          </>
        ) : (
          <>
            <Loader2 className="mx-auto h-8 w-8 animate-spin text-[var(--accent-color)]" />
            <p className="text-sm font-medium">正在完成 GitHub 登录...</p>
          </>
        )}
      </div>
    </div>
  );
}
