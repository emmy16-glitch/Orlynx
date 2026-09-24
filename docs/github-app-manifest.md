# GitHub App manifest bootstrap (one-time owner setup)

Normal users never see this flow. They click **Connect GitHub** after the Orlynx
platform GitHub App is configured.

## Flow

1. Owner opens the protected GitHub App bootstrap route with
   `ORLYNX_SETUP_TOKEN`.
2. Orlynx builds a manifest using the canonical production URL.
3. GitHub shows its official App-creation confirmation. The owner approves.
4. GitHub redirects to Orlynx with a temporary manifest code.
5. The backend verifies single-use state and exchanges the code at
   `POST /app-manifests/{code}/conversions`.
6. Generated credentials are written directly to Vercel production environment
   storage when Vercel automation credentials are available.
7. A production redeploy is triggered and the bootstrap route locks after the App
   is configured.

Private keys, client secrets and webhook secrets are never returned to the browser
or printed to logs.

## Manifest permissions

`apps/api/src/manifest.ts → buildManifest()` requests only permissions used by
real Orlynx features:

- `contents: write` — repository content/commit/push operations;
- `metadata: read` — repository metadata required with repository access;
- `pull_requests: write` — open a review PR for safe default-branch publishing;
- `codespaces: write` — create/use the user's Codespaces;
- `codespaces_lifecycle_admin: write` — start/stop supported Codespace lifecycle.

No PAT flow is used and no administration/secrets/actions permission is requested
unless a future real feature proves it is necessary.

Changing the manifest permissions for an existing production GitHub App can
require the installation owner to accept the updated permission on GitHub before
the new capability becomes available. Orlynx must report that as a connection
needs-attention state rather than pretending PR creation succeeded.

## URLs

The manifest uses the actual canonical production origin for:

- homepage;
- setup/callback;
- manifest conversion redirect;
- webhook.

Preview deployments must not silently replace production callback URLs.

## Webhooks

The webhook endpoint verifies `X-Hub-Signature-256` and records
`X-GitHub-Delivery` in durable Postgres storage so redelivery cannot be processed
as a new authorization change across serverless instances/redeploys.

## If Vercel automation is unavailable

If Orlynx cannot write generated credentials to Vercel securely, the bootstrap
must stop and report the exact owner action required. It must never print secrets
into the page or chat as a workaround.
