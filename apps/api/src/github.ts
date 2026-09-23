// Repository Gateway — PDF §5. Local-first + GitHub passthrough.
// Local mode works without credentials (demo repos under data/repos).
// If GITHUB_TOKEN is set, live GitHub reads are used; otherwise mock.
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync, execSync } from 'node:child_process';
import { dataDir } from './store.js';

const GH = process.env.GITHUB_TOKEN || '';

export async function githubConnectionStatus() {
  if (!GH) return { connected: false, auth: 'not-configured', provider: 'GitHub' };
  try {
    const response = await fetch('https://api.github.com/user', { headers: { Authorization: `Bearer ${GH}`, Accept: 'application/vnd.github+json' } });
    if (!response.ok) return { connected: false, auth: response.status === 401 ? 'expired' : 'unavailable', provider: 'GitHub' };
    const user = await response.json() as { login: string };
    return { connected: true, auth: 'server-configured', provider: 'GitHub', login: user.login };
  } catch { return { connected: false, auth: 'unavailable', provider: 'GitHub' }; }
}

export function repoRoot(project: string): string {
  const root = path.join(dataDir, 'repos', project.replace(/[^a-zA-Z0-9._-]/g, '_'));
  fs.mkdirSync(root, { recursive: true });
  ensureGit(root);
  return root;
}

function ensureGit(root: string) {
  if (!fs.existsSync(path.join(root, '.git'))) {
    execSync('git init -b main', { cwd: root, stdio: 'ignore' });
    execSync('git config user.email "orlynx@local"', { cwd: root, stdio: 'ignore' });
    execSync('git config user.name "Orlynx"', { cwd: root, stdio: 'ignore' });
    fs.writeFileSync(path.join(root, 'README.md'), `# ${path.basename(root)}\n\nOrlynx workspace.\n`);
    execSync('git add -A && git commit -m "init" --allow-empty', { cwd: root, stdio: 'ignore' });
  }
}

export function headSha(project: string): string {
  try {
    return execSync('git rev-parse HEAD', { cwd: repoRoot(project) }).toString().trim();
  } catch { return 'local-init'; }
}

export function listFiles(project: string, sub = ''): { name: string; dir: boolean }[] {
  const root = repoRoot(project);
  const target = path.normalize(path.join(root, sub)).replace(/\\/g, '/');
  if (!target.startsWith(root)) throw new Error('path escape denied');
  return fs.readdirSync(target, { withFileTypes: true }).filter((d) => d.name !== '.git').map((d) => ({ name: d.name, dir: d.isDirectory() }));
}

export function readFile(project: string, file: string): string {
  const root = repoRoot(project);
  const target = path.normalize(path.join(root, file));
  if (!target.startsWith(root)) throw new Error('path escape denied');
  return fs.readFileSync(target, 'utf8').slice(0, 200_000);
}

export function status(project: string): string {
  try { return execSync('git status --porcelain', { cwd: repoRoot(project) }).toString(); }
  catch { return ''; }
}

export interface GitHubRepository {
  full: string;
  name: string;
  owner: string;
  ownerType: string;
  private: boolean;
  defaultBranch: string;
  language: string | null;
  updatedAt: string;
  url: string;
}

export async function githubListRepos(): Promise<GitHubRepository[]> {
  if (!GH) return [];
  try {
    const r = await fetch('https://api.github.com/user/repos?per_page=100&sort=updated', { headers: { Authorization: `Bearer ${GH}`, Accept: 'application/vnd.github+json' } });
    if (!r.ok) return [];
    const j = await r.json() as { full_name: string; name: string; owner: { login: string; type: string }; private: boolean; default_branch: string; language: string | null; updated_at: string; html_url: string }[];
    return j.map((x) => ({ full: x.full_name, name: x.name, owner: x.owner.login, ownerType: x.owner.type, private: x.private, defaultBranch: x.default_branch, language: x.language, updatedAt: x.updated_at, url: x.html_url }));
  } catch { return []; }
}

export async function githubBranches(fullName: string): Promise<string[]> {
  if (!GH || !/^[\w.-]+\/[\w.-]+$/.test(fullName)) return [];
  try {
    const r = await fetch(`https://api.github.com/repos/${fullName}/branches?per_page=100`, { headers: { Authorization: `Bearer ${GH}`, Accept: 'application/vnd.github+json' } });
    if (!r.ok) return [];
    const body = await r.json() as { name: string }[];
    return body.map((branch) => branch.name);
  } catch { return []; }
}

export async function importGitHubRepository(fullName: string, branch: string): Promise<string> {
  if (!GH) throw new Error('GitHub access is not configured for this Orlynx server.');
  if (!/^[\w.-]+\/[\w.-]+$/.test(fullName) || !/^[\w./-]+$/.test(branch) || branch.startsWith('-')) throw new Error('Repository or branch name is invalid.');
  const allowed = await githubBranches(fullName);
  if (!allowed.includes(branch)) throw new Error('That branch is not available to this GitHub connection.');
  const root = path.join(dataDir, 'repos', fullName.replace(/[^a-zA-Z0-9._-]/g, '_'));
  if (fs.existsSync(path.join(root, '.git'))) return fullName;
  fs.mkdirSync(path.dirname(root), { recursive: true });
  if (fs.existsSync(root) && fs.readdirSync(root).length) throw new Error('A local project already uses this repository name.');
  const env = { ...process.env };
  delete env.GITHUB_TOKEN;
  env.GIT_CONFIG_COUNT = '1';
  env.GIT_CONFIG_KEY_0 = 'http.extraheader';
  env.GIT_CONFIG_VALUE_0 = `AUTHORIZATION: basic ${Buffer.from(`x-access-token:${GH}`).toString('base64')}`;
  try {
    execFileSync('git', ['clone', '--depth', '1', `--branch=${branch}`, `https://github.com/${fullName}.git`, root], { env, stdio: 'pipe', timeout: 120_000 });
    return fullName;
  } catch {
    fs.rmSync(root, { recursive: true, force: true });
    throw new Error('The repository could not be imported. Check access and try again.');
  }
}

export function pushGitHubRepository(project: string, branch: string): void {
  const root = repoRoot(project);
  const expectedRemote = `https://github.com/${project}.git`;
  let remote = '';
  try { remote = execSync('git remote get-url origin', { cwd: root }).toString().trim().replace(/\.git$/, ''); }
  catch { throw new Error('This is a local-only project. Import a GitHub repository before pushing.'); }
  if (remote.replace(/\.git$/, '').toLowerCase() !== expectedRemote.replace(/\.git$/, '').toLowerCase()) {
    throw new Error('The configured Git remote does not match this repository.');
  }
  if (!GH) throw new Error('GitHub access is not configured for this Orlynx server.');
  if (!/^[\w./-]+$/.test(branch) || branch.startsWith('-')) throw new Error('Branch name is invalid.');
  const env = { ...process.env };
  delete env.GITHUB_TOKEN;
  env.GIT_CONFIG_COUNT = '1';
  env.GIT_CONFIG_KEY_0 = 'http.extraheader';
  env.GIT_CONFIG_VALUE_0 = `AUTHORIZATION: basic ${Buffer.from(`x-access-token:${GH}`).toString('base64')}`;
  try { execFileSync('git', ['push', 'origin', `HEAD:refs/heads/${branch}`], { cwd: root, env, stdio: 'pipe', timeout: 120_000 }); }
  catch { throw new Error('Push was rejected by GitHub. Your local commit is safe; sync the branch and retry.'); }
}
