// Thread model: conversation is primary, agent mechanics are subordinate.
//
//   Thread -> Turn -> { user message, assistant response (text + typed parts) }
//
// This projection reconstructs a stable turn/run relationship from IDs
// (runId / userMessageId), never from timestamp merging alone. Each run owns
// its message stream, tool calls, activities and result, so overlapping runs
// (e.g. "Fix login" + "Also explain JWT") stay visually attached to the
// request that triggered them.

import type { AgentStreamState, AgentStreamTextSegment } from './protocol';
import type { ActivityItem, LiveReplyView } from './view';

export interface PersistedChatMessage {
  id: string;
  role: string;
  text: string;
  createdAt: string;
  /** Explicit server-owned relationship. Legacy rows may still omit this. */
  runId?: string;
}

export type ThreadTimelineEntry =
  | { kind: 'text'; key: string; sequence: number; segment: AgentStreamTextSegment }
  | { kind: 'activity'; key: string; sequence: number; activity: ActivityItem };

export interface ThreadTurn {
  key: string;
  runId?: string;
  userMessageId?: string;
  userMessage?: PersistedChatMessage;
  /** All user messages explicitly attached to this run, including live follow-ups. */
  userMessages: PersistedChatMessage[];
  assistantMessage?: PersistedChatMessage;
  liveReply?: LiveReplyView;
  /** Work owned by this run, in lifecycle-start order. */
  work: ActivityItem[];
  /** Model text parts retained separately so narration can sit beside the work it introduced. */
  textSegments: AgentStreamTextSegment[];
  /** One chronological assistant surface: text segments + typed work. */
  timeline: ThreadTimelineEntry[];
  state: 'streaming' | 'completed' | 'failed' | 'cancelled' | 'queued' | 'waiting_input' | 'waiting_approval' | 'paused' | 'interrupted' | 'idle';
}

function runOfActivity(item: ActivityItem): string | undefined {
  return item.runId;
}

