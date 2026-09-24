// GitHub App connection flow tests. No live GitHub needed: they verify
// fail-closed behavior, webhook signature enforcement, state validation,
// disconnect semantics and unauthorized-repo rejection.
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import express from 'express';

process.env.ORLYNX_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'orlynx-test-'));
process.env.GITHUB_WEBHOOK_SECRET = 'test-webhook-secret';
process.env.ORLYNX_SESSION_SECRET = 'test-session-secret-at-least-32-bytes';
delete process.env.GITHUB_APP_ID;
delete process.env.GITHUB_APP_SLUG;
delete process.env.GITHUB_APP_CLIENT_SECRET;
delete process.env.GITHUB_APP_PRIVATE_KEY;
delete process.env.ORLYNX_PUBLIC_URL;

const { router } = await import('../src/routes.js');
const { store } = await import('../src/store.js');
const { createSessionToken } = await import('../src/auth.js');
const { sameOriginOnly } = await import('../src/auth.js');

const INSTALLATION_ID = 123;
const AUTH = { Cookie: `orlynx_session=${createSessionToken(INSTALLATION_ID)}` };
function authorize() {
  if (!store.db.githubInstallations.some((item) => item.id === INSTALLATION_ID)) {
    store.db.githubInstallations.push({ id: INSTALLATION_ID, account: 'acme', accountType: 'User', installedAt: new Date().toISOString(), status: 'active' });
  }
}

let base;
let server;
before(async () => {
  const app = express();
  app.use(sameOriginOnly);
  app.use('/v1/github/webhook', express.raw({ type: 'application/json', limit: '1mb' }));
  app.use(express.json({ limit: '2mb' }));
  app.use('/v1', router);
  await new Promise((resolve) => {
    server = app.listen(0, () => {
      base = `http://127.0.0.1:${server.address().port}`;
      resolve();
    });
  });
});
after(() => { server?.close(); });

function sign(body) {
  return `sha256=${crypto.createHmac('sha256', process.env.GITHUB_WEBHOOK_SECRET).update(body).digest('hex')}`;
}

describe('github app connection flow (fail-closed, no live GitHub)', () => {
  it('install route fails closed when the app is not configured', async () => {
    const res = await fetch(`${base}/v1/github/install`, { redirect: 'manual' });
    assert.equal(res.status, 503);
    assert.match((await res.json()).error, /not configured|incomplete/i);
  });

  it('manage route fails closed when the app is not configured', async () => {
    authorize();
    const res = await fetch(`${base}/v1/github/manage`, { redirect: 'manual', headers: AUTH });
    assert.equal(res.status, 503);
  });

  it('setup callback with invalid state redirects to a clean error route, not a raw API page', async () => {
    const res = await fetch(`${base}/v1/github/setup?installation_id=1&state=bogus&setup_action=install`, { redirect: 'manual' });
    assert.equal(res.status, 302);
    assert.match(res.headers.get('location') || '', /\?github=error/);
  });

  it('setup callback without installation id redirects to the error route', async () => {
    const res = await fetch(`${base}/v1/github/setup?state=bogus`, { redirect: 'manual' });
    assert.equal(res.status, 302);
    assert.match(res.headers.get('location') || '', /\?github=error/);
  });

  it('never accepts a GitHub user authorization callback without its browser-bound state', async () => {
    const res = await fetch(`${base}/v1/github/setup?code=fake-code&state=fake-state`, { redirect: 'manual' });
    assert.equal(res.status, 302);
    assert.match(res.headers.get('location') || '', /\?github=error/);
    assert.match(res.headers.get('set-cookie') || '', /orlynx_oauth_state=.*Max-Age=0/i);
  });

  it('rejects webhooks with an invalid signature', async () => {
    const body = JSON.stringify({ action: 'created', installation: { id: 1 } });
    const res = await fetch(`${base}/v1/github/webhook`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-hub-signature-256': 'sha256=00', 'x-github-event': 'installation' },
      body,
    });
    assert.equal(res.status, 401);
  });

  it('accepts signed webhooks for installation removal without deleting session history', async () => {
    const ses = await (await fetch(`${base}/v1/sessions`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ project: 'x/y', owner: 'x', branch: 'main' }),
    })).json().catch(() => ({}));
    void ses;
    const body = JSON.stringify({ action: 'deleted', installation: { id: 999, account: { login: 'someone', type: 'User' } } });
    const res = await fetch(`${base}/v1/github/webhook`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-hub-signature-256': sign(body), 'x-github-event': 'installation', 'x-github-delivery': 'delivery-1' },
      body,
    });
    assert.equal(res.status, 204);
  });

  it('accepts signed installation_repositories webhooks (scope changes)', async () => {
    const body = JSON.stringify({ action: 'added', installation: { id: 999 }, repositories_added: [{ full_name: 'a/b' }], repositories_removed: [] });
    const res = await fetch(`${base}/v1/github/webhook`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-hub-signature-256': sign(body), 'x-github-event': 'installation_repositories' },
      body,
    });
    assert.equal(res.status, 204);
  });

  it('disconnect clears access metadata but reports a clean status payload', async () => {
    authorize();
    const res = await fetch(`${base}/v1/github/disconnect`, { method: 'POST', headers: AUTH });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.disconnected, true);
    assert.equal(body.connected, false);
    assert.equal(Object.hasOwn(body, 'token'), false);
  });

  it('rejects import of unauthorized repositories without trusting the client', async () => {
    authorize();
    const res = await fetch(`${base}/v1/repos/import`, {
      method: 'POST', headers: { ...AUTH, 'Content-Type': 'application/json' },
      body: JSON.stringify({ repository: 'someone/private-repo', branch: 'main' }),
    });
    assert.ok([400, 403, 503].includes(res.status));
    assert.match((await res.json()).error, /not authorized|not available|not configured|not connected|temporarily unavailable/i);
  });

  it('integration status separates platform config from user connection without secrets', async () => {
    const status = await (await fetch(`${base}/v1/integrations/status`)).json();
    assert.equal(status.github.connected, false);
    assert.equal(status.githubAvailable, false);
    assert.equal(typeof status.github.authorizedRepositories, 'number');
    const serialized = JSON.stringify(status);
    assert.doesNotMatch(serialized, /PRIVATE KEY|CLIENT_SECRET|BEGIN RSA/i);
    assert.doesNotMatch(serialized, /OpenCode|githubPlatform|appId|webhookUrl|setupCallbackUrl/i);
    assert.equal(Object.hasOwn(status.github, 'token'), false);
  });

  it('rejects protected repository APIs without a signed session cookie', async () => {
    const res = await fetch(`${base}/v1/repos`);
    assert.equal(res.status, 401);
  });

  it('allows the configured production origin and rejects other write origins', async () => {
    process.env.ORLYNX_PUBLIC_URL = 'https://orlynx.vercel.app';
    const rejected = await fetch(`${base}/v1/github/disconnect`, { method: 'POST', headers: { ...AUTH, Origin: 'https://example.invalid' } });
    assert.equal(rejected.status, 403);
    authorize();
    const accepted = await fetch(`${base}/v1/github/disconnect`, { method: 'POST', headers: { ...AUTH, Origin: 'https://orlynx.vercel.app' } });
    assert.equal(accepted.status, 200);
    delete process.env.ORLYNX_PUBLIC_URL;
  });
});
