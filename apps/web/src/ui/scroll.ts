// Smart live-follow scrolling: pure, testable viewport-follow decisions.
// FOLLOWING_LIVE vs READING_HISTORY is user intent: only real scroll input
// changes it. Content growth (streaming tokens, new rows) never flips it.

/** Distance from the live edge that still counts as "following live". */
export const NEAR_BOTTOM_PX = 140;

/** True when the viewport is at (or near enough to) the live edge. */
export function isNearBottom(distanceFromBottom: number, threshold: number = NEAR_BOTTOM_PX): boolean {
  return distanceFromBottom < threshold;
}

/** Distance from the live edge given document/viewport geometry. */
export function distanceFromBottom(scrollHeight: number, scrollTop: number, clientHeight: number): number {
  return Math.max(0, scrollHeight - scrollTop - clientHeight);
}

/**
 * Follow state after the USER scrolls. Called only from real scroll input —
 * never from content appends — so growth while following cannot be mistaken
 * for "the user scrolled away" (§91).
 */
export function followAfterUserScroll(distance: number, threshold: number = NEAR_BOTTOM_PX): boolean {
  return isNearBottom(distance, threshold);
}

/** Follow state after new content arrives: unchanged, whatever it was. */
export function followAfterContentGrowth(wasFollowing: boolean): boolean {
  return wasFollowing;
}

const FOLLOW_WORTHY = new Set([
  'run.queued', 'run.started', 'run.completed', 'run.failed',
  'step.started', 'step.finished',
  'message.delta',
  'tool.requested', 'tool.started', 'tool.output', 'tool.completed', 'tool.failed',
  'workspace.preparing', 'workspace.ready', 'workspace.reconnecting', 'workspace.stopped',
  'changes.updated', 'branch.changed', 'file.changed',
  'activity.started', 'activity.progress', 'activity.completed',
  'approval.required', 'approval.resolved',
  'receipt.created',
]);

const HIDDEN_TELEMETRY = new Set(['message.start', 'message.end', 'state.snapshot']);

/**
 * Only user-visible content may move the viewport or raise "New activity".
 * Hidden infrastructure (heartbeats, stream markers, snapshots) never does.
 * Mirrors the visibility policy in mapping.ts without projecting full rows.
 */
export function isFollowWorthyEvent(type: string, payload?: Record<string, unknown>): boolean {
  if (HIDDEN_TELEMETRY.has(type)) return false;
  if (type === 'state.delta') {
    const p = payload || {};
    const str = (v: unknown): string => typeof v === 'string' ? v : '';
    const scope = str(p.scope);
    const raw = str(p.state);
    const reason = str(p.reason || p.error || p.message);
    if (scope === 'agent-adapter') {
      // Dynamic import would complicate the hot path; classify inline with
      // the same rules as mapping.ts adapterKind (steady = invisible).
      const text = `${raw} ${reason}`.toLowerCase();
      if (/fail|unavailable|error|auth|model|rate.?limit|quota|exceed|too many|reject|expired|forbidden|unauthor|needs.?attention|not.?available/.test(text)) return true;
      if (/start|install|connect|reconnect|busy|work|load|prepar|pending|waiting|retry/.test(text)) return true;
      return false;
    }
    return /fail|error|unavailable|disconnect|offline|interrupt|expired|denied/i.test(`${raw} ${reason}`);
  }
  return FOLLOW_WORTHY.has(type);
}

/** Reduced-motion users get an instant jump instead of a smooth one. */
export function jumpBehavior(): ScrollBehavior {
  if (typeof window !== 'undefined' && typeof window.matchMedia === 'function'
    && window.matchMedia('(prefers-reduced-motion: reduce)').matches) return 'auto';
  return 'smooth';
}
