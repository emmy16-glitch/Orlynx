import type { WorkspaceRecord, WorkspaceState } from '@orlynx/shared';

export interface CreateWorkspaceInput {
  workspaceId: string;
  sessionId: string;
  userId: string;
  projectId: string;
  repositoryId: number;
  branch: string;
}

export interface WorkspaceProvider {
  create(input: CreateWorkspaceInput): Promise<WorkspaceRecord>;
  start(workspace: WorkspaceRecord): Promise<WorkspaceRecord>;
  stop(workspace: WorkspaceRecord): Promise<WorkspaceRecord>;
  get(workspace: WorkspaceRecord): Promise<WorkspaceRecord>;
  getStatus(workspace: WorkspaceRecord): Promise<WorkspaceState>;
  destroy(workspace: WorkspaceRecord): Promise<void>;
}
