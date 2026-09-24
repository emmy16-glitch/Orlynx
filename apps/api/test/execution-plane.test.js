import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { createBridgeToken, verifyBridgeToken } from '../src/bridge-auth.ts';
import { decryptCredential, encryptCredential } from '../src/credentials.ts';

describe('execution-plane credentials', () => {
  it('binds short-lived bridge credentials to workspace, session, user, and connection', () => {
    process.env.ORLYNX_BRIDGE_SIGNING_SECRET = 'test-only-bridge-secret-with-at-least-32-bytes';
    const token = createBridgeToken({ workspaceId: 'ws_1', sessionId: 'ses_1', userId: 'user_1', connectionId: 'conn_1' }, 60);
    assert.deepEqual(verifyBridgeToken(token), {
      v: 1, workspaceId: 'ws_1', sessionId: 'ses_1', userId: 'user_1', connectionId: 'conn_1',
      iat: verifyBridgeToken(token).iat, exp: verifyBridgeToken(token).exp,
    });
    assert.throws(() => verifyBridgeToken(`${token.slice(0, -1)}x`), /invalid/);
  });

  it('expires bridge credentials server-side', () => {
    process.env.ORLYNX_BRIDGE_SIGNING_SECRET = 'test-only-bridge-secret-with-at-least-32-bytes';
    const token = createBridgeToken({ workspaceId: 'ws_1', sessionId: 'ses_1', userId: 'user_1', connectionId: 'conn_1' }, 30);
    const original = Date.now;
    Date.now = () => original() + 31_000;
    try { assert.throws(() => verifyBridgeToken(token), /expired/); } finally { Date.now = original; }
  });

  it('encrypts stored GitHub user credentials with authenticated encryption', () => {
    process.env.ORLYNX_CREDENTIAL_ENCRYPTION_KEY = Buffer.alloc(32, 7).toString('base64');
    const first = encryptCredential('github-user-token'); const second = encryptCredential('github-user-token');
    assert.notEqual(first, second);
    assert.equal(decryptCredential(first), 'github-user-token');
    assert.throws(() => decryptCredential(`${first.slice(0, -1)}x`));
  });
});
