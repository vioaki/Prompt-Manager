import {
  handleAdminApprovePr,
  handleAdminClosePr,
  handleAdminDeleteItem,
  handleAdminGetPr,
  handleAdminListPrs,
  handleAdminUpdateConfig,
  handleAdminUpdateItem,
} from './admin.js';
import {
  handleAuthCallback,
  handleAuthExchange,
  handleAuthLogin,
  handleAuthMe,
} from './auth.js';
import { getAllowedOrigins, type Env } from './env.js';
import { handleLegacyReadApi } from './legacyReadApi.js';
import { handleSubmit } from './submit.js';

function resolveCorsHeaders(request: Request, env: Env, isPublicReadApi: boolean): Record<string, string> {
  const origin = request.headers.get('Origin') || '';
  const allowed = getAllowedOrigins(env);

  let allowOrigin = '';
  if (isPublicReadApi) {
    allowOrigin = '*';
  } else if (origin && allowed.includes(origin)) {
    allowOrigin = origin;
  }

  const headers: Record<string, string> = {
    'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization, If-None-Match, X-Expected-Head-Sha',
    'Access-Control-Expose-Headers': 'ETag',
    'Access-Control-Max-Age': '86400',
    Vary: 'Origin',
  };
  if (allowOrigin) {
    headers['Access-Control-Allow-Origin'] = allowOrigin;
  }
  return headers;
}

function withCors(response: Response, corsHeaders: Record<string, string>): Response {
  const next = new Response(response.body, response);
  for (const [k, v] of Object.entries(corsHeaders)) {
    next.headers.set(k, v);
  }
  return next;
}

export class OAuthTicket {
  constructor(private readonly state: DurableObjectState) {}

  async fetch(): Promise<Response> {
    const consumed = await this.state.storage.transaction(async (txn) => {
      if (await txn.get<boolean>('used')) return false;
      await txn.put('used', true);
      // Tickets expire after 60 seconds; retain the lock past the validity window.
      await txn.setAlarm(Date.now() + 90_000);
      return true;
    });
    return new Response(null, { status: consumed ? 204 : 409 });
  }

  async alarm(): Promise<void> {
    await this.state.storage.deleteAll();
  }
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const { pathname } = url;
    const method = request.method.toUpperCase();

    const isPublicReadApi =
      pathname === '/api/gallery' || pathname === '/api/templates' || pathname === '/health';
    const cors = resolveCorsHeaders(request, env, isPublicReadApi);

    if (method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: cors });
    }

    try {
      if (pathname === '/health' && method === 'GET') {
        return withCors(
          Response.json({
            status: 'ok',
            repo: `${env.GITHUB_OWNER}/${env.GITHUB_REPO}`,
          }),
          cors,
        );
      }

      // OAuth & Session
      if (pathname === '/auth/login' && method === 'GET') {
        return await handleAuthLogin(request, env);
      }
      if (pathname === '/auth/callback' && method === 'GET') {
        return await handleAuthCallback(request, env);
      }
      if (pathname === '/auth/exchange' && method === 'POST') {
        return withCors(await handleAuthExchange(request, env), cors);
      }
      if (pathname === '/auth/me' && method === 'GET') {
        return withCors(await handleAuthMe(request, env), cors);
      }

      // Legacy-compatible Read API
      if (pathname === '/api/gallery' && method === 'GET') {
        return withCors(await handleLegacyReadApi(request, env, 'gallery'), cors);
      }
      if (pathname === '/api/templates' && method === 'GET') {
        return withCors(await handleLegacyReadApi(request, env, 'template'), cors);
      }

      // Community Submission -> PR
      if (pathname === '/api/submit' && method === 'POST') {
        return withCors(await handleSubmit(request, env), cors);
      }

      // Admin API
      if (pathname === '/api/admin/prs' && method === 'GET') {
        return withCors(await handleAdminListPrs(request, env), cors);
      }

      const prDetailMatch = /^\/api\/admin\/prs\/(\d+)$/.exec(pathname);
      if (prDetailMatch && method === 'GET') {
        return withCors(
          await handleAdminGetPr(request, env, Number.parseInt(prDetailMatch[1], 10)),
          cors,
        );
      }

      const approveMatch = /^\/api\/admin\/prs\/(\d+)\/approve$/.exec(pathname);
      if (approveMatch && method === 'POST') {
        return withCors(
          await handleAdminApprovePr(request, env, Number.parseInt(approveMatch[1], 10)),
          cors,
        );
      }

      const closeMatch = /^\/api\/admin\/prs\/(\d+)\/close$/.exec(pathname);
      if (closeMatch && method === 'POST') {
        return withCors(
          await handleAdminClosePr(request, env, Number.parseInt(closeMatch[1], 10)),
          cors,
        );
      }

      const itemMatch = /^\/api\/admin\/items\/([a-z0-9-]+)$/.exec(pathname);
      if (itemMatch && method === 'PUT') {
        return withCors(await handleAdminUpdateItem(request, env, itemMatch[1]), cors);
      }
      if (itemMatch && method === 'DELETE') {
        return withCors(await handleAdminDeleteItem(request, env, itemMatch[1]), cors);
      }

      if (pathname === '/api/admin/config' && method === 'PUT') {
        return withCors(await handleAdminUpdateConfig(request, env), cors);
      }

      return withCors(Response.json({ error: 'Not Found' }, { status: 404 }), cors);
    } catch (err) {
      return withCors(
        Response.json(
          { error: (err as Error).message || 'Internal Server Error' },
          { status: 500 },
        ),
        cors,
      );
    }
  },
};
