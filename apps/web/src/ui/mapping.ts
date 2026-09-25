// Provider/runtime envelopes stop here. The chat renders only this Orlynx-owned,
// action-oriented projection; command/output payloads are retained for opt-in detail.
import type { ActivityCategory, ActivityEvent, ActivityLifecycle, OrlynxEvent } from '@orlynx/shared';

export type ActivityState = 'done' | 'active' | 'todo' | 'fail';
export interface ActivityItem extends ActivityEvent { key: string; }

type RuntimeEvent = Omit<Partial<OrlynxEvent>, 'type'> & { type: string; payload?: Record<string, unknown> };
const toState = (s: ActivityLifecycle): ActivityState => s === 'success' ? 'done' : s === 'running' ? 'active' : s === 'queued' || s === 'waiting' ? 'todo' : 'fail';
const str = (v: unknown): string => typeof v === 'string' ? v : '';

/** Normalize, correlate, and group the session event ledger into stable visible rows. */
export function toActivities(input: RuntimeEvent[]): ActivityItem[] {
  const events = [...new Map(input.filter((e) => e && e.eventId).map((e) => [e.eventId!, e])).values()]
    .sort((a, b) => (a.sequence || 0) - (b.sequence || 0));
  const rows: ActivityItem[] = [];
  const activeTools = new Map<string, ActivityItem>();
  const filePaths = new Map<string, string[]>();

  const put = (event: RuntimeEvent, category: ActivityCategory, state: ActivityLifecycle, title: string, summary?: string, evidence?: Record<string, unknown>, rawOutput?: string) => {
    const item: ActivityItem = {
      key: event.eventId || `${event.runId || 'session'}:${event.sequence || rows.length}`,
      id: event.eventId || `${event.runId || 'session'}:${event.sequence || rows.length}`,
      runId: event.runId, sequence: event.sequence || 0, timestamp: event.timestamp || '',
      category, state, title, summary, evidence, rawOutput,
      rawRef: event.eventId ? `event:${event.eventId}` : undefined,
      collapsible: Boolean(evidence || rawOutput),
    };
    rows.push(item);
    return item;
  };

  for (const event of events) {
    const p = event.payload || {};
    const tool = str(p.tool || p.name);
    const command = str(p.cmd || p.command);
    const activeKey = str(p.toolCallId || p.callId) || `${event.runId || 'session'}:${tool || 'tool'}`;
    const previous = activeTools.get(activeKey);
    switch (event.type) {
      case 'message.delta': case 'message.start': case 'message.end': case 'state.snapshot': case 'state.delta':
        break; // user-facing text is rendered in chat; state snapshots are not activity.
      case 'run.queued': {
        const item = put(event, 'agent', 'queued', 'Queued', typeof p.position === 'number' ? `Position ${p.position} · starts automatically` : 'Starts automatically');
        item.key = `agent:${event.runId || 'session'}`;
        break;
      }
      case 'run.started': {
        const runKey = `agent:${event.runId || 'session'}`;
        const existing = rows.find((row) => row.key === runKey);
        if (existing) {
          existing.state = 'running';
          existing.title = 'Starting work';
          existing.summary = undefined;
          existing.sequence = event.sequence || existing.sequence;
          existing.rawRef = event.eventId ? `event:${event.eventId}` : existing.rawRef;
        } else {
          const item = put(event, 'agent', 'running', 'Starting work');
          item.key = runKey;
        }
        break;
      }
      case 'activity.started': case 'activity.progress': {
        const runKey = `agent:${event.runId || 'session'}`;
        const existing = rows.find((r) => r.key === runKey);
        const retrying = p.sourceType === 'opencode.retry';
        const title = retrying ? 'AI provider busy — retrying' : humanActivity(str(p.text));
        const summary = retrying
          ? [str(p.text), typeof p.attempt === 'number' ? `attempt ${Number(p.attempt) + 1}` : ''].filter(Boolean).join(' · ')
          : undefined;
        const evidence = retrying
          ? {
              ...(str(p.provider) ? { provider: str(p.provider) } : {}),
              ...(typeof p.nextAt === 'number' ? { nextAt: Number(p.nextAt) } : {}),
            }
          : undefined;
        if (existing) {
          existing.title = title;
          existing.state = 'running';
          existing.summary = summary || existing.summary;
          existing.evidence = evidence ? { ...(existing.evidence || {}), ...evidence } : existing.evidence;
          existing.sequence = event.sequence || existing.sequence;
          existing.rawRef = event.eventId ? `event:${event.eventId}` : existing.rawRef;
          existing.collapsible = Boolean(existing.evidence || existing.rawOutput);
        } else {
          const item = put(event, 'agent', 'running', title, summary, evidence);
          item.key = runKey;
        }
        break;
      }
      case 'activity.completed': {
        const current = [...rows].reverse().find((r) => r.runId === event.runId && r.category === 'agent' && r.state === 'running');
        if (current) { current.state = 'success'; current.sequence = event.sequence || current.sequence; }
        break;
      }
      case 'tool.requested':
        put(event, classifyTool(tool, command), 'waiting', waitingTitle(tool, command));
        break;
      case 'tool.started': {
        const category = classifyTool(tool, command);
        const item = put(event, category, 'running', titleFor(category, tool, command), undefined,
          { tool, command: command || undefined, path: str(p.path) || undefined });
        activeTools.set(activeKey, item);
        break;
      }
      case 'tool.output': {
        if (previous && (typeof p.out === 'string' || typeof p.stderr === 'string')) {
          previous.rawOutput = [str(p.out), str(p.stderr)].filter(Boolean).join('\n');
          previous.collapsible = true;
        }
        break;
      }
      case 'tool.completed': case 'tool.failed': {
        const item = previous || [...rows].reverse().find((r) => r.runId === event.runId && r.state === 'running' && r.category !== 'agent');
        if (item) {
          item.state = event.type === 'tool.completed' ? 'success' : 'failed';
          item.sequence = event.sequence || item.sequence;
          item.rawRef = event.eventId ? `event:${event.eventId}` : item.rawRef;
          item.summary = event.type === 'tool.failed' ? friendlyFailure(str(p.error || p.message)) : item.summary;
          item.evidence = { ...(item.evidence || {}), ...(typeof p.exitCode === 'number' ? { exitCode: p.exitCode } : {}), ...(typeof p.files === 'number' ? { filesChanged: p.files } : {}) };
          item.rawOutput = str(p.out || p.stderr || p.error || p.message) || item.rawOutput;
          item.collapsible = true;
        }
        activeTools.delete(activeKey);
        break;
      }
      case 'file.changed': {
        const runKey = event.runId || 'session';
        const paths = filePaths.get(runKey) || [];
        const path = str(p.path);
        if (path && !paths.includes(path)) paths.push(path);
        filePaths.set(runKey, paths);
        let item = rows.find((r) => r.key === `files:${runKey}`);
        const state: ActivityLifecycle = 'success';
        if (!item) { item = put(event, 'file', state, 'Updated files'); item.key = `files:${runKey}`; }
        item.state = state;
        item.summary = `${paths.length} file${paths.length === 1 ? '' : 's'} changed`;
        item.evidence = { files: paths.map((f) => {
          const operation = events.find((candidate) => candidate.type === 'file.changed' && candidate.runId === runKey && str(candidate.payload?.path) === f)?.payload?.action;
          return { path: f, action: operation === 'create' || operation === 'delete' ? operation : 'modify' };
        }) };
        item.rawRef = event.eventId ? `event:${event.eventId}` : item.rawRef;
        item.collapsible = true;
        break;
      }
      case 'receipt.created': {
        const result = normalizeReceipt(event, p);
        const prior = [...rows].reverse().find((row) => row.category === result.category &&
          (!event.runId || row.runId === event.runId) &&
          (command ? row.evidence?.command === command : row.state === 'running'));
        const evidence = { ...(result.evidence || {}), ...(command ? { command } : {}) };
        if (prior) {
          prior.state = result.state;
          prior.title = result.title;
          prior.summary = result.summary || prior.summary;
          prior.evidence = { ...(prior.evidence || {}), ...evidence };
          prior.rawOutput = result.rawOutput || prior.rawOutput;
          prior.rawRef = event.eventId ? `event:${event.eventId}` : prior.rawRef;
          prior.sequence = event.sequence || prior.sequence;
          prior.collapsible = true;
        } else {
          put(event, result.category, result.state, result.title, result.summary, evidence, result.rawOutput);
        }
        break;
      }
      case 'workspace.preparing': case 'workspace.reconnecting':
        put(event, 'cloud', 'running', event.type === 'workspace.preparing' ? 'Preparing workspace' : 'Reconnecting to workspace');
        break;
      case 'workspace.ready': {
        const pending = [...rows].reverse().find((r) => r.category === 'cloud' && r.state === 'running');
        if (pending) { pending.state = 'success'; pending.title = 'Development environment ready'; pending.sequence = event.sequence || pending.sequence; }
        else put(event, 'cloud', 'success', 'Development environment ready');
        break;
      }
      case 'workspace.stopped': put(event, 'cloud', 'success', 'Workspace stopped'); break;
      case 'approval.required': put(event, 'approval', 'waiting', humanApproval(p)); break;
      case 'approval.resolved': {
        const pending = [...rows].reverse().find((r) => r.category === 'approval' && r.state === 'waiting');
        if (pending) { pending.state = p.approved ? 'success' : 'cancelled'; pending.title = p.approved ? 'Approval completed' : 'Approval declined'; }
        break;
      }
      case 'run.completed': {
        for (const row of rows) if (row.runId === event.runId && row.state === 'running') row.state = 'success';
        if (!rows.some((r) => r.runId === event.runId && r.category === 'agent')) put(event, 'agent', 'success', 'Work completed', str(p.summary) || 'Ready for review');
        break;
      }
      case 'run.failed': {
        for (const row of rows) if (row.runId === event.runId && row.state === 'running') row.state = p.cancelled ? 'cancelled' : 'failed';
        const agentRow = [...rows].reverse().find((row) => row.runId === event.runId && row.category === 'agent');
        const title = p.cancelled
          ? 'Work stopped'
          : p.errorKind === 'rate_limit' ? 'Model is busy'
          : p.errorKind === 'auth' ? 'Reconnect OpenCode'
          : p.errorKind === 'model' ? 'Model unavailable'
          : p.errorKind === 'quota' ? 'OpenCode quota reached'
          : 'Work needs attention';
        const summary = friendlyFailure(str(p.error || p.message));
        if (agentRow) { agentRow.state = p.cancelled ? 'cancelled' : 'failed'; agentRow.title = title; agentRow.summary = summary; }
        else put(event, p.cancelled ? 'agent' : 'error', p.cancelled ? 'cancelled' : 'failed', title, summary);
        break;
      }
      default: break;
    }
  }
  return rows.slice(-100);
}

