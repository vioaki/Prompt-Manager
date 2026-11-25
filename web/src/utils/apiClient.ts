import type { AiSuggestion, PromptMeta, SiteConfig } from '@prompt-pages/shared';

export interface AuthUser {
  id: number;
  login: string;
  name: string;
  avatarUrl: string;
  isAdmin: boolean;
}

export interface PendingPrSummary {
  prNumber: number;
  prUrl: string;
  prTitle: string;
  branch: string;
  baseBranch: string;
  headSha: string;
  headRepoFullName: string;
  isCrossRepo: boolean;
  createdAt: string;
  submittedBy: string;
  userAvatarUrl: string;
  draft: boolean;
}

export interface PendingPrReviewDetail extends PendingPrSummary {
  reviewableInApp: boolean;
  inAppBlockReason?: string;
  changedFiles: string[];
  contentDir: string | null;
  meta: PromptMeta | null;
  mediaBaseUrl: string | null;
  aiSuggestion: AiSuggestion | null;
}

export class ApiError extends Error {
  status: number;

  constructor(message: string, status: number) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
  }
}

const OAUTH_VERIFIER_STORAGE_KEY = 'pm_oauth_pkce_verifier';

function cleanBase(url: string): string {
  return url.trim().replace(/\/+$/, '');
}

function bytesToBase64Url(bytes: Uint8Array): string {
  let binary = '';
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

export function getStoredOAuthVerifier(): string | null {
  try {
    return sessionStorage.getItem(OAUTH_VERIFIER_STORAGE_KEY);
  } catch {
    return null;
  }
}

export function clearStoredOAuthVerifier(): void {
  try {
    sessionStorage.removeItem(OAUTH_VERIFIER_STORAGE_KEY);
  } catch {
    // ignore
  }
}

async function parseJsonOrThrow<T>(resp: Response): Promise<T> {
  const text = await resp.text();
  let data: unknown;
  try {
    data = text ? JSON.parse(text) : {};
  } catch {
    throw new ApiError(`服务返回异常 (${resp.status}): ${text.slice(0, 120)}`, resp.status);
  }
  if (!resp.ok) {
    const msg =
      typeof data === 'object' && data && 'error' in data
        ? String((data as { error: unknown }).error)
        : `请求失败 (${resp.status})`;
    throw new ApiError(msg, resp.status);
  }
  return data as T;
}

export async function createOAuthLoginUrl(
  workerApiUrl: string,
  returnToHash: string,
): Promise<string> {
  const base = cleanBase(workerApiUrl);
  const verifierBytes = new Uint8Array(32);
  crypto.getRandomValues(verifierBytes);
  const verifier = bytesToBase64Url(verifierBytes);

  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier));
  const challenge = bytesToBase64Url(new Uint8Array(digest));

  try {
    sessionStorage.setItem(OAUTH_VERIFIER_STORAGE_KEY, verifier);
  } catch {
    // ignore storage errors
  }

  const normalizedPath = window.location.pathname
    .replace(/\/index\.html$/i, '')
    .replace(/\/+$/, '');
  const currentBase = `${window.location.origin}${normalizedPath}/`;
  const redirect = `${currentBase}#/auth/callback?next=${encodeURIComponent(returnToHash)}`;

  return `${base}/auth/login?redirect=${encodeURIComponent(redirect)}&challenge=${encodeURIComponent(challenge)}`;
}

export async function exchangeAuthTicket(
  workerApiUrl: string,
  ticket: string,
  verifier: string,
): Promise<{ token: string; user: AuthUser }> {
  const resp = await fetch(`${cleanBase(workerApiUrl)}/auth/exchange`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ticket, verifier }),
  });
  return parseJsonOrThrow(resp);
}

