# Agent Activity Presentation

Orlynx accepts low-level runtime activity as input and presents users with
meaningful progress, evidence, and next actions. The primary conversation is not a
terminal transcript. Raw provider events are normalized in the existing event
stream and displayed progressively through `AgentWorkStream` and
`TaskActivityRow`.

## Experience contract

The default work stream answers: **What is happening? What changed? Did it work?
Does it need me?** A user may drill down when they need proof or diagnostics:

1. **Human summary:** e.g. “Running API tests”, “4 integration tests failed”,
   “Updated 3 files”, “API health check could not connect”.
2. **Structured code/execution evidence:** command, path, changed files, bounded
   edit snippets/final diffs, counts, exit code, and user-facing error context.
   The user can choose **Summary** (evidence on demand) or **Code** (evidence
   opened automatically). The browser remembers that choice; Build defaults to
   Code when no preference exists.
3. **Raw output:** stdout/stderr, stack fragments, and test transcript remain a
   separate explicit disclosure even in Code mode, shown in a bounded,
   independently scrollable region.

Provider tool names and payload shapes are not rendered as chat content. Message
deltas are conversation text, not activity cards. Private chain-of-thought is never
included; the stream describes observable actions only.

## Normalized event model

`packages/shared/src/index.ts` owns the UI-facing `ActivityEvent` contract. A
provider's event shape remains in the canonical `OrlynxEvent` envelope and is
projected by `apps/web/src/ui/mapping.ts`:

```ts
type ActivityEvent = {
  id: string;
  runId?: string;
  taskId?: string;
  sequence: number;
  timestamp: string;
  category: 'agent' | 'search' | 'file' | 'command' | 'test' | 'build' |
    'git' | 'cloud' | 'preview' | 'approval' | 'error';
  state: 'queued' | 'running' | 'success' | 'failed' | 'waiting' | 'cancelled';
  title: string;
  summary?: string;
  evidence?: Record<string, unknown>;
  rawRef?: string;
  rawOutput?: string;
  collapsible?: boolean;
};
```

`rawRef` identifies the source event receipt; the client retains raw output only as
part of the session's bounded event window. `evidence` contains small structured
metadata, not an unbounded terminal transcript. The UI model is a projection and
does not change the session/run truth owned by the API.

### Runtime mapping

| Runtime input | Normalized presentation |
| --- | --- |
| `run.started`, `activity.started`, `activity.progress` | One stable run action row; later observable progress updates that row. Reasoning-like wording is translated to action-oriented copy. |
| `tool.started` → completed/failed/output | One correlated tool activity (call ID where supplied, otherwise run/tool identity); observable command/path/edit input is retained in bounded evidence while command, test, build, search, file, and Git actions receive product language. |
| `receipt.created` | Command/test/build/health-check result, exit status, parsed counts and failure names, with raw receipt behind details. |
| `changes.updated` / repeated `file.changed` | One code-change row with deduplicated paths and create/modify/delete evidence; workspace results may include bounded exact diff snippets while the complete reviewable diff stays in Changes. |
| workspace lifecycle | Preparing/reconnecting/ready/stopped language; provider and port mechanics stay hidden. |
| approval lifecycle | A waiting-for-approval summary, resolved in place when available. |
| `run.completed` / `run.failed` | Closes running rows for that run and presents completion, cancellation, or attention state. |
| message deltas, state snapshots | Not activity rows; chat text and session state have their own UI. |

Every input with a stable event ID is deduplicated before mapping; events are
sequence-sorted. Lifecycle rows keep stable IDs while their state/title changes.
History is bounded to the latest 100 normalized rows by the mapper; the normal
view shows a compact recent window, and older rows are available on demand.

## Grouping and summaries

- A run's initial activity and subsequent progress update the same agent row.
- Tool start/finish events correlate by `toolCallId`/`callId` when provided. For
  legacy adapters, the current run + tool name is the fallback correlation key.
- File changes deduplicate by path and collect action metadata. They never produce
  a line per event in the main stream.
- Test output parsing recognizes common `passed`/`failed`/`skipped` summaries,
  Mocha-style counts, and Node TAP counters. Named failing cases are surfaced as
  evidence when the adapter output includes recognizable failure markers.