function humanActivity(text: string): string {
  if (!text) return 'Working on your request';
  if (/opencode|agent engine/i.test(text)) return 'Starting Orlynx AI';
  if (/reasoning|thinking/i.test(text)) return 'Reviewing the request';
  if (/read(ing)? files|search(ing)? repository/i.test(text)) return 'Inspecting the repository';
  if (/plan/i.test(text)) return 'Planning the next steps';
  if (/test/i.test(text)) return 'Running tests';
  if (/build/i.test(text)) return 'Building the project';
  if (/updat|edit|patch|writ/i.test(text)) return 'Updating files';
  return text.replace(/[.!…]+$/, '');
}
function classifyTool(tool: string, command: string): ActivityCategory {
  const name = `${tool} ${command}`.toLowerCase();
  if (/test|vitest|jest|pytest/.test(name)) return 'test';
  if (/build|tsc|compile/.test(name)) return 'build';
  if (/git|commit|push|branch/.test(name)) return 'git';
  if (/search|read|inspect|list/.test(name)) return 'search';
  if (/patch|edit|write|file/.test(name)) return 'file';
  return 'command';
}
function titleFor(category: ActivityCategory, tool: string, command: string): string {
  if (category === 'test') return 'Running tests';
  if (category === 'build') return 'Building the project';
  if (category === 'search') return 'Inspecting the repository';
  if (category === 'file') return 'Updating files';
  if (category === 'git') return 'Updating repository';
  if (/health|curl/i.test(command)) return 'Checking service health';
  return tool === 'exec' || /shell|command/i.test(tool) ? 'Running a command' : `Working with ${tool || 'the project'}`;
}
function waitingTitle(tool: string, command: string): string {
  if (/test/i.test(`${tool} ${command}`)) return 'Tests are queued';
  if (/build|tsc/i.test(`${tool} ${command}`)) return 'Build is queued';
  return 'Action is queued';
}
function friendlyFailure(raw: string): string | undefined {
  if (/FreeUsageLimitError|temporarily rate limit|rate.?limit exceeded|too many requests/i.test(raw)) return 'This model is temporarily rate limited by OpenCode. Orlynx already retried it; try again shortly or choose another model.';
  if (/reached its quota|available quota|available credits|billing|payment/i.test(raw)) return 'The OpenCode account has reached its quota or available credits.';
  if (/free model.*not available.*Orlynx|public third-party route|choose another free model/i.test(raw)) return 'That free model is restricted on OpenCode’s side for third-party clients. Choose another free model.';
  if (/Reconnect your OpenCode account|credential.*rejected|HTTP 401|HTTP 403|provider connection needs to be refreshed/i.test(raw)) return 'OpenCode rejected the saved connection. Reconnect OpenCode, then continue in this same chat.';
  if (/model.*not available|selected model is not currently available|unknown model/i.test(raw)) return 'The selected model is not available right now. Choose another model and try again.';
  if (/AI workspace connection was interrupted/i.test(raw)) return 'The AI workspace connection was interrupted. Reconnect and try again.';
  if (/previous AI task stopped responding/i.test(raw)) return 'The previous AI task stopped responding and was released. You can try again.';
  if (/current access level does not allow/i.test(raw)) return 'The current access level does not allow this task.';
  if (/timeout|timed out/i.test(raw)) return 'The command timed out. The process may still be running.';
  if (/ECONNREFUSED|curl.*exit code 7|curl:\s*\(7\)/i.test(raw)) return 'The service health check could not connect.';
  if (/duplicate.message|duplicate message/i.test(raw)) return 'Duplicate-message handling needs attention.';
  if (/selected model finished without returning visible text/i.test(raw)) return 'The model returned no visible response. Try again or choose another model.';
  return raw ? raw.replace(/^OpenCode\s+/i, '').slice(0, 280) : undefined;
}
function humanApproval(p: Record<string, unknown>): string {
  const count = Number(p.files || p.count || 0);
  return count ? `Review ${count} changed file${count === 1 ? '' : 's'} before continuing` : 'Waiting for your approval';
}

