// Thread model: conversation is primary, agent mechanics are subordinate.
//
//   Thread -> Turn -> { user message, assistant response (text + typed parts) }
//
// This projection reconstructs a stable turn/run relationship from IDs
// (runId / userMessageId), never from timestamp merging alone. Each run owns
// its message stream, tool calls, activities and result, so overlapping runs
// (e.g. "Fix login" + "Also explain JWT") stay visually attached to the
// request that triggered them.

import type { AgentStreamState } from './protocol';
import type { ActivityItem, LiveReplyView } from './view';

export interface PersistedChatMessage {
  id: string;
  role: string;
  text: string;
  createdAt: string;
  /** Explicit server-owned relationship. Legacy rows may still omit this. */
  runId?: string;
}

export interface ThreadTurn {
  key: string;
  runId?: string;
  userMessageId?: string;
  userMessage?: PersistedChatMessage;
  assistantMessage?: PersistedChatMessage;
  liveReply?: LiveReplyView;
  /** Work owned by this run, in lifecycle-start order. */
  work: ActivityItem[];
  state: 'streaming' | 'completed' | 'failed' | 'cancelled' | 'queued' | 'idle';
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

  const ensureTurn = (key: string, runId?: string): ThreadTurn => {
    let turn = byKey.get(key);
    if (!turn) {
      turn = { key, runId, work: [], state: 'idle' };
      byKey.set(key, turn);
      turns.push(turn);
    }
    return turn;
  };

  // 1. Durable messages own turns. New rows carry explicit runId. The
  // msg_<runId> convention remains only as a legacy-history fallback.
  const assistantByRun = new Map<string, PersistedChatMessage>();
  for (const message of messages) {
    if (message.role !== 'assistant') continue;
    const runId = message.runId || (message.id.startsWith('msg_') ? message.id.slice(4) : '');
    if (runId) assistantByRun.set(runId, message);
  }
  // User messages: each starts (or joins) a turn. Run linkage comes from the
  // stream's run.userMessageId when available.
  const userTurnKey = new Map<string, string>();
  for (const message of messages) {
    if (message.role !== 'user') continue;
    const runId = Object.values(stream.runs).find((run) => run.userMessageId === message.id)?.id;
    const key = runId ? `run:${runId}` : `user:${message.id}`;
    const turn = ensureTurn(key, runId);
    turn.userMessage = message;
    turn.userMessageId = message.id;
    userTurnKey.set(message.id, key);
  }

  // 2. Attach durable assistant messages to their run turn.
  for (const [runId, message] of assistantByRun) {
    const turn = ensureTurn(`run:${runId}`, runId);
    turn.assistantMessage = message;
    if (!turn.userMessage) {
      const run = stream.runs[runId];
      if (run?.userMessageId) {
        const user = messages.find((m) => m.id === run.userMessageId);
        if (user) {
          turn.userMessage = user;
          turn.userMessageId = user.id;
        }
      }
    }
  }

  // 3. Attach live (streaming) replies to their run turn.
  for (const reply of liveReplies) {
    const turn = ensureTurn(`run:${reply.runId}`, reply.runId);
    // Newest live text wins per run; runs never concatenate into one bubble.
    if (!turn.liveReply || reply.messageId === turn.liveReply.messageId) {
      turn.liveReply = reply;
    } else {
      // A second live message for the same run (should be rare) — keep the
      // longest stream to avoid flicker, they share one run lifecycle.
      turn.liveReply = reply.text.length >= turn.liveReply.text.length ? reply : turn.liveReply;
    }
    if (!turn.userMessage && reply.userMessageId) {
      const user = messages.find((m) => m.id === reply.userMessageId);
      if (user) {
        turn.userMessage = user;
        turn.userMessageId = user.id;
      }
    }
  }

  // 4. Attach work items to the run that owns them.
  const orphaned: ActivityItem[] = [];
  for (const item of activities) {
    const runId = runOfActivity(item);
    if (runId) {
      ensureTurn(`run:${runId}`, runId).work.push(item);
    } else {
      orphaned.push(item);
    }
  }

  // 5. Run state per turn (server-authoritative run record first, stream second).
  for (const turn of turns) {
    if (!turn.runId) {
      turn.state = turn.assistantMessage ? 'completed' : 'idle';
      continue;
    }
    const run = stream.runs[turn.runId];
    if (run) {
      turn.state = run.state === 'running' ? 'streaming' : run.state === 'queued' ? 'queued' : run.state;
    } else if (turn.liveReply) {
      turn.state = turn.liveReply.state === 'streaming' ? 'streaming' : turn.liveReply.state;
    } else if (turn.assistantMessage) {
      turn.state = 'completed';
    }
  }

  // Orphaned work (no run linkage — legacy history) attaches after the
  // nearest preceding user turn so it never floats above the conversation.
  if (orphaned.length) {
    const fallback = turns.length ? turns[turns.length - 1] : ensureTurn('legacy:orphaned');
    fallback.work.push(...orphaned);
  }

  // Stable chronological order: anchor each turn to its user message time,
  // then first work sequence. Never re-sort on every delta (no jumping rows).
  const timeOf = (turn: ThreadTurn): number => {
    if (turn.userMessage) return Date.parse(turn.userMessage.createdAt) || 0;
    const first = turn.work[0];
    return first ? Date.parse(first.timestamp) || 0 : 0;
  };
  turns.sort((a, b) => timeOf(a) - timeOf(b) || a.key.localeCompare(b.key));
  for (const turn of turns) {
    turn.work.sort((a, b) => (a.sequence || 0) - (b.sequence || 0) || a.key.localeCompare(b.key));
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
