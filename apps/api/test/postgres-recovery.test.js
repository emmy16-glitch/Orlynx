import test from 'node:test';
import assert from 'node:assert/strict';
import { PGlite } from '@electric-sql/pglite';
import { PostgresControlPlaneRepository } from '../src/storage.ts';
import { setControlPlaneRepositoryForTests } from '../src/storage.ts';
import { reconcileTaskWorkspace } from '../src/agents.ts';
import { recoverDurableTaskSessionsOnce } from '../src/workspace-jobs.ts';

async function fixture(t) {
  const db = new PGlite();
  t.after(() => db.close());
  const deferredQuery = (query, values = []) => ({
    query, values,
    then: (resolve, reject) => db.query(query, values).then(result => result.rows).then(resolve, reject),
  });
  const sql = (strings, ...values) => {
    const query = strings.reduce((text, part, i) => text + part + (i < values.length ? `$${i + 1}` : ''), '');
    return deferredQuery(query, values);
  };
  sql.query = deferredQuery;
  sql.transaction = (queries) => db.transaction(async tx => {
    const results = [];
    for (const query of queries) results.push((await tx.query(query.query, query.values)).rows);
    return results;
  });
  const repository = new PostgresControlPlaneRepository(sql);
  await repository.initialize();
  const now = new Date().toISOString();
  await db.query('INSERT INTO users VALUES ($1,$2,$3,$3)', ['u', 'tester', now]);
  await repository.upsertProject({ id: 'p', userId: 'u', installationId: 1, repositoryId: 1, fullName: 'test/repo', defaultBranch: 'main' });
  await repository.putSession({ id: 's', userId: 'u', projectId: 'p', project: 'test/repo', branch: 'main', mode: 'build', workspaceId: 'ws', createdAt: now, updatedAt: now });
  const task = (id, state = 'queued', plane = 'workspace') => ({ id, sessionId: 's', workspaceId: 'direct:s', runId: `run-${id}`, prompt: 'start localhost', state, plane, modelId: 'opencode/free', createdAt: now, updatedAt: now });
  return { db, repository, task, now };
}

test('direct failure preserves task identity while durably rebinding workspace', async (t) => {
  const { repository, task } = await fixture(t);
  const admitted = task('t', 'running', 'direct');
  await repository.putTask(admitted);
  await repository.putTask({ ...admitted, plane: 'workspace', state: 'queued', workspaceId: 'ws-recovered' });
  const restored = await repository.getTask('t');
  assert.equal(restored.workspaceId, 'ws-recovered');
  assert.equal(restored.plane, 'workspace');
  assert.equal(restored.state, 'queued');
  assert.equal(restored.runId, admitted.runId);
  assert.equal(restored.modelId, admitted.modelId);
});

test('database claim respects human-waiting work but permits read-only direct chat', async (t) => {
  const { repository, task } = await fixture(t);
  await repository.putTask(task('waiting', 'waiting_approval'));
  await repository.putTask(task('build'));
  assert.equal(await repository.claimQueuedTask('s', 'build'), null);
  await repository.putTask(task('chat', 'queued', 'direct'));
  assert.equal((await repository.claimQueuedTask('s', 'chat')).id, 'chat');
  assert.equal(await repository.claimQueuedTask('s', 'build'), null);
});

test('next-task claim cannot bypass waiting input or a running task in another lane', async (t) => {
  const { repository, task } = await fixture(t);
  await repository.putTask(task('waiting', 'waiting_input'));
  await repository.putTask(task('build'));
  assert.equal(await repository.claimNextQueuedTask('s'), null);
  await repository.putTask(task('waiting', 'completed'));
  await repository.putTask(task('chat', 'running', 'direct'));
  assert.equal(await repository.claimQueuedTask('s', 'build'), null);
  assert.equal(await repository.claimNextQueuedTask('s'), null);
});

test('simultaneous queue claims promote only one task per session', async (t) => {
  const { repository, task } = await fixture(t);
  await repository.putTask(task('a'));
  await repository.putTask(task('b', 'queued', 'direct'));
  const claims = await Promise.all([repository.claimQueuedTask('s', 'a'), repository.claimQueuedTask('s', 'b')]);
  assert.equal(claims.filter(Boolean).length, 1);
});

