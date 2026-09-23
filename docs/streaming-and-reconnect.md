# Streaming and Reconnect

## Envelope and ownership

SSE carries `{ eventId, sessionId, runId?, sequence, type, timestamp, payload }`.
`sequence` is monotonic per session and `eventId` is stable for an emitted receipt.
The API owns session/run truth; runtime/provider events remain inputs to the UI
projection described in [agent-activity-presentation.md](agent-activity-presentation.md).

## Live path

`GET /v1/sessions/:id/events?after=N` replays stored events after the sequence and
then pushes live events. The client (`ingest` in `apps/web/src/App.tsx`):

1. Rejects already-seen event IDs, including replayed start/output events.
2. Buffers newly received event envelopes until the next animation frame.
3. Merges and sorts by sequence, retaining the most recent 300 in memory.
4. Persists the maximum sequence in `orlynx:seq:<session-id>`.
5. Refreshes changes/messages/runs only for terminal or receipt events; workspace
   lifecycle changes refresh workspace detail.

`apps/web/src/ui/mapping.ts` normalizes these events into stable activity rows.
Progress updates reconcile into existing lifecycle rows rather than adding a new
card. Tool start and completion correlate by stable tool call ID when available.
File operations group by run/path, receipts produce structured counts/evidence,
and raw output remains behind explicit disclosure. The conversation never renders
raw low-level event objects. Text deltas are message content, not activity rows.

## State and ordering

`runState` uses run snapshots and ordered `run.*` events. A terminal event is
matched to its run ID, so a reordered `run.started` cannot override completion.
Activity lifecycle row IDs remain stable while state/title/evidence are updated.
The work stream shows a compact recent window (with access to earlier history) and
the mapper caps normalized history at 100 items.

## Reconnect

On `EventSource.onerror`, the client closes the source, displays Reconnecting, and
retries with a bounded 1s/2s/4s/8s backoff from `?after=lastSeq`. Offline state
pauses until the browser reports online (with a 3s retry check). Replayed event IDs
are ignored, and unseen events are reconciled in sequence order. The header remains
the compact connection/work status indicator; a disconnect message says the
conversation and changes are safe.

The server retains the newest 2,000 event receipts per session in its local JSON
store. The browser retains 300 events. Raw payloads are therefore bounded by event
count, not by bytes; adapters should cap output size and avoid secrets. A dedicated
blob receipt store, independent TTL, and cross-device cursor are future work.

## Rendering and scroll

SSE batches update React at most once per animation frame. The page auto-follows
only while the reader remains within 140px of the bottom; once scrolled upward it
continues receiving events silently and shows a “New activity” action. See
[chat-scroll-behavior.md](chat-scroll-behavior.md). The status live region announces
meaningful failure/completion milestones, not tokens or raw output.

## Adapter guidance

Adapters should emit unique stable event IDs, increasing session sequences, run
IDs, timestamps, and tool-call IDs for concurrent calls. Prefer structured fields
for exit code, file operations, test counts/failure names, and log references.
Never emit hidden model reasoning as user-visible activity. Use action/status
events (`search.started`, `tests.completed`, etc.) and leave interpretation to the
normalized Orlynx projection rather than coupling a UI to one provider's schema.
