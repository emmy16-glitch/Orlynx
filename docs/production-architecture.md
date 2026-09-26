# Production architecture

Render is the primary Orlynx control plane. Workspace execution is supplied by a
provider behind the Orlynx workspace interface.

```text
Browser / PWA
    |
    v
Render Web/API
    |
    +-- authentication
    +-- direct AI chat
    +-- durable task admission
    +-- SSE event replay
    +-- authenticated bridge gateway
    |
    v
Neon Postgres
    |
    v
Workspace provider
    |
    +-- Orlynx Runner (preferred when configured)
    |      |
    |      +-- prebuilt isolated workspace
    |      +-- bridge
    |      +-- OpenCode
    |
    +-- GitHub Codespaces (fallback)
           |
           +-- bridge
           +-- OpenCode
```

## Control-plane boundary

The Render control plane owns identity-linked sessions, GitHub authorization,
workspace orchestration, task admission, event persistence/replay, encrypted
provider credentials, approvals, change sets and audit records.

Repository code execution does not run inside the Render web process.

## Execution providers

`WorkspaceProvider` is the execution boundary. The durable workspace row stores
which provider owns the environment.

- `orlynx-runner` uses a prebuilt isolated runner and can be prewarmed when the
  repository is opened.
- `github-codespaces` remains a supported fallback and recovery provider.

The browser consumes the same workspace/task state regardless of provider.

## Realtime and durability

Postgres is authoritative for tasks, commands, events and workspace state.

The authenticated bridge WebSocket is the normal low-latency transport. Commands
are written durably before direct socket delivery. Database claim/poll paths
remain recovery mechanisms for reconnects, restarts and multi-instance routing.

## Security

- Same-origin web/API requests; credentialed wildcard CORS is not used.
- GitHub install/manifest callbacks use signed, expiring, single-use state.
- Webhooks use HMAC verification and durable delivery-ID idempotency.
- GitHub credentials remain server-side and are short-lived where possible.
- Provider credentials are encrypted at rest.
- Bridge credentials are short-lived and scoped to user, session, workspace and
  connection.
- Runner workspaces are isolated containers with resource limits. A production
  runner host must never execute multiple repositories directly in one shared
  host process.
- Direct push to `main`/`master` remains denied by the bridge.
- Consequential actions are recorded in the audit log.

## Deployment truth

Render is production. Vercel configuration is legacy/fallback material only and
must not be treated as a second active production topology.

See [render-production.md](render-production.md) and
[warm-runner-architecture.md](warm-runner-architecture.md).
