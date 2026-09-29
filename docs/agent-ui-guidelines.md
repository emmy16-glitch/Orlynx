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
- Investigation dialogue is ordered and bounded;
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

Keep touch targets accessible, focus states visible, state understandable without color, and reduced motion respected.

## Verification

Run supported typecheck/tests/build after changes and add regression tests for any modified architecture contract.
