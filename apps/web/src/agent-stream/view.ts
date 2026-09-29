import type { ActivityCategory, ActivityEvent, ActivityLifecycle } from '@orlynx/shared';
import type { AgentStreamActivity, AgentStreamState, AgentStreamTool } from './protocol';
import { rebuildAgentStream } from './store';

export type ActivityState = 'done' | 'active' | 'todo' | 'fail';
export interface ActivityItem extends ActivityEvent { key: string; }

const compact = (value: string, max = 120) => {
  const oneLine = String(value || '').replace(/\s+/g, ' ').trim();
  return oneLine.length > max ? `${oneLine.slice(0, max - 1)}…` : oneLine;
};

export const toState = (state: ActivityLifecycle): ActivityState => state === 'success' ? 'done'
  : state === 'running' ? 'active'
    : state === 'queued' || state === 'waiting' ? 'todo'
      : 'fail';

export function adapterKind(state: string, reason: string): 'steady' | 'transitional' | 'attention' {
  const text = `${state} ${reason}`.toLowerCase();
  if (/fail|unavailable|error|auth|model|rate.?limit|quota|exceed|too many|reject|expired|forbidden|unauthor|needs.?attention|not.?available/.test(text)) return 'attention';
  if (/start|install|connect|reconnect|busy|work|load|prepar|pending|waiting|retry/.test(text)) return 'transitional';
  return 'steady';
}

function categoryForSemanticType(value?: string): ActivityCategory | undefined {
  if (value === 'terminal') return 'command';
  if (value === 'file-change') return 'file';
  if (value === 'file-read') return 'search';
  if (value === 'test-result') return 'test';
  if (value === 'build-result') return 'build';
  if (value === 'git') return 'git';
  if (value === 'preview') return 'preview';
  if (value === 'approval') return 'approval';
  if (value === 'error') return 'error';
  if (value === 'status') return 'agent';
  return undefined;
}

function classifyTool(tool: string, command: string, semanticType?: string): ActivityCategory {
  const canonical = categoryForSemanticType(semanticType);
  if (canonical) return canonical;
  // Legacy-history fallback only. New v1 server events carry semanticType.
  const name = `${tool} ${command}`.toLowerCase();
  if (/test|vitest|jest|pytest|mocha|playwright/.test(name)) return 'test';
  if (/build|tsc|compile|webpack|vite build|next build/.test(name)) return 'build';
  if (/git|commit|push|branch|checkout|merge|rebase/.test(name)) return 'git';
  if (/search|read|inspect|list|grep|find|glob/.test(name)) return 'search';
  if (/patch|edit|write|file|apply_patch/.test(name)) return 'file';
  return 'command';
}

function commandLabel(command: string, max = 78): string {
  return compact(command.replace(/^\$\s*/, '').replace(/\s+/g, ' ').trim(), max);
}

function toolTitle(tool: AgentStreamTool, category: ActivityCategory): string {
  const command = tool.command || '';
  const path = tool.path || '';
  const explicit = tool.title && !/^(?:read|search|list|edit|write|patch|bash|shell|command|exec)$/i.test(tool.title)
    ? compact(tool.title, 88)
    : '';

  if (category === 'test') {
    return tool.state === 'success' ? 'Tests passed' : tool.state === 'failed' ? 'Tests failed' : command ? `Running ${commandLabel(command)}` : 'Running tests';
  }
  if (category === 'build') {
    return tool.state === 'success' ? 'Build passed' : tool.state === 'failed' ? 'Build failed' : command ? `Building with ${commandLabel(command)}` : 'Building the project';
  }
  if (category === 'search') {
    if (path) return `Reading ${compact(path, 82)}`;
    if (explicit) return explicit;
    if (command) return `Inspecting: ${commandLabel(command)}`;
    return 'Inspecting the repository';
  }
  if (category === 'file') {
    if (path) return `Editing ${compact(path, 82)}`;
    if (explicit) return explicit;
    return command ? `Editing via ${commandLabel(command)}` : 'Editing files';
  }
  if (category === 'git') {
    const normalized = command.toLowerCase();
    if (/git\s+status/.test(normalized)) return 'Checking Git status';
    if (/git\s+fetch/.test(normalized)) return 'Fetching origin';
    if (/git\s+pull/.test(normalized)) return 'Pulling remote changes';
    if (/git\s+diff/.test(normalized)) return 'Inspecting Git diff';
    if (/git\s+log/.test(normalized)) return 'Inspecting Git history';
    if (/git\s+show/.test(normalized)) return 'Inspecting Git commit';
    if (/git\s+commit/.test(normalized)) return tool.state === 'success' ? 'Committed changes' : 'Committing changes';
    if (/git\s+push/.test(normalized)) return tool.state === 'success' ? 'Published to GitHub' : 'Publishing to GitHub';
    if (/git\s+(checkout|switch)/.test(normalized)) return 'Switching Git branch';
    if (command) return `Git: ${commandLabel(command)}`;
    return explicit || 'Working with Git';
  }
  if (/health|curl/i.test(command)) {
    return tool.state === 'failed' ? 'Service health check failed' : tool.state === 'success' ? 'Service health check passed' : 'Checking service health';
  }
  if (explicit) return explicit;
  if (command) {
    return tool.state === 'failed'
      ? `Failed: ${commandLabel(command)}`
      : tool.state === 'success'
        ? `Ran ${commandLabel(command)}`
        : `Running ${commandLabel(command)}`;
  }
  return tool.name === 'exec' || /bash|shell|command|terminal/i.test(tool.name)
    ? 'Running command'
    : `Working with ${tool.name || 'the project'}`;
}

