// Orlynx control-plane Express app. Serverless-safe: no listen() here,
// no static serving on Vercel (Vercel serves the web build itself).
import express from 'express';
import cors from 'cors';
import fs from 'node:fs';
import path from 'node:path';
import { router } from './routes.js';
import { githubAppConfigured } from './github.js';

export const app = express();
app.use(cors());
app.use('/v1/github/webhook', express.raw({ type: 'application/json', limit: '1mb' }));
app.use(express.json({ limit: '2mb' }));

app.get('/health', (_req, res) => res.json({
  ok: true,
  service: 'orlynx-api',
  time: new Date().toISOString(),
  database: {
    backend: 'file',
    durable: process.env.VERCEL !== '1',
    note: process.env.VERCEL === '1'
      ? 'Ephemeral serverless filesystem. Attach durable storage before multi-instance production use.'
      : 'Local filesystem persistence.',
  },
  githubConfigured: githubAppConfigured(),
}));
app.use('/v1', router);

// Local dev (and persistent compute) serve the web build single-origin.
// On Vercel the static build is served by the platform instead.
if (process.env.VERCEL !== '1') {
  const webDist = path.resolve(process.cwd(), '../web/dist');
  if (fs.existsSync(webDist)) app.use(express.static(webDist));
}
