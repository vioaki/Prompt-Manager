import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import {
  ApiError,
  clearStoredOAuthVerifier,
  createOAuthLoginUrl,
  exchangeAuthTicket,
  fetchCurrentUser,
  getStoredOAuthVerifier,
  type AuthUser,
} from '../utils/apiClient';
import { useCatalog } from './useCatalog';

interface AuthContextValue {
  user: AuthUser | null;
  token: string | null;
  workerApiUrl: string;
  authReady: boolean;
  login: (returnToHash?: string) => void;
  logout: () => void;
  completeLogin: (ticket: string) => Promise<AuthUser>;
}

const TOKEN_STORAGE_KEY = 'pm_worker_session_token';
const AuthContext = createContext<AuthContextValue | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const { catalog } = useCatalog();
  const workerApiUrl =
    (import.meta.env.VITE_WORKER_API_URL as string | undefined)?.trim() ||
    catalog?.site.workerApiUrl?.trim() ||
    '';

  const [token, setToken] = useState<string | null>(() => {
    try {
      return sessionStorage.getItem(TOKEN_STORAGE_KEY);
    } catch {
      return null;
    }
  });
  const [user, setUser] = useState<AuthUser | null>(null);
  const [authReady, setAuthReady] = useState(false);
  const justAuthenticatedTokenRef = useRef<string | null>(null);

  useEffect(() => {
    if (!workerApiUrl) {
      setAuthReady(true);
      return;
    }
    if (!token) {
      setUser(null);
      setAuthReady(true);
      return;
    }
    if (justAuthenticatedTokenRef.current === token) {
      justAuthenticatedTokenRef.current = null;
      setAuthReady(true);
      return;
    }

    let cancelled = false;
    fetchCurrentUser(workerApiUrl, token)
      .then((res) => {
        if (!cancelled) setUser(res.user);
      })
      .catch((err) => {
        if (!cancelled) {
          // Only discard session token on explicit 401 Unauthorized;
          // preserve valid session across transient network or 5xx errors.
          if (err instanceof ApiError && err.status === 401) {
            setUser(null);
            setToken(null);
            try {
              sessionStorage.removeItem(TOKEN_STORAGE_KEY);
            } catch {
              // ignore
            }
          }
        }
      })
      .finally(() => {
        if (!cancelled) setAuthReady(true);
      });

    return () => {
      cancelled = true;
    };
  }, [workerApiUrl, token]);

  const login = useCallback(
    (returnToHash = '/upload') => {
      if (!workerApiUrl) {
        alert('尚未配置 Cloudflare Worker API 地址，请先在 site.config.json 中填写 workerApiUrl。');
        return;
      }
      void createOAuthLoginUrl(workerApiUrl, returnToHash).then((url) => {
        window.location.href = url;
      });
    },
    [workerApiUrl],
  );

  const logout = useCallback(() => {
    setUser(null);
    setToken(null);
    clearStoredOAuthVerifier();
    try {
      sessionStorage.removeItem(TOKEN_STORAGE_KEY);
    } catch {
      // ignore
    }
  }, []);

  const completeLogin = useCallback(
    async (ticket: string) => {
      if (!workerApiUrl) {
        throw new Error('未配置 Worker API 地址');
      }
      const verifier = getStoredOAuthVerifier();
      if (!verifier) {
        throw new Error('缺少浏览器登录校验状态，请在当前浏览器重新发起登录');
      }
      try {
        const res = await exchangeAuthTicket(workerApiUrl, ticket, verifier);
        clearStoredOAuthVerifier();
        justAuthenticatedTokenRef.current = res.token;
        setToken(res.token);
        setUser(res.user);
        setAuthReady(true);
        try {
          sessionStorage.setItem(TOKEN_STORAGE_KEY, res.token);
        } catch {
          // ignore
        }
        return res.user;
      } catch (err) {
        if (err instanceof ApiError && err.status === 401) {
          clearStoredOAuthVerifier();
        }
        throw err;
      }
    },
    [workerApiUrl],
  );

  return (
    <AuthContext.Provider
      value={{ user, token, workerApiUrl, authReady, login, logout, completeLogin }}
    >
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth() {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used inside AuthProvider');
  return ctx;
}