function activityCategory(activity: AgentStreamActivity): ActivityCategory {
  if (activity.kind === 'workspace') return 'cloud';
  if (activity.kind === 'preview') return 'preview';
  if (activity.kind === 'changes') return 'file';
  if (activity.kind === 'approval') return 'approval';
  if (activity.kind === 'error') return 'error';
  if (activity.kind === 'receipt') {
    const command = typeof activity.evidence?.command === 'string' ? activity.evidence.command : '';
    const semanticType = typeof activity.evidence?.semanticType === 'string' ? activity.evidence.semanticType : undefined;
    return classifyTool('', command, semanticType);
  }
  return activity.sourceType === 'repository.map' ? 'search' : 'agent';
}

function makeActivity(activity: AgentStreamActivity): ActivityItem {
  const category = activityCategory(activity);
  let title = activity.title;
  let summary = activity.summary;
  let evidence = activity.evidence;
  const sourceType = activity.sourceType || (typeof evidence?.sourceType === 'string' ? evidence.sourceType : '');
  if (sourceType === 'agent.dialogue.orlynx' || sourceType === 'agent.dialogue.model') {
    const raw = String(activity.title || '');
    const reflectionId = typeof evidence?.reflectionId === 'number' ? evidence.reflectionId : Number(evidence?.reflectionId || 0) || undefined;
    title = sourceType === 'agent.dialogue.orlynx' ? 'Orlynx → Model' : 'Model → Orlynx';
    summary = raw.replace(/^\s*(?:Orlynx\s*[→>-]\s*Model|Model\s*[→>-]\s*Orlynx):\s*/i, '').trim() || activity.summary;
    evidence = { ...(evidence || {}), sourceType, ...(reflectionId ? { reflectionId } : {}) };
  } else if (sourceType === 'agent.memory') {
    const raw = String(activity.title || '');
    title = 'Orlynx learned';
    summary = raw.replace(/^\s*Orlynx learned(?: from this verified recovery)?\s*[·:-]?\s*/i, '').trim() || activity.summary;
    evidence = { ...(evidence || {}), sourceType };
  }
  if (activity.kind === 'receipt') {
    const command = typeof activity.evidence?.command === 'string' ? activity.evidence.command : '';
    const counts = category === 'test' ? parseTestCounts(activity.rawOutput || '') : undefined;
    const failed = activity.state === 'failed' || (counts?.failed || 0) > 0;
    if (category === 'test') {
      title = failed ? 'Tests failed' : 'Tests passed';
      if (counts) summary = [
        counts.passed !== undefined ? `${counts.passed} passed` : '',
        counts.failed !== undefined ? `${counts.failed} failed` : '',
        counts.skipped !== undefined ? `${counts.skipped} skipped` : '',
        counts.failures?.[0] ? `Main issue: ${counts.failures[0]}` : '',
      ].filter(Boolean).join(' · ');
      evidence = { ...(evidence || {}), ...(counts || {}) };
    } else if (category === 'build') {
      title = failed ? 'Build failed' : 'Build passed';
    } else if (/health|curl/i.test(command)) {
      title = failed ? 'Service health check failed' : 'Service health check passed';
    } else if (category === 'git' && command) {
      title = /git\s+push/i.test(command) ? (failed ? 'Git publish failed' : 'Published to GitHub')
        : /git\s+commit/i.test(command) ? (failed ? 'Git commit failed' : 'Committed changes')
          : /git\s+fetch/i.test(command) ? 'Fetched origin'
            : /git\s+pull/i.test(command) ? 'Pulled remote changes'
              : `Git: ${commandLabel(command)}`;
    } else if (category === 'command' && command) {
      title = failed ? `Failed: ${commandLabel(command)}` : `Ran ${commandLabel(command)}`;
    }
  }
  return {
    key: activity.id,
    id: activity.id,
    runId: activity.runId,
    taskId: activity.taskId,
    // Presentation order is anchored to lifecycle start. Progress updates mutate
    // the same object without making the row jump around the transcript.
    sequence: activity.startedSequence,
    timestamp: activity.timestamp,
    category,
    state: activity.state,
    title,
    summary,
    evidence,
    rawOutput: activity.rawOutput,
    rawRef: `stream:${activity.id}`,
    collapsible: Boolean(evidence || activity.rawOutput),
  };
}

