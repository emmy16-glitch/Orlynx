# Orlynx

Orlynx is a phone-first, GitHub-native AI development workspace. It keeps a task,
conversation, repository changes, approvals, and optional compute workspace in one
session. Agent/runtime events are normalized into calm, human-readable progress;
commands, test logs, and provider payloads remain available as on-demand details.

## Quick start

Requirements: Node.js 20 or newer and npm. From the repository root:

```sh
npm install
npm run dev
```

Open **http://localhost:5173/**. The Vite development server proxies `/v1` and
`/health` requests to the API on **http://localhost:4000/**. The local provider is
the default and does not require credentials. To use optional GitHub-backed
workspace behavior, copy `.env.example` to `.env` and configure `GITHUB_TOKEN`.

Useful commands:

| Command | Purpose |
| --- | --- |
| `npm run dev` | Start web and API development servers |
| `npm run dev:web` | Start only the Vite web client |
| `npm run dev:api` | Start only the API (`PORT`, default 4000) |
| `npm test` | API, event-presentation, and integration tests (integration tests use a live API when available) |
| `npm run e2e` | Run API end-to-end checks against a live API |
| `npm run build` | Type-check/build all workspaces, including shared type declarations |

Runtime session data is stored locally under `data/` (override with
`ORLYNX_DATA_DIR`). It is intentionally git-ignored.

## Product architecture

```text
apps/web       React 18 + Vite chat, changes review, files, preview, and tools
apps/api       Express API, session persistence, SSE event stream, workspaces
packages/shared Canonical session/run/event and normalized activity types
bridge         Outbound WebSocket bridge prototype
```

The web client restores the last session, streams ordered events over SSE, and
reconciles reconnect/replay with stable event IDs and per-session sequences. The
current execution engine is a local/native demonstration adapter; OpenCode, Cline,
real Codespaces, and GitHub authentication are integration seams rather than live
providers in this build. Cloud, preview, and Git operations are therefore not all
production-backed yet.

## Agent activity presentation

Runtime events are input to a single Orlynx presentation pipeline, not UI content.
`apps/web/src/ui/mapping.ts` correlates lifecycle transitions, groups related
file/command events, parses test receipts, and converts failures to understandable
messages. `AgentWorkStream` and `TaskActivityRow` render three progressive layers:

1. **Summary:** current action, outcome, counts, and attention state.
2. **Evidence:** test results, changed paths, command/exit code, and failure names.
3. **Raw output:** terminal/test output after an explicit second action.

Private model reasoning is not part of the event presentation. Stable event IDs
prevent replay duplicates; work updates batch to animation frames; the page only
auto-follows while the reader remains near the bottom and offers a new-activity
control when they scroll away. See [`docs/agent-activity-presentation.md`](docs/agent-activity-presentation.md)
for the normalized event contract, grouping rules, lifecycle, accessibility, and
performance limits.

## Documentation

- [Agent activity presentation](docs/agent-activity-presentation.md) — summaries,
  structured evidence, raw output, lifecycle, scroll, reconnect, accessibility.
- [Streaming and reconnect](docs/streaming-and-reconnect.md) — SSE envelope,
  event replay, deduplication, and recovery.
- [Chat scroll behavior](docs/chat-scroll-behavior.md) — follow mode and mobile
  viewport behavior.
- [Session lifecycle](docs/session-lifecycle.md) — restore, persistence, and
  per-session state.
- [Cloud workspace lifecycle](docs/cloud-workspace-lifecycle.md) — local/cloud
  transitions and failure handling.
- [System integration](docs/system-integration.md) — ownership and request paths.
- [Agent UI guidelines](docs/agent-ui-guidelines.md) — design and implementation
  constraints.
- [UI intelligence layer](docs/ui-intelligence-layer.md) and
  [component sources](docs/ui-component-sources.md) — UI architecture and source
  provenance.
- [End-to-end verification](docs/end-to-end-verification.md) — automated checks
  and environment/device coverage.

## Contributing and verification

Before changing UI, follow the [agent UI guidelines](docs/agent-ui-guidelines.md).
Run `npm test` and `npm run build` before submitting. When testing integration
flows, keep the API running with `npm run dev:api` or `npm run dev`; the API test
suite reports when its live integration checks are skipped.
