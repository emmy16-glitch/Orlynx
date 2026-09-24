// GitHub App gateway. Installation access tokens are created on demand and never persisted.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync, execSync } from 'node:child_process';
import { dataDir, store } from './store.js';

const API = 'https://api.github.com';
const appId = process.env.GITHUB_APP_ID || '';
const appSlug = process.env.GITHUB_APP_SLUG || '';
const publicUrl = (process.env.ORLYNX_PUBLIC_URL || '').replace(/\/$/, '');
const clientSecret = process.env.GITHUB_APP_CLIENT_SECRET || '';
const webhookSecret = process.env.GITHUB_WEBHOOK_SECRET || '';
const privateKeyValue = process.env.GITHUB_APP_PRIVATE_KEY || '';
const privateKey = privateKeyValue.includes('BEGIN')
  ? privateKeyValue.replace(/\\n/g, '\n')
  : privateKeyValue ? Buffer.from(privateKeyValue, 'base64').toString('utf8') : '';

export function githubAppConfigured(): boolean {
  let publicOriginIsSafe = false;
  try {
    const url = new URL(publicUrl);
    publicOriginIsSafe = url.protocol === 'https:' || ['localhost', '127.0.0.1', '::1'].includes(url.hostname);
  } catch { publicOriginIsSafe = false; }
  return Boolean(appId && appSlug && publicOriginIsSafe && clientSecret && privateKey && webhookSecret);
}

export function githubInstallUrl(): string {
  if (!githubAppConfigured()) throw new Error('GitHub App settings are incomplete on this Orlynx server.');
  const state = signState({ purpose: 'install', nonce: crypto.randomBytes(18).toString('base64url'), exp: Date.now() + 10 * 60_000 });
  return `https://github.com/apps/${encodeURIComponent(appSlug)}/installations/new?state=${encodeURIComponent(state)}`;
}

export function githubSetupUrl(): string {
  if (!githubAppConfigured()) throw new Error('GitHub App settings are incomplete on this Orlynx server.');
  return `${publicUrl}/v1/github/setup`;
}

export function githubWebhookUrl(): string {
  if (!githubAppConfigured()) throw new Error('GitHub App settings are incomplete on this Orlynx server.');
  return `${publicUrl}/v1/github/webhook`;
}

export async function acceptGitHubWebhook(rawBody: Buffer, signature: string, event: string): Promise<void> {
  if (!webhookSecret) throw new Error('GitHub webhook signing is not configured.');
  const expected = crypto.createHmac('sha256', webhookSecret).update(rawBody).digest();
  const received = Buffer.from(signature.replace(/^sha256=/, ''), 'hex');
  if (expected.length !== received.length || !crypto.timingSafeEqual(expected, received)) throw new Error('GitHub webhook signature is invalid.');
  const payload = JSON.parse(rawBody.toString('utf8')) as { action?: string; installation?: { id: number; account?: { login?: string; type?: string } } };
  if (event !== 'installation' || !payload.installation) return;
  const id = payload.installation.id;
  if (payload.action === 'deleted' || payload.action === 'suspend') {
    store.db.githubInstallations = store.db.githubInstallations.filter((item) => item.id !== id);
    tokenCache.delete(id);
    store.save();
  } else if (payload.action === 'created' || payload.action === 'unsuspend') {
    const rows = store.db.githubInstallations.filter((item) => item.id !== id);
    rows.push({ id, account: payload.installation.account?.login || 'GitHub account', accountType: payload.installation.account?.type || 'User', installedAt: new Date().toISOString() });
    store.db.githubInstallations = rows;
    store.save();
  }
}

export async function completeGitHubInstallation(installationId: string, state: string, setupAction: string) {
  const claims = verifyState(state);
  if (claims.purpose !== 'install') throw new Error('GitHub installation state is invalid.');
  const id = Number(installationId);
  if (!Number.isSafeInteger(id) || id <= 0) throw new Error('GitHub returned an invalid installation id.');
  if (setupAction === 'install' || setupAction === 'update') {
    const jwt = createAppJwt();
    const response = await fetch(`${API}/app/installations/${id}`, { headers: githubHeaders(jwt) });
    if (!response.ok) throw new Error(`GitHub could not verify the app installation (HTTP ${response.status}).`);
    const installation = await response.json() as { id: number; account?: { login?: string; type?: string } };
    const rows = store.db.githubInstallations.filter((item) => item.id !== installation.id);
    rows.push({ id: installation.id, account: installation.account?.login || 'GitHub account', accountType: installation.account?.type || 'User', installedAt: new Date().toISOString() });
    store.db.githubInstallations = rows;
    store.save();
  } else if (setupAction === 'uninstall') {
    store.db.githubInstallations = store.db.githubInstallations.filter((item) => item.id !== id);
    store.save();
  } else {
    throw new Error('GitHub returned an unsupported installation action.');
  }
  return `${publicUrl}/?github=${setupAction === 'uninstall' ? 'disconnected' : 'connected'}`;
}

