// Orlynx AI layer tests: preferences, permission enforcement, provider
// key validation. No live OpenCode/GitHub needed; engine calls fail closed.
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import express from 'express';

process.env.ORLYNX_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'orlynx-ai-test-'));
process.env.ORLYNX_SESSION_SECRET = 'test-session-secret-at-least-32-bytes';
delete process.env.OPENCODE_BASE_URL;

const ai = await import('../src/ai.js');
const { store } = await import('../src/store.js');
const { createSessionToken } = await import('../src/auth.js');
const { router } = await import('../src/routes.js');
const { taskPermission } = await import('../src/agents.js');

const SID = 'ses_aitest1';
const INSTALLATION_ID = 123;
const AUTH = { Cookie: `orlynx_session=${createSessionToken(INSTALLATION_ID)}` };
store.db.githubInstallations.push({ id: INSTALLATION_ID, account: 'acme', accountType: 'User', installedAt: new Date().toISOString(), status: 'active' });
store.db.sessions[SID] = { id: SID, installationId: INSTALLATION_ID, project: 'acme/demo', owner: 'acme', branch: 'main', mode: 'repository', workspaceId: null, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() };
store.save();

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

describe('orlynx AI layer', () => {
  it('rejects unknown modes and permissions server-side', () => {
    assert.throws(() => ai.setSessionPrefs(SID, { mode: 'turbo' }), /Unknown agent mode/);
    assert.throws(() => ai.setSessionPrefs(SID, { permission: 'godmode' }), /Unknown permission/);
    assert.throws(() => ai.setSessionPrefs(SID, { modelId: 'not a model!!' }), /Unknown model/);
  });

  it('persists session prefs server-side (not browser-only)', () => {
    const prefs = ai.setSessionPrefs(SID, { mode: 'plan', permission: 'read-only', modelId: 'openai/gpt-5' });
    assert.equal(prefs.mode, 'plan');
    assert.equal(prefs.permission, 'read-only');
    assert.equal(prefs.modelId, 'openai/gpt-5');
    assert.equal(prefs.providerId, 'openai');
    const reloaded = ai.getSessionPrefs(SID, 'acme/demo');
    assert.equal(reloaded.mode, 'plan');
  });

  it('read-only blocks writes at the enforcement boundary, not just the UI', () => {
    ai.setSessionPrefs(SID, { permission: 'read-only' });
    assert.equal(ai.canPerform(SID, 'terminal.exec', { cmd: 'npm test' }).allowed, false);
    assert.equal(ai.canPerform(SID, 'git.commit').allowed, false);
    assert.equal(ai.canPerform(SID, 'git.push').allowed, false);
    assert.equal(ai.canPerform(SID, 'agent.task').allowed, true);
  });

  it('ask-first requires approval for terminal commands', () => {
    ai.setSessionPrefs(SID, { permission: 'ask-first' });
    const gate = ai.canPerform(SID, 'terminal.exec', { cmd: 'npm test' });
    assert.equal(gate.allowed, true);
    assert.equal(gate.needsApproval, true);
  });

  it('destructive commands are blocked even with full access', () => {
    ai.setSessionPrefs(SID, { permission: 'full' });
    assert.equal(ai.canPerform(SID, 'terminal.exec', { cmd: 'rm -rf /tmp/x' }).allowed, true);
    assert.equal(ai.canPerform(SID, 'terminal.exec', { cmd: 'rm -rf /' }).allowed, false);
    assert.equal(ai.canPerform(SID, 'terminal.exec', { cmd: 'mkfs /dev/sda' }).allowed, false);
  });

  it('temporary full access expires with the run and never changes the default', () => {
    ai.setSessionPrefs(SID, { permission: 'read-only' });
    assert.equal(ai.canPerform(SID, 'git.push').allowed, false);
    (store.db.runs[SID] ||= []).push({ id: 'run_temp1', sessionId: SID, engine: 'opencode', state: 'running', permission: 'read-only', tempPermission: 'full', startedAt: new Date().toISOString() });
    assert.equal(ai.canPerform(SID, 'git.push').allowed, true);
    store.db.runs[SID][0].state = 'completed';
    assert.equal(ai.canPerform(SID, 'git.push').allowed, false);
    assert.equal(ai.getSessionPrefs(SID).permission, 'read-only');
    store.db.runs[SID] = [];
    store.save();
  });

  it('only permits per-task elevation from Ask first', () => {
    assert.deepEqual(taskPermission('ask-first', 'full'), { permission: 'full', tempPermission: 'full' });
    assert.deepEqual(taskPermission('read-only', 'full'), { permission: 'read-only' });
    assert.deepEqual(taskPermission('full', 'full'), { permission: 'full' });
  });

  it('does not expose another installation session through AI status', async () => {
    store.db.sessions.ses_other = { ...store.db.sessions[SID], id: 'ses_other', installationId: 456 };
    const res = await fetch(`${base}/v1/ai/status?sessionId=ses_other`, { headers: AUTH });
    assert.equal(res.status, 404);
    delete store.db.sessions.ses_other;
  });

  it('classifies provider/engine errors for honest UX', () => {
    assert.equal(ai.classifyError('HTTP 429 rate limit exceeded'), 'rate_limit');
    assert.equal(ai.classifyError('insufficient quota'), 'quota');
    assert.equal(ai.classifyError('401 unauthorized key'), 'auth');
    assert.equal(ai.classifyError('Could not reach the configured OpenCode server'), 'engine');
    assert.equal(ai.classifyError('Read only: blocked'), 'permission');
  });

  it('does not accept provider keys when account connection is unsupported', async () => {
    for (const body of [{ providerId: 'openai', apiKey: 'short' }, { providerId: 'nope!!', apiKey: 'sk-valid-looking-key-12345' }, { providerId: '', apiKey: '' }]) {
      const res = await fetch(`${base}/v1/ai/providers/connect-key`, { method: 'POST', headers: { ...AUTH, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
      assert.equal(res.status, 501);
    }
    assert.equal(ai.providerHasKey('openai'), false);
  });

  it('exec is blocked for read-only sessions over HTTP', async () => {
    ai.setSessionPrefs(SID, { permission: 'read-only' });
    const res = await fetch(`${base}/v1/sessions/${SID}/exec`, { method: 'POST', headers: { ...AUTH, 'Content-Type': 'application/json' }, body: JSON.stringify({ cmd: 'npm test' }) });
    assert.equal(res.status, 403);
  });

  it('exec requires approval for ask-first sessions over HTTP', async () => {
    ai.setSessionPrefs(SID, { permission: 'ask-first' });
    const res = await fetch(`${base}/v1/sessions/${SID}/exec`, { method: 'POST', headers: { ...AUTH, 'Content-Type': 'application/json' }, body: JSON.stringify({ cmd: 'npm test' }) });
    assert.equal(res.status, 409);
    assert.equal((await res.json()).approvalRequired, true);
  });

  it('session prefs endpoint validates and never interrupts silently', async () => {
    const bad = await fetch(`${base}/v1/ai/session/${SID}`, { method: 'PUT', headers: { ...AUTH, 'Content-Type': 'application/json' }, body: JSON.stringify({ mode: 'turbo' }) });
    assert.equal(bad.status, 400);
    const ok = await fetch(`${base}/v1/ai/session/${SID}`, { method: 'PUT', headers: { ...AUTH, 'Content-Type': 'application/json' }, body: JSON.stringify({ mode: 'ask', permission: 'read-only' }) });
    assert.equal(ok.status, 200);
    assert.equal((await ok.json()).prefs.mode, 'ask');
    const missing = await fetch(`${base}/v1/ai/session/ses_nope`, { method: 'PUT', headers: { ...AUTH, 'Content-Type': 'application/json' }, body: JSON.stringify({ mode: 'ask' }) });
    assert.equal(missing.status, 404);
  });

  it('models endpoint fails closed without inventing availability', async () => {
    const res = await fetch(`${base}/v1/ai/models`, { headers: AUTH });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.available, false);
    assert.deepEqual(body.models, []);
  });

  it('provider disconnect is unavailable when no real account connection exists', async () => {
    const res = await fetch(`${base}/v1/ai/providers/openai/disconnect`, { method: 'POST', headers: AUTH });
    assert.equal(res.status, 501);
  });

  it('protects project APIs without a signed Orlynx session', async () => {
    const res = await fetch(`${base}/v1/ai/models`);
    assert.equal(res.status, 401);
  });
});
