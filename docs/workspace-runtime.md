# Workspace runtime (execution plane)

Orlynx production is split deliberately:

- Vercel is the control plane: authentication, sessions, task creation,
  approvals, durable event replay, and the WebSocket gateway.
- Postgres is product truth. Vercel `/tmp`, browser storage, and process memory
  are never authoritative in production.
- One GitHub Codespace is the execution plane for an active project. Its
  checkout is authoritative for files, Git, terminal, tests, and previews.
- OpenCode runs inside that Codespace on `127.0.0.1:4096`, protected by a random
  per-bootstrap password. It is never exposed to the browser or public network.

## Provisioning

`GitHubCodespacesProvider` uses the signed-in user's expiring GitHub App user
access token. Installation tokens remain limited to repository APIs; PATs are
not supported. The app requires `codespaces: write` and
`codespaces_lifecycle_admin: write` permissions.

Arbitrary repositories need no Orlynx devcontainer files. On Vercel, an
ephemeral Vercel Sandbox uses authenticated `gh codespace ssh` to install
OpenCode and the compiled bridge in `~/.orlynx/runtime`, then terminates. It
writes nothing into the repository and needs no additional hosting account.

The separately deployable `runtime-worker/Dockerfile` is the non-Vercel/local
alternative. Deploy it on persistent compute with:

- `ORLYNX_RUNTIME_WORKER_TOKEN` (shared only with the control plane)
- optional `PORT` (default `8080`)

Expose it only over TLS, then set its HTTPS URL and matching token on Vercel.
GitHub user tokens are transmitted only for the bootstrap request and are not
stored or logged by the worker.

## Bridge

The bridge makes an outbound WSS connection to `/bridge`. Its HMAC credential
expires in at most ten minutes and is bound to workspace, session, user, and
connection IDs. An authenticated connection receives rotating short-lived
credentials for reconnects.

Commands are durable Postgres rows. The gateway claims them, the bridge records
results to a Codespace-local idempotency journal before replying, and the
gateway persists results/events. Sent commands are redelivered after a lost
connection; completed IDs are not executed twice.

The bridge exposes typed operations, not a remote shell API: constrained test
and build commands, policy-filtered PTY input, repository-scoped files, safe Git
operations, private OpenCode requests, and port discovery. Direct pushes to
`main`/`master`, force pushes, path escape, and shell metacharacters are denied.

## Readiness

The durable lifecycle is:

`not_created → creating → starting → bootstrapping → connecting → ready → stopping → stopped`

Any stage may enter `failed`. `ready` is written only after GitHub reports the
Codespace running, the scoped bridge authenticates, and the bridge reports a
successful OpenCode health check. Codespace existence alone is not readiness.
