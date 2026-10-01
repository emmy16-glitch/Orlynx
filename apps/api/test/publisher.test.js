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


test('publication preserves exact bytes, executable/symlink modes, and repairs interrupted remote receipts', () => {
  const publisher = fs.readFileSync(new URL('../src/publisher.ts', import.meta.url), 'utf8');
  const bridge = fs.readFileSync(new URL('../../../bridge/src/index.ts', import.meta.url), 'utf8');

  assert.match(publisher, /git\.read-publication-file/);
  assert.match(publisher, /contentBase64/);
  assert.match(publisher, /mode: item\.mode/);
  assert.doesNotMatch(publisher, /Buffer\.from\(String\(item\.content/);
  assert.match(publisher, /existingTargetSha === change\.commitSha/);
  assert.match(publisher, /change\.pushedAt \|\|=/);
  assert.match(publisher, /retryPullRequestBranch/);
  assert.match(publisher, /reconcilePublishedWorkspace/);

  const publicationRead = bridge.slice(
    bridge.indexOf("case 'git.read-publication-file':"),
    bridge.indexOf("case 'git.reconcile-published':"),
  );
  assert.match(publicationRead, /fs\.lstatSync/);
  assert.match(publicationRead, /fs\.readlinkSync/);
  assert.match(publicationRead, /'120000'/);
  assert.match(publicationRead, /'100755'/);
  assert.match(publicationRead, /contentBase64/);

  const reconciliation = bridge.slice(
    bridge.indexOf("case 'git.reconcile-published':"),
    bridge.indexOf("case 'git.branch.create':"),
  );
  assert.match(reconciliation, /currentHead !== expectedHead/);
  assert.match(reconciliation, /unrelated\.length/);
  assert.match(reconciliation, /remoteHead !== publishedHead/);
  assert.match(reconciliation, /git\(\['reset', '--hard', remoteRef\]/);
});

test('publication hashing is byte-exact rather than UTF-8-only', () => {
  const binary = Buffer.from([0x00, 0xff, 0x7f, 0x80, 0x41]);
  const same = Buffer.from([0x00, 0xff, 0x7f, 0x80, 0x41]);
  const changed = Buffer.from([0x00, 0xfe, 0x7f, 0x80, 0x41]);
  assert.equal(publicationInternals.sha256(binary), publicationInternals.sha256(same));
  assert.notEqual(publicationInternals.sha256(binary), publicationInternals.sha256(changed));
});

test('bridge path containment rejects realpath escapes rather than trusting lexical paths', () => {
  const bridge = fs.readFileSync(new URL('../../../bridge/src/index.ts', import.meta.url), 'utf8');
  const guard = bridge.slice(bridge.indexOf('function pathInside'), bridge.indexOf('type VerificationArtifact'));
  assert.match(guard, /fs\.realpathSync\(REPO_ROOT\)/);
  assert.match(guard, /fs\.realpathSync\(probe\)/);
  assert.match(guard, /Path resolves outside the workspace repository/);
});
