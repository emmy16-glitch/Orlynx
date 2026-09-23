// Agent Gateway — PDF §8. Adapter contract: native first, OpenCode/Cline swappable.
import { v4 as uuid } from 'uuid';
import type { AgentRun } from '@orlynx/shared';
import { store } from './store.js';
import { emit } from './events.js';
import { createChangeSet } from './changes.js';

export type Engine = 'native' | 'opencode' | 'cline';

function needsCloud(text: string): boolean {
  return /test|run|build|install|preview|exec|shell|server/i.test(text);
}

export async function startRun(sessionId: string, project: string, userText: string, engine: Engine = 'native'): Promise<AgentRun> {
  const run: AgentRun = {
    id: `run_${uuid().slice(0, 8)}`, sessionId, engine,
    state: 'running', activity: 'Reading request', startedAt: new Date().toISOString(),
  };
  (store.db.runs[sessionId] ||= []).push(run);
  emit(sessionId, 'run.started', { engine }, run.id);
  emit(sessionId, 'activity.started', { text: 'Reading files' }, run.id);

  // Capability planner (PDF §6.1/§10): decide repository-only vs cloud
  const cloud = needsCloud(userText);
  emit(sessionId, 'activity.progress', { text: cloud ? 'Planning cloud execution' : 'Reasoning over repository' }, run.id);

  // Simulated visible-work stream (AG-UI inspired §§8.3-8.4 — no hidden reasoning exposed)
  const deltas = cloud
    ? [`I'll run the needed checks for: "${userText.slice(0, 120)}".`, 'Using the attached cloud workspace (local provider for localhost).']
    : [`Here's my plan for: "${userText.slice(0, 120)}".`, 'Repository-only change — review before commit.'];

  emit(sessionId, 'message.start', { engine }, run.id);
  for (const d of deltas) emit(sessionId, 'message.delta', { delta: d }, run.id);
  const assistantText = deltas.join('');
  (store.db.messages[sessionId] ||= []).push({
    id: `msg_${run.id}`, sessionId, role: 'assistant', text: assistantText, createdAt: new Date().toISOString(),
  });
  emit(sessionId, 'message.end', {}, run.id);

  // Produce a concrete repository patch when the intent looks like an edit
  if (/readme|doc|update|fix|refactor|add|create|edit/i.test(userText)) {
    emit(sessionId, 'tool.started', { tool: 'fs.patch' }, run.id);
    const name = userText.toLowerCase().includes('readme') ? 'README.md' : 'NOTES_FROM_AGENT.md';
    createChangeSet(sessionId, project, [{
      path: name, action: 'modify',
      after: `# Updated by Orlynx agent\n\nTask: ${userText}\n\n- Reviewed in Changes tab\n- Base-SHA protected\n- ${new Date().toISOString()}\n`,
    }], run.id);
    emit(sessionId, 'tool.completed', { tool: 'fs.patch', files: 1 }, run.id);
    emit(sessionId, 'file.changed' as never as never, { path: name } as never, run.id);
  }

  run.state = 'completed'; run.finishedAt = new Date().toISOString();
  emit(sessionId, 'run.completed', { summary: 'Done — review Changes' }, run.id);
  emit(sessionId, 'activity.completed', { text: 'Done' }, run.id);
  store.save();
  return run;
}

export function cancelRun(sessionId: string, runId: string) {
  const r = (store.db.runs[sessionId] || []).find((x) => x.id === runId);
  if (r && (r.state === 'running' || r.state === 'queued')) {
    r.state = 'cancelled'; store.save();
    emit(sessionId, 'run.failed', { cancelled: true }, runId);
  }
  return r;
}
