# Agent permissions

## Profiles

- **Build** mode + **Full access** — independent work inside the current
  project: read/edit/create/delete project files, terminal, tests, builds, dev
  servers, dependency installs, workspace use.
- **Ask first** (default) — same abilities, but terminal commands require an
  explicit approval (`409 approval-required` → Approve & run). Commit/push
  always require review approval regardless of profile.
- **Read only** (also the **Ask** mode guardrail) — inspect/explain only.
  Enforced at the API boundary: terminal, commit and push return `403`, and the
  task carries a read-only instruction to the engine.

“Full access” is scoped to the current Orlynx project. Always blocked, even
with full access: destructive patterns (`rm -rf /`, `mkfs`, fork bombs,
`dd … of=/dev/…`), destructive cloud/account operations (cloud is fail-closed),
and anything outside the imported repository (path-escape checks, GitHub
installation scoping).

## Temporary elevation

“Allow full access for this task” sets `tempPermission: 'full'` on that run
only. `canPerform()` honors it while the run is `running`; completion,
failure or cancellation expires it automatically, and the stored default never
changes.

## Enforcement

`canPerform(sessionId, action)` in `apps/api/src/ai.ts` is the single
authorization point for `terminal.exec`, `git.commit`, `git.push`,
`agent.task`, `cloud.action`. The UI is not a security boundary — every
mutation route re-checks. Approval-required terminal runs emit
`approval.required` events; consequential Git actions reuse the existing
approve → commit → push review chain.
