# Agent UI guidelines

## Core rule

The Orlynx conversation is the product surface. Infrastructure exists to support it.

## Reuse before invention

Before adding UI:

1. inspect current Orlynx primitives/product components;
2. inspect the component registry;
3. extend an existing pattern where possible;
4. add a new primitive only when the product actually needs a new interaction concept.

Do not create duplicate Button/Modal/Card/Toast/Loader/Badge/Tabs patterns.

## Canonical activity path

New runtime work must flow through:

~~~text
provider / bridge
→ canonical Orlynx event
→ durable event ledger
→ browser agent-stream store
→ thread projection
→ typed parts
→ part renderer
~~~

Do not bypass this with a second raw-event UI.

## Conversation rules

- natural follow-ups remain in the same active turn;
- explicit queued work is visibly separate;
- queued and active work are not conflated;
- Investigation dialogue is one stable live object per run segment and remains strictly ordered by event sequence;
- private hidden chain-of-thought is never shown;
- completed work becomes visually quiet;
- only current work animates.

## Status language

Describe user capabilities, not infrastructure SKUs.

Prefer:

- Preparing workspace
- Reconnecting
- AI runtime unavailable
- Repairing AI runtime
- Preview unavailable
- Waiting for approval

Only expose provider details when they help diagnose an actual problem.

## Failure isolation

Do not show “workspace failed” when only the OpenCode adapter failed.

Do not show “model unavailable” when the problem is GitHub/bridge/Preview.

UI copy must preserve subsystem boundaries.

## Mobile

Verify at 360/390/412px plus desktop.

Queue controls, Investigation blocks, composer, approvals, changes and Preview must remain usable with keyboard open.

Investigation content must use the page's normal scroll; do not add a nested overflow region that can capture mobile swipe gestures.

## Scrolling

Follow live output only while the reader remains near the bottom.

Never pull a user away from history they intentionally scrolled to read.

## Evidence

Default view: concise action + outcome.

First expansion: structured evidence.

Raw output: explicit bounded disclosure.

Do not dump provider payloads directly into chat.

## Design

Use semantic tokens and the existing Orlynx visual system.

Use one primary UI typeface consistently across navigation, headings, chat, controls and Investigation dialogue. Monospace is reserved for code, commands, paths and terminal output.

Keep touch targets accessible, focus states visible, state understandable without color, and reduced motion respected.

## Verification

Run supported typecheck/tests/build after changes and add regression tests for any modified architecture contract.

## Live-stream ordering contract

The conversation must preserve human-first chronology even when the backend admits work faster than the browser can paint:

1. the user's submitted message is rendered synchronously;
2. only after that paint boundary may task admission begin;
3. run/workspace/tool/model stream events render beneath that user turn;
4. reconnect/replay must preserve the same ordering and stable identities.

An Orlynx ↔ Model Investigation is one durable run-scoped UI object, not a stack of temporary cards. It should show the public diagnostic loop in order:

- Orlynx question;
- model hypothesis;
- model evidence summary;
- next discriminating check;
- observed tool evidence;
- final verified outcome or concrete block reason.

The model-facing diagnostic is a public evidence summary, not hidden chain-of-thought.

Long-running silent work must remain visibly alive. Liveness notices may update the current activity row, but they must never count as provider progress or reset a stuck-task watchdog.

## Files and Changes

`Files` is the repository browser. `Changes` is the persistent review surface.

While a task is actively editing, canonical file/change events may appear immediately under a Live change set. Once Orlynx persists the verified change set, that same work moves naturally into the durable Changes history. The UI must not double-count a live projection and its durable replacement.

Chat should keep file activity compact; full paths, line statistics and exact diffs belong in Changes.