export async function githubConnectionStatus() {
  return {
    configured: githubAppConfigured(),
    connected: githubAppConfigured() && store.db.githubInstallations.length > 0,
    auth: !githubAppConfigured() ? 'not-configured' : store.db.githubInstallations.length ? 'github-app' : 'installation-required',
    provider: 'GitHub App',
    installations: store.db.githubInstallations.map(({ id, account, accountType, installedAt }) => ({ id, account, accountType, installedAt })),
    installUrl: githubAppConfigured() ? '/v1/github/install' : null,
    setupCallbackUrl: githubAppConfigured() ? githubSetupUrl() : null,
    webhookUrl: githubAppConfigured() ? githubWebhookUrl() : null,
  };
}

function signState(claims: Record<string, unknown>): string {
  const data = Buffer.from(JSON.stringify(claims)).toString('base64url');
  const signature = crypto.createHmac('sha256', clientSecret).update(data).digest('base64url');
  return `${data}.${signature}`;
}

function verifyState(state: string): { purpose: string; exp: number } {
  if (!githubAppConfigured()) throw new Error('GitHub App is not configured.');
  const [data, signature, extra] = state.split('.');
  if (!data || !signature || extra) throw new Error('GitHub installation state is invalid.');
  const expected = crypto.createHmac('sha256', clientSecret).update(data).digest();
  let received: Buffer;
  try { received = Buffer.from(signature, 'base64url'); } catch { throw new Error('GitHub installation state is invalid.'); }
  if (expected.length !== received.length || !crypto.timingSafeEqual(expected, received)) throw new Error('GitHub installation state signature is invalid.');
  let claims: { purpose: string; exp: number };
  try { claims = JSON.parse(Buffer.from(data, 'base64url').toString('utf8')); } catch { throw new Error('GitHub installation state is invalid.'); }
  if (!claims.exp || claims.exp < Date.now()) throw new Error('GitHub installation state expired. Start the connection again.');
  return claims;
}

function createAppJwt(): string {
  if (!githubAppConfigured()) throw new Error('GitHub App settings are incomplete on this Orlynx server.');
  const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url');
  const unsigned = `${encode({ alg: 'RS256', typ: 'JWT' })}.${encode({ iat: Math.floor(Date.now() / 1000) - 60, exp: Math.floor(Date.now() / 1000) + 8 * 60, iss: appId })}`;
  const signature = crypto.sign('RSA-SHA256', Buffer.from(unsigned), privateKey).toString('base64url');
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
  if (!store.db.githubInstallations.some((item) => item.id === installationId)) throw new Error('This GitHub installation is not connected to Orlynx.');
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
  full: string; name: string; owner: string; ownerType: string; private: boolean;
  defaultBranch: string; language: string | null; updatedAt: string; url: string;
  installationId: number;
}

export async function githubListRepos(): Promise<GitHubRepository[]> {
  const repos: GitHubRepository[] = [];
  for (const installation of store.db.githubInstallations) {
    const cached = repositoryCache.get(installation.id);
    if (cached && cached.expiresAt > Date.now()) { repos.push(...cached.repos); continue; }
    const token = await installationToken(installation.id);
    const installationRepos: GitHubRepository[] = [];
    for (let page = 1; page <= 10; page++) {
      const response = await fetch(`${API}/installation/repositories?per_page=100&page=${page}`, { headers: githubHeaders(token) });
      if (!response.ok) throw new Error(`Could not list repositories for GitHub installation ${installation.account} (HTTP ${response.status}).`);
      const data = await response.json() as { repositories: { full_name: string; name: string; owner: { login: string; type: string }; private: boolean; default_branch: string; language: string | null; updated_at: string; html_url: string }[]; total_count: number };
      installationRepos.push(...data.repositories.map((repo) => ({ full: repo.full_name, name: repo.name, owner: repo.owner.login, ownerType: repo.owner.type, private: repo.private, defaultBranch: repo.default_branch, language: repo.language, updatedAt: repo.updated_at, url: repo.html_url, installationId: installation.id })));
      if (data.repositories.length < 100 || installationRepos.length >= data.total_count) break;
    }
    repositoryCache.set(installation.id, { repos: installationRepos, expiresAt: Date.now() + 30_000 });
    repos.push(...installationRepos);
  }
  return repos;
}