test('old failover bindings self-heal from scoped durable workspace state', async (t) => {
  const { repository, task, now } = await fixture(t);
  setControlPlaneRepositoryForTests(repository);
  t.after(() => setControlPlaneRepositoryForTests(undefined));
  await repository.putWorkspace({ id: 'ws', sessionId: 's', userId: 'u', projectId: 'p', repositoryId: 1, branch: 'main', provider: 'github-codespaces', state: 'ready', bridgeState: 'ready', createdAt: now, updatedAt: now });
  const stale = task('stale');
  await repository.putTask(stale);
  assert.equal((await reconcileTaskWorkspace(stale)).id, 'ws');
  assert.equal((await repository.getTask('stale')).workspaceId, 'ws');
});

test('expired workspace lease is reclaimable and stale workers cannot finalize the new lease', async (t) => {
  const { db, repository, now } = await fixture(t);
  await repository.putWorkspace({ id: 'ws', sessionId: 's', userId: 'u', projectId: 'p', repositoryId: 1, branch: 'main', provider: 'github-codespaces', state: 'starting', bridgeState: 'disconnected', createdAt: now, updatedAt: now });
  const job = { id: 'job', workspaceId: 'ws', sessionId: 's', kind: 'prepare', state: 'queued', attempt: 0, allowFallback: true, createdAt: now, updatedAt: now };
  assert.equal(await repository.enqueueWorkspaceJob(job), true);
  assert.equal(await repository.enqueueWorkspaceJob({ ...job, id: 'duplicate' }), false);
  const [first] = await repository.claimWorkspaceJobs('worker', 1, 60);
  await db.query("UPDATE workspace_jobs SET lease_until=now()-interval '1 second' WHERE id='job'");
  assert.equal(await repository.renewWorkspaceJobLease('job', 'worker', 60, first.attempt), false);
  const [second] = await repository.claimWorkspaceJobs('worker', 1, 60);
  assert.equal(second.attempt, first.attempt + 1);
  assert.equal(await repository.noteWorkspaceJobProviderAttempt('job', 'e2b', first), false);
  assert.equal(await repository.noteWorkspaceJobProviderAttempt('job', 'e2b', second), true);
  assert.deepEqual((await repository.getLatestWorkspaceJob('ws')).providerAttempts, ['e2b']);
  assert.equal(await repository.completeWorkspaceJob('job', first), false);
  assert.equal(await repository.failWorkspaceJob('job', 'late failure', first), false);
  assert.equal(await repository.retryWorkspaceJob('job', 'late retry', 1, first), false);
  assert.equal(await repository.completeWorkspaceJob('job', second), true);
  assert.equal((await repository.getLatestWorkspaceJob('ws')).state, 'completed');
});

test('failed compute resource metadata is retained without changing repository ownership', async t => {
  const { db, repository, now } = await fixture(t);
  const workspace = { id: 'ws', sessionId: 's', userId: 'u', projectId: 'p', repositoryId: 1, branch: 'main', provider: 'github-codespaces', codespaceName: 'old-space', state: 'failed', bridgeState: 'disconnected', createdAt: now, updatedAt: now };
  await repository.putWorkspace(workspace);
  await repository.archiveWorkspaceResource(workspace);
  await repository.archiveWorkspaceResource(workspace);
  const records = (await db.query('SELECT record FROM workspace_recovery_resources')).rows;
  assert.equal(records.length, 1);
  assert.equal(records[0].record.codespaceName, 'old-space');
  assert.equal(records[0].record.userId, 'u');
});

