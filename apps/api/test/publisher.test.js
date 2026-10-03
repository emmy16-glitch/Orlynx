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

test('controlled publish recovers clean committed local work and never gives the workspace push credentials', () => {
  const publisher = fs.readFileSync(new URL('../src/publisher.ts', import.meta.url), 'utf8');
  const gateway = fs.readFileSync(new URL('../src/bridge-gateway.ts', import.meta.url), 'utf8');
  const bridge = fs.readFileSync(new URL('../../../bridge/src/index.ts', import.meta.url), 'utf8');

  assert.match(bridge, /case 'git\.capture-committed-changes'/);
  assert.match(bridge, /merge-base', '--is-ancestor'/);
  assert.match(bridge, /Committed publication recovery requires a clean working tree/);
  assert.match(bridge, /crypto\.createHash\('sha256'\)/);
  assert.doesNotMatch(bridge.slice(bridge.indexOf("case 'git.capture-committed-changes':"), bridge.indexOf("case 'git.read-publication-file':")), /git\(\['push'/);

  assert.match(publisher, /recoverCommittedPublicationCandidate/);
  assert.match(publisher, /recoveredCommittedWork: true/);
  assert.match(publisher, /change\.currentHead \|\| change\.baseSha/);
  assert.match(publisher, /publicationBaseBranch\(session, targetBranch, targetRemoteSha, strategy, e2ePublication\)/);
  assert.match(publisher, /expectedHead: workspaceHeadBeforePublish/);

  assert.match(gateway, /publicationRecoverable/);
  assert.match(gateway, /publishExplicitlyRequested/);
  assert.match(gateway, /effectivePermission === 'full' \|\| publishExplicitlyRequested/);
  assert.match(gateway, /item === 'changes' \|\| item === 'publish'/);
});

test('workspace commit stages only approved files and rejects unrelated staged files', () => {
  const bridge = fs.readFileSync(new URL('../../../bridge/src/index.ts', import.meta.url), 'utf8');
  const block = bridge.slice(bridge.indexOf("case 'git.commit':"), bridge.indexOf("case 'command.exec':"));
  assert.match(block, /approved file allowlist/);
  assert.match(block, /unrelated staged files/);
  assert.match(block, /git\(\['add', '--', file\]\)/);
  assert.doesNotMatch(block, /git\(\['add', '--all'\]\)/);
  assert.doesNotMatch(bridge, /case 'git\.push':/);
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

test('publish candidate waits for tests but permits downstream deployment verification', () => {
  const change = {runId:'run',files:[{path:'src/fix.ts'}]};
  const task = {runId:'run',harness:{verification:{missing:['publish','deployment']}}};
  assert.equal(publicationInternals.publicationCandidate([change],[task],'run').task,task);
  task.harness.verification.missing.push('tests');
  assert.throws(() => publicationInternals.publicationCandidate([change],[task],'run'), /No verified change set/);
  task.harness.verification.missing = ['publish','deployment'];
  assert.throws(() => publicationInternals.publicationCandidate([change],[task],'other-run'), /No verified change set/);
});


test('publication reconstructs local-only commit receipts and preserves GitHub auth failures', async () => {
  const sha = 'a'.repeat(40);
  const exists = publicationInternals.remoteCommitExists;
  assert.equal(await exists(1, 'owner/repo', sha, async () => ({ sha })), true);
  for (const status of [404, 422]) {
    assert.equal(await exists(1, 'owner/repo', sha, async () => { throw Object.assign(new Error('missing'), { status }); }), false);
  }
  await assert.rejects(() => exists(1, 'owner/repo', sha, async () => { throw Object.assign(new Error('forbidden'), { status: 403 }); }), /forbidden/);
  assert.equal(await exists(1, 'owner/repo', 'invalid', async () => { throw new Error('must not request'); }), false);
});


test('first isolated E2E publication reads its original remote base but targets only the isolated branch', () => {
  const branch = 'orlynx-e2e/1760000000000';
  const session = { branch, checkpoint: { liveE2EBaseBranch: 'main' } };
  assert.equal(publicationInternals.publicationBaseBranch(session, branch, null, 'direct', true), 'main');
  assert.equal(publicationInternals.publicationBaseBranch(session, branch, 'a'.repeat(40), 'direct', true), branch);
  assert.throws(() => publicationInternals.publicationBaseBranch({ branch }, branch, null, 'direct', true), /base branch/);
});
