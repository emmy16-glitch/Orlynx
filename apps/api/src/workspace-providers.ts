import type { WorkspaceProviderId, WorkspaceRecord } from '@orlynx/shared';
import { GitHubCodespacesProvider } from './github-codespaces.js';
import { OrlynxRunnerProvider, orlynxRunnerConfigured } from './orlynx-runner.js';
import type { WorkspaceProvider } from './workspace-provider.js';

const codespaces = new GitHubCodespacesProvider();
const runner = new OrlynxRunnerProvider();

export function defaultWorkspaceProviderId(): WorkspaceProviderId {
  const configured = String(process.env.ORLYNX_WORKSPACE_PROVIDER || 'auto').toLowerCase();
  if (configured === 'github-codespaces') return 'github-codespaces';
  if (configured === 'orlynx-runner') {
    if (!orlynxRunnerConfigured()) throw new Error('ORLYNX_WORKSPACE_PROVIDER=orlynx-runner but ORLYNX_RUNNER_URL/ORLYNX_RUNNER_TOKEN are not configured.');
    return 'orlynx-runner';
  }
  return orlynxRunnerConfigured() ? 'orlynx-runner' : 'github-codespaces';
}

export function workspaceProvider(id: WorkspaceProviderId): WorkspaceProvider {
  return id === 'orlynx-runner' ? runner : codespaces;
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
