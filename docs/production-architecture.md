# Production architecture

Browser → `https://orlynx.vercel.app` (Vite PWA + serverless control plane) →
workspace plane (Codespace/persistent host: bridge → OpenCode) → GitHub
(installation tokens, server-side only).

- Same-origin frontend + API: no CORS allowlists, no wildcard credentials.
- CSRF/state: HMAC-signed single-use expiring tokens for install + manifest
  callbacks; webhook HMAC (`X-Hub-Signature-256`) with constant-time compare;
  delivery-ID idempotency (last 500 persisted).
- Setup endpoints are owner-gated (`ORLYNX_SETUP_TOKEN`) and lock permanently
  once the GitHub App is configured.
- Rotation: replace the env value in Vercel and redeploy; no code changes.
  Webhook secret rotation must match the GitHub App settings page.
- Failure language is consistent across GitHub/AI/Cloud: disconnected →
  connect, needs-attention → reconnect, error → retry, all fail-closed.
