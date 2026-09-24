// GitHub App gateway. Installation access tokens are created on demand and never persisted.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync, execSync } from 'node:child_process';
import { dataDir, store } from './store.js';
import { decryptCredential, encryptCredential } from './credentials.js';
import { controlPlaneRepository, durableStorageConfigured } from './storage.js';

const API = 'https://api.github.com';

// Read env lazily (per call, never cached at module load): serverless
// runtimes may not have every variable populated when modules initialize.
function appId(): string { return process.env.GITHUB_APP_ID || ''; }
function appSlug(): string { return process.env.GITHUB_APP_SLUG || ''; }
function clientId(): string { return process.env.GITHUB_CLIENT_ID || ''; }
function publicUrl(): string { return (process.env.ORLYNX_PUBLIC_URL || '').replace(/\/$/, ''); }
function clientSecret(): string { return process.env.GITHUB_APP_CLIENT_SECRET || ''; }
function webhookSecret(): string { return process.env.GITHUB_WEBHOOK_SECRET || ''; }
function privateKey(): string {
  // Canonical name is GITHUB_APP_PRIVATE_KEY; GITHUB_PRIVATE_KEY is accepted
  // as a legacy alias (early bootstrap wrote that name).
  const raw = process.env.GITHUB_APP_PRIVATE_KEY || process.env.GITHUB_PRIVATE_KEY || '';
  if (raw.includes('BEGIN')) return raw.replace(/\\n/g, '\n');
  if (raw) { try { return Buffer.from(raw, 'base64').toString('utf8'); } catch { return ''; } }
  return '';
}

// Canonical server env names for the GitHub App integration. The manifest
// bootstrap must write exactly these (plus ORLYNX_PUBLIC_URL).
export const REQUIRED_GITHUB_ENV = [
  'GITHUB_APP_ID',
  'GITHUB_APP_SLUG',
  'GITHUB_CLIENT_ID',
  'GITHUB_APP_CLIENT_SECRET',
  'GITHUB_APP_PRIVATE_KEY',
  'GITHUB_WEBHOOK_SECRET',
] as const;

export function githubAppConfigured(): boolean {
  let publicOriginIsSafe = false;
  try {
    const url = new URL(publicUrl());
    publicOriginIsSafe = url.protocol === 'https:' || ['localhost', '127.0.0.1', '::1'].includes(url.hostname);
  } catch { publicOriginIsSafe = false; }
  return Boolean(appId() && appSlug() && clientId() && publicOriginIsSafe && clientSecret() && privateKey() && webhookSecret());
}

export interface GitHubInstallation {
  id: number;
  account: string;
  accountType: string;
  status: 'active' | 'suspended';
  connectedAt: string;
  updatedAt: string;
  lastVerifiedAt?: string;
}

function touchInstallation(id: number, account: string, accountType: string, status: 'active' | 'suspended'): void {
  const now = new Date().toISOString();
  const existing = store.db.githubInstallations.find((item) => item.id === id);
  if (existing) {
    existing.account = account;
    existing.accountType = accountType;
    existing.status = status;
    existing.updatedAt = now;
  } else {
    store.db.githubInstallations.push({ id, account, accountType, installedAt: now, status, connectedAt: now, updatedAt: now });
  }
  store.save();
}

function forgetInstallation(id: number): void {
  store.db.githubInstallations = store.db.githubInstallations.filter((item) => item.id !== id);
  tokenCache.delete(id);
  repositoryCache.delete(id);
  store.save();
}

export function githubInstallUrl(): string {
  if (!githubAppConfigured()) throw new Error('GitHub App settings are incomplete on this Orlynx server.');
  const state = signState({ purpose: 'install', nonce: crypto.randomBytes(18).toString('base64url'), exp: Date.now() + 10 * 60_000 });
  return `https://github.com/apps/${encodeURIComponent(appSlug())}/installations/new?state=${encodeURIComponent(state)}`;
}

export function githubSetupUrl(): string {
  if (!githubAppConfigured()) throw new Error('GitHub App settings are incomplete on this Orlynx server.');
  return `${publicUrl()}/v1/github/setup`;
}

export function githubWebhookUrl(): string {
  if (!githubAppConfigured()) throw new Error('GitHub App settings are incomplete on this Orlynx server.');
  return `${publicUrl()}/v1/github/webhook`;
}

export interface GitHubWebhookSummary {
  event: string;
  action?: string;
  installationId?: number;
  account?: string;
  repositoriesChanged?: number;
  duplicate?: boolean;
}

