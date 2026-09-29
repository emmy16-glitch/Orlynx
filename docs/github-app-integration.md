# GitHub App integration

Orlynx connects to GitHub through the Orlynx GitHub App.

Normal users do not paste classic or fine-grained PATs into Orlynx.

Repository authorization and user-scoped GitHub authorization are handled through GitHub's App/OAuth flows, with credentials stored server-side.

## User experience

The current connection flow supports the combination required by Orlynx:

1. user chooses **Connect GitHub**;
2. Orlynx creates signed, expiring state;
3. GitHub OAuth establishes the user's GitHub identity/authorization;
4. Orlynx verifies the GitHub App installation(s) accessible to that user;
5. if the App still needs to be installed, the user is sent through GitHub's installation flow;
6. repository access is verified live;
7. Orlynx stores the durable connection state;
8. the user returns to Orlynx and sees only authorized repositories.

Repository-selection updates can return through the configured setup URL and are revalidated against GitHub.

## Why Orlynx needs both installation and user authorization

The GitHub App installation controls repository access.

Some user-scoped GitHub capabilities, including Codespaces operations, require user authorization as well.

Orlynx therefore keeps these concepts separate:

- **installation authorization** — which repositories the App may access;
- **user authorization** — which user-scoped GitHub operations may be performed for the authenticated user.

The browser never receives the raw authorization credentials.

## GitHub App configuration

The production App should use the canonical ORLYNX_PUBLIC_URL for homepage, OAuth/setup callback, setup URL and webhook URL.

The current manifest requests the repository/user capabilities used by Orlynx:

- Contents: write;
- Metadata: read;
- Pull requests: write;
- Codespaces: write;
- Codespaces lifecycle admin: write.

Do not add broader permissions merely because they might be useful later.

## Server configuration

The current GitHub gateway expects the relevant set of:

- ORLYNX_PUBLIC_URL
- GITHUB_APP_ID
- GITHUB_APP_SLUG
- GITHUB_CLIENT_ID
- GITHUB_APP_CLIENT_SECRET
- GITHUB_APP_PRIVATE_KEY
- GITHUB_WEBHOOK_SECRET

GITHUB_PRIVATE_KEY is accepted by the code as a legacy alias, but GITHUB_APP_PRIVATE_KEY is the canonical name.

## Authorization model

Repository operations revalidate authorization rather than trusting a frontend list.

Important rules:

- installation tokens are minted on demand and are not browser credentials;
- suspended installations are excluded from active capability;
- repository selection changes invalidate cached repository listings;
- removing repository access preserves the Orlynx conversation but blocks unauthorized repository operations;
- multiple accessible installations may be aggregated;
- installation tokens remain installation-scoped;
- user authorization remains user-scoped and encrypted/durable where required.

## Webhooks

The webhook endpoint verifies X-Hub-Signature-256.

Delivery IDs are persisted for idempotency in production so a GitHub redelivery is not processed as a new authorization event after restart/redeploy.

Relevant installation/repository events update durable connection state and invalidate caches.

## Disconnect behavior

An Orlynx-side disconnect stops using the stored GitHub connection and cached access.

It does not silently delete project conversation history.

Uninstalling the GitHub App on github.com is a separate user-controlled action.

## Publication

The coding-agent shell does not receive unrestricted GitHub credentials.

Explicit publish operations are handled through Orlynx-controlled publication.

If the user names a branch, Orlynx preserves that target instead of guessing another branch.

The publication path must enforce current authorization and server-side policy.

## Codespaces

Codespaces is a supported workspace provider/fallback and uses the user's GitHub authorization when required.

Codespaces is not the only Orlynx execution architecture: the warm runner is preferred when configured.

See [workspace-runtime.md](workspace-runtime.md) and [warm-runner-architecture.md](warm-runner-architecture.md).

## Verification

Automated tests should cover signed state handling, OAuth/install return, setup/update return, invalid state, webhook signature enforcement, webhook delivery dedupe, installation suspend/delete/update, unauthorized repository rejection and connection-status secrecy.

Live verification still requires a real configured GitHub App and user account.

No test fixture should be described as proof of live GitHub availability.
