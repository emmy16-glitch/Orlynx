import type { WorkspaceProviderId, WorkspaceRecord } from '@orlynx/shared';
import { GitHubCodespacesProvider } from './github-codespaces.js';
import { OrlynxRunnerProvider, orlynxRunnerConfigured } from './orlynx-runner.js';
import { E2BWorkspaceProvider, e2bConfigured } from './e2b-provider.js';
import type { WorkspaceProvider } from './workspace-provider.js';

const codespaces = new GitHubCodespacesProvider();
const e2b = new E2BWorkspaceProvider();
const runner = new OrlynxRunnerProvider();

export function defaultWorkspaceProviderId(): WorkspaceProviderId {
  // Codespaces is the stable, persistent Build environment. Render runners are
  // now opt-in only and never become the critical path merely because runner
  // credentials happen to be configured in production.
  const configured = String(process.env.ORLYNX_WORKSPACE_PROVIDER || 'github-codespaces').toLowerCase();
  if (configured === 'github-codespaces' || configured === 'auto') return 'github-codespaces';
  if (configured === 'e2b') {
    if (!e2bConfigured()) throw new Error('ORLYNX_WORKSPACE_PROVIDER=e2b is not configured: set E2B_API_KEY.');
    return 'e2b';
  }
  if (configured === 'orlynx-runner') {
    if (!orlynxRunnerConfigured()) throw new Error('ORLYNX_WORKSPACE_PROVIDER=orlynx-runner is not configured: set ORLYNX_RUNNER_HOSTS or ORLYNX_RUNNER_URL together with ORLYNX_RUNNER_TOKEN.');
    return 'orlynx-runner';
  }
  return 'github-codespaces';
}

export function workspaceProvider(id: WorkspaceProviderId): WorkspaceProvider {
  if (id === 'orlynx-runner') return runner;
  if (id === 'e2b') return e2b;
  return codespaces;
}

export function fallbackWorkspaceProviderId(
  current: WorkspaceProviderId,
  attempted: Iterable<WorkspaceProviderId> = [],
): WorkspaceProviderId | null {
  const used = new Set(attempted);
  used.add(current);

  // Provider order is deliberate:
  // persistent GitHub Codespaces -> isolated E2B -> warm Render runner pool.
  // Explicit E2B/runner deployments still prefer returning to Codespaces when
  // it has not already been attempted. Never revisit an attempted provider.
  if (current === 'github-codespaces') {
    if (e2bConfigured() && !used.has('e2b')) return 'e2b';
    if (orlynxRunnerConfigured() && !used.has('orlynx-runner')) return 'orlynx-runner';
    return null;
  }

  if (current === 'e2b') {
    if (!used.has('github-codespaces')) return 'github-codespaces';
    if (orlynxRunnerConfigured() && !used.has('orlynx-runner')) return 'orlynx-runner';
    return null;
  }

  if (current === 'orlynx-runner') {
    if (!used.has('github-codespaces')) return 'github-codespaces';
    if (e2bConfigured() && !used.has('e2b')) return 'e2b';
    return null;
  }

  return null;
}

export function providerForWorkspace(workspace: Pick<WorkspaceRecord, 'provider'>): WorkspaceProvider {
  return workspaceProvider(workspace.provider);
}

export function shouldPrewarmWorkspace(): boolean {
  if (process.env.ORLYNX_PREWARM_WORKSPACES === '0') return false;
  return defaultWorkspaceProviderId() === 'orlynx-runner';
}

export function runnerFallbackEnabled(): boolean {
  return process.env.ORLYNX_RUNNER_FALLBACK_TO_CODESPACES !== '0';
}

export function workspaceInfrastructureConfigured(): boolean {
  try {
    const provider = defaultWorkspaceProviderId();
    if (provider === 'orlynx-runner') return orlynxRunnerConfigured();
    if (provider === 'e2b') return e2bConfigured();
    return process.env.VERCEL === '1'
      || process.env.ORLYNX_HOSTED_PRODUCTION === '1'
      || process.env.RENDER === 'true'
      || Boolean(process.env.RENDER_SERVICE_ID)
      || process.env.ORLYNX_BOOTSTRAP_MODE === 'sandbox'
      || process.env.ORLYNX_BOOTSTRAP_MODE === 'local'
      || Boolean(process.env.ORLYNX_RUNTIME_WORKER_URL && process.env.ORLYNX_RUNTIME_WORKER_TOKEN);
  } catch {
    return false;
  }
}