export async function acceptGitHubWebhook(rawBody: Buffer, signature: string, event: string, deliveryId = ''): Promise<GitHubWebhookSummary> {
  if (!webhookSecret()) throw new Error('GitHub webhook signing is not configured.');
  const expected = crypto.createHmac('sha256', webhookSecret()).update(rawBody).digest();
  let received: Buffer;
  try { received = Buffer.from(signature.replace(/^sha256=/, ''), 'hex'); }
  catch { throw new Error('GitHub webhook signature is invalid.'); }
  if (expected.length !== received.length || !crypto.timingSafeEqual(expected, received)) throw new Error('GitHub webhook signature is invalid.');
  let payload: {
    action?: string;
    installation?: { id: number; account?: { login?: string; type?: string } };
    repositories_added?: { full_name: string }[];
    repositories_removed?: { full_name: string }[];
  };
  try { payload = JSON.parse(rawBody.toString('utf8')); }
  catch { throw new Error('GitHub webhook payload is not valid JSON.'); }
  const installationId = payload.installation?.id;
  const account = payload.installation?.account?.login;
  // Webhook idempotency: GitHub may redeliver. Never process the same
  // delivery twice as separate authorization changes.
  if (deliveryId) {
    if (store.db.webhookDeliveries.some((item) => item.id === deliveryId)) {
      console.info(`[orlynx] github webhook duplicate delivery=${deliveryId} ignored`);
      return { event, action: payload.action, installationId, account, duplicate: true };
    }
    store.db.webhookDeliveries.push({ id: deliveryId, event, receivedAt: new Date().toISOString() });
    if (store.db.webhookDeliveries.length > 500) store.db.webhookDeliveries = store.db.webhookDeliveries.slice(-500);
    store.save();
  }
  // Never log secrets: event type, delivery, action, installation/account only.
  console.info(`[orlynx] github webhook event=${event} action=${payload.action || '-'} delivery=${deliveryId || '-'} installation=${installationId || '-'} account=${account || '-'}`);
  if (event === 'installation' && installationId) {
    const name = account || 'GitHub account';
    const kind = payload.installation?.account?.type || 'User';
    if (payload.action === 'deleted') {
      forgetInstallation(installationId);
    } else if (payload.action === 'suspend') {
      touchInstallation(installationId, name, kind, 'suspended');
    } else if (payload.action === 'unsuspend') {
      touchInstallation(installationId, name, kind, 'active');
      repositoryCache.delete(installationId);
    } else if (payload.action === 'created' || payload.action === 'new_permissions_accepted') {
      touchInstallation(installationId, name, kind, 'active');
      repositoryCache.delete(installationId);
    }
    return { event, action: payload.action, installationId, account: name };
  }
  if (event === 'installation_repositories' && installationId) {
    // Repository scope changed on GitHub: drop cached listing so the next
    // authorization check re-reads the authoritative set. History is preserved.
    repositoryCache.delete(installationId);
    const changed = (payload.repositories_added?.length || 0) + (payload.repositories_removed?.length || 0);
    return { event, action: payload.action, installationId, account, repositoriesChanged: changed };
  }
  return { event, action: payload.action, installationId, account };
}

export function githubManageUrl(installationId?: number): string {
  if (!githubAppConfigured()) throw new Error('GitHub App settings are incomplete on this Orlynx server.');
  if (installationId) return `https://github.com/settings/installations/${installationId}`;
  return `https://github.com/apps/${encodeURIComponent(appSlug())}/installations/new`;
}

export async function disconnectGitHub(installationId: number): Promise<void> {
  // Orlynx-side disconnect: stop minting tokens, drop cached access, forget
  // installation metadata. Sessions, messages, changes and local history stay.
  // (Uninstalling the app on github.com is a separate, user-driven action.)
  tokenCache.delete(installationId);
  repositoryCache.delete(installationId);
  store.db.githubInstallations = store.db.githubInstallations.filter((item) => item.id !== installationId);
  if (durableStorageConfigured()) await controlPlaneRepository().deleteGitHubConnection(installationId);
  store.save();
}