export async function fetchCurrentUser(
  workerApiUrl: string,
  token: string,
): Promise<{ user: AuthUser }> {
  const resp = await fetch(`${cleanBase(workerApiUrl)}/auth/me`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  return parseJsonOrThrow(resp);
}

export async function submitPromptPr(
  workerApiUrl: string,
  token: string,
  formData: FormData,
): Promise<{ id: string; prNumber: number; prUrl: string; branch: string }> {
  const resp = await fetch(`${cleanBase(workerApiUrl)}/api/submit`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}` },
    body: formData,
  });
  return parseJsonOrThrow(resp);
}

export async function fetchPendingPrs(
  workerApiUrl: string,
  token: string,
  page = 1,
  perPage = 20,
): Promise<{ prs: PendingPrSummary[]; page: number; perPage: number; hasNext: boolean }> {
  const resp = await fetch(
    `${cleanBase(workerApiUrl)}/api/admin/prs?page=${page}&per_page=${perPage}`,
    {
      headers: { Authorization: `Bearer ${token}` },
    },
  );
  return parseJsonOrThrow(resp);
}

export async function fetchPendingPrDetail(
  workerApiUrl: string,
  token: string,
  prNumber: number,
): Promise<{ pr: PendingPrReviewDetail }> {
  const resp = await fetch(`${cleanBase(workerApiUrl)}/api/admin/prs/${prNumber}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  return parseJsonOrThrow(resp);
}

export async function approvePendingPr(
  workerApiUrl: string,
  token: string,
  prNumber: number,
  expectedHeadSha: string,
  formData?: FormData,
): Promise<{ merged: true; prNumber: number; mergedSha: string } | { merged: false; saved: true; prNumber: number; headSha: string }> {
  const headers: Record<string, string> = {
    Authorization: `Bearer ${token}`,
    'X-Expected-Head-Sha': expectedHeadSha,
  };

  let body: BodyInit;
  if (formData) {
    formData.set('expectedHeadSha', expectedHeadSha);
    body = formData;
  } else {
    headers['Content-Type'] = 'application/json';
    body = JSON.stringify({ expectedHeadSha });
  }

  const resp = await fetch(`${cleanBase(workerApiUrl)}/api/admin/prs/${prNumber}/approve`, {
    method: 'POST',
    headers,
    body,
  });
  return parseJsonOrThrow(resp);
}

export async function closePendingPr(
  workerApiUrl: string,
  token: string,
  prNumber: number,
): Promise<{ closed: boolean; prNumber: number }> {
  const resp = await fetch(`${cleanBase(workerApiUrl)}/api/admin/prs/${prNumber}/close`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}` },
  });
  return parseJsonOrThrow(resp);
}

export async function updatePublishedItem(
  workerApiUrl: string,
  token: string,
  id: string,
  formData: FormData,
  sourceRevision?: string,
): Promise<{ updated: boolean; id: string; commitSha: string; meta: PromptMeta }> {
  const resp = await fetch(`${cleanBase(workerApiUrl)}/api/admin/items/${encodeURIComponent(id)}`, {
    method: 'PUT',
    headers: { Authorization: `Bearer ${token}`, 'X-Expected-Head-Sha': sourceRevision || '' },
    body: formData,
  });
  return parseJsonOrThrow(resp);
}

export async function deletePublishedItem(
  workerApiUrl: string,
  token: string,
  id: string,
  sourceRevision?: string,
): Promise<{ deleted: boolean; id: string; commitSha: string }> {
  const resp = await fetch(`${cleanBase(workerApiUrl)}/api/admin/items/${encodeURIComponent(id)}`, {
    method: 'DELETE',
    headers: { Authorization: `Bearer ${token}`, 'X-Expected-Head-Sha': sourceRevision || '' },
  });
  return parseJsonOrThrow(resp);
}

export async function updateSiteConfig(
  workerApiUrl: string,
  token: string,
  patch: Partial<Pick<SiteConfig, 'sensitiveTags' | 'allowPublicSensitiveToggle'>>,
): Promise<{ updated: boolean; site: SiteConfig }> {
  const resp = await fetch(`${cleanBase(workerApiUrl)}/api/admin/config`, {
    method: 'PUT',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(patch),
  });
  return parseJsonOrThrow(resp);
}
