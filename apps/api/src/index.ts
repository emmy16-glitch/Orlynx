import http from 'node:http';
import { app } from './app.js';
import { githubAppConfigured, githubPlatformHealth } from './github.js';
import { attachBridgeGateway } from './bridge-gateway.js';
import { warmOpenCodeProviderLayer, warmOpenCodeRuntime } from './opencode-local.js';
import { defaultWorkspaceProviderId, runnerFallbackEnabled, shouldPrewarmWorkspace } from './workspace-providers.js';
import { runnerGlobalMaxWorkspaces, runnerHosts, runnerPoolSnapshot } from './runner-pool.js';
import { e2bConfigured, e2bPlatformHealth } from './e2b-provider.js';
import { noteComputeFailure, noteComputeSuccess } from './compute-broker.js';

const PORT = Number(process.env.PORT || 4000);

// Startup banner: report GitHub App readiness without logging secret values.
const required = ['ORLYNX_PUBLIC_URL', 'GITHUB_APP_ID', 'GITHUB_APP_SLUG', 'GITHUB_APP_CLIENT_SECRET', 'GITHUB_APP_PRIVATE_KEY', 'GITHUB_WEBHOOK_SECRET'];
const missing = required.filter((name) => !process.env[name]);
if (githubAppConfigured()) {
  console.log('[orlynx-api] GitHub App is configured. Users connect via /v1/github/install.');
} else {
  console.log(`[orlynx-api] GitHub App is NOT fully configured (missing: ${missing.join(', ') || 'invalid ORLYNX_PUBLIC_URL'}). GitHub routes fail closed until server secrets are set.`);
}

if (githubAppConfigured()) {
  // Platform authentication is not a compute outcome. A healthy GitHub App
  // response must never be recorded as a successful Codespaces compute
  // operation, and a failed one must not quarantine interactive compute
  // before any real work has run. Broker history is written only from actual
  // provisioning/task outcomes (see workspaces.ts, opencode-local.ts).
  void githubPlatformHealth()
    .then((platform) => {
      const permissions = platform.permissions || {};
      console.log(
        `[startup-smoke] github-app healthy=${platform.healthy} contents=${permissions.contents || 'none'} codespaces=${permissions.codespaces || 'none'} actions=${permissions.actions || 'none'}`,
      );
    })
    .catch((error) => {
      console.warn(`[startup-smoke] github-app capability check failed: ${error instanceof Error ? error.message : 'unknown error'}`);
    });
}

await warmOpenCodeProviderLayer();

// The free-model runtime lives on a separate service and may sleep. Wake it as
// soon as the API itself wakes so the user's first chat message does not pay
// the full downstream cold-start cost. This is background-only and never
// delays API availability.
void warmOpenCodeRuntime()
  .then((ready) => console.log(`[startup-smoke] direct-runtime warm=${ready}`))
  .catch(() => console.warn('[startup-smoke] direct-runtime warmup failed'));

try {
  console.log(`[orlynx-api] workspace provider=${defaultWorkspaceProviderId()} prewarm=${shouldPrewarmWorkspace()} codespacesFallback=${runnerFallbackEnabled()} e2bConfigured=${e2bConfigured()} runnerHosts=${runnerHosts().length} runnerGlobalMax=${runnerGlobalMaxWorkspaces()}`);
} catch (error) {
  console.warn(`[orlynx-api] workspace provider configuration error: ${error instanceof Error ? error.message : 'unknown error'}`);
}

if (e2bConfigured()) {
  // Same rule as above: platform reachability is diagnostics, not a compute
  // outcome. Broker history comes only from real provisioning/task results.
  void e2bPlatformHealth()
    .then((health) => {
      console.log(`[startup-smoke] e2b configured=${health.configured} healthy=${health.healthy}`);
    })
    .catch(() => {
      console.warn('[startup-smoke] e2b capability check failed');
    });
}

if (runnerHosts().length) {
  // Free Render runners may all be asleep when the API wakes. This startup
  // smoke runs in the background, so make it cold-start-aware before recording
  // a broker failure. Otherwise the normal probe can cache five timeouts and
  // depress runner scoring before rankedRunnerHosts() gets a chance to wake them.
  void runnerPoolSnapshot(true)
    .then((snapshot) => {
      const healthy = snapshot.filter((item) => item.health.ok && !item.health.draining && item.health.available > 0);
      if (healthy.length) {
        noteComputeSuccess('orlynx-runner', Math.min(...healthy.map((item) => item.health.latencyMs || 1)));
        console.log(`[startup-smoke] runner-pool healthy=${healthy.length}/${snapshot.length}`);
      } else {
        noteComputeFailure('orlynx-runner', 'No runner host recovered through the startup wake probe.');
        const details = snapshot
          .map(({ host, health }) => `${host.id}:${health.detail || (health.draining ? 'draining' : 'unavailable')}`)
          .join(', ')
          .slice(0, 900);
        console.warn(`[startup-smoke] runner-pool healthy=0/${snapshot.length} details=${details}`);
      }
    })
    .catch((error) => {
      noteComputeFailure('orlynx-runner', error instanceof Error ? error.message : 'Runner pool health check failed');
      console.warn('[startup-smoke] runner-pool capability check failed');
    });
}

const server = http.createServer(app);
attachBridgeGateway(server);
server.listen(PORT, '0.0.0.0', () => {
  console.log(`[orlynx-api] listening on http://0.0.0.0:${PORT}`);
  void (async () => {
    try {
      const response = await fetch(`http://127.0.0.1:${PORT}/v1/ai/catalog`, {
        headers: { Accept: 'application/json' },
        signal: AbortSignal.timeout(5_000),
      });
      const body = await response.json().catch(() => ({})) as { models?: unknown[]; error?: string };
      console.log(`[startup-smoke] ai-catalog status=${response.status} models=${Array.isArray(body.models) ? body.models.length : 0}${body.error ? ` error=${body.error}` : ''}`);
    } catch (error) {
      console.warn(`[startup-smoke] ai-catalog failed: ${error instanceof Error ? error.message : 'unknown error'}`);
    }
  })();
});
