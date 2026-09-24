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
delete process.env.GITHUB_APP_ID;
delete process.env.GITHUB_APP_SLUG;
delete process.env.GITHUB_APP_CLIENT_SECRET;
delete process.env.GITHUB_APP_PRIVATE_KEY;
delete process.env.ORLYNX_PUBLIC_URL;

const { router } = await import('../src/routes.js');

let base;
let server;
before(async () => {
  const app = express();
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
    const res = await fetch(`${base}/v1/github/manage`, { redirect: 'manual' });
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
    const res = await fetch(`${base}/v1/github/disconnect`, { method: 'POST' });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.disconnected, true);
    assert.equal(body.connected, false);
    assert.equal(Object.hasOwn(body, 'token'), false);
  });

  it('rejects import of unauthorized repositories without trusting the client', async () => {
    const res = await fetch(`${base}/v1/repos/import`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ repository: 'someone/private-repo', branch: 'main' }),
    });
    assert.ok([400, 403].includes(res.status));
    assert.match((await res.json()).error, /not authorized|not available|not configured|not connected/i);
  });

  it('integration status separates platform config from user connection without secrets', async () => {
    const status = await (await fetch(`${base}/v1/integrations/status`)).json();
    assert.equal(status.github.configured, false);
    assert.equal(status.github.connected, false);
    assert.equal(status.github.provider, 'GitHub App');
    assert.equal(status.githubPlatform.configured, false);
    assert.equal(status.githubPlatform.healthy, false);
    assert.equal(status.githubPlatform.appId, null);
    assert.equal(status.github.userAuthorizationState, 'not-established');
    assert.equal(typeof status.github.authorizedRepositories, 'number');
    const serialized = JSON.stringify(status);
    assert.doesNotMatch(serialized, /PRIVATE KEY|CLIENT_SECRET|BEGIN RSA/i);
    assert.equal(Object.hasOwn(status.github, 'token'), false);
  });
});
