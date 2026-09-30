export type WorkspaceFailureKind = 'authorization' | 'configuration' | 'transient';

// Keep provider fallback and durable retry decisions consistent. Repository
// installation visibility errors do not carry an HTTP status from GitHub.
export function classifyWorkspaceFailure(error: unknown): WorkspaceFailureKind {
  const detail = error instanceof Error ? error.message : String(error);
  if (/HTTP\s*(?:401|403)|forbidden|unauthorized|permission|authorization expired|repository is not available through (?:the connected Orlynx GitHub App installation|an installed GitHub App)/i.test(detail)) return 'authorization';
  if (/not configured|invalid .*configuration/i.test(detail)) return 'configuration';
  return 'transient';
}
