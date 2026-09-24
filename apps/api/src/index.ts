import express from 'express';
import cors from 'cors';
import path from 'node:path';
import { router } from './routes.js';
import { githubAppConfigured } from './github.js';

const app = express();
const PORT = Number(process.env.PORT || 4000);
app.use(cors());
app.use('/v1/github/webhook', express.raw({ type: 'application/json', limit: '1mb' }));
app.use(express.json({ limit: '2mb' }));

app.get('/health', (_req, res) => res.json({ ok: true, service: 'orlynx-api', time: new Date().toISOString() }));
app.use('/v1', router);

// serve web build if present (single-origin localhost)
const webDist = path.resolve(process.cwd(), '../web/dist');
app.use(express.static(webDist));

// Startup banner: report GitHub App readiness without logging secret values.
const required = ['ORLYNX_PUBLIC_URL', 'GITHUB_APP_ID', 'GITHUB_APP_SLUG', 'GITHUB_APP_CLIENT_SECRET', 'GITHUB_APP_PRIVATE_KEY', 'GITHUB_WEBHOOK_SECRET'];
const missing = required.filter((name) => !process.env[name]);
if (githubAppConfigured()) {
  console.log('[orlynx-api] GitHub App is configured. Users connect via /v1/github/install.');
} else {
  console.log(`[orlynx-api] GitHub App is NOT fully configured (missing: ${missing.join(', ') || 'invalid ORLYNX_PUBLIC_URL'}). GitHub routes fail closed until server secrets are set.`);
}

app.listen(PORT, () => console.log(`[orlynx-api] listening on http://localhost:${PORT}`));