export async function githubRepositoryAuthorized(project: string): Promise<boolean> {
  try { return (await githubListRepos()).some((repo) => repo.full.toLowerCase() === project.toLowerCase()); }
  catch { return false; }
}

async function findRepository(fullName: string): Promise<GitHubRepository> {
  const repo = (await githubListRepos()).find((item) => item.full.toLowerCase() === fullName.toLowerCase());
  if (!repo) throw new Error('This repository is not available through an installed GitHub App.');
  return repo;
}

export async function githubBranches(fullName: string): Promise<string[]> {
  const repo = await findRepository(fullName);
  const token = await installationToken(repo.installationId);
  const response = await fetch(`${API}/repos/${encodeURIComponent(repo.owner)}/${encodeURIComponent(repo.name)}/branches?per_page=100`, { headers: githubHeaders(token) });
  if (!response.ok) throw new Error(`Could not load branches for ${fullName} (HTTP ${response.status}).`);
  const body = await response.json() as { name: string }[];
  return body.map((branch) => branch.name);
}

export function repoRoot(project: string): string {
  const root = importedRepositoryRoot(project);
  if (!root) throw new Error('Repository is not imported from an authorized GitHub App installation.');
  return root;
}

export function configureCommitIdentity(project: string): void {
  const name = process.env.ORLYNX_GIT_AUTHOR_NAME || `${appSlug}[bot]`;
  const email = process.env.ORLYNX_GIT_AUTHOR_EMAIL || `${appId}+${appSlug}[bot]@users.noreply.github.com`;
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

export function listFiles(project: string, sub = ''): { name: string; dir: boolean }[] {
  const root = importedRepositoryRoot(project);
  if (!root) throw new Error('Project repository is unavailable. Reconnect GitHub and import it again.');
  const target = path.resolve(root, sub || '.');
  if (target !== root && !target.startsWith(`${root}${path.sep}`)) throw new Error('path escape denied');
  return fs.readdirSync(target, { withFileTypes: true }).filter((entry) => entry.name !== '.git').map((entry) => ({ name: entry.name, dir: entry.isDirectory() }));
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

export async function importGitHubRepository(fullName: string, branch: string): Promise<string> {
  if (!/^[\w.-]+\/[\w.-]+$/.test(fullName) || !branch || branch.startsWith('-')) throw new Error('Repository or branch name is invalid.');
  const repo = await findRepository(fullName);
  const branches = await githubBranches(fullName);
  if (!branches.includes(branch)) throw new Error('That branch is not available to this GitHub App installation.');
  const root = path.join(dataDir, 'repos', fullName.replace(/[^a-zA-Z0-9._-]/g, '_'));
  if (importedRepositoryRoot(fullName)) return fullName;
  fs.mkdirSync(path.dirname(root), { recursive: true });
  if (fs.existsSync(root) && fs.readdirSync(root).length) throw new Error('An unrelated local repository already uses this name.');
  const token = await installationToken(repo.installationId);
  try {
    execFileSync('git', ['clone', '--depth', '1', `--branch=${branch}`, `https://github.com/${fullName}.git`, root], { env: gitCredentialEnv(token), stdio: 'pipe', timeout: 120_000 });
    return fullName;
  } catch {
    fs.rmSync(root, { recursive: true, force: true });
    throw new Error('The repository import failed. Verify GitHub App contents access and retry.');
  }
}

export async function pushGitHubRepository(project: string, branch: string): Promise<void> {
  const root = importedRepositoryRoot(project);
  if (!root) throw new Error('This is not an imported GitHub repository.');
  if (!/^[\w./-]+$/.test(branch) || branch.startsWith('-')) throw new Error('Branch name is invalid.');
  const repo = await findRepository(project);
  const token = await installationToken(repo.installationId);
  try { execFileSync('git', ['push', 'origin', `HEAD:refs/heads/${branch}`], { cwd: root, env: gitCredentialEnv(token), stdio: 'pipe', timeout: 120_000 }); }
  catch { throw new Error('GitHub rejected the push. Your local commit is safe; refresh the branch and retry.'); }
}
