# GitHub App manifest bootstrap

This is an owner/operator setup flow. Normal Orlynx users do not see it.

The active production control plane is Render.

## Purpose

The manifest flow can create/configure the platform GitHub App without exposing generated private credentials to normal users.

## Manifest permissions

Request only permissions required by real product features.

Current areas may include:

- repository metadata;
- contents read/write for controlled Git operations;
- pull requests when Orlynx publication uses PRs;
- Codespaces permissions when Codespaces fallback is enabled.

Do not add broad administration, Actions, secrets or organization permissions without a concrete implemented feature that requires them.

## URLs

Manifest-created application URLs must use the canonical ORLYNX_PUBLIC_URL.

For production this is the Render origin.

Typical endpoints include:

- homepage: ORLYNX_PUBLIC_URL;
- setup/callback: ORLYNX_PUBLIC_URL/v1/github/setup;
- webhook: ORLYNX_PUBLIC_URL/v1/github/webhook.

Preview/temporary deployments must not silently replace production callback URLs.

## Credential handling

Generated private key/client secret/webhook material must remain server-side.

The bootstrap flow must never print those values into chat or a browser page as a workaround.

If automatic secure environment persistence is unavailable, stop and give the operator a secure explicit action instead of exposing the values.

## Webhooks

The webhook endpoint verifies X-Hub-Signature-256.

X-GitHub-Delivery is recorded durably so redelivery cannot become a second authorization change after API restart or multi-instance routing.

## Existing installations

Permission changes can require an installation owner to approve the new permission set on GitHub.

Orlynx should report this as a connection-needs-attention state rather than pretending the new capability succeeded.

## Deployment note

Historical versions of this flow referenced writing environment values to Vercel. Vercel is not the current Orlynx production topology. Current deployment configuration must target the active Render environment/operator process.