export async function completeGitHubInstallation(installationId: string, state: string, setupAction: string): Promise<{ redirect: string; installationId: number | null }> {
  const id = Number(installationId);
  if (!Number.isSafeInteger(id) || id <= 0) throw new Error('GitHub returned an invalid installation id.');
  try {
    const claims = verifyState(state);
    if (claims.purpose !== 'install') throw new Error('GitHub installation state is invalid.');
  } catch (error) {
    // Repository updates from GitHub's installation management pages (and the
    // "Redirect on update" return) do not carry our install state. Never trust
    // the id blindly: fall through to live verification against the GitHub
    // API below, then still require the OAuth step before any session exists.
    if (setupAction !== 'update' && setupAction !== 'install') throw error;
    console.info('[orlynx] github setup continuing without install state (update/return flow); verifying installation with GitHub');
  }
  if (setupAction === 'uninstall') {
    forgetInstallation(id);
  } else if (setupAction === 'install' || setupAction === 'update') {
    const jwt = createAppJwt();
    const response = await fetch(`${API}/app/installations/${id}`, { headers: githubHeaders(jwt) });
    if (!response.ok) {
      if (response.status === 403) throw new Error('This organization requires owner approval before Orlynx can access its repositories. Ask an organization owner to approve the installation, then reconnect.');
      throw new Error(`GitHub could not verify the app installation (HTTP ${response.status}).`);
    }
    const installation = await response.json() as { id: number; account?: { login?: string; type?: string }; suspended_at?: string | null };
    touchInstallation(installation.id, installation.account?.login || 'GitHub account', installation.account?.type || 'User', installation.suspended_at ? 'suspended' : 'active');
    // Post-connection verification: mint a token and list repositories before
    // reporting success. A stored installation alone is never "connected".
    repositoryCache.delete(installation.id);
    try {
      await installationToken(installation.id);
      await githubListRepos(installation.id);
      const row = store.db.githubInstallations.find((item) => item.id === installation.id);
      if (row) { row.lastVerifiedAt = new Date().toISOString(); store.save(); }
    } catch (error) {
      forgetInstallation(installation.id);
      throw new Error(error instanceof Error ? error.message : 'GitHub verification failed after installation.');
    }
  } else {
    throw new Error('GitHub returned an unsupported installation action.');
  }
  return { redirect: `${publicUrl()}/?github=${setupAction === 'uninstall' ? 'disconnected' : 'connected'}`, installationId: setupAction === 'uninstall' ? null : id };
}

export function githubOAuthUrl(installationId: number): { url: string; state: string } {
  if (!githubAppConfigured()) throw new Error('GitHub connection is temporarily unavailable.');
  if (!Number.isSafeInteger(installationId) || installationId <= 0) throw new Error('GitHub returned an invalid installation id.');
  const state = signState({ purpose: 'oauth', installationId, nonce: crypto.randomBytes(18).toString('base64url'), exp: Date.now() + 10 * 60_000 });
  const query = new URLSearchParams({ client_id: clientId(), redirect_uri: `${publicUrl()}/v1/github/setup`, state });
  return { url: `https://github.com/login/oauth/authorize?${query}`, state };
}

export async function completeGitHubOAuth(code: string, state: string): Promise<{ installationId: number; login: string }> {
  if (process.env.VERCEL === '1' && !durableStorageConfigured()) throw new Error('Durable storage must be configured before users can connect GitHub.');
  const claims = verifyState(state);
  if (claims.purpose !== 'oauth' || !Number.isSafeInteger(claims.installationId) || Number(claims.installationId) <= 0) {
    throw new Error('GitHub authorization state is invalid.');
  }
  if (!code || code.length > 512) throw new Error('GitHub did not return an authorization code.');
  const tokenResponse = await fetch('https://github.com/login/oauth/access_token', {
    method: 'POST',
    headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
    body: JSON.stringify({ client_id: clientId(), client_secret: clientSecret(), code, redirect_uri: `${publicUrl()}/v1/github/setup` }),
    signal: AbortSignal.timeout(10_000),
  });
  const tokenBody = await tokenResponse.json().catch(() => ({})) as { access_token?: string; refresh_token?: string; expires_in?: number; refresh_token_expires_in?: number; error?: string };
  if (!tokenResponse.ok || !tokenBody.access_token) throw new Error('GitHub could not verify your account. Start the connection again.');
  const userHeaders = githubHeaders(tokenBody.access_token);
  const [userResponse, installationsResponse] = await Promise.all([
    fetch(`${API}/user`, { headers: userHeaders, signal: AbortSignal.timeout(10_000) }),
    fetch(`${API}/user/installations?per_page=100`, { headers: userHeaders, signal: AbortSignal.timeout(10_000) }),
  ]);
  if (!userResponse.ok || !installationsResponse.ok) throw new Error('GitHub could not verify access to this installation.');
  const user = await userResponse.json() as { id?: number; login?: string };
  const installations = await installationsResponse.json() as { installations?: { id: number }[] };
  const installationId = Number(claims.installationId);
  if (!(installations.installations || []).some((item) => item.id === installationId)) {
    throw new Error('Your GitHub account does not have access to this Orlynx installation.');
  }
  if (!user.id) throw new Error('GitHub did not return a stable user identity.');
  const now = new Date();
  if (durableStorageConfigured()) await controlPlaneRepository().upsertGitHubConnection({
    userId: String(user.id), installationId, login: user.login || 'GitHub user',
    accessToken: encryptCredential(tokenBody.access_token),
    refreshToken: tokenBody.refresh_token ? encryptCredential(tokenBody.refresh_token) : undefined,
    accessTokenExpiresAt: tokenBody.expires_in ? new Date(now.getTime() + tokenBody.expires_in * 1000).toISOString() : undefined,
    refreshTokenExpiresAt: tokenBody.refresh_token_expires_in ? new Date(now.getTime() + tokenBody.refresh_token_expires_in * 1000).toISOString() : undefined,
    createdAt: now.toISOString(), updatedAt: now.toISOString(),
  });
  await restoreGitHubInstallation(installationId);
  return { installationId, login: user.login || 'GitHub user' };
}