test('completed preparation and ready adapter wake queued work without a browser; Git freshness runs first', async t => {
  const { db, repository, task, now } = await fixture(t);
  const previous = process.env.DATABASE_URL;
  process.env.DATABASE_URL = 'postgresql://test/test';
  setControlPlaneRepositoryForTests(repository);
  t.after(() => {
    setControlPlaneRepositoryForTests(undefined);
    if (previous === undefined) delete process.env.DATABASE_URL; else process.env.DATABASE_URL = previous;
  });
  await repository.putWorkspace({ id: 'ws', sessionId: 's', userId: 'u', projectId: 'p', repositoryId: 1, branch: 'main', provider: 'github-codespaces', state: 'ready', bridgeState: 'ready', createdAt: now, updatedAt: now });
  await repository.putWorkspaceAgentAdapter({ workspaceId: 'ws', adapterId: 'opencode', state: 'ready', updatedAt: now });
  await repository.putAISessionPrefs({ sessionId: 's', modelId: 'opencode/kimi-k2.5-free', mode: 'build', permission: 'full', updatedAt: now });
  await repository.putTask({ ...task('wake'), workspaceId: 'ws', mode: 'build', modelId: 'opencode/kimi-k2.5-free' });
  await repository.enqueueWorkspaceJob({ id: 'ready-job', workspaceId: 'ws', sessionId: 's', kind: 'prepare', state: 'queued', allowFallback: true, attempt: 0, createdAt: now, updatedAt: now });
  const [job] = await repository.claimWorkspaceJobs('worker', 1, 60);
  await repository.completeWorkspaceJob(job.id, job);
  const original = repository.getCommand.bind(repository);
  repository.getCommand = async id => {
    const command = await original(id);
    if (command?.kind === 'git.sync') return { ...command, status: 'completed', result: { state: 'current', branch: 'main', head: 'fresh' } };
    return command;
  };
  await recoverDurableTaskSessionsOnce();
  assert.equal((await repository.getTask('wake')).state, 'running');
  const commands = (await db.query('SELECT kind,payload FROM bridge_commands ORDER BY created_at,id')).rows;
  assert.deepEqual(commands.map(command => command.kind), ['git.sync', 'agent.run']);
  assert.equal(commands[1].payload.taskId, 'wake');
});

test('concurrent multi-part deltas fold into durable partial text exactly once and in sequence', async t => {
  const { repository, task, now } = await fixture(t);
  await repository.putTask({ ...task('stream', 'running'), partialText: '', harness: {} });

  const first = await repository.appendEvent({
    eventId: 'delta-1',
    sessionId: 's',
    taskId: 'stream',
    runId: 'run-stream',
    type: 'message.delta',
    payload: { delta: 'Hello ', messagePartId: 'part-a', offset: 0, responseOffset: 0 },
    timestamp: now,
  });
  const second = await repository.appendEvent({
    eventId: 'delta-2',
    sessionId: 's',
    taskId: 'stream',
    runId: 'run-stream',
    type: 'message.delta',
    payload: { delta: 'world', messagePartId: 'part-b', offset: 0, responseOffset: 6 },
    timestamp: new Date(Date.parse(now) + 1).toISOString(),
  });

  await Promise.all([
    repository.checkpointTaskPartialFromEvents('stream', second.sequence),
    repository.checkpointTaskPartialFromEvents('stream', first.sequence),
  ]);
  let restored = await repository.getTask('stream');
  assert.equal(restored.partialText, 'Hello world');
  assert.equal(restored.harness.lastPartialSequence, second.sequence);

  await repository.checkpointTaskPartialFromEvents('stream', second.sequence);
  restored = await repository.getTask('stream');
  assert.equal(restored.partialText, 'Hello world');

  await repository.setTaskPartialText('stream', 'Hello world!', new Date(Date.parse(now) + 2).toISOString());
  restored = await repository.getTask('stream');
  assert.equal(restored.partialText, 'Hello world!');
});

test('event sequence and payload commit together; duplicate replay remains idempotent', async t => {
  const { repository, now } = await fixture(t);
  const first = { eventId: 'event-1', sessionId: 's', runId: 'r', type: 'run.state', payload: { state: 'queued' }, timestamp: now };
  const one = await repository.appendEvent(first);
  const two = await repository.appendEvent({ ...first, eventId: 'event-2', payload: { state: 'running' } });
  assert.equal((await repository.appendEvent(first)).sequence, one.sequence);
  assert.deepEqual((await repository.listEvents('s', one.sequence)).map(event => event.payload.state), ['running']);
  assert.ok(two.sequence > one.sequence);
});
