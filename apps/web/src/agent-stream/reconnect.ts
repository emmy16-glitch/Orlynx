const RETRY_DELAYS_MS = [1_000, 2_000, 4_000, 8_000, 15_000] as const;

export function reconnectDelayMs(attempt: number, random = Math.random): number {
  const index = Math.max(0, Math.min(RETRY_DELAYS_MS.length - 1, Math.floor(attempt) || 0));
  const jitter = Math.max(0, Math.min(1, random()));
  return Math.round(RETRY_DELAYS_MS[index] * (0.8 + jitter * 0.4));
}

export function eventMatchesSession(event: { sessionId?: unknown } | null | undefined, sessionId: string): boolean {
  return Boolean(sessionId) && String(event?.sessionId || '') === sessionId;
}
