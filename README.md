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
the default and does not require credentials. GitHub repository access requires a
server-managed `GITHUB_TOKEN` in the API process environment; `.env.example`
documents the variable, but the current dev script does not auto-load `.env`.

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

The web client restores sessions, streams ordered events over SSE, and reconciles
replay by stable IDs/sequences. If the API server is configured with authorized
GitHub credentials, the repository picker can list, branch-select, clone/import,
commit, and explicitly push the imported project. There is no end-user OAuth/App
installation screen yet; credentials remain server-side. Configure `GITHUB_TOKEN`
on the API process for local GitHub access (the dev runner does not load `.env`
automatically). The native agent is a
local demonstration adapter, cloud readiness is locally simulated, preview URLs
are user-entered, and the terminal is a local shell adapter. OpenCode/Cline
process control and real Codespaces provisioning are not enabled.

## Interface system

The warm cream/brown/blue reference theme is systematized in
`apps/web/src/ui/tokens.css`; one sans family, one Orlynx outline icon set, semantic
status colors, shared spacing/radius/elevation, and mobile-safe surfaces are used
across the entry, project, repository, cloud, task, and settings screens. The
registry in `apps/web/src/ui/registry-data.json` indexes approved foundations,
activity patterns, and screen compositions.

See [`docs/orlynx-design-system.md`](docs/orlynx-design-system.md),
[`docs/orlynx-ui-architecture.md`](docs/orlynx-ui-architecture.md),
[`docs/orlynx-screen-inventory.md`](docs/orlynx-screen-inventory.md),
[`docs/orlynx-component-registry.md`](docs/orlynx-component-registry.md), and
[`docs/orlynx-responsive-behavior.md`](docs/orlynx-responsive-behavior.md) for the
full design language, feature boundaries, navigation, component reuse rules, and
responsive behavior.

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
- [Design system](docs/orlynx-design-system.md), [UI architecture](docs/orlynx-ui-architecture.md),
  [screen inventory](docs/orlynx-screen-inventory.md), [component registry](docs/orlynx-component-registry.md),
  and [responsive behavior](docs/orlynx-responsive-behavior.md).
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