function makeTool(tool: AgentStreamTool): ActivityItem {
  const category = classifyTool(tool.name, tool.command || '', tool.semanticType);
  const testCounts = category === 'test' ? parseTestCounts(tool.output || '') : undefined;
  const failed = tool.state === 'failed' || (category === 'test' && (testCounts?.failed || 0) > 0);
  const state: ActivityLifecycle = failed ? 'failed' : tool.state;
  const evidence: Record<string, unknown> = {
    ...(tool.name ? { tool: tool.name } : {}),
    ...(tool.semanticType ? { semanticType: tool.semanticType } : {}),
    ...(tool.title ? { toolTitle: tool.title } : {}),
    ...(tool.command ? { command: tool.command } : {}),
    ...(tool.path ? { path: tool.path } : {}),
    ...(tool.code ? { code: tool.code } : {}),
    ...(typeof tool.exitCode === 'number' ? { exitCode: tool.exitCode } : {}),
    ...(tool.files ? { files: tool.files } : {}),
    ...(testCounts || {}),
  };
  const title = toolTitle({ ...tool, state: failed ? 'failed' : tool.state }, category);
  let summary = tool.command && !title.includes(commandLabel(tool.command, 78))
    ? compact(tool.command, 120)
    : tool.path && !title.includes(compact(tool.path, 82))
      ? compact(tool.path, 120)
      : undefined;
  if (category === 'test' && testCounts) {
    summary = [
      testCounts.passed !== undefined ? `${testCounts.passed} passed` : '',
      testCounts.failed !== undefined ? `${testCounts.failed} failed` : '',
      testCounts.skipped !== undefined ? `${testCounts.skipped} skipped` : '',
      testCounts.failures?.[0] ? `Main issue: ${testCounts.failures[0]}` : '',
    ].filter(Boolean).join(' · ');
  } else if (failed && tool.error) {
    summary = compact(tool.error, 180);
  }

  return {
    key: `tool:${tool.id}`,
    id: `tool:${tool.id}`,
    runId: tool.runId,
    taskId: tool.taskId,
    sequence: tool.startedSequence,
    timestamp: tool.timestamp,
    category,
    state,
    title,
    summary,
    evidence: Object.keys(evidence).length ? evidence : undefined,
    rawOutput: tool.output || tool.error,
    rawRef: `stream:tool:${tool.id}`,
    collapsible: Boolean(Object.keys(evidence).length || tool.output || tool.error),
  };
}

/**
 * Primary chat projection. The canonical stream store already correlated
 * lifecycle events, so this selector only converts stable semantic objects to
 * UI rows. No raw heartbeat/event switching is allowed here.
 */
export function selectActivities(state: AgentStreamState): ActivityItem[] {
  const rows = state.order.flatMap((entry) => {
    if (entry.kind === 'tool') {
      const tool = state.tools[entry.id];
      return tool ? [makeTool(tool)] : [];
    }
    const activity = state.activities[entry.id];
    return activity ? [makeActivity(activity)] : [];
  });
  return rows.sort((a, b) => {
    const seq = (a.sequence || 0) - (b.sequence || 0);
    if (seq) return seq;
    return a.key.localeCompare(b.key);
  }).slice(-500);
}

