// Render deployment verification. "Deploy it" must prove the deployed
// result, not assume a push eventually deploys. All Render access is optional:
// without RENDER_API_KEY the API reports deployment as unknown instead of
// faking success. Secrets never leave the server process.
const RENDER_API = 'https://api.render.com/v1';

function apiKey(): string {
  return String(process.env.RENDER_API_KEY || '').trim();
}

function serviceIds(): string[] {
  // RENDER_SERVICE_ID remains the primary service for backwards compatibility.
  // RENDER_SERVICE_IDS can add the runtime/runner fleet. Merge + de-duplicate
  // instead of letting the primary variable hide the fleet variable.
  const raw = [
    String(process.env.RENDER_SERVICE_ID || '').trim(),
    String(process.env.RENDER_SERVICE_IDS || '').trim(),
  ].filter(Boolean).join(',');
  if (!raw) return [];
  return [...new Set(raw.split(/[,\s]+/).map((value) => value.trim()).filter(Boolean))].slice(0, 8);
}

export interface RenderServiceDeployState {
  configured: boolean;
  serviceId: string;
  deployId?: string;
  status?: string;
  commitSha?: string | null;
  commitMatches?: boolean;
  live?: boolean;
  finished?: boolean;
  failed?: boolean;
  message: string;
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
  services?: RenderServiceDeployState[];
  message: string;
}

interface RenderDeploy {
  id: string;
  status: string;
  commit?: { id?: string };
  finishedAt?: string | null;
}

function commitsMatch(actual: string | null | undefined, expected: string): boolean {
  if (!actual || !expected) return false;
  const a = actual.toLowerCase();
  const e = expected.toLowerCase();
  const width = Math.min(7, a.length, e.length);
  return width > 0 && (a.startsWith(e.slice(0, width)) || e.startsWith(a.slice(0, width)));
}

async function recentDeploys(serviceId: string): Promise<RenderDeploy[]> {
  // Render can have a newer unrelated deploy at the head of the list while the
  // expected commit is queued/building. Inspect a bounded recent window and
  // select the expected commit rather than falsely reporting version drift.
  const response = await fetch(`${RENDER_API}/services/${encodeURIComponent(serviceId)}/deploys?limit=10`, {
    headers: { Authorization: `Bearer ${apiKey()}`, Accept: 'application/json' },
    signal: AbortSignal.timeout(15_000),
  });
  if (response.status === 401 || response.status === 403) throw new Error('Render API key is invalid or lacks access to this service.');
  if (response.status === 404) throw new Error('Render service was not found. It may have been deleted.');
  if (!response.ok) throw new Error(`Render API returned HTTP ${response.status}.`);
  const body = await response.json() as Array<{ deploy?: RenderDeploy } | RenderDeploy> | RenderDeploy;
  const rows = Array.isArray(body) ? body : [body];
  const deploys = rows
    .map((item) => ('deploy' in item && item.deploy ? item.deploy : item as RenderDeploy))
    .filter((item): item is RenderDeploy => Boolean(item?.id));
  if (!deploys.length) throw new Error('Render returned no deployments for this service.');
  return deploys;
}

async function serviceDeployStatus(serviceId: string, expectedCommitSha: string): Promise<RenderServiceDeployState> {
  let deploys: RenderDeploy[];
  try {
    deploys = await recentDeploys(serviceId);
  } catch (error) {
    return {
      configured: true,
      serviceId,
      message: error instanceof Error ? error.message : 'Render deployment status is unavailable.',
    };
  }

  const deploy = deploys.find((item) => commitsMatch(item.commit?.id, expectedCommitSha)) || deploys[0];
  const status = String(deploy.status || 'unknown').toLowerCase();
  const commitSha = deploy.commit?.id || null;
  const commitMatches = commitsMatch(commitSha, expectedCommitSha);
  const live = status === 'live' || status === 'deployed';
  const failed = ['build_failed', 'failed', 'canceled', 'cancelled', 'deactivated'].includes(status);
  const finished = live || failed;
  const short = expectedCommitSha.slice(0, 7);

  return {
    configured: true,
    serviceId,
    deployId: deploy.id,
    status,
    commitSha,
    commitMatches,
    live,
    finished,
    failed,
    message: live && commitMatches
      ? `Deployment ${deploy.id} is live at ${short}.`
      : live
        ? `Deployment ${deploy.id} is live${commitSha ? ` at ${commitSha.slice(0, 7)}` : ''}, which does not match published ${short} — version drift.`
        : failed
          ? `Deployment ${deploy.id} ${status} for ${short}.`
          : commitMatches
            ? `Deployment ${deploy.id} is ${status} for ${short}.`
            : `Expected deployment ${short} has not appeared on this service yet; latest is ${status}${commitSha ? ` at ${commitSha.slice(0, 7)}` : ''}.`,
  };
}

// Establishes whether production services run the expected commit. With a fleet
// configured, success means every configured active service is live at that
// commit; partial convergence is reported as pending, never as fake success.
export async function renderDeployStatus(expectedCommitSha: string): Promise<RenderDeployState> {
  const key = apiKey();
  const services = serviceIds();
  if (!key || !services.length) {
    return {
      configured: false,
      message: 'Deployment verification is not configured on this server. Confirm the release in the Render dashboard.',
    };
  }

  const states = await Promise.all(services.map((serviceId) => serviceDeployStatus(serviceId, expectedCommitSha)));
  if (states.length === 1) return states[0];

  const expectedLive = states.filter((state) => state.live && state.commitMatches).length;
  const allExpectedLive = expectedLive === states.length;
  const failed = states.some((state) => state.failed);
  const finished = states.every((state) => state.finished);
  const short = expectedCommitSha.slice(0, 7);
  const primary = states[0];

  return {
    configured: true,
    serviceId: primary.serviceId,
    deployId: primary.deployId,
    status: allExpectedLive ? 'live' : failed ? 'failed' : 'converging',
    commitSha: primary.commitSha,
    commitMatches: states.every((state) => state.commitMatches),
    live: allExpectedLive,
    finished,
    failed,
    services: states,
    message: allExpectedLive
      ? `All ${states.length} Render services are live at ${short}.`
      : failed
        ? `Render fleet deployment for ${short} has a failure: ${expectedLive}/${states.length} services are live on the expected commit.`
        : `Render fleet is converging on ${short}: ${expectedLive}/${states.length} services are live on the expected commit.`,
  };
}