- Raw test/command output is not used as the title or summary. Known timeouts and
  connection-refused checks receive human-readable explanations, with original
  diagnostic text kept behind “Show raw output”.
- Duplicate replay does not create a second card. Repeated, distinct invocations
  remain distinct when the adapter supplies a call ID or event identity.

When an adapter does not provide a tool-call ID, same-name concurrent tool calls
in one run cannot always be correlated perfectly. Providers should supply stable
call IDs and structured receipts for the best reconciliation.

## Activity lifecycle and current status

`LiveActivityPill` provides a compact status in the sticky header: Idle, Working,
Waiting for you, Waiting for approval, Paused, Reconnecting, Completed, or Failed.
It can be opened to see the current action. Stop is available while a run is active.
Exactly one latest in-progress/waiting row is emphasized as the current step;
older activity remains visible but visually quieter. Completed history is muted and
bounded. Work does not expose internal “thinking” events.

Meaningful milestones use a polite, atomic screen-reader status: failure, test or
build completion, and terminal work state. Individual tokens, raw log lines, and
routine progress events are not announced. Buttons have labels and expanded-state
semantics; details remain reachable by keyboard. Color is paired with text/icons.
Motion is restrained and honors `prefers-reduced-motion`.

## Scroll, mobile, and long sessions

The conversation scrolls with the page instead of a nested terminal container.
When the reader is within 140px of the bottom, incoming activity is batched to an
animation frame and the page may follow the new bottom. Once the reader scrolls up,
follow mode stops and a “New activity” action appears. Tapping it smoothly returns
to the latest content. Expanding evidence does not install a separate page-level
scroll area; only an explicitly opened raw-output block scrolls independently.

The sticky header status wraps on narrow screens, keeps the composer/tabs usable,
and does not float over the composer. Output blocks have a viewport-bounded height,
word wrapping, and independent intentional scrolling. The browser retains native
keyboard and orientation resize behavior; no scroll-to-bottom is triggered by
visual viewport changes. WebView/device validation is still required to confirm
keyboard behavior on target hardware.

## Reconnect and deduplication

SSE replay uses a monotonic per-session sequence (`?after=N`) and each event has a
stable `eventId`. The client filters seen IDs, orders events by sequence, batches
state updates to one animation frame, and caps the in-memory raw event window at
300. The mapper applies a second ID-deduplication guard and reconciles transitions
in place. Reconnect therefore replays missed work without creating duplicate
visible activity. See [streaming-and-reconnect.md](streaming-and-reconnect.md).

## Raw output retention and security

Raw output lives in event receipts, not in chat message text. A receipt is rendered
as a reference plus concise evidence by default. The API currently persists its
event ledger to the local JSON store and retains the newest 2,000 events per
session; the web client keeps at most 300 runtime events and the normalized
presentation at most 100 rows. Individual output payloads are not yet stored in a
separate blob/log service or expired independently, so adapters should avoid
putting secrets or excessively large transcripts in event payloads. Future durable
providers should use a bounded raw-log store and expose authorized receipt
references while retaining this presentation contract.

## Verification and performance considerations

Automated coverage in `apps/api/test/activity-presentation.test.js` exercises
progress lifecycle coalescing, TAP/test count parsing, failure evidence, file
grouping, event replay deduplication, timeout translation, output references, and
100+ activity events. `ui-intelligence.test.js` protects grouping and component
registry conventions. Build/typecheck validates the shared contract and React
components.

The event input is capped, batches are flushed once per animation frame, mapper
output is bounded, and raw output appears only when requested. The UI uses no
per-token terminal renderer or virtualization dependency. Browser profiling for
very long streamed assistant messages, memory over multi-hour sessions, device
rotation, and keyboard interactions remains a manual/device validation item.

### Example normalized failure and recovery

```text
● Working — Verifying the API
✕ Tests failed — 22 passed · 4 failed
  [View results] → [Show raw output]
● Updating files
✕ API health check failed — The service health check could not connect.
  [View details] → [Show raw output]
✓ API restarted
● Running tests
✓ Tests passed — 26 passed · 0 failed
✓ Ready for review
```

Summary mode keeps commands and implementation evidence one action away. Code
mode reveals observable commands, paths, edit snippets and final diff evidence
inline while preserving raw diagnostics as a separate explicit action.
