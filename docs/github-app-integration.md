# GitHub App integration

Orlynx connects repositories through the platform GitHub App and establishes the signed-in user identity through GitHub OAuth.

There is no normal user PAT-entry flow.

## User experience

1. User chooses Continue with GitHub.
2. Orlynx sends the user through the official GitHub authorization/installation flow as required.
3. The user authorizes the Orlynx GitHub App for all or selected repositories.
4. GitHub returns to the Orlynx setup callback.
5. Orlynx verifies the OAuth user and available installations.
6. Durable production storage records the GitHub user ID and installation relationship.
7. The session cookie represents the active installation connection.
8. Orlynx immediately hydrates durable conversations owned by that GitHub user.
9. Repository picker shows only repositories currently authorized to the installation.

## Stable identity and cross-device conversations

The stable ownership key for durable conversations is the authenticated GitHub user ID.

A browser cookie/localStorage value is not the ownership key.

This allows the same GitHub user to connect from a laptop after working on a phone and recover server-owned sessions.

When a repository/branch is reopened and the current installation still authorizes it, an existing durable user-owned session can be rebound to the current installation instead of creating a blank duplicate.

## Repository authorization

Stable user identity does not bypass repository authorization.

Repository operations still use the current GitHub App installation/user authorization and must fail closed when the repository is no longer available.

Conversation history can remain visible even when repository access is later removed.

## OAuth user authorization

The GitHub OAuth flow stores user-scoped authorization server-side when durable storage is configured.

This authorization is used for user-scoped capabilities such as Codespaces.

Tokens are encrypted at rest and refreshed when supported/required.

Do not replace this flow with a PAT paste box.

## Installation authorization

Installation tokens are minted server-side and remain short-lived.

They are never returned to the browser.

Repository lists and branches are revalidated against GitHub rather than trusting client filtering.

## Multiple installations

A user may have access through personal and organization installations.

The selected/current installation determines the repositories available for a repository action, while durable session ownership remains tied to the stable GitHub user identity.

## Webhooks

The webhook endpoint verifies X-Hub-Signature-256.

X-GitHub-Delivery IDs are recorded durably for idempotency.

Repository-selection changes invalidate cached repository authorization state.

Installation deletion/suspension updates connection availability without silently deleting conversation history.

## Security

- no normal-user PAT flow;
- App/user tokens remain server-side;
- credentials are encrypted where persisted;
- authorization is revalidated;
- same-origin API protections apply;
- callback state is signed/expiring;
- session ownership and repository authorization are separate checks.

## Production

All production URLs use the canonical Render ORLYNX_PUBLIC_URL.

See github-app-manifest.md for owner bootstrap and render-production.md for deployment configuration.
