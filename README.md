# Orlynx

Orlynx is a phone-first, GitHub-native AI development workspace. A user connects
GitHub, opens an authorized repository, chats with Orlynx, watches real agent work,
reviews changes, and explicitly publishes them. The product keeps repository,
conversation, task, approvals, workspace and activity state in one durable session.

There is no production demo agent, fake cloud state, PAT entry flow, or silent local
fallback. When a real integration is unavailable Orlynx fails closed.

## Quick start

Requirements: Node.js 24 and npm.

```sh
npm install
npm run dev
```

Open **http://localhost:5173/**. Vite proxies `/v1` and `/health` to the API
on **http://localhost:4000/**.

Useful commands:

| Command | Purpose |
| --- | --- |
| `npm run dev` | Start web and API development servers |
| `npm run dev:web` | Start only the Vite client |
| `npm run dev:api` | Start only the API |
| `npm run typecheck` | Type-check all workspaces |
| `npm test` | Run automated tests |
| `npm run e2e` | Run API end-to-end checks against a live API |
| `npm run build` | Build all workspaces |

Pull requests and pushes to `main` run the same typecheck/test/build verification
through GitHub Actions.

## Production architecture

```text
Phone / browser
      |
      v
Orlynx control plane (Render)
      |
      +-- GitHub App / OAuth
      +-- Postgres durable sessions + events + approvals + audit
      +-- workspace orchestration
      |
      v
Render warm runner (preferred)
      |
      +-- authenticated Orlynx workspace bridge
      |    +-- PTY / Git / filesystem
      |    +-- preview-port discovery
      |    +-- OpenCode (Adapter #1)
      |    +-- future agent adapters
      |
      +-- GitHub Codespaces fallback
           (used only when runner fallback is needed)
```

### GitHub

Repository access uses the Orlynx GitHub App only. Normal users click **Connect
GitHub**, authorize/install Orlynx on GitHub, choose all or selected repositories,
and return automatically. Installation tokens stay server-side and short-lived.

The one-time owner GitHub App bootstrap can use the official App Manifest flow;
see [docs/github-app-manifest.md](docs/github-app-manifest.md).

### Durable state

When `DATABASE_URL` or `POSTGRES_URL` is configured, Postgres is authoritative
for users, GitHub connections, projects, sessions, messages, tasks, activity
events, AI session preferences, workspaces, approvals, attachments, bridge
commands, per-adapter sessions and health, change sets, webhook-delivery
receipts and audit records.

Local JSON under `data/` is only a development/test fallback. It is not accepted
as production truth on hosted deployments.

### Remote execution

Real execution prefers the prewarmed Render runner. Orlynx prepares the
repository there and connects the authenticated workspace bridge; GitHub
Codespaces remains a fallback execution provider rather than the normal startup
path. A workspace is ready only when the selected provider and authenticated
bridge are usable, and agent runtimes keep their own independent health
lifecycle.

The bridge provides the real PTY, filesystem, Git operations, command execution
and preview-port discovery regardless of the selected workspace provider. Agent
runtimes are registered behind `apps/api/src/agent-runtime.ts`. OpenCode is
Adapter #1. If OpenCode fails, workspace shell/files/Git remain available and
only OpenCode-assigned tasks are affected.

### Events, queueing and mobile recovery

User prompts are admitted to the durable task ledger before execution. Exactly one
queued task per session is atomically promoted to `running`; later prompts remain
ordered and survive API restarts. Model, mode and access policy are snapshotted on
the admitted task so changing conversation settings cannot silently change an
older queued request.

Agent/runtime events are normalized and persisted before being streamed to the
browser over SSE. Every event has a stable ID and monotonically increasing
session sequence. Reconnect requests use `?after=<sequence>` so a phone can sleep,
lose Wi-Fi, switch networks and replay missed activity without duplicates.

The browser also refreshes the authoritative session when it returns to the
foreground. localStorage is only a convenience pointer/draft cache; identity-owned
sessions can be recovered on another authenticated device.

### Safe Git publishing

The AI/provider shell never receives GitHub credentials and cannot run an
authenticated raw push. Normal change sets still support review/approval,
commit, and PR publication. When the user explicitly asks Orlynx to
`push to main` (or chooses the equivalent publish action) and the project's
access policy permits it, the control plane may authorize that one
default-branch push through the workspace bridge. The bridge rejects default
branch pushes unless that explicit control-plane approval flag is present.
Dirty or behind workspaces are rejected before publishing, and publish actions
are written to the audit log.

## Interface

The project experience is chat-first. On mobile the primary project navigation is:

```text
Chat · Files · Changes · More
```

