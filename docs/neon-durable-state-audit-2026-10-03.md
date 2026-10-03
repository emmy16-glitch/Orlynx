# Neon durable-state audit — 2026-10-03

Baseline main: `c432fb3229ed86bfafaf83177aa391d933ed9861`.

The owner supplied project `weathered-scene-87680743`, organization `org-aged-pond-53339226` and branch `br-patient-paper-awwazvd0`. The connected Neon API confirmed the branch is named `production`, ready, primary and default. Organization ownership was supplied by the owner rather than independently inspected.

Read-only production inspection found 28 tasks: 12 completed, 15 failed and one cancelled. No queued, running, waiting-input or waiting-approval tasks existed in this snapshot. All 18 workspace jobs were completed. The completed tasks had passed verification and no missing requirements. Event cursors matched persisted maximum sequence numbers, and there were no duplicate session/sequence groups. No production observation rows or active expired adapter-transition leases existed.

Two Codespaces workspaces were disconnected. Persisted OpenCode health was ready but old; portable adapters retained provider_auth rejection state. Stored ready state alone does not establish current readiness, and the existing adapter policy excludes timestamps older than 90 seconds. Credential source and authenticated task execution remain unverified.

## Confirmed defect

Four bridge commands were expired but still queued/sent since about 01:38 UTC: two `opencode.request` commands and two `ports.list` commands. The database contained 6,610 command rows. Expiration only ran inside `claimCommands`, which requires a connected authenticated bridge poll. A permanently disconnected workspace therefore retained stale active command state indefinitely.

The repair adds a bounded global expiration pass to the durable orchestrator's recovery sweep, while retaining workspace-scoped expiration during delivery. Row locking with SKIP LOCKED permits concurrent sweep/delivery workers. At most 1,000 expired commands are updated per pass. Terminal results are preserved. Expired commands become failed with an unknown execution outcome and a reconciliation-required marker; they are never requeued or replayed. This does not claim whether a command ran before its result was lost.

The executable PostgreSQL regression exercises disconnected expiry, bounded batches, workspace scoping, global cleanup, future deadlines, terminal result preservation, late result rejection, idempotent sweeps and prevention of mutating-command replay. Production data was not manually modified with ad hoc SQL. Deployment and production reconciliation evidence will be recorded after the verified batch is merged.

No schema migration, database branch creation, resource deletion, secret retrieval or credential change is part of this batch. Production authentication failures and historical failed-task causes require separate investigation. This snapshot does not establish a sustained soak, database outage recovery or end-to-end publication behavior.