function normalizeReceipt(event: RuntimeEvent, p: Record<string, unknown>) {
  const command = str(p.cmd || p.command);
  const category = classifyTool('', command);
  const rawOutput = [str(p.out), str(p.stderr), str(p.error)].filter(Boolean).join('\n') || undefined;
  const code = typeof p.code === 'number' ? p.code : undefined;
  const testCounts = parseTestCounts(rawOutput || '');
  const failed = (code !== undefined && code !== 0) || (category === 'test' && (testCounts?.failed || 0) > 0);
  const evidence: Record<string, unknown> = { ...(code === undefined ? {} : { exitCode: code }), ...(testCounts || {}) };
  const summary = category === 'test' && testCounts
    ? [...[testCounts.passed !== undefined && `${testCounts.passed} passed`, testCounts.failed !== undefined && `${testCounts.failed} failed`, testCounts.skipped !== undefined && `${testCounts.skipped} skipped`].filter(Boolean), ...(testCounts.failures?.[0] ? [`Main issue: ${testCounts.failures[0]}`] : [])].join(' · ')
    : failed ? friendlyFailure(str(p.error || rawOutput)) || 'The command did not complete successfully.' : undefined;
  const title = /health|curl/i.test(command) ? (failed ? 'API health check failed' : 'API health check passed')
    : category === 'test' ? (failed ? 'Tests failed' : 'Tests passed') : category === 'build' ? (failed ? 'Build failed' : 'Production build completed') : failed ? 'Command needs attention' : 'Command completed';
  if (testCounts?.failures) evidence.failures = testCounts.failures;
  return { category, state: failed ? 'failed' as const : 'success' as const, title, summary, evidence, rawOutput };
}

