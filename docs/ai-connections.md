# Orlynx AI connections

Users experience **Orlynx AI**, but the architecture separates model providers, selected models, coding-agent adapters and workspace execution.

These concepts must not be collapsed into one “AI connected” boolean.

## Concepts

### Model provider

A provider authenticates access to one or more language models.

Credentials remain server-side and are encrypted where persisted.

### Model

A model is the selected reasoning/generation resource for a turn.

The selected model is persisted as session preference and snapshotted where required so already-admitted work cannot silently change when the picker changes.

### Coding-agent adapter

A coding-agent adapter performs workspace-oriented agent execution.

OpenCode is Adapter #1 today.

The adapter is selected separately from the model because Orlynx owns the product contract around both.

### Workspace provider

The workspace provider supplies mutable compute.

Current architecture:

- Orlynx Runner preferred when configured;
- GitHub Codespaces fallback/recovery.

Workspace readiness and model/provider readiness are separate states.

## Direct Ask / Plan

Direct Ask/Plan can call the selected model through the control plane without starting a mutable workspace.

This path supports real streaming, cancellation and same-run continuation.

It is intentionally lighter than the full coding-agent runtime.

## Build

Build work uses the workspace execution plane and selected coding-agent adapter.

The agent runtime can use the selected model/provider according to the adapter's supported configuration.

A failed agent adapter should not automatically mark filesystem/shell/Git workspace capability as failed.

## Credential handling

Provider credentials:

- are never returned raw to the browser;
- are not stored in localStorage;
- should not appear in event payloads/logs;
- are scoped to the authenticated user;
- are encrypted at rest where persisted.

Connection status can expose health, provider name, model availability and masked metadata without exposing the credential.

## No silent model substitution

If a selected model/provider becomes unavailable, Orlynx should report a needs-attention/error state.

It should not silently switch to a different paid/free provider or model merely to make the request appear successful.

## Catalog and availability

The direct model path uses the Orlynx model catalog/provider transport layer documented in [direct-chat-architecture.md](direct-chat-architecture.md).

Agent-runtime model availability may also depend on the selected adapter.

The UI should merge these concepts carefully rather than inventing model names that the active execution path cannot actually use.

## Health

Useful health is capability-specific.

Examples:

- direct model ready;
- workspace ready;
- agent adapter ready;
- provider credential needs attention.

“AI ready” should only be shown when the capability needed for the requested action is actually usable.

## Disconnect

Disconnecting one model provider should preserve:

- project conversation;
- attachments;
- task history;
- learned lessons;
- repository state.

If the active selection depended on that provider, the session should move to an explicit needs-attention state until the user selects or reconnects a usable model.
