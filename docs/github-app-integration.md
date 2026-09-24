# GitHub App integration

Orlynx connects to GitHub **only** through a GitHub App installation. There is
no classic PAT flow, no fine-grained PAT flow, and no screen that asks users to
paste a token. All GitHub secrets stay in the API process environment; the
browser only ever calls Orlynx routes, which mint short-lived installation
tokens server-side.

## User experience

1. User clicks **Connect GitHub** → browser navigates to `GET /v1/github/install`.
2. Backend creates a signed, single-use, 10-minute state token and redirects to
   the official GitHub App installation page
   (`https://github.com/apps/<slug>/installations/new?state=…`).
3. On GitHub the user picks a personal account or organization and chooses
   **All repositories** or **Only select repositories**, then installs.
4. GitHub redirects back to `GET /v1/github/setup?installation_id=…&setup_action=…&state=…`.
5. Orlynx validates state, verifies the installation over the GitHub API, mints
   an installation token, lists repositories (health check), persists the
   connection, and redirects to `/?github=connected` (or `/?github=error&reason=…`
   with a polished in-app error screen — never a raw API page).
6. The repository picker shows **only** repositories authorized to the
   installation(s), with search plus All / Personal / Organizations / Recent
   filters and per-repo branch selection before import.

## GitHub App configuration checklist

Create (or reuse) a GitHub App with at minimum:

- **Repository permissions:** Contents (read & write), Metadata (read),
  Pull requests (read, only if Orlynx PR features are enabled later).
- **Subscribe to events:** Installation, Installation repositories.
- **Setup URL:** `<ORLYNX_PUBLIC_URL>/v1/github/setup`
- **Webhook URL:** `<ORLYNX_PUBLIC_URL>/v1/github/webhook`
  (JSON content type, secret = `GITHUB_WEBHOOK_SECRET`).
- **Homepage URL:** `<ORLYNX_PUBLIC_URL>`

Required environment variables on the API host (see `.env.example`):

| Variable | Purpose |
| --- | --- |
| `ORLYNX_PUBLIC_URL` | Public origin used for callback/error redirects (https, or localhost for dev). |
| `GITHUB_APP_ID` | Numeric App ID (used as JWT `iss`). |
| `GITHUB_APP_SLUG` | App slug for install/manage URLs. |
| `GITHUB_APP_CLIENT_SECRET` | HMAC key for install-state tokens. Never leaves the server. |
| `GITHUB_APP_PRIVATE_KEY` | PEM (or base64 PEM) for App JWTs and installation tokens. Never leaves the server. |
| `GITHUB_WEBHOOK_SECRET` | Verifies `X-Hub-Signature-256` on webhooks. Never leaves the server. |

The API logs which variables are missing at startup (names only, never values)
and every GitHub route fails closed until configuration is complete.

## Implemented routes (actual)

| Route | Purpose |
| --- | --- |
| `GET /v1/github/install` | 302 to the GitHub installation page (or 503 when unconfigured). |
| `GET /v1/github/manage` | 302 to GitHub installation settings (`/settings/installations/<id>`) so users can add/remove repos or switch all/selected without reconnecting. |
| `GET /v1/github/setup` | Installation callback: validates single-use state, verifies the installation, health-checks (token + repo list), persists, then 302 to `/?github=connected`, `/?github=disconnected`, or `/?github=error&reason=…`. |
| `POST /v1/github/webhook` | Signed webhook receiver (raw body, constant-time HMAC). Handles `installation` (created / deleted / suspend / unsuspend / new_permissions_accepted) and `installation_repositories` (added / removed → cache invalidated). |
| `POST /v1/github/disconnect` | Orlynx-side disconnect: drops installation metadata and cached tokens, preserves sessions/history. (Uninstalling the app on github.com is separate and user-driven.) |
| `GET /v1/github/status` | Stored connection state (fast, no secrets). |
| `GET /v1/repos` | Authorized repositories aggregated across **active** installations; each row keeps its authorizing installation id. |
| `GET /v1/repos/:owner/:name/branches` | Live branch list; 403 when the repo is not authorized. |
| `POST /v1/repos/import` | Authorization-checked clone; 403 when not authorized. |
| `GET /v1/integrations/status` | Real health: `github.health` (`healthy`/`unhealthy`), `healthMessage`, `authorizedRepositories`, `login`, per-installation `status`/`manageUrl`, plus `userAuthorizationState: 'not-established'`. |

## Authorization model

- `findRepository()` resolves every repo against the **live** installation
  repository listing, so import / branches / push fail closed (403/409) the
  moment access is removed — frontend filtering is never trusted.
- Suspended installations are excluded from listing and token minting; status
  reports `needsAttention: true` with org-approval guidance.
- Multiple installations (personal + orgs) aggregate; installation tokens are
  always minted per installation and cached only until expiry (minus 60s
  clock skew margin). Raw tokens are never persisted or sent to the browser.
- Removing repo access on GitHub: webhook clears the cache; local clones and
  Orlynx conversations are preserved; the workspace shows “GitHub access was
  removed … conversation preserved” with a manage-access action.

## User authorization (Codespaces)

The installation flow establishes **repository** authorization only. User-scoped
operations (e.g. Codespaces) additionally need a GitHub user authorization,
which is currently `not-established`: cloud routes stay fail-closed (503) and
the Cloud screen says so explicitly rather than pretending. When implemented,
it must reuse the install-time authorization, persist server-side, and gate
with a dedicated “Authorize cloud access” action — never a token paste box.

## Verification without live credentials

`npm test` includes `test/github-flow.test.js`, which exercises install,
manage, setup-error redirects, webhook signature enforcement (valid/invalid),
`installation_repositories` handling, disconnect, unauthorized-import
rejection, and status shape/secrecy with **no live GitHub access**.
Live end-to-end (`test/e2e.js`, read-only + real OpenCode run) requires a
configured GitHub App installation and OpenCode server and exits with code 2
(“E2E BLOCKED”) when they are absent instead of faking success.
