# Legacy Vercel deployment

> Render is the primary production control plane. This document is retained only for legacy/fallback Vercel deployments. The current production topology and required host settings are in [render-production.md](render-production.md).

The `orlynx` Vercel project serves the frontend and control-plane functions.
`/v1/*` and `/health` reach the Express API; `/bridge` reaches the WebSocket
gateway. Long-running work stays in GitHub Codespaces.

Required production environment:

- GitHub App: `ORLYNX_PUBLIC_URL`, `GITHUB_APP_ID`, `GITHUB_APP_SLUG`,
  `GITHUB_CLIENT_ID`, `GITHUB_APP_CLIENT_SECRET`, `GITHUB_APP_PRIVATE_KEY`,
  `GITHUB_WEBHOOK_SECRET`, and `ORLYNX_SESSION_SECRET`.
- Postgres: `DATABASE_URL` (Vercel Marketplace Neon is supported).
- Security: `ORLYNX_CREDENTIAL_ENCRYPTION_KEY` (base64 32 bytes) and an
  independent `ORLYNX_BRIDGE_SIGNING_SECRET` (at least 32 bytes).
- Bootstrap: Vercel Sandbox authenticates automatically with deployment OIDC.
  `ORLYNX_RUNTIME_WORKER_URL` and `ORLYNX_RUNTIME_WORKER_TOKEN` are only needed
  when choosing the standalone container worker instead.

The GitHub App must have repository contents write, metadata read, Codespaces
write, and Codespaces lifecycle admin write. Existing installations must accept
new permissions and users must reconnect once so Orlynx can store the encrypted,
expiring GitHub App user token and refresh token.

Production refuses authenticated product work when Postgres is absent. The
health route verifies schema access and reports control-plane readiness without
printing secrets. A global `OPENCODE_BASE_URL` is ignored on Vercel.

## Live verification

Set `ORLYNX_E2E_ENABLED=true` only for the controlled test deployment. CI uses a
Playwright storage-state file (`ORLYNX_E2E_STORAGE_STATE`) captured after the
normal GitHub login, or a dedicated secret cookie as fallback. The E2E creates
only an `orlynx-e2e/<timestamp>` branch; the bridge refuses this helper for any
other branch and refuses pushes to `main`/`master`.

## Marketplace database rollout

After attaching the Neon Postgres resource to the Orlynx Vercel project, create a fresh Production deployment so the new database environment variables are available to the runtime. Verify `/health` reports `durableStorage: true` before considering project/session creation ready.
