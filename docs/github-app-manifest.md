# GitHub App manifest bootstrap (one-time owner setup)

Normal users never see this. They use Connect GitHub after setup completes.

## Flow

1. Owner opens `https://orlynx.vercel.app/?setup=github-app`, enters
   `ORLYNX_SETUP_TOKEN`, and clicks **Create GitHub App**.
2. Browser posts the server-generated manifest to
   `https://github.com/settings/apps/new?state=…`. Preferred name **Orlynx**;
   fallbacks `Orlynx App`, `Orlynx Dev` if taken (owner picks on GitHub's page;
   the actual slug is reported after creation).
3. GitHub shows its official confirmation page. Owner approves.
4. GitHub redirects to `/v1/setup/github-app/callback?code=…&state=…`.
5. Backend verifies single-use state, exchanges the code at
   `POST /app-manifests/{code}/conversions`, and writes the credentials
   straight into Vercel production env via the Vercel API
   (`GITHUB_APP_ID/SLUG`, `GITHUB_CLIENT_ID`, `GITHUB_APP_CLIENT_SECRET`,
   `GITHUB_PRIVATE_KEY`, `GITHUB_WEBHOOK_SECRET`, `ORLYNX_PUBLIC_URL`),
   then triggers a production redeploy. Only masked metadata
   (`appId`, `slug`, `configured`) is ever returned or logged.
6. Once configured, setup routes lock (`Setup complete`) and normal
   Connect GitHub works.

## Manifest contents

`apps/api/src/manifest.ts → buildManifest()` uses only real production URLs
(homepage, `redirect_url` = callback, `callback_urls` = setup,
`setup_url`, webhook URL) and minimum permissions mapped to real calls:
`contents:write` (clone/commit/push), `metadata:read`, events
`installation` + `installation_repositories`. No admin/secrets/actions scopes.

## If automation is missing

Without `VERCEL_TOKEN`/`VERCEL_PROJECT_ID` on the server, the callback stops
after conversion with a pending-owner-action message instead of handling
secrets manually. Secrets are never printed, URL-encoded, logged, or returned
to the browser under any circumstance.
