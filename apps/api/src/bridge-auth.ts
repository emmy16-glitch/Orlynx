import crypto from 'node:crypto';

export interface BridgeClaims {
  v: 1;
  workspaceId: string;
  sessionId: string;
  userId: string;
  connectionId: string;
  iat: number;
  exp: number;
}

function secret(): string {
  const value = process.env.ORLYNX_BRIDGE_SIGNING_SECRET || '';
  if (Buffer.byteLength(value) < 32) throw new Error('ORLYNX_BRIDGE_SIGNING_SECRET must contain at least 32 bytes.');
  return value;
}

function signature(data: string): Buffer { return crypto.createHmac('sha256', secret()).update(data).digest(); }

export function createBridgeToken(input: Omit<BridgeClaims, 'v' | 'iat' | 'exp'>, ttlSeconds = 300): string {
  if (ttlSeconds < 30 || ttlSeconds > 900) throw new Error('Bridge token lifetime must be between 30 and 900 seconds.');
  const now = Math.floor(Date.now() / 1000);
  const claims: BridgeClaims = { ...input, v: 1, iat: now, exp: now + ttlSeconds };
  const body = Buffer.from(JSON.stringify(claims)).toString('base64url');
  return `${body}.${signature(body).toString('base64url')}`;
}

function verifyBridgeTokenWithExpiryGrace(token: string, expiryGraceSeconds: number): BridgeClaims {
  const [body, signatureText, extra] = token.split('.');
  if (!body || !signatureText || extra) throw new Error('Bridge credential is invalid.');
  const expected = signature(body);
  let received: Buffer;
  try { received = Buffer.from(signatureText, 'base64url'); } catch { throw new Error('Bridge credential is invalid.'); }
  if (received.length !== expected.length || !crypto.timingSafeEqual(received, expected)) throw new Error('Bridge credential is invalid.');
  let claims: BridgeClaims;
  try { claims = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')) as BridgeClaims; } catch { throw new Error('Bridge credential is invalid.'); }
  const now = Math.floor(Date.now() / 1000);
  const expiredTooLongAgo = claims.exp <= now - Math.max(0, expiryGraceSeconds);
  if (claims.v !== 1 || !claims.workspaceId || !claims.sessionId || !claims.userId || !claims.connectionId || claims.iat > now + 30 || expiredTooLongAgo) {
    throw new Error('Bridge credential expired or is invalid.');
  }
  return claims;
}

export function verifyBridgeToken(token: string): BridgeClaims {
  return verifyBridgeTokenWithExpiryGrace(token, 0);
}

export function verifyBridgeReconnectToken(token: string, expiryGraceSeconds = 15 * 60): BridgeClaims {
  if (expiryGraceSeconds < 0 || expiryGraceSeconds > 30 * 60) throw new Error('Bridge reconnect grace is invalid.');
  return verifyBridgeTokenWithExpiryGrace(token, expiryGraceSeconds);
}
