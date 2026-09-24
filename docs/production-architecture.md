# Production architecture

```text
Browser / PWA
    |
    v
https://orlynx.vercel.app
    |
    +-- Vercel web + control-plane API
    +-- Postgres durable state
    +-- GitHub App / OAuth
    |
    v
GitHub Codespace
    |
    v
authenticated Orlynx bridge
    |
    +-- OpenCode
    +-- PTY
    +-- Git/files
    +-- preview ports
```

## Boundaries

The Vercel control plane owns identity-linked sessions, GitHub authorization,
workspace orchestration, event persistence/replay, encrypted provider credentials,
approvals, change sets and audit records.

Long-running code execution does not run as an ordinary Vercel request. It runs in
the workspace execution plane.

## Security

- Same-origin web/API requests; credentialed wildcard CORS is not used.
- GitHub install/manifest callbacks use signed, expiring, single-use state.
- Webhooks use HMAC signature verification and durable delivery-ID idempotency.
- GitHub installation tokens are short-lived and server-side.
- GitHub user/provider credentials are encrypted with AES-256-GCM before durable
  storage.
- Workspace bridge credentials are short-lived HMAC tokens scoped to user,
  session, workspace and connection.
- Direct push to `main`/`master` is denied by the workspace bridge.
- Default-branch publication uses a separate `orlynx/*` branch and GitHub PR.
- Consequential actions are recorded in the audit log.

## Durability

Postgres is production truth. Local JSON, in-memory maps and localStorage may
support development/cache/convenience behavior but must not be required to recover
a production user's session.

Durable events use stable IDs and per-session sequences for replay.

## Retention

Operational cleanup currently removes webhook-delivery receipts after 30 days and
completed/failed bridge commands after 7 days. User conversation/audit retention
remains durable until a product deletion policy is explicitly implemented.

## Failure behavior

Production fails closed when GitHub, durable storage, workspace, bridge or AI
runtime is unavailable. Public UI exposes recovery actions, not operator secret
names or infrastructure setup instructions.
