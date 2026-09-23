// Repository Gateway — PDF §5. Local-first + GitHub passthrough.
// Local mode works without credentials (demo repos under data/repos).
// If GITHUB_TOKEN is set, live GitHub reads are used; otherwise mock.
import fs from 'node:fs';
import path from 'node:path';
import { execSync } from 'node:child_process';
import { dataDir } from './store.js';

const GH = process.env.GITHUB_TOKEN || '';

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

export async function githubListRepos(): Promise<{ full: string }[]> {
  if (!GH) return [];
  const r = await fetch('https://api.github.com/user/repos?per_page=20', { headers: { Authorization: `Bearer ${GH}` } });
  if (!r.ok) return [];
  const j = await r.json() as { full_name: string }[];
  return j.map((x) => ({ full: x.full_name }));
}