export function parseTestCounts(output: string): { passed?: number; failed?: number; skipped?: number; failures?: string[] } | undefined {
  const result: { passed?: number; failed?: number; skipped?: number; failures?: string[] } = {};
  const patterns: [keyof typeof result, RegExp][] = [
    ['passed', /(?:#\s*)?(\d+)\s+(?:tests?\s+)?passed\b|\b(\d+)\s+passing\b|^#\s*pass\s+(\d+)/im],
    ['failed', /(?:#\s*)?(\d+)\s+(?:tests?\s+)?failed\b|\b(\d+)\s+failing\b|^#\s*fail\s+(\d+)/im],
    ['skipped', /(?:#\s*)?(\d+)\s+(?:tests?\s+)?skipped\b|\b(\d+)\s+pending\b|^#\s*skipped\s+(\d+)/im],
  ];
  for (const [key, pattern] of patterns) {
    const match = pattern.exec(output);
    if (match) {
      const count = Number(match[1] || match[2] || match[3]);
      if (key === 'passed') result.passed = count;
      else if (key === 'failed') result.failed = count;
      else result.skipped = count;
    }
  }
  const names = [...output.matchAll(/(?:✕|not ok\s+\d+|FAIL)\s*([^\n]+)/g)].map((m) => m[1].trim()).filter(Boolean).slice(0, 20);
  if (names.length) result.failures = names;
  return Object.keys(result).length ? result : undefined;
}

export function runTone(state: string): { tone: 'work' | 'ok' | 'fail' | 'wait' | 'neutral'; label: string } {
  switch (state) {
    case 'running': case 'queued': return { tone: 'work', label: 'Working' };
    case 'waiting_input': return { tone: 'wait', label: 'Waiting for you' };
    case 'waiting_approval': return { tone: 'wait', label: 'Waiting for approval' };
    case 'paused': return { tone: 'neutral', label: 'Paused' };
    case 'interrupted': return { tone: 'wait', label: 'Reconnecting' };
    case 'completed': return { tone: 'ok', label: 'Completed' };
    case 'failed': case 'cancelled': return { tone: 'fail', label: state === 'cancelled' ? 'Stopped' : 'Failed' };
    default: return { tone: 'neutral', label: 'Idle' };
  }
}

export { toState };
