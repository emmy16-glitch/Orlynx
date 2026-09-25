# Render production

Orlynx can run as one persistent Render web service. The service serves the
React build, Express API and authenticated WebSocket bridge on the same origin.

Recommended service settings:

- Runtime: Node
- Node version: 24.x (from package.json)
- Build command: `npm run render:build`
- Start command: `PATH="$PWD/.render-bin:$PATH" npm run start --workspace=@orlynx/api`
- Health path: `/health`
- Plan: Free for development/testing
- Region: choose the closest available region to the primary users

Set `ORLYNX_HOSTED_PRODUCTION=1` and `ORLYNX_BOOTSTRAP_MODE=local`. The
Render build installs a private copy of the GitHub CLI so the control plane can
bootstrap the user's Codespace directly without Vercel Sandbox.

Production still requires the GitHub App variables, `DATABASE_URL`,
`ORLYNX_SESSION_SECRET`, `ORLYNX_CREDENTIAL_ENCRYPTION_KEY`, and
`ORLYNX_BRIDGE_SIGNING_SECRET`. `ORLYNX_PUBLIC_URL` must be the canonical
Render HTTPS URL and the GitHub App callback/setup/webhook URLs must match it.

The hosted-production guard refuses authenticated product work if durable
Postgres is missing. Verify `/health` reports `durableStorage: true`,
`runtimeBootstrapConfigured: true`, and `bridgeConfigured: true` before
opening a project.
