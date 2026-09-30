import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { randomUUID } from 'node:crypto';

test('workspace OpenCode retries the exact model once, recreates stale sessions, and deduplicates bridge commands', async t => {
  const streams = new Set();
  const sessions = new Map();
  const prompts = [];
  const aborts = [];
  let failures = 1;
  const server = http.createServer(async (req, res) => {
    const pathname = new URL(req.url, 'http://localhost').pathname;
    const json = body => { res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify(body)); };
    if (pathname === '/event') {
      res.setHeader('Content-Type', 'text/event-stream');
      res.write('data: {"type":"server.connected"}\n\n');
      streams.add(res);
      req.on('close', () => streams.delete(res));
      return;
    }
    if (pathname === '/session' && req.method === 'POST') {
      const id = `session-${sessions.size + 1}`;
      sessions.set(id, []);
      return json({ id });
    }
    if (pathname === '/session/status') return json(Object.fromEntries([...sessions.keys()].map(id => [id, { type: 'idle' }])));
    const [, id, action] = pathname.split('/').slice(1);
    if (!sessions.has(id)) { res.statusCode = 404; return json({ error: 'session missing' }); }
    if (action === 'message') return json(sessions.get(id));
    if (action === 'diff') return json([]);
    if (action === 'abort') { aborts.push(id); return json(true); }
    if (action === 'prompt_async') {
      let body = '';
      for await (const chunk of req) body += chunk;
      prompts.push(JSON.parse(body));
      json({});
      setTimeout(() => {
        const error = failures-- > 0;
        const message = error
          ? { info: { role: 'assistant', id: `m-${id}`, error: { data: { statusCode: 503, message: 'route unavailable' } } }, parts: [] }
          : { info: { role: 'assistant', id: `m-${id}` }, parts: [{ type: 'text', text: 'Recovered answer' }] };
        sessions.set(id, [message]);
        const event = error
          ? { type: 'session.error', properties: { sessionID: id, error: message.info.error } }
          : { type: 'session.status', properties: { sessionID: id, status: { type: 'idle' } } };
        for (const stream of streams) stream.write(`data: ${JSON.stringify(event)}\n\n`);
      }, 10);
      return;
    }
    res.statusCode = 404; json({});
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const previousPort = process.env.OPENCODE_PORT;
  process.env.OPENCODE_PORT = String(server.address().port);
  t.after(() => {
    for (const stream of streams) stream.destroy();
    server.closeAllConnections(); server.close();
    if (previousPort === undefined) delete process.env.OPENCODE_PORT; else process.env.OPENCODE_PORT = previousPort;
  });
  const { runAgent, runCommandOnce } = await import('../../../bridge/src/index.ts');
  const events = [];
  const socket = { readyState: 1, OPEN: 1, send: raw => events.push(JSON.parse(raw)) };
  const payload = { taskId: 'task-retry', runId: 'run-retry', sessionId: 'durable', engineSessionId: 'stale-session', model: { providerID: 'opencode', modelID: 'kimi-k2.5-free' }, text: 'hello' };
  const result = await runAgent(payload, socket);
  assert.equal(result.responseText, 'Recovered answer');
  assert.equal(prompts.length, 2);
  assert.deepEqual(prompts.map(prompt => prompt.model), [payload.model, payload.model]);
  assert.ok(aborts.length >= 1);
  assert.ok(events.some(frame => frame.event?.payload.engineSessionId === 'session-1'));

  failures = 10;
  await assert.rejects(runAgent({ ...payload, engineSessionId: '', taskId: 'bounded' }, socket), /503/);
  assert.equal(prompts.length, 4, 'repeated provider failure stops after one retry');

  const replies = [];
  const replySocket = { ...socket, send: raw => replies.push(JSON.parse(raw)) };
  const command = { kind: 'COMMAND', commandId: `test-${randomUUID()}`, type: 'fs.list', payload: { path: '.' } };
  runCommandOnce(command, replySocket);
  runCommandOnce(command, replySocket);
  for (let i = 0; i < 20 && !replies.length; i++) await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(replies.length, 1, 'in-flight replay shares one execution/result');
  runCommandOnce(command, replySocket);
  assert.deepEqual(replies[1], replies[0], 'completed journal replay returns the original result');
});
