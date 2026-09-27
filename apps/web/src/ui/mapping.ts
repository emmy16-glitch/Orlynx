// Provider/runtime envelopes stop here. The chat renders only this Orlynx-owned,
// action-oriented projection; command/output payloads are retained for opt-in detail.
import type { ActivityCategory, ActivityEvent, ActivityLifecycle, OrlynxEvent } from '@orlynx/shared';

export type ActivityState = 'done' | 'active' | 'todo' | 'fail';
export interface ActivityItem extends ActivityEvent { key: string; }

type RuntimeEvent = Omit<Partial<OrlynxEvent>, 'type'> & { type: string; payload?: Record<string, unknown> };
const toState = (s: ActivityLifecycle): ActivityState => s === 'success' ? 'done' : s === 'running' ? 'active' : s === 'queued' || s === 'waiting' ? 'todo' : 'fail';
const str = (v: unknown): string => typeof v === 'string' ? v : '';
const compact = (value: string, max = 96): string => {
  const oneLine = value.replace(/\s+/g, ' ').trim();
  return oneLine.length > max ? `${oneLine.slice(0, max - 1)}…` : oneLine;
};
function toolEvidence(p: Record<string, unknown>, tool: string, command: string): Record<string, unknown> {
  const title = str(p.title);
  const path = str(p.path);
  const code = str(p.code);
  return {
    ...(tool ? { tool } : {}),
    ...(title ? { toolTitle: title } : {}),
    ...(command ? { command } : {}),
    ...(path ? { path } : {}),
    ...(code ? { code } : {}),
  };
}

