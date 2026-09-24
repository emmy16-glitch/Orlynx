# Vercel production deployment

## Project

- Vercel project: **orlynx** (`emmy16-glitchs-projects`), git-connected to
  `emmy16-glitch/Orlynx` (pushes to `main` auto-deploy).
- Canonical production URL: **https://orlynx.vercel.app**
- `vercel.json`: builds the Vite web app to `apps/web/dist` (served as static),
  rewrites `/v1/*` and `/health` to the `api/index.mjs` serverless function
  (the Express control plane, 60s max duration).

## What runs where

Control plane on Vercel: frontend/PWA, GitHub install/setup/webhook/status
routes, manifest bootstrap, AI provider config APIs, stateless orchestration
reads. Workspace/execution plane stays OUTSIDE Vercel (Codespace or persistent
host running OpenCode + bridge) — see `docs/workspace-runtime.md`. Preview
deployments never receive production GitHub credentials; production GitHub URLs
always use `ORLYNX_PUBLIC_URL`, never `VERCEL_URL`.

## Environment (production)

Set via `vercel env add <NAME> production` (values hidden, never in chat/logs):

`ORLYNX_PUBLIC_URL`, `GITHUB_APP_ID`, `GITHUB_APP_SLUG`, `GITHUB_CLIENT_ID`,
`GITHUB_APP_CLIENT_SECRET`, `GITHUB_PRIVATE_KEY`, `GITHUB_WEBHOOK_SECRET`,
`ORLYNX_SETUP_TOKEN` (owner bootstrap only), plus `VERCEL_TOKEN`,
`VERCEL_PROJECT_ID`, `VERCEL_TEAM_ID`, `VERCEL_PROJECT` so the manifest
callback can store generated credentials itself. Any env change requires a
production redeploy (`vercel --prod`).

## Known serverless limits (not hidden)

- Filesystem store is **ephemeral** (`/tmp`, `durable:false` in `/health`).
  Installation/session mappings work per-instance but are not durable
  multi-instance truth. Attach Postgres/KV and swap the `Store` backend before
  claiming durable multi-device production behavior.
- SSE streams are bounded by function lifetime; clients already reconnect with
  `?after=` replay cursors.
