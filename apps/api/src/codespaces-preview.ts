import type { WorkspaceRecord } from '@orlynx/shared';

export function codespacesPreviewUrl(
  workspace: Pick<WorkspaceRecord, 'codespaceName'>,
  port: number,
): string | undefined {
  if (!workspace.codespaceName || !Number.isInteger(port) || port <= 0 || port > 65535) return undefined;

  const rawDomain = String(process.env.ORLYNX_CODESPACES_PORT_FORWARDING_DOMAIN || 'app.github.dev').trim();
  const domain = rawDomain
    .replace(/^https?:\/\//i, '')
    .replace(/\/.*$/, '')
    .replace(/^\.+|\.+$/g, '');

  if (!domain || !/^[a-z0-9.-]+$/i.test(domain)) return undefined;
  return `https://${workspace.codespaceName}-${port}.${domain}/`;
}
