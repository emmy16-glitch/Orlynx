# Secrets and environment classification

Orlynx treats the browser, control plane and workspace as different trust boundaries.

## Browser-safe configuration

The client must not contain GitHub App private material, provider credentials, bridge signing material or workspace secrets.

VITE-prefixed values must be treated as public bundle data.

## Render control-plane secrets

The production Render service may require values such as:

- DATABASE_URL or POSTGRES_URL;
- ORLYNX_CREDENTIAL_ENCRYPTION_KEY;
- ORLYNX_BRIDGE_SIGNING_SECRET;
- ORLYNX_SESSION_SECRET;
- GITHUB_APP_ID;
- GITHUB_APP_SLUG;
- GITHUB_CLIENT_ID;
- GITHUB_APP_CLIENT_SECRET;
- GITHUB_APP_PRIVATE_KEY;
- GITHUB_WEBHOOK_SECRET;
- runner URL/token configuration when a warm runner is used.

The exact active set is documented in .env.example.

Values must never be printed into normal logs or returned to the browser.

## Workspace secrets

A workspace receives only credentials required for narrowly scoped execution.

Bridge credentials are short-lived and scoped to user/session/workspace/connection.

The agent shell does not receive unrestricted GitHub publication credentials.

Connected OpenCode account credentials are delivered only through the protected workspace/runtime path when required.

## Event redaction

The bridge and control plane sanitize event payloads before streaming/durable persistence.

Current redaction includes common forms of:

- GitHub tokens;
- API keys;
- bearer/authorization values;
- token/password/secret fields.

Historical events are sanitized again before replay/reflection.

## Learning-memory redaction

Verified learned lessons are separately cleaned before storage.

Memory is not an alternate secret store.

## Runtime repair

The OpenCode self-heal path installs only the pinned native OpenCode runtime package into an Orlynx-private runtime directory. It does not copy GitHub/model secrets into npm command arguments.

## Production validation

Startup/health diagnostics may report missing variable names or capability state, but never secret values.

Render is the active production control plane. Vercel-specific secret instructions are historical and must not be used for current deployment.