export function buildThread(
  messages: PersistedChatMessage[],
  activities: ActivityItem[],
  liveReplies: LiveReplyView[],
  stream: AgentStreamState,
): ThreadTurn[] {
  const turns: ThreadTurn[] = [];
  const byKey = new Map<string, ThreadTurn>();
  const turnsByRun = new Map<string, ThreadTurn[]>();
  const turnByUserMessage = new Map<string, ThreadTurn>();

  const ensureTurn = (key: string, runId?: string): ThreadTurn => {
    let turn = byKey.get(key);
    if (!turn) {
      turn = { key, runId, userMessages: [], work: [], textSegments: [], timeline: [], state: 'idle' };
      byKey.set(key, turn);
      turns.push(turn);
    }
    return turn;
  };

  const messageTime = (message?: PersistedChatMessage): number => {
    const value = message ? Date.parse(message.createdAt) : Number.NaN;
    return Number.isFinite(value) ? value : 0;
  };

  const registerRunTurn = (runId: string, turn: ThreadTurn) => {
    const list = turnsByRun.get(runId) || [];
    if (!list.some((item) => item.key === turn.key)) {
      list.push(turn);
      list.sort((a, b) => messageTime(a.userMessage) - messageTime(b.userMessage) || a.key.localeCompare(b.key));
      turnsByRun.set(runId, list);
    }
  };

  const turnForRunAt = (runId: string, timestamp?: string): ThreadTurn => {
    const existing = turnsByRun.get(runId) || [];
    if (!existing.length) {
      const fallback = ensureTurn(`run:${runId}`, runId);
      registerRunTurn(runId, fallback);
      return fallback;
    }

    const ordered = [...existing].sort((a, b) => messageTime(a.userMessage) - messageTime(b.userMessage) || a.key.localeCompare(b.key));
    const eventTime = timestamp ? Date.parse(timestamp) : Number.NaN;
    if (!Number.isFinite(eventTime)) return ordered[ordered.length - 1];

    // Keep work below the user message that was current when that work
    // happened. This prevents a later same-run follow-up from jumping above
    // already-rendered tool output while the run is still streaming.
    let candidate = ordered[0];
    for (const turn of ordered) {
      if (messageTime(turn.userMessage) <= eventTime) candidate = turn;
      else break;
    }
    return candidate;
  };

  const runByInitialMessage = new Map<string, string>();
  for (const run of Object.values(stream.runs)) {
    if (run.userMessageId) runByInitialMessage.set(run.userMessageId, run.id);
  }

  // Every human message is its own visual turn, even when several messages
  // intentionally steer the same execution run. Execution identity and visual
  // chronology are related but not the same thing.
  for (const message of messages) {
    if (message.role !== 'user') continue;
    const runId = message.runId || runByInitialMessage.get(message.id);
    const turn = ensureTurn(`user:${message.id}`, runId);
    turn.userMessage = message;
    turn.userMessageId = message.id;
    turn.userMessages = [message];
    turnByUserMessage.set(message.id, turn);
    if (runId) registerRunTurn(runId, turn);
  }

  // Durable assistant messages finish the latest visual segment of their run.
  // The msg_<runId> convention remains only as a legacy-history fallback.
  for (const message of messages) {
    if (message.role !== 'assistant') continue;
    const runId = message.runId || (message.id.startsWith('msg_') ? message.id.slice(4) : '');
    if (!runId) {
      ensureTurn(`assistant:${message.id}`).assistantMessage = message;
      continue;
    }
    const turn = turnForRunAt(runId, message.createdAt);
    turn.assistantMessage = message;
  }

  // Live text belongs to the newest human message in the same run. As a user
  // steers an active task, the response continues beneath that new message
  // instead of remaining attached to the first prompt and later reshuffling.
  for (const reply of liveReplies) {
    const exact = reply.userMessageId ? turnByUserMessage.get(reply.userMessageId) : undefined;
    const hasRunTurns = (turnsByRun.get(reply.runId) || []).length > 0;
    const turn = hasRunTurns ? turnForRunAt(reply.runId) : exact || turnForRunAt(reply.runId);
    if (!hasRunTurns && exact) {
      exact.runId = reply.runId;
      registerRunTurn(reply.runId, exact);
    }
    turn.liveReply = reply;
    if (!turn.userMessage && reply.userMessageId) {
      const user = messages.find((message) => message.id === reply.userMessageId && message.role === 'user');
      if (user) {
        turn.userMessage = user;
        turn.userMessageId = user.id;
        turn.userMessages = [user];
      }
    }
  }

  // Preserve provider text-part boundaries. OpenCode emits stable messagePartId
  // values, so narration before and after a tool call remains independently
  // placeable in the transcript. Direct providers without part IDs still
  // produce one continuous segment, which is the correct fallback.
  for (const segment of Object.values(stream.segments)) {
    if (!segment.runId || !segment.text) continue;
    turnForRunAt(segment.runId, segment.timestamp).textSegments.push(segment);
  }

  // Tool/activity work is placed according to when it occurred, not simply
  // under the first prompt that owns the execution run.
  const orphaned: ActivityItem[] = [];
  for (const item of activities) {
    const runId = runOfActivity(item);
    if (runId) turnForRunAt(runId, item.timestamp).work.push(item);
    else orphaned.push(item);
  }

  // Legacy work without run identity goes under the nearest preceding human
  // message. It must never float above later conversation content.
  for (const item of orphaned) {
    const eventTime = Date.parse(item.timestamp);
    const candidates = turns
      .filter((turn) => turn.userMessage && (!Number.isFinite(eventTime) || messageTime(turn.userMessage) <= eventTime))
      .sort((a, b) => messageTime(a.userMessage) - messageTime(b.userMessage));
    const target = candidates[candidates.length - 1] || turns[turns.length - 1] || ensureTurn('legacy:orphaned');
    target.work.push(item);
  }

  // Only the newest visual segment of a shared execution run is live. Earlier
  // segments remain stable while the backend continues the same task.
  for (const [runId, group] of turnsByRun) {
    const ordered = [...group].sort((a, b) => messageTime(a.userMessage) - messageTime(b.userMessage) || a.key.localeCompare(b.key));
    const latest = ordered[ordered.length - 1];
    const run = stream.runs[runId];
    for (const turn of ordered) {
      if (turn !== latest) {
        turn.state = 'completed';
        continue;
      }
      if (run) {
        turn.state = run.state === 'running' ? 'streaming' : run.state === 'queued' ? 'queued' : run.state;
      } else if (turn.liveReply) {
        turn.state = turn.liveReply.state === 'streaming' ? 'streaming' : turn.liveReply.state;
      } else if (turn.assistantMessage) {
        turn.state = 'completed';
      }
    }
  }

  for (const turn of turns) {
    if (turn.runId) continue;
    turn.state = turn.assistantMessage ? 'completed' : 'idle';
  }

  const timeOf = (turn: ThreadTurn): number => {
    if (turn.userMessage) return messageTime(turn.userMessage);
    if (turn.assistantMessage) return messageTime(turn.assistantMessage);
    const first = turn.work[0];
    return first ? Date.parse(first.timestamp) || 0 : 0;
  };

  // Keys and original message timestamps are stable, so streaming deltas mutate
  // existing rows rather than causing the transcript to reorganize at finish.
  turns.sort((a, b) => timeOf(a) - timeOf(b) || a.key.localeCompare(b.key));
  for (const turn of turns) {
    turn.work.sort((a, b) => (a.sequence || 0) - (b.sequence || 0) || a.key.localeCompare(b.key));
    turn.textSegments.sort((a, b) => a.startedSequence - b.startedSequence || a.id.localeCompare(b.id));
    turn.timeline = [
      ...turn.work.map((activity) => ({
        kind: 'activity' as const,
        key: `activity:${activity.key}`,
        sequence: activity.sequence || 0,
        activity,
      })),
      ...turn.textSegments.map((segment) => ({
        kind: 'text' as const,
        key: `text:${segment.id}`,
        sequence: segment.startedSequence,
        segment,
      })),
    ].sort((a, b) => a.sequence - b.sequence || a.key.localeCompare(b.key));
  }
  return turns;
}

/** The single "current work" item for live indicators: latest running/waiting part in the latest active turn. */
export function currentTurnWork(turns: ThreadTurn[]): ActivityItem | undefined {
  for (let i = turns.length - 1; i >= 0; i--) {
    const running = [...turns[i].work].reverse().find((item) => item.state === 'running' || item.state === 'waiting');
    if (running) return running;
    if (turns[i].state === 'streaming' || turns[i].state === 'queued') {
      const last = turns[i].work[turns[i].work.length - 1];
      if (last) return last;
    }
  }
  return undefined;
}
