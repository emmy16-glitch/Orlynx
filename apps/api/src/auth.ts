import crypto from 'node:crypto';
import type { NextFunction, Request, Response } from 'express';

const COOKIE = 'orlynx_session';
const FLOW_COOKIE = 'orlynx_oauth_state';
const MAX_AGE_SECONDS = 60 * 60 * 24 * 30;

type SessionClaims = { installationId: number; exp: number; v: 1 };

function appendCookie(res: Response, value: string): void {
  const current = res.getHeader('Set-Cookie');
  const values = Array.isArray(current) ? current.map(String) : current ? [String(current)] : [];
  res.setHeader('Set-Cookie', [...values, value]);
}

function secret(): string {
  return process.env.ORLYNX_SESSION_SECRET
    || process.env.GITHUB_WEBHOOK_SECRET
    || process.env.GITHUB_APP_CLIENT_SECRET
    || '';
}

function sign(data: string): string {
  if (!secret()) throw new Error('Orlynx session signing is not configured.');
  return crypto.createHmac('sha256', secret()).update(data).digest('base64url');
}

export function createSessionToken(installationId: number): string {
  if (!Number.isSafeInteger(installationId) || installationId <= 0) throw new Error('Invalid GitHub installation.');
  const claims: SessionClaims = { installationId, exp: Date.now() + MAX_AGE_SECONDS * 1000, v: 1 };
  const data = Buffer.from(JSON.stringify(claims)).toString('base64url');
  return `${data}.${sign(data)}`;
}

export function readSessionToken(token: string): SessionClaims | null {
  const [data, signature, extra] = token.split('.');
  if (!data || !signature || extra || !secret()) return null;
  const expected = Buffer.from(sign(data), 'base64url');
  let received: Buffer;
  try { received = Buffer.from(signature, 'base64url'); } catch { return null; }
  if (expected.length !== received.length || !crypto.timingSafeEqual(expected, received)) return null;
  try {
    const claims = JSON.parse(Buffer.from(data, 'base64url').toString('utf8')) as SessionClaims;
    if (claims.v !== 1 || !Number.isSafeInteger(claims.installationId) || claims.installationId <= 0 || claims.exp < Date.now()) return null;
    return claims;
  } catch { return null; }
}

function cookies(req: Request): Record<string, string> {
  const result: Record<string, string> = {};
  for (const part of String(req.headers.cookie || '').split(';')) {
    const index = part.indexOf('=');
    if (index < 1) continue;
    const name = part.slice(0, index).trim();
    const value = part.slice(index + 1).trim();
    try { result[name] = decodeURIComponent(value); } catch { result[name] = value; }
  }
  return result;
}

export function oauthStateFor(req: Request): string {
  return cookies(req)[FLOW_COOKIE] || '';
}

export function setOAuthStateCookie(res: Response, state: string): void {
  const secure = process.env.NODE_ENV === 'production' || process.env.VERCEL === '1';
  appendCookie(res, `${FLOW_COOKIE}=${encodeURIComponent(state)}; Path=/v1/github/setup; HttpOnly; SameSite=Lax; Max-Age=600${secure ? '; Secure' : ''}`);
}

export function clearOAuthStateCookie(res: Response): void {
  const secure = process.env.NODE_ENV === 'production' || process.env.VERCEL === '1';
  appendCookie(res, `${FLOW_COOKIE}=; Path=/v1/github/setup; HttpOnly; SameSite=Lax; Max-Age=0${secure ? '; Secure' : ''}`);
}

export function installationIdFor(req: Request): number | null {
  return readSessionToken(cookies(req)[COOKIE] || '')?.installationId || null;
}

export function setSessionCookie(res: Response, installationId: number): void {
  const secure = process.env.NODE_ENV === 'production' || process.env.VERCEL === '1';
  appendCookie(res, `${COOKIE}=${encodeURIComponent(createSessionToken(installationId))}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${MAX_AGE_SECONDS}${secure ? '; Secure' : ''}`);
}

export function clearSessionCookie(res: Response): void {
  const secure = process.env.NODE_ENV === 'production' || process.env.VERCEL === '1';
  appendCookie(res, `${COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0${secure ? '; Secure' : ''}`);
}

export function requireSession(req: Request, res: Response, next: NextFunction): void {
  const installationId = installationIdFor(req);
  if (!installationId) {
    res.status(401).json({ error: 'Connect GitHub to continue.', code: 'AUTH_REQUIRED' });
    return;
  }
  (req as Request & { orlynxInstallationId?: number }).orlynxInstallationId = installationId;
  next();
}

export function requestInstallationId(req: Request): number {
  return (req as Request & { orlynxInstallationId?: number }).orlynxInstallationId || installationIdFor(req) || 0;
}

export function sameOriginOnly(req: Request, res: Response, next: NextFunction): void {
  if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return next();
  const origin = req.header('origin');
  if (!origin) return next();
  try {
    const configured = process.env.ORLYNX_PUBLIC_URL;
    const expected = configured
      ? new URL(configured).origin
      : `${req.protocol}://${req.get('host')}`;
    if (new URL(origin).origin !== expected) {
      res.status(403).json({ error: 'Cross-origin request denied.' });
      return;
    }
  } catch {
    res.status(403).json({ error: 'Cross-origin request denied.' });
    return;
  }
  next();
}