export type LiveReplyView = {
  runId: string;
  messageId: string;
  userMessageId?: string;
  text: string;
  startedAt: string;
  plane?: string;
  state: 'streaming' | 'completed' | 'failed' | 'cancelled';
};

export function selectLiveReplies(state: AgentStreamState, persistedMessages: any[] = []): LiveReplyView[] {
  const durableRunIds = new Set(
    persistedMessages
      .filter((message) => message?.role === 'assistant')
      .flatMap((message) => {
        const explicit = String(message?.runId || '');
        if (explicit) return [explicit];
        const id = String(message?.id || '');
        return id.startsWith('msg_') ? [id.slice(4)] : [];
      }),
  );
  return Object.values(state.messages)
    .filter((message) => message.text && !durableRunIds.has(message.runId))
    .sort((a, b) => Date.parse(a.startedAt) - Date.parse(b.startedAt))
    .map((message) => ({
      runId: message.runId,
      messageId: message.id,
      userMessageId: message.userMessageId,
      text: message.text,
      startedAt: message.startedAt,
      plane: message.plane,
      state: message.state,
    }));
}

/** Compatibility entry point for tests and non-streaming callers. */
export function toActivities(input: any[]): ActivityItem[] {
  return selectActivities(rebuildAgentStream(input));
}

export function chatActivities(items: ActivityItem[]): ActivityItem[] {
  return items;
}

export type ConversationTimelineEntry =
  | { kind: 'message'; key: string; timestamp: string; message: { id: string; role: string; text: string; createdAt: string } }
  | { kind: 'activity'; key: string; timestamp: string; activity: ActivityItem };

export function activityTranscriptLabel(item: ActivityItem): string {
  if (item.evidence?.sourceType === 'repository.map') return 'Repository';
  if (item.category === 'search') return 'Read';
  if (item.category === 'command') return 'Run command';
  if (item.category === 'test') return 'Run tests';
  if (item.category === 'build') return 'Build';
  if (item.category === 'file') return /change|update|edit|file/i.test(item.title) ? 'Edit' : 'File';
  if (item.category === 'git') return 'Git';
  if (item.category === 'cloud') return 'Workspace';
  if (item.category === 'approval') return 'Approval';
  if (item.category === 'error') return 'Error';
  if (item.category === 'agent') return 'Working';
  return 'Activity';
}

export function buildConversationTimeline(
  messages: Array<{ id: string; role: string; text: string; createdAt: string }>,
  activities: ActivityItem[],
): ConversationTimelineEntry[] {
  const messageEntries: ConversationTimelineEntry[] = messages
    .filter((message) => message.role === 'user' || message.role === 'assistant')
    .map((message) => ({ kind: 'message', key: `message:${message.id}`, timestamp: message.createdAt, message }));
  const activityEntries: ConversationTimelineEntry[] = activities.map((activity) => ({
    kind: 'activity',
    key: `activity:${activity.key}`,
    timestamp: activity.timestamp,
    activity,
  }));
  const weight = (entry: ConversationTimelineEntry) => entry.kind === 'activity' ? 1 : entry.message.role === 'user' ? 0 : 2;
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

export function parseTestCounts(output: string): { passed?: number; failed?: number; skipped?: number; failures?: string[] } | undefined {
  const result: { passed?: number; failed?: number; skipped?: number; failures?: string[] } = {};
  const patterns: [keyof typeof result, RegExp][] = [
    ['passed', /(?:#\s*)?(\d+)\s+(?:tests?\s+)?passed\b|\b(\d+)\s+passing\b|^#\s*pass\s+(\d+)/im],
    ['failed', /(?:#\s*)?(\d+)\s+(?:tests?\s+)?failed\b|\b(\d+)\s+failing\b|^#\s*fail\s+(\d+)/im],
    ['skipped', /(?:#\s*)?(\d+)\s+(?:tests?\s+)?skipped\b|\b(\d+)\s+pending\b|^#\s*skipped\s+(\d+)/im],
  ];
  for (const [key, pattern] of patterns) {
    const match = pattern.exec(output);
    if (!match) continue;
    const count = Number(match[1] || match[2] || match[3]);
    if (key === 'passed') result.passed = count;
    else if (key === 'failed') result.failed = count;
    else result.skipped = count;
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
