import { generateKeyPairSync, verify as nodeCryptoVerify } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  BOT_COMMENT_MARKER,
  MAX_TOTAL_UPLOAD_BYTES,
  encodeAiBundleBlock,
} from '@prompt-pages/shared';
import { isAllowedCallbackUrl } from './auth.js';
import {
  base64ToBytes,
  bytesToBase64,
  detectImageMimeFromBytes,
  sha256Base64Url,
  signJwtHs256,
  signJwtRs256,
  verifyJwtHs256,
} from './crypto.js';
import type { Env, SessionUser } from './env.js';
import { clearRepoWriteTokenCache, encodeGitRefPath, getReviewedItemFiles, hasValidatedHead, type PendingPrSummary } from './github.js';
import worker from './index.js';
import { readUploadForm } from './submit.js';
import { clearLegacyApiCache } from './legacyReadApi.js';

const consumed = new Set<string>();
const mockEnv: Env = {
  OAUTH_TICKETS: {
    idFromName: (name: string) => name,
    get: (id: string) => ({ fetch: async () => {
      if (consumed.has(id)) return new Response(null, { status: 409 });
      consumed.add(id);
      return new Response(null, { status: 204 });
    } }),
  } as unknown as DurableObjectNamespace,
  GITHUB_OWNER: 'vioaki',
  GITHUB_REPO: 'Prompt-Manager-Pages',
  GITHUB_DEFAULT_BRANCH: 'main',
  PAGES_BASE_URL: 'https://vioaki.github.io/Prompt-Manager-Pages',
  ALLOWED_ORIGINS: 'https://vioaki.github.io,http://localhost:5173',
  ADMIN_LOGINS: 'vioaki',
  GITHUB_CLIENT_ID: 'cid_test',
  GITHUB_CLIENT_SECRET: 'csec_test',
  SESSION_SECRET: 'super-secret-test-key-32-bytes-long',
  GITHUB_BOT_TOKEN: 'ghp_bot_test_token',
};

const VALID_WEBP = new Uint8Array([
  0x52, 0x49, 0x46, 0x46, 0x24, 0x00, 0x00, 0x00,
  0x57, 0x45, 0x42, 0x50, 0x56, 0x50, 0x38, 0x20,
]);

const FAKE_MP4 = new Uint8Array([
  0x00, 0x00, 0x00, 0x18, 0x66, 0x74, 0x79, 0x70,
  0x6d, 0x70, 0x34, 0x32, 0x00, 0x00, 0x00, 0x00,
]);

const SAMPLE_META = {
  schemaVersion: 1,
  id: '20261125-demo-abcdef',
  title: 'Demo',
  category: 'gallery',
  prompt: 'hello world',
  description: '',
  tags: ['banana'],
  author: { name: 'alice', github: 'alice' },
  media: {
    main: 'main.webp',
    thumb: 'thumb.webp',
    mimeType: 'image/webp',
    width: 800,
    height: 800,
  },
  refs: [],
  createdAt: '2026-11-25T00:00:00Z',
};

afterEach(() => {
  vi.restoreAllMocks();
  clearLegacyApiCache();
  clearRepoWriteTokenCache();
  consumed.clear();
});

async function makeSessionToken(user: SessionUser) {
  return signJwtHs256({ kind: 'session', user }, mockEnv.SESSION_SECRET, 3600);
}

