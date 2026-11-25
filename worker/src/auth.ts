import {
  randomBase64Url,
  sha256Base64Url,
  signJwtHs256,
  timingSafeEqualStr,
  verifyJwtHs256,
} from './crypto.js';
import { getAdminLogins, getAllowedOrigins, type Env, type SessionUser } from './env.js';

const SESSION_TTL_SECONDS = 7 * 24 * 60 * 60; // 7 days
const TICKET_TTL_SECONDS = 60; // 60 seconds single-use callback exchange
const STATE_TTL_SECONDS = 600; // 10 minutes
const OAUTH_NONCE_COOKIE = 'pm_oauth_nonce';
const PKCE_CHALLENGE_RE = /^[A-Za-z0-9_-]{43}$/;

function parseCookies(cookieHeader: string | null): Record<string, string> {
  const out: Record<string, string> = {};
  if (!cookieHeader) return out;
  for (const part of cookieHeader.split(';')) {
    const eq = part.indexOf('=');
    if (eq === -1) continue;
    const key = part.slice(0, eq).trim();
    const val = part.slice(eq + 1).trim();
    if (key) out[key] = val;
  }
  return out;
}

function buildNonceCookie(nonce: string, isHttps: boolean, maxAgeSeconds: number): string {
  const attrs = [
    `${OAUTH_NONCE_COOKIE}=${nonce}`,
    'HttpOnly',
    'SameSite=Lax',
    'Path=/auth/callback',
    `Max-Age=${maxAgeSeconds}`,
  ];
  if (isHttps) attrs.push('Secure');
  return attrs.join('; ');
}

function normalizeBasePath(pathname: string): string {
  const stripped = pathname.replace(/\/index\.html$/i, '').replace(/\/+$/, '');
  return stripped || '/';
}

/**
 * Pin callback redirects strictly to this site's configured PAGES_BASE_URL path
 * (plus local loopback dev origins when explicitly enabled in ALLOWED_ORIGINS),
 * preventing sibling repos on shared hosts like *.github.io from receiving tickets.
 */
export function isAllowedCallbackUrl(urlStr: string, env: Env): boolean {
  let parsed: URL;
  let pages: URL;
  try {
    parsed = new URL(urlStr);
    pages = new URL(env.PAGES_BASE_URL.replace(/\/+$/, '') + '/');
  } catch {
    return false;
  }

  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    return false;
  }
  if (parsed.username || parsed.password || parsed.search) {
    return false;
  }
  if (!parsed.hash.startsWith('#/auth/callback')) {
    return false;
  }
  const hashAfterRoute = parsed.hash.slice('#/auth/callback'.length);
  if (hashAfterRoute !== '' && !hashAfterRoute.startsWith('?')) {
    return false;
  }

  const allowedOrigins = getAllowedOrigins(env);
  if (!allowedOrigins.includes(parsed.origin)) {
    return false;
  }

  // Production / deployed site: exact origin + pathname match against PAGES_BASE_URL
  if (parsed.origin === pages.origin) {
    return normalizeBasePath(parsed.pathname) === normalizeBasePath(pages.pathname);
  }

  // Local development loopback only (when explicitly present in ALLOWED_ORIGINS)
  const isLoopback =
    parsed.protocol === 'http:' &&
    (parsed.hostname === 'localhost' || parsed.hostname === '127.0.0.1');
  if (isLoopback) {
    return normalizeBasePath(parsed.pathname) === '/';
  }

  return false;
}

