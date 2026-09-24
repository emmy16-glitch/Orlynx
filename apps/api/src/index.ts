import express from 'express';
import cors from 'cors';
import path from 'node:path';
import { router } from './routes.js';

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

app.listen(PORT, () => console.log(`[orlynx-api] listening on http://localhost:${PORT}`));