describe('worker crypto, base64 & magic bytes', () => {
  it('signs and verifies HS256 JWT and rejects tampered or malformed tokens without 500', async () => {
    const token = await signJwtHs256({ kind: 'test', sub: 'alice' }, mockEnv.SESSION_SECRET, 60);
    const ok = await verifyJwtHs256<{ kind: string; sub: string }>(token, mockEnv.SESSION_SECRET);
    expect(ok?.sub).toBe('alice');

    expect(await verifyJwtHs256(token + 'x', mockEnv.SESSION_SECRET)).toBeNull();
    expect(await verifyJwtHs256('a.b.!!!', mockEnv.SESSION_SECRET)).toBeNull();
    expect(await verifyJwtHs256('a.b.c', mockEnv.SESSION_SECRET)).toBeNull();

    const resp = await worker.fetch(
      new Request('https://worker.example.dev/auth/me', {
        headers: { Authorization: 'Bearer a.b.!!!' },
      }),
      mockEnv,
    );
    expect(resp.status).toBe(401);
  });

  it('round-trips large binary payloads via fast native base64', () => {
    const large = new Uint8Array(128 * 1024);
    for (let i = 0; i < large.length; i++) large[i] = i & 0xff;
    const encoded = bytesToBase64(large);
    const decoded = base64ToBytes(encoded);
    expect(decoded.byteLength).toBe(large.byteLength);
    expect(decoded[0]).toBe(0);
    expect(decoded[255]).toBe(255);
    expect(decoded[large.length - 1]).toBe(255);
  });

  it('signs verifiable RS256 JWT with both PKCS#1 (with literal \\n) and PKCS#8 keys', async () => {
    const { publicKey, privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
    const pkcs1Pem = privateKey.export({ type: 'pkcs1', format: 'pem' }).toString();
    const pkcs8Pem = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
    const escapedPkcs1Pem = pkcs1Pem.replace(/\n/g, '\\n');

    for (const pem of [pkcs1Pem, escapedPkcs1Pem, pkcs8Pem]) {
      const jwt = await signJwtRs256({ iss: '12345', iat: 1000, exp: 1600 }, pem);
      const [h, p, s] = jwt.split('.');
      const ok = nodeCryptoVerify(
        'sha256',
        Buffer.from(`${h}.${p}`),
        publicKey,
        Buffer.from(s, 'base64url'),
      );
      expect(ok).toBe(true);
    }
  });

  it('encodes git ref path segments without escaping slashes and detects image magic bytes', () => {
    expect(encodeGitRefPath('submit/20261125-demo-abcdef')).toBe('submit/20261125-demo-abcdef');
    expect(encodeGitRefPath('submit/a b/c')).toBe('submit/a%20b/c');
    expect(detectImageMimeFromBytes(VALID_WEBP)).toBe('image/webp');
    expect(detectImageMimeFromBytes(FAKE_MP4)).toBeNull();
  });
});

describe('worker hardened OAuth flow (pinned callback, browser nonce cookie, PKCE, single-use ticket)', () => {
  it('pins callback path to PAGES_BASE_URL and blocks sibling repos on same github.io host', () => {
    expect(
      isAllowedCallbackUrl('https://vioaki.github.io/Prompt-Manager-Pages/#/auth/callback?next=%2Fupload', mockEnv),
    ).toBe(true);
    expect(
      isAllowedCallbackUrl('https://vioaki.github.io/Prompt-Manager-Pages#/auth/callback', mockEnv),
    ).toBe(true);
    expect(
      isAllowedCallbackUrl('https://vioaki.github.io/other-evil-repo/#/auth/callback', mockEnv),
    ).toBe(false);
    expect(
      isAllowedCallbackUrl('https://vioaki.github.io/#/auth/callback', mockEnv),
    ).toBe(false);
    expect(
      isAllowedCallbackUrl('http://localhost:5173/#/auth/callback?next=%2Fupload', mockEnv),
    ).toBe(true);
  });

  it('enforces nonce cookie + PKCE verifier + atomic single-use ticket + rejects malformed exchange bodies', async () => {
    // Malformed /auth/exchange bodies must return 400, never 500
    for (const rawBody of ['null', '[]', '{"ticket":123,"verifier":"x"}']) {
      const badResp = await worker.fetch(
        new Request('https://worker.example.dev/auth/exchange', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: rawBody,
        }),
        mockEnv,
      );
      expect(badResp.status).toBe(400);
    }

    const verifier = 'browser_generated_pkce_verifier_secret_1234567890';
    const challenge = await sha256Base64Url(verifier);
    const redirect = 'https://vioaki.github.io/Prompt-Manager-Pages/#/auth/callback?next=%2Fupload';

    // Step 1: /auth/login sets HttpOnly nonce cookie and redirects to GitHub
    const loginResp = await worker.fetch(
      new Request(
        `https://worker.example.dev/auth/login?redirect=${encodeURIComponent(redirect)}&challenge=${encodeURIComponent(challenge)}`,
      ),
      mockEnv,
    );
    expect(loginResp.status).toBe(302);
    const setCookie = loginResp.headers.get('Set-Cookie') || '';
    expect(setCookie).toContain('pm_oauth_nonce=');
    expect(setCookie).toContain('HttpOnly');
    expect(setCookie).toContain('SameSite=Lax');
    const cookiePair = setCookie.split(';')[0];

    const ghUrl = new URL(loginResp.headers.get('Location')!);
    const state = ghUrl.searchParams.get('state')!;
    expect(state).toBeTruthy();

    // Step 2a: /auth/callback WITHOUT matching cookie is rejected (CSRF protection)
    const noCookieResp = await worker.fetch(
      new Request(`https://worker.example.dev/auth/callback?code=gh_code&state=${encodeURIComponent(state)}`),
      mockEnv,
    );
    expect(noCookieResp.status).toBe(400);

    // Step 2b: /auth/callback WITH matching cookie succeeds and issues ticket
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url.includes('/login/oauth/access_token')) {
          return Response.json({ access_token: 'gho_temp' });
        }
        if (url === 'https://api.github.com/user') {
          return Response.json({
            id: 424242,
            login: 'alice',
            name: 'Alice',
            avatar_url: 'https://avatars.githubusercontent.com/u/424242',
          });
        }
        throw new Error(`Unexpected fetch: ${url}`);
      }),
    );

    const cbResp = await worker.fetch(
      new Request(`https://worker.example.dev/auth/callback?code=gh_code&state=${encodeURIComponent(state)}`, {
        headers: { Cookie: cookiePair },
      }),
      mockEnv,
    );
    expect(cbResp.status).toBe(302);
    const finalLoc = cbResp.headers.get('Location')!;
    const ticketMatch = /[?&]ticket=([^&]+)/.exec(finalLoc);
    expect(ticketMatch).toBeTruthy();
    const ticket = decodeURIComponent(ticketMatch![1]);

    // Step 3a: Wrong PKCE verifier is rejected (401) without consuming ticket
    const wrongVerifierResp = await worker.fetch(
      new Request('https://worker.example.dev/auth/exchange', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ticket, verifier: 'wrong_verifier_secret_that_is_long_enough_12345' }),
      }),
      mockEnv,
    );
    expect(wrongVerifierResp.status).toBe(401);

    // Step 3b: Valid verifier exchanges ticket ONCE
    const okExchange = await worker.fetch(
      new Request('https://worker.example.dev/auth/exchange', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ticket, verifier }),
      }),
      mockEnv,
    );
    expect(okExchange.status).toBe(200);
    const session = (await okExchange.json()) as { token: string; user: SessionUser };
    expect(session.user.login).toBe('alice');

    // Step 3c: Replaying the exact same ticket + verifier a second time is rejected (401)
    const replayExchange = await worker.fetch(
      new Request('https://worker.example.dev/auth/exchange', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ticket, verifier }),
      }),
      mockEnv,
    );
    expect(replayExchange.status).toBe(401);
  });
});

