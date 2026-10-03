export const E2E_BRANCH_PREFIX = 'orlynx-e2e/';

export function liveE2EEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.ORLYNX_E2E_ENABLED === 'true';
}

export function liveE2ERepository(env: NodeJS.ProcessEnv = process.env): string {
  return String(env.ORLYNX_E2E_REPOSITORY || '').trim();
}

export function validLiveE2EBranch(branch: string): boolean {
  return /^orlynx-e2e\/[0-9]{10,17}(?:-[A-Za-z0-9._-]+)?$/.test(String(branch || ''));
}

export function liveE2ERepositoryAllowed(project: string, env: NodeJS.ProcessEnv = process.env): boolean {
  const allowed = liveE2ERepository(env);
  return Boolean(allowed) && String(project || '').toLowerCase() === allowed.toLowerCase();
}

export function assertLiveE2ESession(project: string, branch: string, env: NodeJS.ProcessEnv = process.env): void {
  if (!liveE2EEnabled(env)) throw new Error('Live E2E is disabled.');
  if (!liveE2ERepositoryAllowed(project, env)) throw new Error('Live E2E repository is not allowlisted.');
  if (!validLiveE2EBranch(branch)) throw new Error('Live E2E branch must use the orlynx-e2e/<timestamp> namespace.');
}


type E2ESession = { project: string; branch: string; checkpoint?: { liveE2EBranch?: string } };

export function liveE2ESessionBranch(session: E2ESession): string | undefined {
  return session.checkpoint?.liveE2EBranch || (session.branch.startsWith(E2E_BRANCH_PREFIX) ? session.branch : undefined);
}

export function assertLiveE2EPublication(
  session: E2ESession,
  targetBranch: string,
  strategy: string,
  workspaceBranch?: string,
  env: NodeJS.ProcessEnv = process.env,
): void {
  const isolatedBranch = liveE2ESessionBranch(session) || (workspaceBranch?.startsWith(E2E_BRANCH_PREFIX) ? workspaceBranch : undefined);
  if (!isolatedBranch) return;
  assertLiveE2ESession(session.project, isolatedBranch, env);
  if (session.branch !== isolatedBranch || targetBranch !== isolatedBranch || strategy !== 'direct') {
    throw new Error('Live E2E sessions may publish only their isolated E2E branch using direct publication.');
  }
  if (workspaceBranch !== undefined && workspaceBranch !== isolatedBranch) {
    throw new Error('Live E2E workspace branch does not match the isolated E2E branch.');
  }
}
