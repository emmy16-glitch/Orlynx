# Cloud Workspace Lifecycle

The UI keeps optional compute inside the same project conversation. States are
`none → preparing → ready`, `ready → stopped`, and provider failure → `failed`.
SSE connection state is separate from workspace state.

## Current implementation boundary

The route calls `ensureWorkspace`, emits `workspace.preparing`, and the local
adapter simulates a ready transition. `WorkspaceInfo.provider` deliberately stays
`local`; a configured GitHub credential alone does not mean a Codespace exists.
The existing `createCodespaceViaGitHub` helper is not wired into provisioning or
polling. The UI describes this as a local simulation and does not display guessed
machine size, uptime, or cloud-provider readiness.

## User flow

`Work on cloud` retains the session and conversation, shows a restrained preparing
transition, and returns to the same Chat tab. Cloud detail offers current status,
provider type, refresh, stop, and a route back to the conversation. Stop keeps
conversation, messages, and changes. Start errors keep the chat visible and
explain that saved changes are preserved.

## Future provider contract

A real Codespaces provider must create, poll, reconnect, stop, and report workspace
identity, branch, and readiness from the remote API. Until then, do not say
“GitHub Codespaces”, show fabricated compute specs/uptime, or use the local timer as
evidence of remote readiness. See [system-integration.md](system-integration.md)
and [orlynx-screen-inventory.md](orlynx-screen-inventory.md).