/** Normalize, correlate, and group the session event ledger into stable visible rows. */
export function toActivities(input: RuntimeEvent[]): ActivityItem[] {
  const events = [...new Map(input.filter((e) => e && e.eventId).map((e) => [e.eventId!, e])).values()]
    .sort((a, b) => (a.sequence || 0) - (b.sequence || 0));
  const rows: ActivityItem[] = [];
  const activeTools = new Map<string, ActivityItem>();
  const filePaths = new Map<string, string[]>();
  // Semantic lifecycle state. Raw heartbeats update these in place; only
  // meaningful transitions project a visible row. Nothing here deletes raw
  // events — the ledger keeps everything, the transcript shows what matters.
  const adapterStates = new Map<string, string>();
  const adapterRows = new Map<string, ActivityItem>();
  let workspaceRow: ActivityItem | null = null;
  const finishedRuns = new Set<string>();

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
      case 'message.delta':
        break; // text chunks render directly in the live assistant message.
      case 'message.start':
      case 'message.end':
        break; // streaming telemetry: the live assistant message already shows this.
      case 'state.snapshot':
        break; // session restoration infrastructure, not conversation history.
      case 'state.delta': {
        // Infrastructure state (heartbeats, polling, transport) is tracked as
        // current state, not transcript history. Repeated identical states —
        // e.g. 100x "ready" — must not create new rows.
        const scope = str(p.scope);
        const adapterId = str(p.adapterId) || 'orlynx-ai';
        const rawState = str(p.state).toLowerCase();
        const reason = str(p.reason || p.error || p.message);
        const previous = adapterStates.get(scope === 'agent-adapter' ? adapterId : scope || 'runtime');
        const key = scope === 'agent-adapter' ? adapterId : scope || 'runtime';
        if (scope === 'agent-adapter') {
          const kind = adapterKind(rawState, reason);
          if (rawState && rawState === previous) break; // steady-state heartbeat: invisible.
          adapterStates.set(key, rawState);
          const existing = adapterRows.get(key);
          if (kind === 'steady') {
            // STARTING -> READY (or ERROR -> READY) resolves the in-flight
            // row; bare READY with no pending transition stays invisible.
            if (existing && (existing.state === 'running' || existing.state === 'failed')) {
              existing.state = 'success';
              existing.title = 'Orlynx AI ready';
              existing.summary = undefined;
              existing.sequence = event.sequence || existing.sequence;
              existing.rawRef = event.eventId ? `event:${event.eventId}` : existing.rawRef;
            }
            break;
          }
          if (kind === 'transitional') {
            const title = previous && adapterAttention(previous) ? 'Reconnecting AI' : 'Starting Orlynx AI';
            if (existing && existing.state === 'running') {
              existing.title = title;
              existing.sequence = event.sequence || existing.sequence;
              existing.rawRef = event.eventId ? `event:${event.eventId}` : existing.rawRef;
              break;
            }
            const item = put(event, 'agent', 'running', title, reason || undefined, {
              ...(adapterId ? { adapterId } : {}),
              ...(rawState ? { state: rawState } : {}),
            });
            adapterRows.set(key, item);
            break;
          }
          // Attention states (unavailable/auth/model/rate-limit) are actionable
          // and stay visible, coalesced into one row per adapter.
          const title = adapterAttentionTitle(rawState, reason);
          if (existing) {
            existing.state = 'failed';
            existing.title = title;
            existing.summary = friendlyFailure(reason) || existing.summary;
            existing.evidence = { ...(existing.evidence || {}), ...(adapterId ? { adapterId } : {}), ...(rawState ? { state: rawState } : {}) };
            existing.sequence = event.sequence || existing.sequence;
            existing.rawRef = event.eventId ? `event:${event.eventId}` : existing.rawRef;
            break;
          }
          const item = put(event, 'agent', 'failed', title, friendlyFailure(reason), {
            ...(adapterId ? { adapterId } : {}),
            ...(rawState ? { state: rawState } : {}),
          });
          adapterRows.set(key, item);
          break;
        }
        // Non-adapter infrastructure (bridge health, polling, transport): hidden
        // unless it carries a failure the user must act on.
        if (!/fail|error|unavailable|disconnect|offline|interrupt|expired|denied/i.test(`${rawState} ${reason}`)) break;
        if (rawState && rawState === previous) break;
        adapterStates.set(key, rawState);
        put(event, 'error', 'failed', 'Connection issue', friendlyFailure(reason) || 'The workspace connection needs attention.', {
          ...(scope ? { scope } : {}),
          ...(rawState ? { state: rawState } : {}),
        });
        break;
      }
      case 'run.queued': {
        const buildWorkspace = p.mode === 'build' && p.plane === 'workspace';
        const title = buildWorkspace ? 'Waiting to start Build task' : p.mode === 'plan' ? 'Waiting to start planning' : 'Queued';
        put(event, 'agent', 'queued', title, typeof p.position === 'number' ? `Position ${p.position} · starts automatically` : 'Starts automatically');
        break;
      }
      case 'run.started': {
        put(event, 'agent', 'running', p.plane === 'workspace' ? 'Build task started' : 'Response started',
          [str(p.mode), str(p.model)].filter(Boolean).join(' · ') || undefined,
          {
            ...(str(p.plane) ? { plane: str(p.plane) } : {}),
            ...(str(p.provider) ? { provider: str(p.provider) } : {}),
            ...(str(p.permission) ? { permission: str(p.permission) } : {}),
          });
        break;
      }
      case 'activity.started': {
        const title = humanActivity(str(p.text));
        const prior = [...rows].reverse().find((r) => r.runId === event.runId && r.category === 'agent' && r.state === 'running');
        if (prior && prior.title === title) {
          prior.sequence = event.sequence || prior.sequence;
          break;
        }
        put(event, 'agent', 'running', title, undefined,
          str(p.sourceType) ? { sourceType: str(p.sourceType) } : undefined);
        break;
      }
      case 'activity.progress': {
        const retrying = p.sourceType === 'opencode.retry';
        const title = retrying ? 'AI provider busy — retrying' : humanActivity(str(p.text));
        const summary = retrying
          ? [str(p.text), typeof p.attempt === 'number' ? `attempt ${Number(p.attempt) + 1}` : ''].filter(Boolean).join(' · ')
          : str(p.text) && humanActivity(str(p.text)) !== str(p.text).replace(/[.!…]+$/, '') ? str(p.text) : undefined;
        const evidence = {
          ...(str(p.sourceType) ? { sourceType: str(p.sourceType) } : {}),
          ...(str(p.provider) ? { provider: str(p.provider) } : {}),
          ...(typeof p.nextAt === 'number' ? { nextAt: Number(p.nextAt) } : {}),
          ...(typeof p.attempt === 'number' ? { attempt: Number(p.attempt) } : {}),
        };
        // Same-phase progress updates the in-flight row instead of opening a
        // new one every few seconds.
        const prior = [...rows].reverse().find((r) => r.runId === event.runId && r.category === 'agent' && r.state === 'running');
        if (prior && prior.title === title) {
          if (summary) prior.summary = summary;
          if (Object.keys(evidence).length) prior.evidence = { ...(prior.evidence || {}), ...evidence };
          prior.sequence = event.sequence || prior.sequence;
          break;
        }
        put(event, 'agent', 'running', title, summary, Object.keys(evidence).length ? evidence : undefined);
        break;
      }
      case 'activity.completed': {
        const current = [...rows].reverse().find((r) => r.runId === event.runId && r.category === 'agent' && r.state === 'running');
        if (current) { current.state = 'success'; current.sequence = event.sequence || current.sequence; }
        break;
      }
      case 'tool.requested': {
        const category = classifyTool(tool, command);
        const item = put(event, category, 'waiting', waitingTitle(tool, command), command ? compact(command, 120) : undefined, toolEvidence(p, tool, command));
        activeTools.set(activeKey, item);
        break;
      }
      case 'tool.started': {
        const category = classifyTool(tool, command);
        const title = titleFor(category, tool, command, str(p.title));
        const summary = command ? compact(command, 120) : pathSummary(p);
        if (previous?.state === 'waiting') {
          // requested -> started is one logical action: evolve the same row.
          previous.state = 'running';
          previous.category = category;
          previous.title = title;
          if (summary) previous.summary = summary;
          previous.evidence = toolEvidence(p, tool, command);
          previous.sequence = event.sequence || previous.sequence;
          previous.rawRef = event.eventId ? `event:${event.eventId}` : previous.rawRef;
          previous.collapsible = true;
          activeTools.set(activeKey, previous);
          break;
        }
        const item = put(event, category, 'running', title, summary,
          toolEvidence(p, tool, command));
        activeTools.set(activeKey, item);
        break;
      }
      case 'tool.output': {
        if (previous) {
          const delta = str(p.outDelta);
          if (p.replace) previous.rawOutput = delta;
          else if (delta) previous.rawOutput = `${previous.rawOutput || ''}${delta}`;
          else if (typeof p.out === 'string' || typeof p.stderr === 'string') previous.rawOutput = [str(p.out), str(p.stderr)].filter(Boolean).join('\n');
          previous.sequence = event.sequence || previous.sequence;
          previous.rawRef = event.eventId ? `event:${event.eventId}` : previous.rawRef;
          previous.collapsible = Boolean(previous.rawOutput);
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
          item.evidence = {
            ...(item.evidence || {}),
            ...toolEvidence(p, tool, command),
            ...(typeof p.exitCode === 'number' ? { exitCode: p.exitCode } : {}),
            ...(typeof p.files === 'number' ? { filesChanged: p.files } : {}),
          };
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
      case 'changes.updated': {
        const incoming = Array.isArray(p.files) ? p.files as Array<Record<string, unknown>> : [];
        const files = incoming.flatMap((file) => {
          const path = str(file.path);
          if (!path) return [];
          const action = str(file.action);
          return [{
            path,
            action: action === 'create' || action === 'delete' ? action : 'modify',
            ...(str(file.diff) ? { diff: str(file.diff) } : {}),
          }];
        });
        const runKey = event.runId || 'session';
        let item = rows.find((row) => row.key === `files:${runKey}`);
        if (!item) {
          item = put(event, 'file', 'success', 'Code changes ready');
          item.key = `files:${runKey}`;
        }
        item.state = 'success';
        item.title = 'Code changes ready';
        item.summary = `${typeof p.count === 'number' ? p.count : files.length} file${(typeof p.count === 'number' ? p.count : files.length) === 1 ? '' : 's'} changed`;
        item.evidence = files.length ? { files, ...(str(p.changeId) ? { changeId: str(p.changeId) } : {}) } : undefined;
        item.rawRef = event.eventId ? `event:${event.eventId}` : item.rawRef;
        item.sequence = event.sequence || item.sequence;
        item.collapsible = files.length > 0;
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
      case 'workspace.preparing': case 'workspace.reconnecting': {
        // Workspace startup is one coherent lifecycle: evolve a single row
        // through queued/preparing/connecting/recovery instead of a wall of
        // nearly identical cards.
        const message = str(p.message);
        const detail = message && !/^Preparing workspace/i.test(message) ? message : undefined;
        const recovering = event.type === 'workspace.reconnecting' && /fail|interrupt|could not|stale|lost|expire/i.test(message)
          || /ssh|recover|replacement|fresh codespace|fresh environment|could not establish/i.test(message);
        const title = recovering ? 'Recovering workspace'
          : event.type === 'workspace.reconnecting' ? 'Reconnecting to workspace' : 'Preparing workspace';
        const summary = recovering && !detail ? 'Starting a fresh environment…' : detail || defaultWorkspaceHint(title);
        if (workspaceRow && workspaceRow.state === 'running') {
          workspaceRow.title = title;
          if (summary) workspaceRow.summary = summary;
          workspaceRow.sequence = event.sequence || workspaceRow.sequence;
          workspaceRow.rawRef = event.eventId ? `event:${event.eventId}` : workspaceRow.rawRef;
          break;
        }
        workspaceRow = put(event, 'cloud', 'running', title, summary);
        break;
      }
      case 'workspace.ready': {
        if (workspaceRow && workspaceRow.state === 'running') {
          // Resolve the in-flight preparation row; no second "ready" card.
          workspaceRow.state = 'success';
          workspaceRow.title = 'Workspace ready';
          workspaceRow.summary = undefined;
          workspaceRow.evidence = str(p.provider) ? { provider: str(p.provider) } : workspaceRow.evidence;
          workspaceRow.sequence = event.sequence || workspaceRow.sequence;
          workspaceRow.rawRef = event.eventId ? `event:${event.eventId}` : workspaceRow.rawRef;
          workspaceRow.collapsible = Boolean(workspaceRow.evidence);
          break;
        }
        const last = rows.length ? rows[rows.length - 1] : undefined;
        if (last?.category === 'cloud' && last.state === 'success' && last.title === 'Workspace ready') break; // duplicate ready: invisible.
        workspaceRow = put(event, 'cloud', 'success', 'Workspace ready', undefined,
          str(p.provider) ? { provider: str(p.provider) } : undefined);
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
        for (const row of rows) if (row.runId === event.runId && (row.state === 'running' || row.state === 'waiting')) row.state = 'success';
        const doneKey = `completed:${event.runId || 'session'}`;
        if (event.runId && finishedRuns.has(doneKey)) break; // replayed completion: no duplicate card.
        if (event.runId) finishedRuns.add(doneKey);
        put(event, 'agent', 'success', 'Work completed', str(p.summary) || 'Ready for review');
        break;
      }
      case 'run.failed': {
        for (const row of rows) if (row.runId === event.runId && (row.state === 'running' || row.state === 'waiting')) row.state = p.cancelled ? 'cancelled' : 'failed';
        const failKey = `failed:${event.runId || 'session'}:${str(p.error || p.message).slice(0, 80)}`;
        if (event.runId && finishedRuns.has(failKey)) break; // replayed failure: no duplicate card.
        if (event.runId) finishedRuns.add(failKey);
        const failureText = str(p.error || p.message);
        const runtimeUnavailable = /OpenCode runtime.*(?:HTTP\s+(?:502|503|504)|unavailable|did not become ready|could not start)/i.test(failureText);
        const title = p.cancelled
          ? 'Work stopped'
          : runtimeUnavailable ? 'AI runtime unavailable'
          : p.errorKind === 'rate_limit' ? 'Model is busy'
          : p.errorKind === 'auth' ? 'Reconnect AI'
          : p.errorKind === 'model' ? 'Model unavailable'
          : p.errorKind === 'quota' ? 'AI quota reached'
          : 'Work needs attention';
        put(event, p.cancelled ? 'agent' : 'error', p.cancelled ? 'cancelled' : 'failed', title, friendlyFailure(failureText), {
          ...(str(p.errorKind) ? { errorKind: str(p.errorKind) } : {}),
          ...(p.recoverable ? { recoverable: true } : {}),
        });
        break;
      }
      default: break;
    }
  }
  return rows.slice(-500);
}

/** Classify an agent-adapter infrastructure state for visibility decisions. */
function adapterKind(state: string, reason: string): 'steady' | 'transitional' | 'attention' {
  const text = `${state} ${reason}`.toLowerCase();
  if (/fail|unavailable|error|auth|model|rate.?limit|quota|exceed|too many|reject|expired|forbidden|unauthor|needs.?attention|not.?available/.test(text)) return 'attention';
  if (/start|install|connect|reconnect|busy|work|load|prepar|pending|waiting|retry/.test(text)) return 'transitional';
  return 'steady';
}
function adapterAttention(state: string): boolean {
  return adapterKind(state, '') === 'attention';
}
/** User-facing wording for adapter attention states; never leaks "adapter". */
function adapterAttentionTitle(state: string, reason: string): string {
  const text = `${state} ${reason}`.toLowerCase();
  if (/auth|credential|reconnect|401|403|expired|forbidden|sign.?in/.test(text)) return 'Authentication required';
  if (/rate.?limit|too many|busy|retry|429/.test(text)) return 'Model is busy';
  if (/quota|credit|billing|payment/.test(text)) return 'AI quota reached';
  if (/model.*(unavailable|unknown|not .*available)|not .*model/.test(text)) return 'Model unavailable';
  return 'AI runtime unavailable';
}
/** Compact one-line hint for collapsed workspace rows. */
function defaultWorkspaceHint(title: string): string | undefined {
  if (title === 'Recovering workspace') return 'Starting a fresh environment…';
  if (title === 'Reconnecting to workspace') return 'Connecting…';
  return 'Starting development environment…';
}
/** Compact one-line hint for collapsed read/search rows. */
function pathSummary(p: Record<string, unknown>): string | undefined {
  const path = str(p.path);
  const title = str(p.title);
  if (path) return compact(path, 120);
  if (title) return compact(title, 120);
  return undefined;
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
function titleFor(category: ActivityCategory, tool: string, command: string, observedTitle = ''): string {
  if (category === 'test') return 'Running tests';
  if (category === 'build') return 'Building the project';
  if (category === 'search') return str(observedTitle) && !/^read|search|list$/i.test(observedTitle) ? compact(observedTitle, 88) : 'Inspecting the repository';
  if (category === 'file') return str(observedTitle) && !/^edit|write|patch$/i.test(observedTitle) ? compact(observedTitle, 88) : 'Updating files';
  if (category === 'git') return /status|log|diff|show|branch/i.test(command) ? 'Inspecting Git state' : 'Updating repository';
  if (/health|curl/i.test(command)) return 'Checking service health';
  if (command) return 'Running command';
  return observedTitle && observedTitle !== tool ? compact(observedTitle, 88)
    : tool === 'exec' || /bash|shell|command|terminal/i.test(tool) ? 'Running command' : `Working with ${tool || 'the project'}`;
}
function waitingTitle(tool: string, command: string): string {
  const text = `${tool} ${command}`;
  if (/test|vitest|jest|pytest/i.test(text)) return 'Waiting to run tests';
  if (/build|tsc|compile/i.test(text)) return 'Waiting to build the project';
  if (/git/i.test(text)) return 'Waiting to run Git command';
  if (/read|search|inspect|list/i.test(text)) return 'Waiting to inspect the repository';
  if (/patch|edit|write|file/i.test(text)) return 'Waiting to update files';
  if (command) return 'Waiting to run command';
  return 'Waiting for the previous action';
}
function friendlyFailure(raw: string): string | undefined {
  if (/OpenCode runtime.*(?:HTTP\s+(?:502|503|504)|unavailable|did not become ready|could not start)/i.test(raw)) return 'The AI runtime could not start. Your message is saved — try again.';
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

/** Chat mirrors the observable execution ledger in chronological order. */
export function chatActivities(items: ActivityItem[]): ActivityItem[] {
  return items;
}


export type ConversationTimelineEntry =
  | { kind: 'message'; key: string; timestamp: string; message: { id: string; role: string; text: string; createdAt: string } }
  | { kind: 'activity'; key: string; timestamp: string; activity: ActivityItem };

export function activityTranscriptLabel(item: ActivityItem): string {
  if (item.evidence?.sourceType === 'repository.map') return 'Repository';
  if (item.category === 'search') return /search/i.test(item.title) ? 'Search' : 'Read';
  if (item.category === 'command') return 'Run command';
  if (item.category === 'test') return 'Run tests';
  if (item.category === 'build') return 'Build';
  if (item.category === 'file') return /change|update|edit|file/i.test(item.title) ? 'Edit' : 'File';
  if (item.category === 'git') return 'Git';
  if (item.category === 'cloud') return 'Workspace';
  if (item.category === 'approval') return 'Approval';
  if (item.category === 'error') return 'Error';
  if (item.category === 'agent') {
    if (/orlynx ai|reconnecting ai|authentication|model|runtime unavailable|quota/i.test(item.title)) return 'AI';
    if (/review|inspect|plan|think|reason|working|request/i.test(item.title)) return 'Thought';
    if (/response/i.test(item.title)) return 'Response';
    return 'Status';
  }
  return 'Activity';
}

export function buildConversationTimeline(
  messages: Array<{ id: string; role: string; text: string; createdAt: string }>,
  activities: ActivityItem[],
): ConversationTimelineEntry[] {
  const messageEntries: ConversationTimelineEntry[] = messages
    .filter((message) => message.role === 'user' || message.role === 'assistant')
    .map((message) => ({
      kind: 'message',
      key: `message:${message.id}`,
      timestamp: message.createdAt,
      message,
    }));
  const activityEntries: ConversationTimelineEntry[] = activities.map((activity) => ({
    kind: 'activity',
    key: `activity:${activity.key}`,
    timestamp: activity.timestamp,
    activity,
  }));

  const weight = (entry: ConversationTimelineEntry): number => {
    if (entry.kind === 'activity') return 1;
    return entry.message.role === 'user' ? 0 : 2;
  };

  return [...messageEntries, ...activityEntries].sort((a, b) => {
    const at = Date.parse(a.timestamp || '') || 0;
    const bt = Date.parse(b.timestamp || '') || 0;
    if (at !== bt) return at - bt;
    const aw = weight(a);
    const bw = weight(b);
    if (aw !== bw) return aw - bw;
    if (a.kind === 'activity' && b.kind === 'activity') return (a.activity.sequence || 0) - (b.activity.sequence || 0);
    return a.key.localeCompare(b.key);
  });
}
