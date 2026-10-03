import { PGlite } from '@electric-sql/pglite';
import { PostgresControlPlaneRepository } from '../../src/storage.ts';
export async function controlPlaneFixture(t) {
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
