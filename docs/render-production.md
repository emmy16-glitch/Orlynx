# Render production

Render is the primary Orlynx control plane. One persistent Node web service serves
the built frontend, Express API, session SSE streams and the authenticated
`/bridge` WebSocket gateway. GitHub Codespaces remains the execution plane and
OpenCode runs inside each workspace.

## Service

Repository: `emmy16-glitch/Orlynx`  
Branch: `main`  
Runtime: Node.js 24  
Build: `npm run render:build`  
Start: `PATH="$PWD/.render-bin:$PATH" npm run start --workspace=@orlynx/api`

`scripts/render-build.sh` builds every workspace and installs a private copy of
the GitHub CLI into `.render-bin`. This is required by the local Codespaces
bootstrap path.

## Required host settings

Use the Render service's canonical HTTPS origin for the public URL:

```text
ORLYNX_PUBLIC_URL=https://orlynx.onrender.com
ORLYNX_HOSTED_PRODUCTION=1
ORLYNX_BOOTSTRAP_MODE=local
```

Production also requires the server-side values documented in `.env.example`:

- `DATABASE_URL` or `POSTGRES_URL`
- `ORLYNX_CREDENTIAL_ENCRYPTION_KEY`
- `ORLYNX_BRIDGE_SIGNING_SECRET`
- `ORLYNX_SESSION_SECRET` (recommended even though existing GitHub secrets can
  provide a fallback signing secret)
- `GITHUB_APP_ID`
- `GITHUB_APP_SLUG`
- `GITHUB_CLIENT_ID`
- `GITHUB_APP_CLIENT_SECRET`
- `GITHUB_APP_PRIVATE_KEY`
- `GITHUB_WEBHOOK_SECRET`

Do not copy a Vercel `ORLYNX_PUBLIC_URL` value into Render. Same-origin
protection, OAuth return URLs and the Codespace bridge URL all depend on this
being the Render origin.

## GitHub App URLs

The production GitHub App must allow the Render origin. Configure its public and
callback URLs consistently:

```text
Homepage:  https://orlynx.onrender.com
Callback:  https://orlynx.onrender.com/v1/github/setup
Setup URL: https://orlynx.onrender.com/v1/github/setup
Webhook:   https://orlynx.onrender.com/v1/github/webhook
```

If repository-selection updates use "Redirect on update", they should return to
the same setup URL.

## Execution provider

Render remains the web/control plane. When a separate Docker-capable runner host
is configured, set:

```text
ORLYNX_WORKSPACE_PROVIDER=auto
ORLYNX_RUNNER_URL=https://<private-runner-host>
ORLYNX_RUNNER_TOKEN=<independent secret>
ORLYNX_PREWARM_WORKSPACES=1
```

The Render web service does not need Docker privileges. It talks to the runner
manager over authenticated HTTPS. GitHub Codespaces remains the fallback
provider and still uses `ORLYNX_BOOTSTRAP_MODE=local`.

See [warm runner architecture](warm-runner-architecture.md).

## Durable chat execution

Messages are stored before agent execution. The task ledger is an ordered durable
inbox:

```text
user message
    -> durable message + queued task
    -> atomic oldest-task promotion
    -> bridge agent.run
    -> OpenCode event stream
    -> durable Orlynx events
    -> browser SSE
    -> completion/failure
    -> promote next queued task
```

Only one task can be `running` for a session. Follow-up messages remain
`queued` and survive API redeploys. The task snapshots model, mode and access
policy at admission time.

## Streaming and bridge behavior

Render keeps SSE and WebSocket connections on the persistent Node service. Orlynx
uses event-first delivery with durable replay:

- OpenCode events are primary; a slower session poll is recovery only.
- Bridge results/commands are durable and idempotent.
- Browser SSE receives in-process events immediately and checks Postgres on a
  slower recovery interval.
- SSE sequence replay fills gaps after sleep, network changes or server restarts.
- A bridge READY event attempts to resume the oldest admitted queued task.

## Verification after a deployment

A production release should show all of the following before it is treated as
healthy:

1. GitHub Actions typecheck, tests and build pass for the deployed commit.
2. Render reports the same commit as live.
3. Startup logs report that the GitHub App is configured and the API is listening.
4. `/health` is healthy and durable storage is available.
5. GitHub OAuth returns to the Render origin.
6. A Codespace reaches bridge/OpenCode ready.
7. A chat response streams live.
8. A second prompt sent during the first run is queued and starts automatically.
9. Reconnecting the browser replays events without duplicates.

## Lightweight chat dependencies

The API owns its AI SDK dependencies in `apps/api/package.json` and the root lockfile. Build with `bash scripts/render-build.sh`; do not install AI packages in `.render-ai`. The build and startup verify compiled provider imports. See [direct chat architecture](direct-chat-architecture.md) for routing, snapshots, authentication and production smoke tests.