export async function githubUserAccessToken(userId: string): Promise<string> {
  const repository = controlPlaneRepository();
  // The installation lookup is intentionally explicit: a user-scoped token is
  // never substituted with an app installation token or operator PAT.
  const connection = await repository.getGitHubConnectionByUser(userId);
  if (!connection) throw new Error('GitHub user authorization is required for Codespaces.');
  const expiresAt = connection.accessTokenExpiresAt ? Date.parse(connection.accessTokenExpiresAt) : Number.POSITIVE_INFINITY;
  if (expiresAt > Date.now() + 5 * 60_000) return decryptCredential(connection.accessToken);
  if (!connection.refreshToken) throw new Error('GitHub user authorization expired. Reconnect GitHub.');
  const response = await fetch('https://github.com/login/oauth/access_token', {
    method: 'POST', headers: { Accept: 'application/json', 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ client_id: clientId(), client_secret: clientSecret(), grant_type: 'refresh_token', refresh_token: decryptCredential(connection.refreshToken) }),
    signal: AbortSignal.timeout(10_000),
  });
  const body = await response.json().catch(() => ({})) as { access_token?: string; refresh_token?: string; expires_in?: number; refresh_token_expires_in?: number };
  if (!response.ok || !body.access_token) throw new Error('GitHub user authorization expired. Reconnect GitHub.');
  const now = new Date();
  await repository.upsertGitHubConnection({ ...connection, accessToken: encryptCredential(body.access_token), refreshToken: body.refresh_token ? encryptCredential(body.refresh_token) : connection.refreshToken, accessTokenExpiresAt: body.expires_in ? new Date(now.getTime() + body.expires_in * 1000).toISOString() : undefined, refreshTokenExpiresAt: body.refresh_token_expires_in ? new Date(now.getTime() + body.refresh_token_expires_in * 1000).toISOString() : connection.refreshTokenExpiresAt, updatedAt: now.toISOString() });
  return body.access_token;
}

export function githubCallbackErrorUrl(reason: string): string {
  return `${publicUrl() || ''}/?github=error&reason=${encodeURIComponent(reason.slice(0, 160))}`;
}

export async function githubConnectionStatus(installationId?: number | null) {
  const source = installationId ? store.db.githubInstallations.filter((item) => item.id === installationId) : [];
  const installations = source.map(({ id, account, accountType, installedAt, connectedAt, updatedAt, lastVerifiedAt, status }) => ({
    id, account, accountType, installedAt: connectedAt || installedAt, updatedAt, lastVerifiedAt: lastVerifiedAt || null, status: status || 'active',
    manageUrl: githubAppConfigured() ? githubManageUrl(id) : null,
  }));
  const active = installations.filter((item) => item.status !== 'suspended');
  let userAuthorizationState: 'established' | 'not-established' = 'not-established';
  if (installationId && durableStorageConfigured()) {
    try { if (await controlPlaneRepository().getGitHubConnectionByInstallation(installationId)) userAuthorizationState = 'established'; } catch {}
  }
  return {
    configured: githubAppConfigured(),
    connected: githubAppConfigured() && active.length > 0,
    needsAttention: githubAppConfigured() && installations.length > 0 && active.length === 0,
    auth: !githubAppConfigured() ? 'not-configured' : active.length ? 'github-app' : installations.length ? 'suspended' : 'installation-required',
    provider: 'GitHub App',
    login: active[0]?.account || installations[0]?.account || null,
    installations,
    installUrl: githubAppConfigured() ? '/v1/github/install' : null,
    manageUrl: githubAppConfigured() ? '/v1/github/manage' : null,
    setupCallbackUrl: githubAppConfigured() ? githubSetupUrl() : null,
    webhookUrl: githubAppConfigured() ? githubWebhookUrl() : null,
    // User-scoped GitHub authorization (e.g. Codespaces) is not established by
    // the installation flow. Cloud stays fail-closed until that exists.
    userAuthorizationState,
  };
}

export interface GitHubPlatformHealth {
  configured: boolean;
  healthy: boolean;
  appId: string | null;
  slug: string | null;
  name: string | null;
  permissions: Record<string, string>;
  events: string[];
  message: string;
}

