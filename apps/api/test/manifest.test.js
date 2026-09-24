// GitHub App manifest bootstrap tests. No live GitHub/Vercel needed:
// manifest shape, state single-use, route locking, secret handling.
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import express from 'express';

process.env.ORLYNX_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'orlynx-manifest-test-'));
process.env.ORLYNX_SETUP_TOKEN = 'test-setup-token';
process.env.ORLYNX_PUBLIC_URL = 'https://orlynx.example.com';
delete process.env.GITHUB_APP_ID;
delete process.env.GITHUB_APP_SLUG;
delete process.env.GITHUB_APP_CLIENT_SECRET;
delete process.env.GITHUB_APP_PRIVATE_KEY;
delete process.env.GITHUB_WEBHOOK_SECRET;
delete process.env.VERCEL_TOKEN;

const manifest = await import('../src/manifest.js');
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

describe('github app manifest bootstrap', () => {
  it('requires the owner setup token', async () => {
    const res = await fetch(`${base}/v1/setup/github-app`);
    assert.equal(res.status, 401);
  });

  it('generates a manifest with production URLs and minimal permissions only', async () => {
    const res = await fetch(`${base}/v1/setup/github-app?setup_token=test-setup-token`);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.mode, 'bootstrap');
    assert.equal(body.publicUrl, 'https://orlynx.example.com');
    assert.equal(body.manifest.redirect_url, 'https://orlynx.example.com/v1/setup/github-app/callback');
    assert.equal(body.manifest.hook_attributes.url, 'https://orlynx.example.com/v1/github/webhook');
    assert.equal(body.manifest.setup_url, 'https://orlynx.example.com/v1/github/setup');
    assert.deepEqual(body.manifest.default_permissions, { contents: 'write', metadata: 'read' });
    assert.deepEqual(body.manifest.default_events, ['installation', 'installation_repositories']);
    assert.ok(!('client_secret' in body.manifest) && !('pem' in body.manifest));
    assert.ok(body.state);
  });

  it('manifest state is single-use and rejects replays', () => {
    const state = manifest.signManifestState();
    manifest.verifyManifestState(state);
    assert.throws(() => manifest.verifyManifestState(state), /already used/);
    assert.throws(() => manifest.verifyManifestState('bogus'), /invalid/);
  });

  it('callback without a manifest code redirects to the error screen, never raw output', async () => {
    const state = manifest.signManifestState();
    const res = await fetch(`${base}/v1/setup/github-app/callback?code=&state=${encodeURIComponent(state)}`, { redirect: 'manual' });
    assert.equal(res.status, 302);
    assert.match(res.headers.get('location') || '', /\?internal=setup-github&error=/);
  });

  it('callback with a replayed state is rejected', async () => {
    const state = manifest.signManifestState();
    manifest.verifyManifestState(state);
    const res = await fetch(`${base}/v1/setup/github-app/callback?code=abc&state=${encodeURIComponent(state)}`, { redirect: 'manual' });
    assert.equal(res.status, 302);
    assert.match(res.headers.get('location') || '', /error=/);
  });

  it('reports pending-owner-action instead of storing secrets when Vercel is unwired', async () => {
    const result = await manifest.persistCredentialsToVercel({ id: 1, slug: 'x', name: 'x', client_id: 'a', client_secret: 'b', webhook_secret: 'c', pem: 'd' });
    assert.equal(result.stored, false);
    assert.match(result.detail, /VERCEL_TOKEN/);
  });

  it('masked summaries never contain secret material', () => {
    const summary = manifest.maskedConversionSummary({ id: 123, slug: 'orlynx', name: 'Orlynx' });
    assert.doesNotMatch(JSON.stringify(summary), /BEGIN|sk_|whsec|ghs_/i);
    assert.equal(summary.appId, 123);
  });
});
