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
Orlynx control plane (Vercel)
      |
      +-- GitHub App / OAuth
      +-- Postgres durable sessions + events + approvals + audit
      +-- workspace orchestration
      |
      v
GitHub Codespace
      |
      v
authenticated Orlynx workspace bridge
      |
      +-- OpenCode
      +-- PTY
      +-- Git
      +-- filesystem
      +-- preview ports
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
commands, engine-session mappings, change sets, webhook-delivery receipts and
audit records.

Local JSON under `data/` is only a development/test fallback. It is not accepted
as production truth on Vercel.

### Remote execution

Real execution happens in a GitHub Codespace. Orlynx provisions it with the user's
GitHub authorization, bootstraps the workspace bridge, starts OpenCode, and marks
the workspace ready only after the authenticated bridge and OpenCode are healthy.

The bridge provides the real PTY, filesystem, Git operations, command execution,
preview-port discovery and OpenCode RPC. OpenCode is the first production agent
runtime; `apps/api/src/agent-runtime.ts` keeps orchestration behind an adapter
boundary for future real runtimes.

### Events and mobile recovery

Agent/runtime events are normalized and persisted before being streamed to the
browser over SSE. Every event has a stable ID and monotonically increasing
session sequence. Reconnect requests use `?after=<sequence>` so a phone can sleep,
lose Wi-Fi, switch networks and replay missed activity without duplicates.

The browser also refreshes the authoritative session when it returns to the
foreground. localStorage is only a convenience pointer/draft cache; identity-owned
sessions can be recovered on another authenticated device.

### Safe Git publishing

Changes require review/approval before commit or publish. The workspace bridge
refuses direct pushes to `main` or `master`. Default-branch publication creates
an isolated `orlynx/*` branch, pushes it, and opens a real GitHub pull request.
Important workspace/approval/commit/publish actions are written to the audit log.

## Interface

The project experience is chat-first. On mobile the primary project navigation is:

```text
Chat · Files · Changes · More
```

AI model/mode/access controls live near the composer. OpenCode, Codespaces, bridge
credentials and provider plumbing are implementation details and should not become
top-level user navigation.

The event presentation pipeline in `apps/web/src/ui/mapping.ts` turns low-level
runtime output into summary → evidence → raw detail. Private model reasoning is not
rendered.

Production deployments are triggered from the `main` branch through the connected Vercel project.

## Production configuration

See `.env.example` and [docs/vercel-production.md](docs/vercel-production.md).
Production requires durable storage, GitHub App configuration, credential
encryption and bridge signing. Secrets must remain server-side.

## Documentation

- [System integration](docs/system-integration.md)
- [Session lifecycle](docs/session-lifecycle.md)
- [Streaming and reconnect](docs/streaming-and-reconnect.md)
- [Workspace runtime](docs/workspace-runtime.md)
- [GitHub App integration](docs/github-app-integration.md)
- [GitHub App manifest](docs/github-app-manifest.md)
- [Agent activity presentation](docs/agent-activity-presentation.md)
- [Design system](docs/orlynx-design-system.md)
- [UI architecture](docs/orlynx-ui-architecture.md)
- [Responsive behavior](docs/orlynx-responsive-behavior.md)
- [End-to-end verification](docs/end-to-end-verification.md)