// Platform check: can this server authenticate as the GitHub App? This is
// operator/platform state — NOT the user's connection state.
export async function githubPlatformHealth(): Promise<GitHubPlatformHealth> {
  if (!githubAppConfigured()) {
    return { configured: false, healthy: false, appId: null, slug: null, name: null, permissions: {}, events: [], message: 'GitHub App credentials are not configured on this server.' };
  }
  try {
    const response = await fetch(`${API}/app`, { headers: githubHeaders(createAppJwt()), signal: AbortSignal.timeout(10_000) });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const app = await response.json() as { id: number; slug?: string; name?: string; permissions?: Record<string, string>; events?: string[] };
    return {
      configured: true, healthy: true,
      appId: String(app.id), slug: app.slug || null, name: app.name || null,
      permissions: app.permissions || {}, events: app.events || [],
      message: 'GitHub App authentication verified.',
    };
  } catch (error) {
    return { configured: true, healthy: false, appId: appId() || null, slug: appSlug() || null, name: null, permissions: {}, events: [], message: error instanceof Error ? `GitHub App authentication failed: ${error.message}` : 'GitHub App authentication failed.' };
  }
}

export async function githubHealth(installationId?: number): Promise<{ healthy: boolean; authorizedRepositories: number; message: string }> {
  if (!githubAppConfigured()) return { healthy: false, authorizedRepositories: 0, message: 'GitHub App is not configured on this Orlynx server.' };
  const active = store.db.githubInstallations.filter((item) => (item.status || 'active') !== 'suspended' && (!installationId || item.id === installationId));
  if (!active.length) {
    const any = store.db.githubInstallations.length > 0;
    return { healthy: false, authorizedRepositories: 0, message: any ? 'The GitHub App installation is suspended. Ask an organization owner to unsuspend it, then reconnect.' : 'Install the Orlynx GitHub App to connect repositories.' };
  }
  try {
    const repos = await githubListRepos(installationId);
    return { healthy: true, authorizedRepositories: repos.length, message: repos.length ? 'GitHub App is healthy.' : 'GitHub App is connected but no repositories are selected. Add repositories on GitHub.' };
  } catch (error) {
    return { healthy: false, authorizedRepositories: 0, message: error instanceof Error ? error.message : 'GitHub verification failed.' };
  }
}

export async function restoreGitHubInstallation(installationId: number): Promise<void> {
  const existing = store.db.githubInstallations.find((item) => item.id === installationId);
  if (existing && (existing.status || 'active') !== 'suspended') return;
  if (!githubAppConfigured()) throw new Error('GitHub connection is temporarily unavailable.');
  const response = await fetch(`${API}/app/installations/${installationId}`, { headers: githubHeaders(createAppJwt()), signal: AbortSignal.timeout(10_000) });
  if (!response.ok) throw new Error(response.status === 404 ? 'Your GitHub connection is no longer available.' : 'GitHub connection could not be verified.');
  const installation = await response.json() as { id: number; account?: { login?: string; type?: string }; suspended_at?: string | null };
  touchInstallation(installation.id, installation.account?.login || 'GitHub account', installation.account?.type || 'User', installation.suspended_at ? 'suspended' : 'active');
}

// Explicit re-verification after the user changes repository access on
// GitHub (Manage repositories / Redirect on update). Drops cached tokens and
// listings, re-reads the authoritative set from GitHub, and stamps the
// verification time. Never invents access: every check hits the live API.
export async function refreshGitHubInstallation(installationId: number): Promise<{ authorizedRepositories: number }> {
  if (!Number.isSafeInteger(installationId) || installationId <= 0) throw new Error('Reconnect GitHub to continue.');
  repositoryCache.delete(installationId);
  tokenCache.delete(installationId);
  await restoreGitHubInstallation(installationId);
  await installationToken(installationId);
  const repos = await githubListRepos(installationId);
  const row = store.db.githubInstallations.find((item) => item.id === installationId);
  if (row) { row.lastVerifiedAt = new Date().toISOString(); store.save(); }
  return { authorizedRepositories: repos.length };
}

const usedStates = new Map<string, number>();
function signState(claims: Record<string, unknown>): string {
  const data = Buffer.from(JSON.stringify(claims)).toString('base64url');
  const signature = crypto.createHmac('sha256', clientSecret()).update(data).digest('base64url');
  return `${data}.${signature}`;
}

