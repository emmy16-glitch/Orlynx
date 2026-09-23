// Attachment Gateway — PDF §9. Safe names, size limits, scoped materialization.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { v4 as uuid } from 'uuid';
import { safeName } from '@orlynx/shared';
import { store, dataDir } from './store.js';

const MAX_MB = Number(process.env.ORLYNX_MAX_UPLOAD_MB || 15);

export function saveAttachment(sessionId: string, original: string, mime: string, buf: Buffer) {
  if (buf.length > MAX_MB * 1024 * 1024) throw new Error(`file too large (max ${MAX_MB}MB)`);
  const lower = original.toLowerCase();
  if (lower.endsWith('.env') || lower.endsWith('.pem') || lower.includes('id_rsa')) {
    // warn but allow — caller surfaces warning (PDF §9.3)
  }
  const id = `att_${uuid().slice(0, 8)}`;
  const s = safeName(original);
  const dest = path.join(dataDir, 'attachments', `${id}__${s}`);
  fs.writeFileSync(dest, buf);
  const meta = {
    id, sessionId, filename: original, safeName: s, mime,
    size: buf.length, hash: crypto.createHash('sha256').update(buf).digest('hex').slice(0, 16),
    createdAt: new Date().toISOString(),
  };
  (store.db.attachments[sessionId] ||= []).push(meta);
  store.save();
  return { meta, path: dest };
}

export function materializeForRuntime(sessionId: string, project: string): string[] {
  // copy session attachments into workspace-scoped dir (PDF §9.2)
  const wsDir = path.join(dataDir, 'repos', project.replace(/[^a-zA-Z0-9._-]/g, '_'), '.app', 'attachments', sessionId);
  fs.mkdirSync(wsDir, { recursive: true });
  const out: string[] = [];
  for (const a of store.db.attachments[sessionId] || []) {
    const src = path.join(dataDir, 'attachments', `${a.id}__${a.safeName}`);
    if (fs.existsSync(src)) {
      const dst = path.join(wsDir, a.safeName);
      fs.copyFileSync(src, dst);
      out.push(dst);
    }
  }
  return out;
}
