import crypto from 'node:crypto';

const VERSION = 'v1';

function encryptionKey(): Buffer {
  const encoded = process.env.ORLYNX_CREDENTIAL_ENCRYPTION_KEY || '';
  let key: Buffer;
  try { key = Buffer.from(encoded, 'base64'); } catch { key = Buffer.alloc(0); }
  if (key.length !== 32) throw new Error('ORLYNX_CREDENTIAL_ENCRYPTION_KEY must be a base64 encoded 32-byte key.');
  return key;
}

export function encryptCredential(value: string): string {
  if (!value) throw new Error('Cannot encrypt an empty credential.');
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', encryptionKey(), iv);
  const encrypted = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [VERSION, iv.toString('base64url'), tag.toString('base64url'), encrypted.toString('base64url')].join('.');
}

export function decryptCredential(envelope: string): string {
  const [version, ivText, tagText, dataText, extra] = envelope.split('.');
  if (version !== VERSION || !ivText || !tagText || !dataText || extra) throw new Error('Credential envelope is invalid.');
  const decipher = crypto.createDecipheriv('aes-256-gcm', encryptionKey(), Buffer.from(ivText, 'base64url'));
  decipher.setAuthTag(Buffer.from(tagText, 'base64url'));
  return Buffer.concat([decipher.update(Buffer.from(dataText, 'base64url')), decipher.final()]).toString('utf8');
}
