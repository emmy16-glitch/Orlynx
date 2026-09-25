# Orlynx system integration

Orlynx is a phone-first control plane over real GitHub repositories, real cloud workspaces, and a real coding-agent runtime. Production never falls back to a demo or simulated agent.

## Product flow

1. The user connects GitHub through the Orlynx GitHub App.
2. Orlynx lists only repositories authorized for that installation.
3. Opening a repository creates an identity-owned durable session.
4. Chat is the primary workspace. Files and changes are secondary views.
5. When execution is needed, Orlynx provisions a GitHub Codespace through the user's GitHub authorization.
6. The Orlynx workspace bridge is bootstrapped inside that Codespace.
7. OpenCode runs privately inside the workspace and is reached only through the authenticated bridge.
8. User prompts are admitted durably; one task is atomically promoted while follow-up prompts remain ordered in the session queue.
9. Runtime events are normalized into the Orlynx event contract and persisted before replay to clients.
10. The user reviews changes and explicitly approves publication.
11. Direct publication to main/master is denied by the workspace bridge. Default-branch work is published to an isolated `orlynx/*` branch and opened as a GitHub pull request.

## Control plane

The Render/API control plane owns:

- GitHub App installation and OAuth handoff
- repository authorization
- durable users/projects/sessions/messages/tasks/events
- encrypted provider credentials
- approvals and audit records
- workspace lifecycle orchestration
- GitHub publication receipts

When `DATABASE_URL` or `POSTGRES_URL` is configured, Postgres is authoritative. Local JSON storage exists only for local development/tests and is not accepted as production truth on hosted deployments.

## Execution plane

The execution plane is a real GitHub Codespace. It owns the checked-out repository, Git state, PTY, tests/builds, preview ports and OpenCode process. The bridge initiates an authenticated outbound WebSocket connection to Orlynx using a short-lived HMAC credential scoped to user, session, workspace and connection.

A workspace is not reported ready until the Codespace is running, the bridge is authenticated and OpenCode reports healthy.

## Agent abstraction

OpenCode is the first production agent runtime. Orlynx orchestration depends on an `AgentRuntimeAdapter` boundary so future real runtimes can implement the same session/event contracts without changing the product UI.

## GitHub security

- GitHub App only; no PAT user flow.
- Installation tokens are short-lived and server-side.
- User-scoped GitHub authorization is stored encrypted for Codespaces.
- Repository authorization is revalidated against the installation.
- Webhooks require `X-Hub-Signature-256`.
- `X-GitHub-Delivery` is persisted atomically in Postgres to reject replay across instances/redeploys.
- Deleting an installation invalidates its durable GitHub connection.

## Production guarantees

Production must fail closed when GitHub, durable storage, workspace, bridge or AI runtime is unavailable. The user-facing UI should explain the capability that is unavailable without exposing operator secrets or environment-variable instructions.
