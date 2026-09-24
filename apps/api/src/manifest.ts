// Owner-only GitHub App manifest bootstrap. Creates the ONE production GitHub
// App via GitHub's official manifest flow. Secrets never touch the browser,
// logs, or error traces — only masked metadata is ever returned.
import crypto from 'node:crypto';
import { publicSiteUrl } from './site.js';
import { githubAppConfigured } from './github.js';

const GITHUB_API = 'https://api.github.com';

function setupToken(): string {
  return process.env.ORLYNX_SETUP_TOKEN || '';
}

export function setupAccess(): { enabled: boolean; locked: boolean; reason: string } {
  if (githubAppConfigured()) {
    return { enabled: false, locked: true, reason: 'GitHub App already configured. Setup complete.' };
  }
  if (!setupToken()) {
    return { enabled: false, locked: false, reason: 'Set ORLYNX_SETUP_TOKEN on the server to enable one-time GitHub App setup.' };
  }
  return { enabled: true, locked: false, reason: '' };
}

export function setupAuthorized(headerToken: string, queryToken: string): boolean {
  const expected = setupToken();
  if (!expected) return false;
  const candidate = (headerToken || queryToken || '').trim();
  if (!candidate) return false;
  const a = Buffer.from(expected);
  const b = Buffer.from(candidate);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

const usedManifestStates = new Map<string, number>();

export function signManifestState(): string {
  const nonce = crypto.randomBytes(18).toString('base64url');
  const payload = JSON.stringify({ purpose: 'manifest', nonce, exp: Date.now() + 15 * 60_000 });
  const data = Buffer.from(payload).toString('base64url');
  const signature = crypto.createHmac('sha256', setupToken()).update(data).digest('base64url');
  return `${data}.${signature}`;
}

export function verifyManifestState(state: string): void {
  if (!setupToken()) throw new Error('Setup is not enabled on this server.');
  const [data, signature, extra] = state.split('.');
  if (!data || !signature || extra) throw new Error('Setup state is invalid.');
  const expected = crypto.createHmac('sha256', setupToken()).update(data).digest();
  let received: Buffer;
  try { received = Buffer.from(signature, 'base64url'); } catch { throw new Error('Setup state is invalid.'); }
  if (expected.length !== received.length || !crypto.timingSafeEqual(expected, received)) throw new Error('Setup state signature is invalid.');
  const claims = JSON.parse(Buffer.from(data, 'base64url').toString('utf8')) as { purpose?: string; exp?: number };
  if (claims.purpose !== 'manifest') throw new Error('Setup state is invalid.');
  if (!claims.exp || claims.exp < Date.now()) throw new Error('Setup state expired. Start setup again.');
  const now = Date.now();
  for (const [value, expires] of usedManifestStates) if (expires < now) usedManifestStates.delete(value);
  if (usedManifestStates.has(state)) throw new Error('Setup state was already used.');
  usedManifestStates.set(state, claims.exp);
}

// Manifest permissions mapped to actual Orlynx API calls:
// - contents:write → clone/import (github.ts importGitHubRepository), commit,
//   push (pushGitHubRepository) via installation tokens.
// - metadata:read → required companion permission for repository access.
// Everything else is intentionally NOT requested.
//
// NOTE: no `default_events` is sent. GitHub's manifest flow rejects
// `installation` / `installation_repositories` as default events, and Orlynx
// must not subscribe to activity events it never handles. Installation
// lifecycle is learned from the setup callback + live API checks, and the
// webhook endpoint verifies anything GitHub delivers to the registered hook.
export function buildManifest(appName: string): Record<string, unknown> {
  const publicUrl = publicSiteUrl();
  if (!publicUrl) throw new Error('ORLYNX_PUBLIC_URL must be the canonical production HTTPS URL before creating the GitHub App.');
  return {
    name: appName,
    url: publicUrl,
    hook_attributes: { url: `${publicUrl}/v1/github/webhook`, active: true },
    redirect_url: `${publicUrl}/v1/setup/github-app/callback`,
    callback_urls: [`${publicUrl}/v1/github/setup`],
    setup_url: `${publicUrl}/v1/github/setup`,
    description: 'Orlynx — GitHub-native AI development workspace.',
    public: false,
    default_permissions: { contents: 'write', metadata: 'read', codespaces: 'write', codespaces_lifecycle_admin: 'write' },
  };
}

export const MANIFEST_APP_NAME = 'Orlynx';
export const MANIFEST_APP_FALLBACKS = ['Orlynx App', 'Orlynx Dev'];

interface Conversion {
  id: number; slug: string; name: string; client_id: string;
  client_secret: string; webhook_secret: string; pem: string;
}

export async function exchangeManifestCode(code: string): Promise<Conversion> {
  if (!code || code.length > 256) throw new Error('GitHub did not return a manifest code.');
  const response = await fetch(`${GITHUB_API}/app-manifests/${encodeURIComponent(code)}/conversions`, {
    method: 'POST',
    headers: { Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28' },
  });
  if (!response.ok) throw new Error(`GitHub manifest conversion failed (HTTP ${response.status}). Start setup again.`);
  const body = await response.json() as Partial<Conversion>;
  if (!body.id || !body.slug || !body.client_id || !body.client_secret || !body.webhook_secret || !body.pem) {
    throw new Error('GitHub returned an incomplete App conversion. Start setup again.');
  }
  return body as Conversion;
}

export function maskedConversionSummary(conversion: { id: number; slug: string; name: string }): Record<string, unknown> {
  return {
    created: true,
    appId: conversion.id,
    slug: conversion.slug,
    name: conversion.name,
    privateKey: 'configured',
    clientSecret: 'configured',
    webhookSecret: 'configured',
  };
}

interface VercelPersistResult { stored: boolean; redeployed: boolean; detail: string }

// Env keys the bootstrap writes. Must cover the complete GitHub gateway
// configuration or production silently misconfigures itself.
export const MANIFEST_CREDENTIAL_KEYS = [
  'ORLYNX_PUBLIC_URL',
  'GITHUB_APP_ID',
  'GITHUB_APP_SLUG',
  'GITHUB_CLIENT_ID',
  'GITHUB_APP_CLIENT_SECRET',
  'GITHUB_APP_PRIVATE_KEY',
  'GITHUB_WEBHOOK_SECRET',
] as const;

export async function persistCredentialsToVercel(conversion: Conversion): Promise<VercelPersistResult> {
  const token = process.env.VERCEL_TOKEN || '';
  const project = process.env.VERCEL_PROJECT_ID || process.env.VERCEL_PROJECT || '';
  const team = process.env.VERCEL_TEAM_ID || '';
  const publicUrl = publicSiteUrl();
  if (!token || !project || !publicUrl) {
    return {
      stored: false, redeployed: false,
      detail: 'Set VERCEL_TOKEN and VERCEL_PROJECT_ID on the server so Orlynx can store the generated credentials itself. Otherwise the secrets cannot be saved without manual copying, which Orlynx refuses to do.',
    };
  }
  const teamQuery = team ? `?teamId=${encodeURIComponent(team)}` : '';
  const entries: { key: string; value: string; type: 'plain' | 'sensitive' }[] = [
    { key: 'ORLYNX_PUBLIC_URL', value: publicUrl, type: 'plain' },
    { key: 'GITHUB_APP_ID', value: String(conversion.id), type: 'plain' },
    { key: 'GITHUB_APP_SLUG', value: conversion.slug, type: 'plain' },
    { key: 'GITHUB_CLIENT_ID', value: conversion.client_id, type: 'sensitive' },
    { key: 'GITHUB_APP_CLIENT_SECRET', value: conversion.client_secret, type: 'sensitive' },
    // Canonical name required by the gateway (see REQUIRED_GITHUB_ENV).
    { key: 'GITHUB_APP_PRIVATE_KEY', value: conversion.pem, type: 'sensitive' },
    { key: 'GITHUB_WEBHOOK_SECRET', value: conversion.webhook_secret, type: 'sensitive' },
  ];
  const headers = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
  for (const entry of entries) {
    // Remove existing production values first so the upsert is exact.
    try {
      const existing = await fetch(`https://api.vercel.com/v9/projects/${encodeURIComponent(project)}/env${teamQuery}`, { headers: { Authorization: `Bearer ${token}` } });
      if (existing.ok) {
        const list = await existing.json() as { envs?: { id: string; key: string; target?: string[] }[] };
        for (const env of list.envs || []) {
          if (env.key === entry.key && (!env.target || env.target.includes('production'))) {
            await fetch(`https://api.vercel.com/v9/projects/${encodeURIComponent(project)}/env/${env.id}${teamQuery}`, { method: 'DELETE', headers: { Authorization: `Bearer ${token}` } });
          }
        }
      }
    } catch { /* best effort cleanup; upsert below still applies */ }
    const created = await fetch(`https://api.vercel.com/v10/projects/${encodeURIComponent(project)}/env${teamQuery}`, {
      method: 'POST', headers,
      body: JSON.stringify({ key: entry.key, value: entry.value, type: entry.type, target: ['production'], comment: 'Set by Orlynx GitHub App bootstrap.' }),
    });
    if (!created.ok) {
      const detail = (await created.text().catch(() => '')).slice(0, 200);
      throw new Error(`Vercel rejected ${entry.key} (HTTP ${created.status})${detail ? `: ${detail}` : ''}. Secrets were NOT stored.`);
    }
  }
  // Trigger a production redeploy so the new environment takes effect.
  const redeploy = await fetch(`https://api.vercel.com/v13/deployments${teamQuery}`, {
    method: 'POST', headers,
    body: JSON.stringify({ name: project, project, target: 'production' }),
  });
  if (!redeploy.ok) {
    return { stored: true, redeployed: false, detail: 'Credentials stored. Automatic redeploy failed — trigger a production redeploy manually.' };
  }
  return { stored: true, redeployed: true, detail: 'Credentials stored and production redeploy triggered.' };
}
