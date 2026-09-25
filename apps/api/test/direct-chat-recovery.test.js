import test from 'node:test';
import assert from 'node:assert/strict';
import { setControlPlaneRepositoryForTests } from '../src/storage.ts';
import { recoverInterruptedDirectRuns } from '../src/agents.ts';

function fixture(t, task) {
  const previous = process.env.DATABASE_URL;
  process.env.DATABASE_URL = 'postgresql://test:test@localhost/test';
  const writes = [];
  setControlPlaneRepositoryForTests({
    listTasks: async () => [structuredClone(task)],
    putTask: async (value) => { Object.assign(task, value); writes.push(structuredClone(value)); },
    appendEvent: async (event) => ({ ...event, sequence: 1 }),
    getSession: async () => ({ id: 'recovery-session' }),
  });
  t.after(() => {
    setControlPlaneRepositoryForTests(undefined);
    if (previous === undefined) delete process.env.DATABASE_URL; else process.env.DATABASE_URL = previous;
  });
  return writes;
}

test('stale interrupted run preserves partial text, terminates once, and cannot silently replay', async (t) => {
  const task = { id: 'stale-task', runId: 'stale-run', plane: 'direct', state: 'running', partialText: 'Saved answer fragment', updatedAt: new Date(0).toISOString() };
  const writes = fixture(t, task);
  await recoverInterruptedDirectRuns('recovery-session');
  assert.equal(task.state, 'failed');
  assert.equal(task.partialText, 'Saved answer fragment');
  await recoverInterruptedDirectRuns('recovery-session');
  assert.equal(writes.length, 1);
});

test('a fresh heartbeat is not reclaimed by a simultaneous reload', async (t) => {
  const task = { id: 'fresh-task', runId: 'fresh-run', plane: 'direct', state: 'running', updatedAt: new Date().toISOString() };
  const writes = fixture(t, task);
  await recoverInterruptedDirectRuns('recovery-session');
  assert.equal(task.state, 'running');
  assert.equal(writes.length, 0);
});