export async function handleAuthLogin(request: Request, env: Env): Promise<Response> {
  const reqUrl = new URL(request.url);
  const defaultRedirect = `${env.PAGES_BASE_URL.replace(/\/+$/, '')}/#/auth/callback`;
  const redirect = reqUrl.searchParams.get('redirect') || defaultRedirect;
  const challenge = reqUrl.searchParams.get('challenge') || '';

  if (!isAllowedCallbackUrl(redirect, env)) {
    return Response.json(
      { error: '非法的回调地址（仅允许本站固定回调路径）' },
      { status: 400 },
    );
  }

  if (!PKCE_CHALLENGE_RE.test(challenge)) {
    return Response.json({ error: '缺少或无效的登录校验参数 challenge' }, { status: 400 });
  }

  const nonce = randomBase64Url(24);
  const state = await signJwtHs256(
    { kind: 'oauth_state', redirect, nonce, challenge },
    env.SESSION_SECRET,
    STATE_TTL_SECONDS,
  );
  const callbackUrl = `${reqUrl.origin}/auth/callback`;

  const ghAuthorize = new URL('https://github.com/login/oauth/authorize');
  ghAuthorize.searchParams.set('client_id', env.GITHUB_CLIENT_ID);
  ghAuthorize.searchParams.set('redirect_uri', callbackUrl);
  ghAuthorize.searchParams.set('scope', 'read:user');
  ghAuthorize.searchParams.set('state', state);

  const isHttps = reqUrl.protocol === 'https:';
  return new Response(null, {
    status: 302,
    headers: {
      Location: ghAuthorize.toString(),
      'Set-Cookie': buildNonceCookie(nonce, isHttps, STATE_TTL_SECONDS),
      'Cache-Control': 'no-store',
    },
  });
}

export async function handleAuthCallback(request: Request, env: Env): Promise<Response> {
  const reqUrl = new URL(request.url);
  const isHttps = reqUrl.protocol === 'https:';
  const clearCookie = buildNonceCookie('', isHttps, 0);
  const code = reqUrl.searchParams.get('code');
  const state = reqUrl.searchParams.get('state');

  if (!code || !state) {
    return new Response('Missing OAuth code or state', {
      status: 400,
      headers: { 'Set-Cookie': clearCookie, 'Cache-Control': 'no-store' },
    });
  }

  const statePayload = await verifyJwtHs256<{
    kind: string;
    redirect: string;
    nonce: string;
    challenge: string;
  }>(state, env.SESSION_SECRET);

  if (
    !statePayload ||
    statePayload.kind !== 'oauth_state' ||
    typeof statePayload.nonce !== 'string' ||
    typeof statePayload.challenge !== 'string' ||
    !PKCE_CHALLENGE_RE.test(statePayload.challenge) ||
    !isAllowedCallbackUrl(statePayload.redirect, env)
  ) {
    return new Response('Invalid or expired OAuth state', {
      status: 400,
      headers: { 'Set-Cookie': clearCookie, 'Cache-Control': 'no-store' },
    });
  }

  const cookies = parseCookies(request.headers.get('Cookie'));
  const cookieNonce = cookies[OAUTH_NONCE_COOKIE] || '';
  if (!cookieNonce || !timingSafeEqualStr(cookieNonce, statePayload.nonce)) {
    return new Response('OAuth browser session mismatch, please retry login', {
      status: 400,
      headers: { 'Set-Cookie': clearCookie, 'Cache-Control': 'no-store' },
    });
  }

  const tokenResp = await fetch('https://github.com/login/oauth/access_token', {
    method: 'POST',
    headers: {
      Accept: 'application/json',
      'Content-Type': 'application/json',
      'User-Agent': 'prompt-manager-pages-worker',
    },
    body: JSON.stringify({
      client_id: env.GITHUB_CLIENT_ID,
      client_secret: env.GITHUB_CLIENT_SECRET,
      code,
      redirect_uri: `${reqUrl.origin}/auth/callback`,
    }),
  });

  if (!tokenResp.ok) {
    return new Response('Failed to exchange GitHub OAuth code', {
      status: 502,
      headers: { 'Set-Cookie': clearCookie, 'Cache-Control': 'no-store' },
    });
  }

  const tokenData = (await tokenResp.json()) as { access_token?: string; error?: string };
  if (!tokenData.access_token) {
    return new Response(`GitHub OAuth error: ${tokenData.error || 'unknown'}`, {
      status: 400,
      headers: { 'Set-Cookie': clearCookie, 'Cache-Control': 'no-store' },
    });
  }

  // Fetch minimal public profile and immediately discard GitHub access_token
  const userResp = await fetch('https://api.github.com/user', {
    headers: {
      Accept: 'application/vnd.github+json',
      Authorization: `Bearer ${tokenData.access_token}`,
      'User-Agent': 'prompt-manager-pages-worker',
    },
  });

  if (!userResp.ok) {
    return new Response('Failed to fetch GitHub user profile', {
      status: 502,
      headers: { 'Set-Cookie': clearCookie, 'Cache-Control': 'no-store' },
    });
  }

  const ghUser = (await userResp.json()) as {
    id: number;
    login: string;
    name: string | null;
    avatar_url: string;
  };

  const admins = getAdminLogins(env);
  const user: SessionUser = {
    id: ghUser.id,
    login: ghUser.login,
    name: ghUser.name || ghUser.login,
    avatarUrl: ghUser.avatar_url,
    isAdmin: admins.has(ghUser.login.toLowerCase()),
  };

  const ticket = await signJwtHs256(
    {
      kind: 'auth_ticket',
      jti: randomBase64Url(16),
      challenge: statePayload.challenge,
      user,
    },
    env.SESSION_SECRET,
    TICKET_TTL_SECONDS,
  );

  const sep = statePayload.redirect.includes('?') ? '&' : '?';
  return new Response(null, {
    status: 302,
    headers: {
      Location: `${statePayload.redirect}${sep}ticket=${encodeURIComponent(ticket)}`,
      'Set-Cookie': clearCookie,
      'Cache-Control': 'no-store',
    },
  });
}

