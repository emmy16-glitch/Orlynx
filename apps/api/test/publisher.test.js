import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { publicationInternals } from '../src/publisher.ts';

test('publication parser only accepts safe branch/path state', () => {
  assert.deepEqual(
    publicationInternals.parsePorcelainPaths(' M src/a.ts\n?? src/new.ts\nR  old.ts -> src/new-name.ts\n'),
    ['src/a.ts', 'src/new.ts', 'src/new-name.ts'],
  );
  assert.equal(publicationInternals.safeBranch('fix/chat-stream'), 'fix/chat-stream');
  assert.equal(publicationInternals.safeBranch(' release/v2 '), 'release/v2');
  assert.throws(() => publicationInternals.safeBranch('../main'));
  assert.equal(publicationInternals.sha256('same'), publicationInternals.sha256('same'));
  assert.notEqual(publicationInternals.sha256('same'), publicationInternals.sha256('changed'));
});

test('verified publication is control-plane GitHub App work, never a workspace push', () => {
  const publisher = fs.readFileSync(new URL('../src/publisher.ts', import.meta.url), 'utf8');
  const gateway = fs.readFileSync(new URL('../src/bridge-gateway.ts', import.meta.url), 'utf8');
  const routes = fs.readFileSync(new URL('../src/routes.ts', import.meta.url), 'utf8');

  assert.match(publisher, /githubInstallationApiRequest/);
  assert.match(publisher, /githubInstallationPermissionStatus/);
  assert.match(publisher, /force:\s*false/);
  assert.match(publisher, /Publication blocked because unrelated workspace files are dirty/);
  assert.match(publisher, /File changed after verification/);
  assert.match(publisher, /GitHub .* moved since this work began/);
  assert.match(publisher, /protectedBranchFallback/);
  assert.doesNotMatch(publisher, /bridgeRequest[^\n]*['"]git\.push['"]/);

  const controlled = gateway.slice(
    gateway.indexOf('async function controlledDefaultBranchPublish'),
    gateway.indexOf('function continuationPayload'),
  );
  assert.match(controlled, /publishVerifiedChangeSet/);
  assert.doesNotMatch(controlled, /git\.push/);

  const chatPublisher = routes.slice(
    routes.indexOf('async function publishCommittedWorkspaceHead'),
    routes.indexOf('async function persistRecoveredBranch'),
  );
  assert.match(chatPublisher, /publishVerifiedChangeSet/);
  assert.doesNotMatch(chatPublisher, /bridgeRequest/);
});

test('workspace commit stages only approved files and rejects unrelated staged files', () => {
  const bridge = fs.readFileSync(new URL('../../../bridge/src/index.ts', import.meta.url), 'utf8');
  const block = bridge.slice(bridge.indexOf("case 'git.commit':"), bridge.indexOf("case 'git.push':"));
  assert.match(block, /approved file allowlist/);
  assert.match(block, /unrelated staged files/);
  assert.match(block, /git\(\['add', '--', file\]\)/);
  assert.doesNotMatch(block, /git\(\['add', '--all'\]\)/);
});
