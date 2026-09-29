# Secrets and environment classification

Render is the production control plane. The browser receives no GitHub, bridge or model-provider secret values.

## Public client configuration

Client-visible VITE_* values must not contain credentials.

The web client talks to Orlynx routes and uses authenticated product/session state rather than embedding infrastructure credentials.

## Server secrets

Examples of server-only configuration include the relevant set of:

- GITHUB_APP_ID
- GITHUB_APP_SLUG
- GITHUB_CLIENT_ID
- GITHUB_APP_CLIENT_SECRET
- GITHUB_APP_PRIVATE_KEY
- GITHUB_WEBHOOK_SECRET
- ORLYNX_CREDENTIAL_ENCRYPTION_KEY
- ORLYNX_BRIDGE_SIGNING_SECRET
- ORLYNX_SESSION_SECRET
- ORLYNX_SETUP_TOKEN
- ORLYNX_RUNNER_TOKEN
- model/provider credentials stored by the supported connection flow

Exact required values are documented in .env.example and subsystem deployment docs.

Names may be reported as missing during startup. Secret values must never be printed.

## GitHub credentials

Normal users do not paste PATs into Orlynx.

GitHub repository authorization comes through the Orlynx GitHub App.

Installation/user credentials remain server-side and are short-lived or encrypted as appropriate.

The agent workspace does not receive unrestricted GitHub credentials.

Controlled publication is performed through Orlynx policy rather than by handing the coding agent an authenticated push shell.

## Provider/model credentials

Provider credentials are stored server-side and encrypted where persisted.

The browser receives connection/health state, not raw keys.

A disconnected or expired provider must produce an explicit needs-attention state rather than silently switching credentials/models.

## Bridge credentials

Bridge credentials are:

- short-lived;
- signed;
- scoped to the intended user/session/workspace/connection;
- used only for the control-plane ↔ workspace bridge relationship.

They are not general-purpose API tokens.

## Workspace environment

The workspace may receive the minimum environment necessary to run repository work and the selected agent runtime.

The bridge filters sensitive control-plane environment variables from generic shell execution where possible.

Repository code is untrusted from the infrastructure perspective.

## Event redaction

Event payloads are sanitized before durable storage and before streaming.

Current redaction covers common shapes such as:

- GitHub token prefixes;
- API-key-like strings;
- authorization/bearer values;
- fields whose key names contain token/secret/password/private key/API key/credential/authorization;
- long secret-like values in obvious token contexts.

Historical events are sanitized again before replay/reflection.

This is defense in depth.

Do not intentionally emit secrets into terminal output on the assumption that redaction will always catch them.

## Learned-memory redaction

Verified lesson memory uses a separate cleaning step that strips common bearer/token/password/secret/API-key forms before persistence.

Learned lessons are user-scoped.

Environment/repository lessons from one user must not be injected into another user's run.

## Browser storage

Do not store raw credentials in localStorage, sessionStorage, IndexedDB, URL query parameters or client logs.

Browser storage may contain non-secret convenience state such as theme, drafts or recent-session pointers.

## Logs and diagnostics

Operational logs should use identifiers and high-level status.

Timing/diagnostic logs may contain session/run/model identifiers, provider name, duration, CPU/RSS measurements and error category/status.

They should not contain raw keys/tokens or private GitHub credentials.

## Health endpoints

Health/status endpoints may expose whether GitHub is configured, whether durable storage is healthy and whether a provider/runner/adapter is ready.

They must not expose secret values.

## Rotation and compromise

Credential rotation should invalidate the old credential path as quickly as the external provider permits.

Bridge credentials are intentionally short-lived to reduce rotation complexity.

If a secret is suspected to have leaked, do not rely on redaction after the fact; rotate/revoke the underlying credential.