describe('worker submission -> atomic PR with contributor noreply author', () => {
  it('creates branch commit with contributor noreply email and opens PR', async () => {
    const user: SessionUser = {
      id: 424242,
      login: 'alice',
      name: 'Alice Dev',
      avatarUrl: 'https://avatars.githubusercontent.com/u/424242',
      isAdmin: false,
    };
    const token = await makeSessionToken(user);

    const calls: Array<{ url: string; method: string; body?: Record<string, unknown> }> = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        const method = init?.method || 'GET';
        const body = typeof init?.body === 'string' ? JSON.parse(init.body) : undefined;
        calls.push({ url, method, body });

        if (url.endsWith('/git/ref/heads/main')) {
          return Response.json({ object: { sha: 'commit_parent_sha' } });
        }
        if (url.endsWith('/git/commits/commit_parent_sha')) {
          return Response.json({ tree: { sha: 'tree_base_sha' } });
        }
        if (url.endsWith('/git/blobs')) {
          return Response.json({ sha: `blob_${calls.length}` });
        }
        if (url.endsWith('/git/trees')) {
          return Response.json({ sha: 'tree_new_sha' });
        }
        if (url.endsWith('/git/commits')) {
          return Response.json({ sha: 'commit_new_sha' });
        }
        if (url.endsWith('/git/refs')) {
          return Response.json({ ref: body?.ref });
        }
        if (url.endsWith('/pulls')) {
          return Response.json({
            number: 17,
            html_url: 'https://github.com/vioaki/Prompt-Manager-Pages/pull/17',
          });
        }
        throw new Error(`Unexpected fetch: ${method} ${url}`);
      }),
    );

    const form = new FormData();
    form.set(
      'payload',
      JSON.stringify({
        title: 'Neon Cat',
        category: 'template',
        prompt: 'A neon cat {{Color}}',
        description: 'test desc',
        tags: ['banana', '二次元'],
        authorName: 'Alice Dev',
        anonymous: false,
        mainWidth: 1024,
        mainHeight: 1024,
        refLayout: [{ kind: 'placeholder', label: 'User' }],
      }),
    );
    form.set('main', new File([VALID_WEBP], 'main.webp', { type: 'image/webp' }));
    form.set('thumb', new File([VALID_WEBP], 'thumb.webp', { type: 'image/webp' }));

    const req = new Request('https://worker.example.dev/api/submit', {
      method: 'POST',
      headers: {
        Origin: 'https://vioaki.github.io',
        Authorization: `Bearer ${token}`,
      },
      body: form,
    });

    const resp = await worker.fetch(req, mockEnv);
    expect(resp.status).toBe(201);
    const data = (await resp.json()) as { prNumber: number; prUrl: string };
    expect(data.prNumber).toBe(17);

    const commitCall = calls.find((c) => c.url.endsWith('/git/commits') && c.method === 'POST');
    expect(commitCall?.body?.author).toMatchObject({
      name: 'Alice Dev',
      email: '424242+alice@users.noreply.github.com',
    });
  });

  it('rejects disguised video uploads by magic bytes', async () => {
    const token = await makeSessionToken({
      id: 1,
      login: 'bob',
      name: 'Bob',
      avatarUrl: '',
      isAdmin: false,
    });

    const form = new FormData();
    form.set(
      'payload',
      JSON.stringify({
        title: 'Bad Video',
        category: 'gallery',
        prompt: 'test',
        description: '',
        tags: [],
        authorName: '',
        anonymous: true,
        mainWidth: 512,
        mainHeight: 512,
        refLayout: [],
      }),
    );
    form.set('main', new File([FAKE_MP4], 'fake.webp', { type: 'image/webp' }));

    const req = new Request('https://worker.example.dev/api/submit', {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}` },
      body: form,
    });
    const resp = await worker.fetch(req, mockEnv);
    expect(resp.status).toBe(400);
  });
});

describe('worker legacy read API & hardened admin endpoints', () => {
  it('serves /api/gallery with legacy response shape, Isolate cache, Expose-Headers, and ETag 304', async () => {
    const catalog = {
      schemaVersion: 1,
      generatedAt: '2026-11-25T00:00:00Z',
      total: 1,
      items: [
        {
          id: '20251205-card-0001',
          contentPath: 'content/2025/20251205-card-0001',
          title: '手绘卡片',
          category: 'gallery',
          prompt: 'hand drawn card',
          description: '',
          tags: ['banana'],
          author: { name: 'vioaki', github: 'vioaki' },
          media: {
            mainUrl: 'media/20251205-card-0001/main.webp',
            thumbUrl: 'media/20251205-card-0001/thumb.webp',
            mimeType: 'image/webp',
            width: 800,
            height: 1200,
          },
          refs: [],
          createdAt: '2025-12-05T14:37:45Z',
        },
      ],
    };

    const fetchMock = vi.fn(async (_input: RequestInfo | URL) => Response.json(catalog));
    vi.stubGlobal('fetch', fetchMock);

    const req1 = new Request('https://worker.example.dev/api/gallery?page=1&per_page=10&tag=banana');
    const resp1 = await worker.fetch(req1, mockEnv);
    expect(resp1.status).toBe(200);
    expect(resp1.headers.get('Access-Control-Expose-Headers')).toBe('ETag');
    const etag = resp1.headers.get('ETag');
    expect(etag).toBeTruthy();
    expect(fetchMock).toHaveBeenCalledTimes(1);

    const body = (await resp1.json()) as {
      code: number;
      data: Array<{ id: number; file_path: string; media_type: string }>;
      meta: { total_items: number; server_timestamp: number };
    };
    expect(body.code).toBe(200);
    expect(body.meta.total_items).toBe(1);
    expect(typeof body.meta.server_timestamp).toBe('number');
    expect(body.data[0].id).toBe(1);
    expect(body.data[0].file_path).toBe(
      'https://vioaki.github.io/Prompt-Manager-Pages/media/20251205-card-0001/main.webp',
    );

    const req2 = new Request('https://worker.example.dev/api/gallery?page=1&per_page=10&tag=banana', {
      headers: { 'If-None-Match': etag! },
    });
    const resp2 = await worker.fetch(req2, mockEnv);
    expect(resp2.status).toBe(304);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('lists PR summaries in 1 upstream subrequest (even with 30 PRs) and surfaces upstream errors', async () => {
    const adminToken = await makeSessionToken({
      id: 99,
      login: 'vioaki',
      name: 'Vioaki',
      avatarUrl: '',
      isAdmin: true,
    });

    const thirtyPrs = Array.from({ length: 20 }, (_, i) => ({
      number: i + 1,
      state: 'open',
      html_url: `https://github.com/vioaki/Prompt-Manager-Pages/pull/${i + 1}`,
      title: `feat(prompt): Item ${i + 1}`,
      body: 'Submitted by @alice',
      created_at: '2026-11-25T00:00:00Z',
      user: { login: 'bot' },
      base: { ref: 'main' },
      head: {
        ref: `submit/20261125-item-${i + 1}`,
        sha: `sha_${i + 1}`,
        repo: { full_name: 'vioaki/Prompt-Manager-Pages' },
      },
    }));

    const fetchMock = vi.fn(async () => Response.json(thirtyPrs));
    vi.stubGlobal('fetch', fetchMock);

    const listResp = await worker.fetch(
      new Request('https://worker.example.dev/api/admin/prs?page=1&per_page=20', {
        headers: { Authorization: `Bearer ${adminToken}` },
      }),
      mockEnv,
    );
    expect(listResp.status).toBe(200);
    const data = (await listResp.json()) as { prs: unknown[]; hasNext: boolean };
    expect(data.prs).toHaveLength(20);
    expect(data.hasNext).toBe(false);
    // Strictly 1 upstream fetch, never N+1
    expect(fetchMock).toHaveBeenCalledTimes(1);

    // Upstream failure must propagate instead of returning silent 200 []
    vi.stubGlobal('fetch', vi.fn(async () => new Response('rate limited', { status: 429 })));
    const errResp = await worker.fetch(
      new Request('https://worker.example.dev/api/admin/prs', {
        headers: { Authorization: `Bearer ${adminToken}` },
      }),
      mockEnv,
    );
    expect(errResp.status).toBe(500);
  });

  it('blocks multi-item/config PRs, ignores spoofed comments, enforces headSha lock, and caches App token', async () => {
    const normalToken = await makeSessionToken({
      id: 2,
      login: 'stranger',
      name: 'Stranger',
      avatarUrl: '',
      isAdmin: false,
    });
    const forbiddenResp = await worker.fetch(
      new Request('https://worker.example.dev/api/admin/prs', {
        headers: { Authorization: `Bearer ${normalToken}` },
      }),
      mockEnv,
    );
    expect(forbiddenResp.status).toBe(403);

    const adminToken = await makeSessionToken({
      id: 99,
      login: 'vioaki',
      name: 'Vioaki',
      avatarUrl: '',
      isAdmin: true,
    });

    const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
    const appEnv: Env = {
      ...mockEnv,
      GITHUB_BOT_TOKEN: undefined,
      GITHUB_APP_ID: '123456',
      GITHUB_APP_INSTALLATION_ID: '987654',
      GITHUB_APP_PRIVATE_KEY: privateKey.export({ type: 'pkcs1', format: 'pem' }).toString(),
    };

    const trustedAiComment = [
      BOT_COMMENT_MARKER,
      'preview',
      encodeAiBundleBlock({
        headSha: 'headsha_1',
        items: {
          '20261125-demo-abcdef': {
            suggestedTags: ['二次元'],
            nsfwRisk: false,
            generatedAt: '2026-11-25T00:00:00Z',
          },
        },
      }),
    ].join('\n');

    const spoofedUserComment = [
      BOT_COMMENT_MARKER,
      encodeAiBundleBlock({
        headSha: 'headsha_1',
        items: {
          '20261125-demo-abcdef': {
            suggestedTags: ['EVIL_SPOOF'],
            nsfwRisk: false,
            generatedAt: '2026-11-25T00:00:00Z',
          },
        },
      }),
    ].join('\n');

    let mergeBody: Record<string, unknown> | undefined;
    let appTokenRequests = 0;
    const calledUrls: string[] = [];

    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        const method = init?.method || 'GET';
        calledUrls.push(`${method} ${url}`);

        if (url.endsWith('/app/installations/987654/access_tokens')) {
          appTokenRequests += 1;
          return Response.json({
            token: 'ghs_cached_app_token',
            expires_at: new Date(Date.now() + 3600_000).toISOString(),
          });
        }
        // PR #5: clean single-item submission
        if (url.endsWith('/pulls/5') && method === 'GET') {
          return Response.json({
            number: 5,
            state: 'open',
            changed_files: 3,
            html_url: 'https://github.com/vioaki/Prompt-Manager-Pages/pull/5',
            title: 'feat(prompt): Demo (@alice)',
            body: 'Submitted by @alice',
            created_at: '2026-11-25T00:00:00Z',
            user: { login: 'bot' },
            base: { ref: 'main' },
            head: {
              ref: 'submit/20261125-demo-abcdef',
              sha: 'headsha_1',
              repo: { full_name: 'vioaki/Prompt-Manager-Pages' },
            },
          });
        }
        if (url.includes('/pulls/5/files')) {
          return Response.json([
            { filename: 'content/2026/20261125-demo-abcdef/meta.json', status: 'added' },
            { filename: 'content/2026/20261125-demo-abcdef/main.webp', status: 'added' },
            { filename: 'content/2026/20261125-demo-abcdef/thumb.webp', status: 'added' },
          ]);
        }
        if (url.includes('/issues/5/comments')) {
          return Response.json([
            {
              body: trustedAiComment,
              user: { login: 'github-actions[bot]', type: 'Bot' },
            },
            {
              body: spoofedUserComment,
              user: { login: 'attacker', type: 'User' },
            },
          ]);
        }
        // PR #8 changes an item and moves a path from outside that item.
        if (url.endsWith('/pulls/8') && method === 'GET') {
          return Response.json({
            number: 8,
            state: 'open',
            changed_files: 2,
            html_url: 'https://github.com/vioaki/Prompt-Manager-Pages/pull/8',
            title: 'sneaky pr',
            body: '',
            created_at: '2026-11-25T00:00:00Z',
            user: { login: 'attacker' },
            base: { ref: 'main' },
            head: {
              ref: 'submit/20261125-demo-abcdef',
              sha: 'sneaky_sha',
              repo: { full_name: 'vioaki/Prompt-Manager-Pages' },
            },
          });
        }
        if (url.includes('/pulls/8/files')) {
          return Response.json([
            { filename: 'content/2026/20261125-demo-abcdef/meta.json', status: 'added' },
            { filename: 'content/2026/20261125-demo-abcdef/from-outside.webp', previous_filename: 'site.config.json', status: 'renamed' },
          ]);
        }
        if (url.includes('/contents/content/2026/20261125-demo-abcdef/meta.json')) {
          return Response.json({
            content: btoa(JSON.stringify(SAMPLE_META)),
            encoding: 'base64',
          });
        }
        if (url.includes('/contents/content/2026/20261125-demo-abcdef?ref=headsha_1')) {
          return Response.json([
            { path: 'content/2026/20261125-demo-abcdef/meta.json', type: 'file' },
            { path: 'content/2026/20261125-demo-abcdef/main.webp', type: 'file' },
            { path: 'content/2026/20261125-demo-abcdef/thumb.webp', type: 'file' },
            { path: 'content/2026/20261125-demo-abcdef/credits.txt', type: 'file' },
          ]);
        }
        if (url.includes('/actions/workflows/pr-preview.yml/runs')) {
          return Response.json({ workflow_runs: [{
            head_sha: 'headsha_1', head_branch: 'submit/20261125-demo-abcdef',
            head_repository: { full_name: 'vioaki/Prompt-Manager-Pages' },
            pull_requests: [{ number: 5 }], conclusion: 'success',
          }] });
        }
        if (url.endsWith('/git/commits/headsha_1')) {
          return Response.json({ tree: { sha: 'pr_tree_sha' } });
        }
        if (url.endsWith('/git/blobs')) {
          return Response.json({ sha: 'blob_updated_meta' });
        }
        if (url.endsWith('/git/trees')) {
          return Response.json({ sha: 'tree_updated_sha' });
        }
        if (url.endsWith('/git/commits') && method === 'POST') {
          return Response.json({ sha: 'commit_updated_sha' });
        }
        if (url.endsWith('/git/refs/heads/submit/20261125-demo-abcdef') && method === 'PATCH') {
          return Response.json({ ref: 'refs/heads/submit/20261125-demo-abcdef' });
        }
        if (url.endsWith('/pulls/5/merge')) {
          mergeBody = JSON.parse(String(init?.body || '{}'));
          return Response.json({ merged: true });
        }
        if (url.endsWith('/git/refs/heads/submit/20261125-demo-abcdef') && method === 'DELETE') {
          return new Response(null, { status: 204 });
        }
        throw new Error(`Unexpected fetch: ${method} ${url}`);
      }),
    );

    // 1. PR #8 touching site.config.json is marked reviewableInApp=false and rejected by approve
    const detail8 = await worker.fetch(
      new Request('https://worker.example.dev/api/admin/prs/8', {
        headers: { Authorization: `Bearer ${adminToken}` },
      }),
      appEnv,
    );
    expect(detail8.status).toBe(200);
    const detail8Body = (await detail8.json()) as { pr: { reviewableInApp: boolean } };
    expect(detail8Body.pr.reviewableInApp).toBe(false);

    const approve8 = await worker.fetch(
      new Request('https://worker.example.dev/api/admin/prs/8/approve', {
        method: 'POST',
        headers: { Authorization: `Bearer ${adminToken}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ expectedHeadSha: 'sneaky_sha' }),
      }),
      appEnv,
    );
    expect(approve8.status).toBe(400);

    // 2. PR #5 detail ignores attacker's spoofed comment and keeps trusted bot suggestion
    const detail5 = await worker.fetch(
      new Request('https://worker.example.dev/api/admin/prs/5', {
        headers: { Authorization: `Bearer ${adminToken}` },
      }),
      appEnv,
    );
    const detail5Body = (await detail5.json()) as {
      pr: { reviewableInApp: boolean; aiSuggestion: { suggestedTags: string[] } | null };
    };
    expect(detail5Body.pr.reviewableInApp).toBe(true);
    expect(detail5Body.pr.aiSuggestion?.suggestedTags).toEqual(['二次元']);

    // 3. Approve with stale expectedHeadSha returns 409 Conflict
    const staleApprove = await worker.fetch(
      new Request('https://worker.example.dev/api/admin/prs/5/approve', {
        method: 'POST',
        headers: { Authorization: `Bearer ${adminToken}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ expectedHeadSha: 'outdated_sha' }),
      }),
      appEnv,
    );
    expect(staleApprove.status).toBe(409);

    // An edit is saved at the reviewed SHA and awaits validation of the new head.
    const editForm = new FormData();
    editForm.set('expectedHeadSha', 'headsha_1');
    editForm.set(
      'payload',
      JSON.stringify({
        title: 'Demo Normalized',
        category: 'template',
        prompt: 'hello {{Name}}',
        description: '',
        tags: ['banana', '模板'],
        authorName: 'alice',
        anonymous: false,
        mainWidth: 800,
        mainHeight: 800,
        refLayout: [],
      }),
    );

    const approveResp = await worker.fetch(
      new Request('https://worker.example.dev/api/admin/prs/5/approve', {
        method: 'POST',
        headers: { Authorization: `Bearer ${adminToken}` },
        body: editForm,
      }),
      appEnv,
    );
    expect(approveResp.status).toBe(202);
    expect(await approveResp.json()).toMatchObject({ merged: false, headSha: 'commit_updated_sha' });
    expect(mergeBody).toBeUndefined();
    expect(appTokenRequests).toBe(1);
    expect(calledUrls.some((u) => u.split('?')[0].includes('%2F'))).toBe(false);
    expect(calledUrls).toContain(
      'PATCH https://api.github.com/repos/vioaki/Prompt-Manager-Pages/git/refs/heads/submit/20261125-demo-abcdef',
    );
    expect(calledUrls).not.toContain(
      'DELETE https://api.github.com/repos/vioaki/Prompt-Manager-Pages/git/refs/heads/submit/20261125-demo-abcdef',
    );

    // An unchanged form can approve the checked head without committing or deleting sidecar files.
    const unchanged = {
      ...JSON.parse(String(editForm.get('payload'))), title: SAMPLE_META.title,
      category: SAMPLE_META.category, prompt: SAMPLE_META.prompt, tags: SAMPLE_META.tags,
    };
    const postForm = (payload: unknown) => {
      editForm.set('payload', JSON.stringify(payload));
      return worker.fetch(new Request('https://worker.example.dev/api/admin/prs/5/approve', {
        method: 'POST', headers: { Authorization: `Bearer ${adminToken}` }, body: editForm,
      }), appEnv);
    };
    const badRef = await postForm({ ...unchanged, refLayout: [{ kind: 'existing-image', file: 'ref-0.webp' }] });
    expect(badRef.status).toBe(400);
    expect(mergeBody).toBeUndefined();
    const beforeApproval = calledUrls.length;
    expect((await postForm(unchanged)).status).toBe(200);
    expect(mergeBody).toMatchObject({ sha: 'headsha_1' });
    expect(calledUrls.slice(beforeApproval).some((call) => call.startsWith('POST '))).toBe(false);
  });

  it('refuses editing external fork PRs via approve FormData and returns 409 on main edit conflict', async () => {
    const adminToken = await makeSessionToken({
      id: 99,
      login: 'vioaki',
      name: 'Vioaki',
      avatarUrl: '',
      isAdmin: true,
    });

    let conclusion = 'in_progress';
    const calledUrls: string[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        const method = init?.method || 'GET';
        calledUrls.push(`${method} ${url}`);
        if (url.endsWith('/pulls/9') && method === 'GET') {
          return Response.json({
            number: 9,
            state: 'open',
            changed_files: 1,
            html_url: 'https://github.com/vioaki/Prompt-Manager-Pages/pull/9',
            title: 'feat: fork pr',
            body: '',
            created_at: '2026-11-25T00:00:00Z',
            user: { login: 'ext' },
            base: { ref: 'main' },
            head: {
              ref: 'main',
              sha: 'forksha',
              repo: { full_name: 'ext/Prompt-Manager-Pages' },
            },
          });
        }
        if (url.includes('/pulls/9/files')) {
          return Response.json([
            { filename: 'content/2026/20261125-demo-abcdef/meta.json', status: 'added' },
          ]);
        }
        if (url.includes('/repos/ext/Prompt-Manager-Pages/contents/')) {
          return Response.json({
            content: btoa(JSON.stringify(SAMPLE_META)),
            encoding: 'base64',
          });
        }
        if (url.includes('/actions/workflows/pr-preview.yml/runs')) {
          return Response.json({ workflow_runs: [{ head_sha: 'forksha', head_branch: 'main',
            head_repository: { full_name: 'ext/Prompt-Manager-Pages' }, conclusion }] });
        }
        if (url.endsWith('/pulls/9/merge')) {
          return Response.json({ merged: true });
        }
        if (url.endsWith('/git/ref/heads/main')) {
          return Response.json({ object: { sha: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' } });
        }
        if (url.includes('/contents/content/2026/20261125-demo-abcdef?ref=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa')) {
          return Response.json([
            { path: 'content/2026/20261125-demo-abcdef/meta.json', type: 'file' },
            { path: 'content/2026/20261125-demo-abcdef/main.webp', type: 'file' },
          ]);
        }
        if (url.includes('/contents/content/2026/20261125-demo-abcdef/meta.json?ref=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa')) {
          return Response.json({ content: btoa(JSON.stringify(SAMPLE_META)), encoding: 'base64' });
        }
        if (url.endsWith('/git/commits/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa')) {
          return Response.json({ tree: { sha: 'main_tree' } });
        }
        if (url.endsWith('/git/blobs')) {
          return Response.json({ sha: 'blob_1' });
        }
        if (url.endsWith('/git/trees')) {
          return Response.json({ sha: 'tree_1' });
        }
        if (url.endsWith('/git/commits') && method === 'POST') {
          return Response.json({ sha: 'commit_1' });
        }
        if (url.endsWith('/git/refs/heads/main') && method === 'PATCH') {
          return new Response('Update is not a fast forward', { status: 422 });
        }
        throw new Error(`Unexpected fetch: ${method} ${url}`);
      }),
    );

    const form = new FormData();
    form.set('expectedHeadSha', 'forksha');
    form.set(
      'payload',
      JSON.stringify({
        title: 'Edited Fork',
        category: 'gallery',
        prompt: 'edited',
        description: '',
        tags: [],
        authorName: 'ext',
        anonymous: false,
        mainWidth: 800,
        mainHeight: 800,
        refLayout: [],
      }),
    );

    const rejected = await worker.fetch(
      new Request('https://worker.example.dev/api/admin/prs/9/approve', {
        method: 'POST',
        headers: { Authorization: `Bearer ${adminToken}` },
        body: form,
      }),
      mockEnv,
    );
    expect(rejected.status).toBe(400);
    expect(calledUrls.some((u) => u.includes('/git/refs'))).toBe(false);

    // Direct merge with matching expectedHeadSha succeeds without touching upstream refs
    const approve = () => worker.fetch(new Request('https://worker.example.dev/api/admin/prs/9/approve', {
      method: 'POST', headers: { Authorization: `Bearer ${adminToken}`, 'X-Expected-Head-Sha': 'forksha' },
    }), mockEnv);
    expect((await approve()).status).toBe(412);
    expect(calledUrls.some((url) => url.endsWith('/merge'))).toBe(false);
    conclusion = 'success';
    const merged = await worker.fetch(
      new Request('https://worker.example.dev/api/admin/prs/9/approve', {
        method: 'POST',
        headers: { Authorization: `Bearer ${adminToken}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ expectedHeadSha: 'forksha' }),
      }),
      mockEnv,
    );
    expect(merged.status).toBe(200);
    expect(calledUrls.some((u) => u.includes('/git/refs'))).toBe(false);

    // Concurrent edit on main returning 422 non-fast-forward maps cleanly to 409 Conflict
    const editConflict = await worker.fetch(
      new Request('https://worker.example.dev/api/admin/items/20261125-demo-abcdef', {
        method: 'PUT',
        headers: { Authorization: `Bearer ${adminToken}`, 'X-Expected-Head-Sha': 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' },
        body: form,
      }),
      mockEnv,
    );
    expect(editConflict.status).toBe(409);
  });
});

describe('release regressions', () => {
  it('refuses stale media snapshots but allows an unrelated change to main', async () => {
    const dir = 'content/2026/item';
    const before = [{ path: dir + '/main.webp', type: 'file', sha: 'image-v1' }];
    let current = before;
    vi.stubGlobal('fetch', vi.fn(async (url: string) => Response.json(url.endsWith('ref=old') ? before : current)));
    expect(await getReviewedItemFiles(mockEnv, dir, 'new', 'old')).toEqual([before[0].path]);
    current = [{ ...before[0], sha: 'image-v2' }];
    expect(await getReviewedItemFiles(mockEnv, dir, 'new', 'old')).toBeNull();
    current = [];
    expect(await getReviewedItemFiles(mockEnv, dir, 'new', 'old')).toBeNull();
  });

  it('enforces the total for files, known lengths and chunked multipart bodies', async () => {
    const url = 'https://test.invalid/upload';
    const large = new Uint8Array(MAX_TOTAL_UPLOAD_BYTES + 1);
    const form = new FormData();
    form.set('main', new File([large], 'main.gif'));
    const result = await readUploadForm(new Request(url, { method: 'POST', body: form }));
    expect(result).toBeInstanceOf(Response);
    expect((result as Response).status).toBe(413);
    for (const knownLength of [true, false]) {
      const request = new Request(url, { method: 'POST', body: new Uint8Array(MAX_TOTAL_UPLOAD_BYTES + 200_000),
        headers: { 'Content-Type': 'multipart/form-data; boundary=x' } });
      if (knownLength) request.headers.set('Content-Length', String(MAX_TOTAL_UPLOAD_BYTES + 200_000));
      expect((await readUploadForm(request) as Response).status).toBe(413);
    }
  });

  it('checks slash-command validation receipts against the trusted run', async () => {
    const pr: PendingPrSummary = {
      prNumber: 5, prUrl: '', prTitle: '', branch: 'submit/test', baseBranch: 'main', headSha: 'revision',
      headRepoFullName: 'vioaki/Prompt-Manager-Pages', isCrossRepo: false, createdAt: '', submittedBy: '', userAvatarUrl: '', draft: false,
    };
    let path = '.github/workflows/pr-command.yml';
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      if (url.includes('/workflows/pr-preview.yml/')) return Response.json({ workflow_runs: [] });
      if (url.includes('/artifacts?')) return Response.json({ artifacts: [{
        name: 'validated-pr-5-revision', expired: false, workflow_run: { id: 42, head_branch: 'main' },
      }] });
      return Response.json({ event: 'issue_comment', conclusion: 'success', path, head_repository: { full_name: pr.headRepoFullName } });
    }));
    expect(await hasValidatedHead(mockEnv, pr)).toBe(true);
    path = '.github/workflows/other.yml';
    expect(await hasValidatedHead(mockEnv, pr)).toBe(false);
    expect(await hasValidatedHead(mockEnv, { ...pr, isCrossRepo: true })).toBe(false);
  });

  it('falls back to the category feed on an older or differently hosted static site', async () => {
    for (const unavailable of ['<!doctype html>\n<html>', '{"mediaBaseUrl":"https://old.invalid"}\n[]']) {
      clearLegacyApiCache();
      vi.stubGlobal('fetch', vi.fn(async (url: string) => url.endsWith('.all.jsonl')
        ? new Response(unavailable)
        : Response.json({ items: [] })));
      const res = await worker.fetch(new Request('https://test.invalid/api/templates?per_page=-1'), mockEnv);
      expect(res.status).toBe(200);
      expect(await res.json()).toMatchObject({ data: [], meta: { total_items: 0 } });
    }
  });

  it('serves prepared legacy data and honors conditional GET on a cold isolate', async () => {
    const header = { mediaBaseUrl: mockEnv.PAGES_BASE_URL, meta: { page: 1 }, etag: '"stable"' };
    const upstream = vi.fn(async (url: string) => {
      expect(url).toMatch(/gallery\.all\.jsonl$/);
      return new Response(JSON.stringify(header) + '\n[{"id":"prepared"}]');
    });
    vi.stubGlobal('fetch', upstream);
    const url = 'https://test.invalid/api/gallery?per_page=-1';
    const res = await worker.fetch(new Request(url), mockEnv);
    expect(await res.json()).toMatchObject({ meta: { page: 1, server_timestamp: expect.any(Number) }, data: [{ id: 'prepared' }] });
    clearLegacyApiCache();
    expect((await worker.fetch(new Request(url, { headers: { 'If-None-Match': '"stable"' } }), mockEnv)).status).toBe(304);
    expect(upstream).toHaveBeenCalledTimes(2);
  });
});
