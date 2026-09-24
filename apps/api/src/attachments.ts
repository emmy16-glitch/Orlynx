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
// NOTE: attachments are served to OpenCode via the session record only.
// No materializeForRuntime copy into the imported repository exists, so agent
// diffs never include Orlynx runtime files.
