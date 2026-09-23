# End-to-End Verification

## Automated verification

Verified for the premium activity stream update:

- `npx tsc -p apps/web/tsconfig.json --noEmit` → pass.
- `npx tsc -p apps/api/tsconfig.json --noEmit` → pass.
- `npm test` → **19/19 tests pass**: 7 activity-normalization cases, 3 guards, 4
  live API integration cases, 3 registry checks, and 2 event-presentation checks.
- `npm run build` → pass for API, web/Vite, shared declaration build, and bridge.
  Web output: 176.9 KB JavaScript (56.5 KB gzip), 11.0 KB CSS (2.9 KB gzip).
- `npm run e2e` against the local API → **ALL E2E CHECKS PASSED**: repository edit,
  changeset, commit flow, cloud setup/exec, SSE reconnect reachability, and stale
  base-SHA conflict protection.
- `git diff --check` → expected clean before commit.
- No lint or browser-automation configuration exists; typechecks, API tests, and
  runtime E2E are the automated gates.

The activity tests cover lifecycle coalescing, TAP/test counts and failure names,
file grouping/actions, duplicate replay, command timeout normalization, command /
receipt reconciliation, 150-event input, bounded history, raw detail disclosure,
and a concise accessible status surface.

## Interactive and device verification

The local Vite and API services were started and health-checked during development.
Production compilation, live API integration tests, and API E2E passed. No browser
automation runner or device emulator is configured in this environment, so manual
visual interaction checks remain outstanding for:

- user stays at bottom during a stream; user scrolls up; new-activity indicator;
- opening/closing structured evidence and raw output without a viewport jump;
- mobile keyboard open/close, 360/390/412px layouts, and screen rotation;
- screen-reader announcements with a real assistive-technology/browser pairing;
- long chat history and streamed assistant response memory/profile behavior;
- cloud reconnect presentation with a real remote provider.

The app uses page-level scroll, near-bottom follow gating, frame-batched SSE state,
bounded in-memory events/rows, bounded raw-output view height, and reduced-motion
styles. These are code-level safeguards, not a substitute for device profiling.

## Current integration limitations

GitHub OAuth/App install, real Codespaces, OpenCode/Cline process control, durable
object-backed logs, PTY terminal, preview auto-detection, and multi-device cursor
sync remain stubs or seams. The native agent currently simulates execution. API
event retention is bounded by 2,000 events per session but not by payload bytes or
independent raw-log TTL; adapters should not emit secrets or unbounded output.
