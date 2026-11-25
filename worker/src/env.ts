export interface Env {
  GITHUB_OWNER: string;
  GITHUB_REPO: string;
  GITHUB_DEFAULT_BRANCH?: string;
  PAGES_BASE_URL: string;
  ALLOWED_ORIGINS: string;
  ADMIN_LOGINS?: string;

  // OAuth App (minimum read:user scope)
  GITHUB_CLIENT_ID: string;
  GITHUB_CLIENT_SECRET: string;
  SESSION_SECRET: string;
  OAUTH_TICKETS: DurableObjectNamespace;

  // Write credentials: Option A (GitHub App) or Option B (Fine-grained PAT)
  GITHUB_BOT_TOKEN?: string;
  GITHUB_APP_ID?: string;
  GITHUB_APP_INSTALLATION_ID?: string;
  GITHUB_APP_PRIVATE_KEY?: string;
}

export interface SessionUser {
  id: number;
  login: string;
  name: string;
  avatarUrl: string;
  isAdmin: boolean;
}

export function getAdminLogins(env: Env): Set<string> {
  return new Set(
    (env.ADMIN_LOGINS || '')
      .split(',')
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean),
  );
}

export function getAllowedOrigins(env: Env): string[] {
  return (env.ALLOWED_ORIGINS || '')
    .split(',')
    .map((s) => s.trim().replace(/\/+$/, ''))
    .filter(Boolean);
}