function verifyState(state: string): { purpose: string; exp: number; installationId?: number } {
  if (!githubAppConfigured()) throw new Error('GitHub App is not configured.');
  const [data, signature, extra] = state.split('.');
  if (!data || !signature || extra) throw new Error('GitHub installation state is invalid.');
  const expected = crypto.createHmac('sha256', clientSecret()).update(data).digest();
  let received: Buffer;
  try { received = Buffer.from(signature, 'base64url'); } catch { throw new Error('GitHub installation state is invalid.'); }
  if (expected.length !== received.length || !crypto.timingSafeEqual(expected, received)) throw new Error('GitHub installation state signature is invalid.');
  let claims: { purpose: string; exp: number; nonce?: string; installationId?: number };
  try { claims = JSON.parse(Buffer.from(data, 'base64url').toString('utf8')); } catch { throw new Error('GitHub installation state is invalid.'); }
  if (!claims.exp || claims.exp < Date.now()) throw new Error('GitHub installation state expired. Start the connection again.');
  // Single-use: reject replayed callbacks.
  const now = Date.now();
  for (const [value, expires] of usedStates) if (expires < now) usedStates.delete(value);
  if (usedStates.has(state)) throw new Error('GitHub installation state was already used. Start the connection again.');
  usedStates.set(state, claims.exp);
  return claims;
}

function createAppJwt(): string {
  if (!githubAppConfigured()) throw new Error('GitHub App settings are incomplete on this Orlynx server.');
  const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url');
  const unsigned = `${encode({ alg: 'RS256', typ: 'JWT' })}.${encode({ iat: Math.floor(Date.now() / 1000) - 60, exp: Math.floor(Date.now() / 1000) + 8 * 60, iss: appId() })}`;
  const signature = crypto.sign('RSA-SHA256', Buffer.from(unsigned), privateKey()).toString('base64url');
  return `${unsigned}.${signature}`;
}

function githubHeaders(token: string, accept = 'application/vnd.github+json'): Record<string, string> {
  return { Authorization: `Bearer ${token}`, Accept: accept, 'X-GitHub-Api-Version': '2022-11-28' };
}

const tokenCache = new Map<number, { token: string; expiresAt: number }>();
const repositoryCache = new Map<number, { repos: GitHubRepository[]; expiresAt: number }>();
async function installationToken(installationId: number): Promise<string> {
  const cached = tokenCache.get(installationId);
  if (cached && cached.expiresAt > Date.now() + 60_000) return cached.token;
  const installation = store.db.githubInstallations.find((item) => item.id === installationId);
  if (!installation) throw new Error('This GitHub installation is not connected to Orlynx.');
  if ((installation.status || 'active') === 'suspended') throw new Error('This GitHub installation is suspended. Ask an organization owner to unsuspend it, then reconnect.');
  const response = await fetch(`${API}/app/installations/${installationId}/access_tokens`, { method: 'POST', headers: githubHeaders(createAppJwt()), body: '{}' });
  if (!response.ok) throw new Error(`GitHub could not issue an installation token (HTTP ${response.status}).`);
  const data = await response.json() as { token: string; expires_at: string };
  const token = { token: data.token, expiresAt: Date.parse(data.expires_at) };
  tokenCache.set(installationId, token);
  return token.token;
}

function gitCredentialEnv(token: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [name, value] of Object.entries(process.env)) {
    if (!/(TOKEN|SECRET|PASSWORD|PRIVATE.?KEY|API.?KEY|CREDENTIAL)/i.test(name) && value !== undefined) env[name] = value;
  }
  env.GIT_CONFIG_GLOBAL = process.platform === 'win32' ? 'NUL' : '/dev/null';
  env.GIT_CONFIG_SYSTEM = process.platform === 'win32' ? 'NUL' : '/dev/null';
  env.GIT_CONFIG_COUNT = '1';
  env.GIT_CONFIG_KEY_0 = 'http.extraheader';
  env.GIT_CONFIG_VALUE_0 = `AUTHORIZATION: basic ${Buffer.from(`x-access-token:${token}`).toString('base64')}`;
  env.GIT_TERMINAL_PROMPT = '0';
  return env;
}

export interface GitHubRepository {
  id: number;
  full: string; name: string; owner: string; ownerType: string; private: boolean;
  defaultBranch: string; language: string | null; updatedAt: string; url: string;
  installationId: number;
}

export async function githubListRepos(installationId?: number): Promise<GitHubRepository[]> {
  const repos: GitHubRepository[] = [];
  const active = store.db.githubInstallations.filter((item) => (item.status || 'active') !== 'suspended' && (!installationId || item.id === installationId));
  for (const installation of active) {
    const cached = repositoryCache.get(installation.id);
    if (cached && cached.expiresAt > Date.now()) { repos.push(...cached.repos); continue; }
    const token = await installationToken(installation.id);
    const installationRepos: GitHubRepository[] = [];
    for (let page = 1; page <= 10; page++) {
      const response = await fetch(`${API}/installation/repositories?per_page=100&page=${page}`, { headers: githubHeaders(token) });
      if (!response.ok) throw new Error(`Could not list repositories for GitHub installation ${installation.account} (HTTP ${response.status}).`);
      const data = await response.json() as { repositories: { id: number; full_name: string; name: string; owner: { login: string; type: string }; private: boolean; default_branch: string; language: string | null; updated_at: string; html_url: string }[]; total_count: number };
      installationRepos.push(...data.repositories.map((repo) => ({ id: repo.id, full: repo.full_name, name: repo.name, owner: repo.owner.login, ownerType: repo.owner.type, private: repo.private, defaultBranch: repo.default_branch, language: repo.language, updatedAt: repo.updated_at, url: repo.html_url, installationId: installation.id })));
      if (data.repositories.length < 100 || installationRepos.length >= data.total_count) break;
    }
    repositoryCache.set(installation.id, { repos: installationRepos, expiresAt: Date.now() + 30_000 });
    repos.push(...installationRepos);
  }
  return repos;
}

