# Streaming and Reconnect

## Envelope
`{ eventId, sessionId, runId?, sequence, type, timestamp, payload }`.
`sequence` is monotonic per session; `eventId` is globally unique.

## Live path
SSE `GET /v1/sessions/:id/events?after=N`: server first replays `history(after)`,
then pushes live emits. Client (`ingest` in `App.tsx`):
1. drops duplicates by `eventId`,
2. merges + sorts by `sequence` (out-of-order safe),
3. caps at 300, persists max sequence to `orlynx:seq:<sid>`.

State derivation (`runState`) uses the latest `run.*` by sequence and checks for a
later terminal event with the same `runId` — the UI can never show "✓ Tests passed"
followed by "● Tests running" from reordered delivery.

## Reconnect
`EventSource.onerror` → close → backoff 1s/2s/4s/8s (capped) → new `EventSource`
with `?after=lastSeq`. Header shows Reconnecting; offline (`navigator.onLine`)
shows Offline and pauses retries on a 3s poll. Refresh-triggering event types are
narrow: `changes.updated/receipt.created/run.completed/run.failed` refresh
changes+messages+runs; `workspace.*` refreshes session detail only.
