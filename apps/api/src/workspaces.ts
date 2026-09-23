// Workspace Gateway — PDF §6. Generic provider interface.
// LocalProvider runs instantly (localhost demo). CodespacesProvider calls GitHub REST when token present.
import { execSync, spawn } from 'node:child_process';
import path from 'node:path';
import type { WorkspaceState } from '@orlynx/shared';
import { repoRoot } from './github.js';

export interface WorkspaceInfo {
  id: string; sessionId: string; project: string; branch: string;
  provider: 'local' | 'codespaces'; state: WorkspaceState;
  updatedAt: string; externalId?: string;
}

const workspaces = new Map<string, WorkspaceInfo>();
const procs = new Map<string, ReturnType<typeof spawn>>();

export function ensureWorkspace(sessionId: string, project: string, branch: string): WorkspaceInfo {
  const existing = [...workspaces.values()].find((w) => w.sessionId === sessionId && w.project === project);
  if (existing && existing.state === 'ready') return existing;
  const ws: WorkspaceInfo = {
    id: `ws_${sessionId.slice(0, 6)}`, sessionId, project, branch,
    // Codespaces creation is not yet wired into this lifecycle; never label a local
    // simulated workspace as Codespaces merely because a token is configured.
    provider: 'local',
    state: 'preparing', updatedAt: new Date().toISOString(),
  };
  workspaces.set(ws.id, ws);
  // simulate async ready (local = immediate shell check; codespaces = API poll stub)
  setTimeout(() => { ws.state = 'ready'; ws.updatedAt = new Date().toISOString(); }, 800);
  return ws;
}

export function getWorkspace(sessionId: string): WorkspaceInfo | undefined {
  return [...workspaces.values()].find((w) => w.sessionId === sessionId);
}

export function stopWorkspace(sessionId: string): WorkspaceInfo | undefined {
  const ws = getWorkspace(sessionId);
  if (ws) { ws.state = 'stopped'; ws.updatedAt = new Date().toISOString(); procs.get(ws.id)?.kill(); }
  return ws;
}

export function execInWorkspace(project: string, cmd: string, cwd = '', timeoutMs = 30000): { code: number; out: string } {
  // allowlist-ish: block obviously destructive ops unless explicitly approved
  const denied = [/rm\s+-rf\s+\//, /mkfs/, /:KATEX_INLINE_OPEN\(\):KATEX_CLOSE/];
  if (denied.some((r) => r.test(cmd))) throw new Error('command denied by policy (needs approval)');
  try {
    const root = repoRoot(project);
    const target = path.resolve(root, cwd || '.');
    if (target !== root && !target.startsWith(`${root}${path.sep}`)) throw new Error('workspace path escape denied');
    const out = execSync(cmd, { cwd: target, timeout: timeoutMs, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    return { code: 0, out: String(out).slice(0, 50_000) };
  } catch (e: unknown) {
    const err = e as { status?: number; stdout?: string; stderr?: string; message?: string };
    return { code: err.status ?? 1, out: String(err.stdout || err.stderr || err.message || 'failed').slice(0, 50_000) };
  }
}

export async function createCodespaceViaGitHub(repo: string, branch: string): Promise<unknown> {
  // Reference: GET/POST /repos/{owner}/{repo}/codespaces (PDF R1). Requires token + permission.
  const token = process.env.GITHUB_TOKEN;
  if (!token) throw new Error('GITHUB_TOKEN not set — using local provider');
  const [owner, name] = repo.split('/');
  const r = await fetch(`https://api.github.com/repos/${owner}/${name}/codespaces`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json' },
    body: JSON.stringify({ ref: branch }),
  });
  if (!r.ok) throw new Error(`codespaces create failed: ${r.status}`);
  return r.json();
}