export async function githubRepositoryAuthorized(project: string, installationId?: number): Promise<boolean> {
  try { return (await githubListRepos(installationId)).some((repo) => repo.full.toLowerCase() === project.toLowerCase()); }
  catch { return false; }
}

async function findRepository(fullName: string, installationId?: number): Promise<GitHubRepository> {
  const repo = (await githubListRepos(installationId)).find((item) => item.full.toLowerCase() === fullName.toLowerCase());
  if (!repo) throw new Error('This repository is not available through an installed GitHub App.');
  return repo;
}

export async function githubBranches(fullName: string, installationId?: number): Promise<string[]> {
  const repo = await findRepository(fullName, installationId);
  const token = await installationToken(repo.installationId);
  const response = await fetch(`${API}/repos/${encodeURIComponent(repo.owner)}/${encodeURIComponent(repo.name)}/branches?per_page=100`, { headers: githubHeaders(token) });
  // findRepository already enforces installation authorization, so a 404 here
  // means the repository exists but has no branches yet (e.g. empty repo).
  if (response.status === 404) return [];
  if (!response.ok) throw new Error(`Could not load branches for ${fullName} (HTTP ${response.status}).`);
  const body = await response.json() as { name: string }[];
  return body.map((branch) => branch.name);
}

export async function githubRepositoryFiles(fullName: string, branch: string, directory: string, installationId?: number): Promise<{ name: string; dir: boolean; modified: boolean }[]> {
  const repo = await findRepository(fullName, installationId); const token = await installationToken(repo.installationId);
  const clean = directory.replace(/^\/+|\/+$/g, ''); if (clean.split('/').includes('..')) throw new Error('path escape denied');
  const response = await fetch(`${API}/repos/${encodeURIComponent(repo.owner)}/${encodeURIComponent(repo.name)}/contents/${clean.split('/').map(encodeURIComponent).join('/')}?ref=${encodeURIComponent(branch)}`, { headers: githubHeaders(token) });
  if (!response.ok) throw new Error(`GitHub could not read repository files (HTTP ${response.status}).`);
  const body = await response.json() as Array<{ name: string; type: string }>;
  if (!Array.isArray(body)) throw new Error('The requested GitHub path is not a directory.');
  return body.filter((item) => item.name !== '.git').map((item) => ({ name: item.name, dir: item.type === 'dir', modified: false }));
}

export async function githubRepositoryFile(fullName: string, branch: string, filename: string, installationId?: number): Promise<string> {
  const repo = await findRepository(fullName, installationId); const token = await installationToken(repo.installationId);
  const clean = filename.replace(/^\/+/, ''); if (!clean || clean.split('/').includes('..')) throw new Error('path escape denied');
  const response = await fetch(`${API}/repos/${encodeURIComponent(repo.owner)}/${encodeURIComponent(repo.name)}/contents/${clean.split('/').map(encodeURIComponent).join('/')}?ref=${encodeURIComponent(branch)}`, { headers: githubHeaders(token) });
  if (!response.ok) throw new Error(`GitHub could not read this file (HTTP ${response.status}).`);
  const body = await response.json() as { type?: string; encoding?: string; content?: string; size?: number };
  if (body.type !== 'file' || body.encoding !== 'base64' || !body.content || Number(body.size || 0) > 1_000_000) throw new Error('This GitHub file cannot be displayed.');
  return Buffer.from(body.content.replace(/\n/g, ''), 'base64').toString('utf8');
}

export function repoRoot(project: string): string {
  const root = importedRepositoryRoot(project);
  if (!root) throw new Error('Repository is not imported from an authorized GitHub App installation.');
  return root;
}

export function configureCommitIdentity(project: string): void {
  const name = process.env.ORLYNX_GIT_AUTHOR_NAME || `${appSlug()}[bot]`;
  const email = process.env.ORLYNX_GIT_AUTHOR_EMAIL || `${appId()}+${appSlug()}[bot]@users.noreply.github.com`;
  const root = repoRoot(project);
  execFileSync('git', ['config', '--local', 'user.name', name], { cwd: root });
  execFileSync('git', ['config', '--local', 'user.email', email], { cwd: root });
}

