import type { WorkspaceProviderId, WorkspaceRecord, WorkspaceState } from '@orlynx/shared';

export interface CreateWorkspaceInput {
  workspaceId: string;
  sessionId: string;
  userId: string;
  projectId: string;
  repositoryId: number;
  branch: string;
}

export interface WorkspaceConnectionValues {
  bridgeToken: string;
  connectionId: string;
  openCodePassword: string;
}

export interface WorkspaceProviderHealth {
  reachable: boolean;
  state: WorkspaceState;
  capabilities?: string[];
  detail?: string;
}

export interface WorkspaceProvider {
  readonly id: WorkspaceProviderId;
  readonly capabilities?: readonly string[];
  create(input: CreateWorkspaceInput): Promise<WorkspaceRecord>;
  start(workspace: WorkspaceRecord): Promise<WorkspaceRecord>;
  stop(workspace: WorkspaceRecord): Promise<WorkspaceRecord>;
  get(workspace: WorkspaceRecord): Promise<WorkspaceRecord>;
  getStatus(workspace: WorkspaceRecord): Promise<WorkspaceState>;
  health?(workspace: WorkspaceRecord): Promise<WorkspaceProviderHealth>;
  destroy(workspace: WorkspaceRecord): Promise<void>;
  replace?(input: CreateWorkspaceInput, workspace: WorkspaceRecord): Promise<WorkspaceRecord>;
  connect?(workspace: WorkspaceRecord, values: WorkspaceConnectionValues): Promise<void>;
  previewUrl?(workspace: WorkspaceRecord, port: number): string | undefined;
}
