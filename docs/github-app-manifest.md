# GitHub App manifest bootstrap

This is an **owner-only, one-time setup path** for creating the Orlynx GitHub App through GitHub's official App Manifest flow.

Normal users never use this page. They use **Connect GitHub**.

## Current manifest behavior

The manifest is built from the canonical ORLYNX_PUBLIC_URL and requests the capabilities Orlynx currently uses:

- contents: write;
- metadata: read;
- pull requests: write;
- codespaces: write;
- codespaces lifecycle admin: write.

The manifest also configures:

- homepage;
- webhook URL;
- manifest conversion redirect;
- normal GitHub setup/OAuth callback;
- setup-on-update / Redirect on update behavior.

Do not expand permissions without a real implemented feature that requires them.

## Setup flow

1. The owner enables the protected setup path with ORLYNX_SETUP_TOKEN.
2. Orlynx builds the manifest using the canonical production URL.
3. GitHub shows the official App-creation confirmation.
4. The owner approves creation.
5. GitHub redirects to Orlynx with a short-lived manifest conversion code.
6. Orlynx validates signed setup state.
7. Orlynx exchanges the code with GitHub.
8. The returned App credentials must be stored in the production secret environment.
9. The production service is redeployed/restarted with those credentials.
10. Once the App is configured, the owner setup route locks.

Private keys, client secrets and webhook secrets must never be rendered into a normal browser page or printed into logs.

## Render is production

The active Orlynx production control plane is Render.

The canonical production URL, callback URLs and webhook URLs must therefore use the Render origin.

Do not point the production GitHub App at Vercel.

## Legacy Vercel bootstrap helper in code

The current source still contains a legacy function named persistCredentialsToVercel in apps/api/src/manifest.ts.

That helper belongs to the earlier deployment architecture.

It is **not** the current production deployment standard and must not be used as justification to configure Orlynx production on Vercel.

Until that legacy helper is removed or replaced with a Render-safe owner setup workflow, generated credentials should be installed through the secure Render secret-management path used by the operator.

The application must never expose generated secrets as a copy/paste workaround in a normal user flow.

## Canonical GitHub environment keys

The GitHub gateway's canonical configuration names are:

- ORLYNX_PUBLIC_URL
- GITHUB_APP_ID
- GITHUB_APP_SLUG
- GITHUB_CLIENT_ID
- GITHUB_APP_CLIENT_SECRET
- GITHUB_APP_PRIVATE_KEY
- GITHUB_WEBHOOK_SECRET

The runtime accepts GITHUB_PRIVATE_KEY only as a legacy alias. New configuration should use GITHUB_APP_PRIVATE_KEY.

## State security

Manifest setup state is:

- signed;
- expiring;
- single-use;
- owner-protected.

A missing/invalid setup token or already-configured App locks the owner bootstrap.

## Webhooks

The manifest points GitHub at the Orlynx webhook endpoint.

Webhook payloads are verified using X-Hub-Signature-256.

Delivery IDs are persisted durably in production so GitHub redelivery is idempotent across service restarts.

## Permission changes

Changing App permissions for an already-installed App may require installation owners to accept the new permissions on GitHub.

Orlynx must report this as a connection-needs-attention state rather than pretending the new capability already works.

## Future cleanup

The legacy Vercel credential-persistence helper should eventually be removed or replaced by a production-provider-neutral bootstrap abstraction.

That cleanup is code work, not documentation work, and should receive tests before the old helper is deleted.
