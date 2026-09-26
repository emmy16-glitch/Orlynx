import test from 'node:test';
import assert from 'node:assert/strict';
import { createBridgeToken, verifyBridgeReconnectToken, verifyBridgeToken } from '../src/bridge-auth.ts';

process.env.ORLYNX_BRIDGE_SIGNING_SECRET = 'test-bridge-signing-secret-at-least-32-bytes-long';

const claims = {
  workspaceId: 'ws_test',
  sessionId: 'ses_test',
  userId: 'user_test',
  connectionId: 'bridge-revision-connection',
};

test('normal bridge verification still rejects an expired token', () => {
  const realNow = Date.now;
  const issuedAt = 1_800_000_000_000;
  try {
    Date.now = () => issuedAt;
    const token = createBridgeToken(claims, 30);
    Date.now = () => issuedAt + 31_000;
    assert.throws(() => verifyBridgeToken(token), /expired|invalid/i);
  } finally {
    Date.now = realNow;
  }
});

test('reconnect verification accepts only a recently expired signed token', () => {
  const realNow = Date.now;
  const issuedAt = 1_800_000_000_000;
  try {
    Date.now = () => issuedAt;
    const token = createBridgeToken(claims, 30);

    Date.now = () => issuedAt + 5 * 60_000;
    assert.equal(verifyBridgeReconnectToken(token).workspaceId, claims.workspaceId);

    const [body, signature] = token.split('.');
    assert.throws(() => verifyBridgeReconnectToken(`${body}x.${signature}`), /invalid/i);

    Date.now = () => issuedAt + 20 * 60_000;
    assert.throws(() => verifyBridgeReconnectToken(token), /expired|invalid/i);
  } finally {
    Date.now = realNow;
  }
});
