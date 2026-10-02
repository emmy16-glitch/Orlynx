// Render deployment verification. "Deploy it" must prove the deployed
// result, not assume a push eventually deploys. All Render access is optional:
// without RENDER_API_KEY the API reports deployment as unknown instead of
// faking success. Secrets never leave the server process.
const RENDER_API = 'https://api.render.com/v1';

function apiKey(): string {
  return String(process.env.RENDER_API_KEY || '').trim();
}

function serviceIds(): string[] {
  const raw = String(process.env.RENDER_SERVICE_ID || process.env.RENDER_SERVICE_IDS || '').trim();
  if (!raw) return [];
  return raw.split(/[,\s]+/).map((value) => value.trim()).filter(Boolean).slice(0, 8);
}

export interface RenderDeployState {
  configured: boolean;
  serviceId?: string;
  deployId?: string;
  status?: string;
  commitSha?: string | null;
  commitMatches?: boolean;
  live?: boolean;
  finished?: boolean;
  failed?: boolean;
  message: string;
}

interface RenderDeploy {
  id: string;
  status: string;
  commit?: { id?: string };
  finishedAt?: string | null;
}

async function latestDeploy(serviceId: string): Promise<RenderDeploy> {
  const response = await fetch(`${RENDER_API}/services/${encodeURIComponent(serviceId)}/deploys?limit=1`, {
    headers: { Authorization: `Bearer ${apiKey()}`, Accept: 'application/json' },
    signal: AbortSignal.timeout(15_000),
  });
  if (response.status === 401 || response.status === 403) throw new Error('Render API key is invalid or lacks access to this service.');
  if (response.status === 404) throw new Error('Render service was not found. It may have been deleted.');
  if (!response.ok) throw new Error(`Render API returned HTTP ${response.status}.`);
  const body = await response.json() as Array<{ deploy?: RenderDeploy }> | RenderDeploy;
  const deploy = Array.isArray(body) ? body[0]?.deploy : (body as RenderDeploy);
  if (!deploy?.id) throw new Error('Render returned no deployments for this service.');
  return deploy;
}

// Establishes whether the service serving production runs the expected
// commit. Returns structured state; callers turn it into receipts/replies.
export async function renderDeployStatus(expectedCommitSha: string): Promise<RenderDeployState> {
  const key = apiKey();
  const services = serviceIds();
  if (!key || !services.length) {
    return {
      configured: false,
      message: 'Deployment verification is not configured on this server. Confirm the release in the Render dashboard.',
    };
  }
  const serviceId = services[0];
  let deploy: RenderDeploy;
  try {
    deploy = await latestDeploy(serviceId);
  } catch (error) {
    return { configured: true, serviceId, message: error instanceof Error ? error.message : 'Render deployment status is unavailable.' };
  }
  const status = String(deploy.status || 'unknown').toLowerCase();
  const commitSha = deploy.commit?.id || null;
  const commitMatches = commitSha ? commitSha.toLowerCase().startsWith(expectedCommitSha.toLowerCase().slice(0, 7)) || expectedCommitSha.toLowerCase().startsWith(commitSha.toLowerCase().slice(0, 7)) : false;
  const live = status === 'live' || status === 'deployed';
  const failed = ['build_failed', 'failed', 'canceled', 'cancelled', 'deactivated'].includes(status);
  const finished = live || failed;
  const short = expectedCommitSha.slice(0, 7);
  return {
    configured: true, serviceId, deployId: deploy.id, status, commitSha, commitMatches, live, finished, failed,
    message: live && commitMatches
      ? `Deployment ${deploy.id} is live at ${short}.`
      : live
        ? `Deployment ${deploy.id} is live${commitSha ? ` at ${commitSha.slice(0, 7)}` : ''}, which does not match published ${short} — version drift.`
        : failed
          ? `Deployment ${deploy.id} ${status} for ${short}.`
          : `Deployment ${deploy.id} is ${status} for ${short}.`,
  };
}