export async function handleAuthExchange(request: Request, env: Env): Promise<Response> {
  let raw: unknown;
  try {
    raw = await request.json();
  } catch {
    return Response.json({ error: '无效的 JSON 请求体' }, { status: 400 });
  }

  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return Response.json({ error: '请求体必须为 JSON 对象' }, { status: 400 });
  }

  const { ticket, verifier } = raw as { ticket?: unknown; verifier?: unknown };
  if (typeof ticket !== 'string' || !ticket.trim()) {
    return Response.json({ error: '缺少有效的 ticket' }, { status: 400 });
  }
  if (typeof verifier !== 'string' || verifier.length < 32 || verifier.length > 128) {
    return Response.json({ error: '缺少有效的登录校验参数 verifier' }, { status: 400 });
  }

  const payload = await verifyJwtHs256<{
    kind: string;
    jti: string;
    challenge: string;
    user: SessionUser;
  }>(ticket, env.SESSION_SECRET);

  if (
    !payload ||
    payload.kind !== 'auth_ticket' ||
    typeof payload.jti !== 'string' ||
    typeof payload.challenge !== 'string' ||
    !payload.user
  ) {
    return Response.json({ error: '登录凭证无效或已过期，请重新登录' }, { status: 401 });
  }

  const expectedChallenge = await sha256Base64Url(verifier);
  if (!timingSafeEqualStr(expectedChallenge, payload.challenge)) {
    return Response.json({ error: '登录凭证与发起浏览器不匹配，请重新登录' }, { status: 401 });
  }

  const id = env.OAUTH_TICKETS.idFromName(payload.jti);
  const consumed = await env.OAUTH_TICKETS.get(id).fetch('https://ticket.internal/consume', { method: 'POST' });
  if (consumed.status === 409) {
    return Response.json({ error: '登录凭证已被使用，请重新登录' }, { status: 401 });
  }

  if (!consumed.ok) throw new Error('登录凭证兑换暂不可用');

  const token = await signJwtHs256(
    { kind: 'session', user: payload.user },
    env.SESSION_SECRET,
    SESSION_TTL_SECONDS,
  );

  return Response.json(
    { token, user: payload.user },
    { headers: { 'Cache-Control': 'no-store' } },
  );
}

export async function authenticateRequest(request: Request, env: Env): Promise<SessionUser | null> {
  const auth = request.headers.get('Authorization') || '';
  if (!auth.startsWith('Bearer ')) return null;
  const token = auth.slice('Bearer '.length).trim();
  if (!token) return null;

  const payload = await verifyJwtHs256<{ kind: string; user: SessionUser }>(
    token,
    env.SESSION_SECRET,
  );
  if (!payload || payload.kind !== 'session' || !payload.user) return null;

  const admins = getAdminLogins(env);
  return {
    ...payload.user,
    isAdmin: admins.has(payload.user.login.toLowerCase()),
  };
}

export async function handleAuthMe(request: Request, env: Env): Promise<Response> {
  const user = await authenticateRequest(request, env);
  if (!user) {
    return Response.json({ error: '未登录或会话已过期' }, { status: 401 });
  }
  return Response.json({ user }, { headers: { 'Cache-Control': 'no-store' } });
}