export function importedRepositoryRoot(project: string): string | undefined {
  const root = path.join(dataDir, 'repos', project.replace(/[^a-zA-Z0-9._-]/g, '_'));
  if (!fs.existsSync(path.join(root, '.git'))) return undefined;
  let remote = '';
  try { remote = execSync('git remote get-url origin', { cwd: root }).toString().trim().replace(/\.git$/, '').toLowerCase(); }
  catch { return undefined; }
  return remote === `https://github.com/${project}.git`.toLowerCase() ? root : undefined;
}

export function importedRepositoryBranch(project: string): string | undefined {
  const root = importedRepositoryRoot(project);
  if (!root) return undefined;
  try { return execFileSync('git', ['branch', '--show-current'], { cwd: root }).toString().trim(); }
  catch { return undefined; }
}

export function headSha(project: string): string {
  return execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repoRoot(project) }).toString().trim();
}

export function listFiles(project: string, sub = ''): { name: string; dir: boolean; modified: boolean }[] {
  const root = importedRepositoryRoot(project);
  if (!root) throw new Error('Project repository is unavailable. Reconnect GitHub and import it again.');
  const target = path.resolve(root, sub || '.');
  if (target !== root && !target.startsWith(`${root}${path.sep}`)) throw new Error('path escape denied');
  const changed = status(project).split('\n').filter(Boolean).map((line) => {
    const value = line.slice(3).trim();
    return value.includes(' -> ') ? value.split(' -> ').pop() || value : value;
  });
  return fs.readdirSync(target, { withFileTypes: true }).filter((entry) => entry.name !== '.git').map((entry) => {
    const relative = [sub.replace(/^\/+|\/+$/g, ''), entry.name].filter(Boolean).join('/');
    return { name: entry.name, dir: entry.isDirectory(), modified: changed.some((file) => file === relative || file.startsWith(`${relative}/`)) };
  });
}

export function readFile(project: string, file: string): string {
  const root = importedRepositoryRoot(project);
  if (!root) throw new Error('Project repository is unavailable.');
  const target = path.resolve(root, file);
  if (target !== root && !target.startsWith(`${root}${path.sep}`)) throw new Error('path escape denied');
  return fs.readFileSync(target, 'utf8').slice(0, 200_000);
}

export function status(project: string): string {
  const root = importedRepositoryRoot(project);
  if (!root) return '';
  try { return execFileSync('git', ['status', '--porcelain'], { cwd: root }).toString(); }
  catch { return ''; }
}

export async function importGitHubRepository(fullName: string, branch: string, installationId?: number): Promise<string> {
  if (!/^[\w.-]+\/[\w.-]+$/.test(fullName) || !branch || branch.startsWith('-')) throw new Error('Repository or branch name is invalid.');
  const repo = await findRepository(fullName, installationId);
  const branches = await githubBranches(fullName, installationId);
  if (!branches.includes(branch)) throw new Error('That branch is not available to this GitHub App installation.');
  const root = path.join(dataDir, 'repos', fullName.replace(/[^a-zA-Z0-9._-]/g, '_'));
  if (importedRepositoryRoot(fullName)) return fullName;
  fs.mkdirSync(path.dirname(root), { recursive: true });
  if (fs.existsSync(root) && fs.readdirSync(root).length) throw new Error('An unrelated local repository already uses this name.');
  const token = await installationToken(repo.installationId);
  try {
    execFileSync('git', ['clone', '--depth', '1', `--branch=${branch}`, `https://github.com/${fullName}.git`, root], { env: gitCredentialEnv(token), stdio: 'pipe', timeout: 120_000 });
    return fullName;
  } catch (error) {
    const err = error as { message?: string; stderr?: Buffer | string };
    const detail = String(err.stderr || err.message || 'unknown').slice(0, 300);
    // Safe to log: clone URL carries no token (auth travels via header).
    console.error(`[orlynx] import failed repo=${fullName} branch=${branch}: ${detail}`);
    fs.rmSync(root, { recursive: true, force: true });
    throw new Error('The repository import failed. Verify GitHub App contents access and retry.');
  }
}

export async function pushGitHubRepository(project: string, branch: string, installationId?: number): Promise<void> {
  const root = importedRepositoryRoot(project);
  if (!root) throw new Error('This is not an imported GitHub repository.');
  if (!/^[\w./-]+$/.test(branch) || branch.startsWith('-')) throw new Error('Branch name is invalid.');
  const repo = await findRepository(project, installationId);
  const token = await installationToken(repo.installationId);
  try { execFileSync('git', ['push', 'origin', `HEAD:refs/heads/${branch}`], { cwd: root, env: gitCredentialEnv(token), stdio: 'pipe', timeout: 120_000 }); }
  catch { throw new Error('GitHub rejected the push. Your local commit is safe; refresh the branch and retry.'); }
}
