// Orlynx control-plane Express app. Serverless-safe: no listen() here,
// no static serving on Vercel (Vercel serves the web build itself).
import express from 'express';
import fs from 'node:fs';
import path from 'node:path';
import { router } from './routes.js';
import { githubAppConfigured } from './github.js';
import { sameOriginOnly } from './auth.js';
import { controlPlaneRepository, durableStorageConfigured } from './storage.js';

export const app = express();
app.disable('x-powered-by');
app.use((_req, res, next) => {
  res.setHeader('Cache-Control', 'private, no-store, max-age=0');
  res.setHeader('Pragma', 'no-cache');
  next();
});
app.use(sameOriginOnly);
app.use('/v1/github/webhook', express.raw({ type: 'application/json', limit: '1mb' }));
app.use(express.json({ limit: '2mb' }));

// Production must never silently drop into the local JSON/dev code paths.
// The one-time owner GitHub-App manifest bootstrap is allowed before the data
// plane is ready; all normal product APIs remain unavailable until durable
// storage exists.
app.use((req, res, next) => {
  const hostedProduction = process.env.VERCEL === '1' || process.env.ORLYNX_HOSTED_PRODUCTION === '1';
  if (!hostedProduction || durableStorageConfigured()) return next();
  if (req.path === '/health' || req.path === '/ready' || req.path.startsWith('/v1/setup/github-app')) return next();
  return res.status(503).json({ error: 'Orlynx is temporarily unavailable.' });
});

app.get('/health', async (_req, res) => {
  // Liveness: the process is alive. Optional sleeping providers (runners,
  // direct runtime, Codespaces) must never fail liveness and cause restarts.
  res.status(200).json({ alive: true, service: 'orlynx-api', time: new Date().toISOString(), commit: String(process.env.RENDER_GIT_COMMIT || '') || null });
});

app.get('/ready', async (_req, res) => {
  // Readiness: the API can accept useful work. Core dependencies only:
  // durable storage when hosted, plus GitHub App configuration. Sleeping
  // optional compute is reported by /v1/integrations/status, never here.
  let database = false;
  let databaseError: string | undefined;
  if (durableStorageConfigured()) {
    try { await controlPlaneRepository().initialize(); database = true; }
    catch (error) { databaseError = error instanceof Error ? error.message.slice(0, 160) : 'database unavailable'; }
  }
  const hostedProduction = process.env.VERCEL === '1' || process.env.ORLYNX_HOSTED_PRODUCTION === '1';
  const ready = githubAppConfigured() && (!hostedProduction || database);
  res.status(ready ? 200 : 503).json({
    ready, service: 'orlynx-api', time: new Date().toISOString(),
    commit: String(process.env.RENDER_GIT_COMMIT || '') || null,
    githubAppConfigured: githubAppConfigured(),
    durableStorage: durableStorageConfigured() ? database : 'not-required',
    ...(databaseError ? { databaseError } : {}),
  });
});
app.use('/v1', router);
app.use((error: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  const uploadError = error as { code?: string };
  if (uploadError?.code === 'LIMIT_FILE_SIZE') {
    res.status(413).json({ error: 'This file is too large to attach.' });
    return;
  }
  console.error('[orlynx-api] request failed', error instanceof Error ? error.name : 'unknown error');
  res.status(500).json({ error: 'The request could not be completed.' });
});

// Local dev (and persistent compute) serve the web build single-origin.
// On Vercel the static build is served by the platform instead.
if (process.env.VERCEL !== '1') {
  const webDist = path.resolve(process.cwd(), '../web/dist');
  if (fs.existsSync(webDist)) app.use(express.static(webDist));
}