Agent/model/mode/access controls live near the composer. The Agent picker selects
the registered coding adapter (OpenCode is Adapter #1 today) independently from
the model picker. Codespaces, bridge credentials and provider plumbing remain
implementation details rather than top-level navigation.

The conversation pipeline is a server-authoritative canonical agent protocol
projected as a thread of turns with typed message parts. Private model
reasoning is never rendered; safe process labels (`Inspecting repository`,
`Running tests`) describe work instead.

```text
provider event → AgentAdapter → canonical event → durable ledger → SSE
      → thread projection (turns owned by run IDs) → typed part renderers
```

Key modules:

| Layer | Location |
| --- | --- |
| Versioned protocol vocabulary + adapter boundary | `packages/shared/src/index.ts` (`CANONICAL_PROTOCOL_VERSION`, `EventType`, `AgentAdapterCapabilities`) |
| Server-side canonicalization + bridge semantic preservation | `apps/api/src/agent-protocol.ts`, `apps/api/src/bridge-gateway.ts` |
| Session core, queue, persistence, recovery | `apps/api/src/agents.ts`, `apps/api/src/events.ts`, `apps/api/src/storage.ts` |
| OpenCode adapter (Adapter #1) | `apps/api/src/agent-runtime.ts`, `apps/api/src/opencode*.ts` |
| Instant direct-chat lane | `apps/api/src/direct-chat.ts` |
| Browser compatibility adapter + deterministic store | `apps/web/src/agent-stream/adapter.ts`, `store.ts` |
| Thread projection + typed parts | `apps/web/src/agent-stream/thread.ts`, `parts.ts` |
| Typed tool/part renderer registry | `apps/web/src/ui/tool-parts.tsx` |
| Transcript, composer, Preview wiring | `apps/web/src/ProductionApp.tsx`, `apps/web/src/ui/preview*.tsx` |

Each user request owns a turn: user message → assistant response (streamed
live, then durable) → compact supporting work (terminal, file changes, test
results, approvals) → quiet message actions (`Copy / Retry|Resume / ⋯`).
One logical tool is one UI object that mutates in place; completed work is
static and only the current activity animates. See
[docs/canonical-agent-stream.md](docs/canonical-agent-stream.md) for the full
contract, including identity rules, replay/recovery, permissions, Stop/Cancel
semantics and the open-source patterns it draws on (AG-UI, ACP, Cline,
OpenHands, assistant-ui/tool-ui, LangGraph, Bolt-style Preview loop).

Production deployments are triggered from `main` to the connected Render web
service (Render dashboard → Orlynx production service; pushes to `main` build
and deploy through `scripts/render-build.sh`). The persistent Node process
owns HTTP, SSE and `/bridge` WebSocket traffic. The warm Render runner is the
preferred execution plane with GitHub Codespaces as fallback. Orlynx is not a
Vercel architecture: do not deploy it to Vercel or reintroduce Vercel into the
runtime path.

## Production configuration

See `.env.example` and [docs/render-production.md](docs/render-production.md).
Production requires durable storage, GitHub App configuration, credential
encryption and bridge signing. Secrets must remain server-side.

## Documentation

- [Agent protocol + conversation architecture](docs/canonical-agent-stream.md) — canonical events, adapter boundary, thread/parts/renderers, recovery
- [Render production](docs/render-production.md) — production hosting, build, environment, deploy checks
- [Production architecture](docs/production-architecture.md) — control plane, execution plane, networking
- [Warm runner architecture](docs/warm-runner-architecture.md) — preferred runner, prewarm, fallback
- [System integration](docs/system-integration.md)
- [Session lifecycle](docs/session-lifecycle.md)
- [Streaming and reconnect](docs/streaming-and-reconnect.md)
- [Chat scroll behavior](docs/chat-scroll-behavior.md)
- [Direct chat architecture](docs/direct-chat-architecture.md)
- [Workspace runtime](docs/workspace-runtime.md) / [Cloud workspace lifecycle](docs/cloud-workspace-lifecycle.md)
- [Agent engine](docs/agent-engine.md) / [Agent permissions](docs/agent-permissions.md) / [Agent UI guidelines](docs/agent-ui-guidelines.md) / [Agent activity presentation](docs/agent-activity-presentation.md)
- [GitHub App integration](docs/github-app-integration.md) / [App manifest](docs/github-app-manifest.md)
- [Design system](docs/orlynx-design-system.md) / [UI architecture](docs/orlynx-ui-architecture.md) / [Component registry](docs/orlynx-component-registry.md) / [Responsive behavior](docs/orlynx-responsive-behavior.md) / [Screens](docs/orlynx-screen-inventory.md)
- [AI connections](docs/ai-connections.md) / [Model switching](docs/model-switching.md) / [UI intelligence](docs/ui-intelligence-layer.md)
- [Secrets and environment](docs/secrets-and-environment.md)
- [End-to-end verification](docs/end-to-end-verification.md)

See [direct chat architecture](docs/direct-chat-architecture.md) for provider dependencies, model routing, authentication, streaming and production verification.
