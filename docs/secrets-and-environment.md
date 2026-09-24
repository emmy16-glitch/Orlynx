# Secrets and environment classification

## Public (safe in client/bundle)

Nothing GitHub/AI-sensitive. `VITE_*` carries no secrets; the web client calls
Orlynx routes only.

## Server secrets (Vercel production env, never logged/returned)

`GITHUB_APP_ID`, `GITHUB_APP_SLUG`, `GITHUB_CLIENT_ID`,
`GITHUB_APP_CLIENT_SECRET`, `GITHUB_PRIVATE_KEY` (PEM preserved verbatim),
`GITHUB_WEBHOOK_SECRET`, `ORLYNX_SETUP_TOKEN`, `VERCEL_TOKEN`,
`OPENCODE_SERVER_PASSWORD` (workspace plane only).

## Runtime workspace secrets

OpenCode provider keys live in the workspace plane (`OPENCODE_*`,
`data/ai-secrets.json` mode 0600) or the engine host env — never on Vercel,
never in the browser, never in `localStorage`.

## Validation

Startup banner names missing vars (never values). `/health` reports
`githubConfigured` + database durability. `/v1/integrations/status` reports
live health without secret material (asserted in tests).
