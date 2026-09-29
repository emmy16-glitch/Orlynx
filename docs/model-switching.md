# Model switching

## Catalog

Orlynx presents models through the selected AI/agent integration.

Direct chat can use the bundled/refreshed models.dev metadata used by the API transport layer, while workspace OpenCode exposes the models available through its provider/runtime path.

The UI must not invent availability for a model the active path cannot actually use.

## Selection

The composer keeps Agent and Model as separate controls.

A model selection is stored in durable session preferences.

## Admission snapshot

When a task is admitted, the relevant model/adapter/mode/access state is snapshotted on the task.

Changing the picker while work is active does not rewrite the active run underneath it.

## Cross-device persistence

Session AI preferences are server-side.

Opening the same durable conversation on another authenticated device restores the session preference rather than relying on that device's localStorage.

## Failure

If a selected model becomes unavailable:

- preserve the conversation;
- preserve draft/attachments;
- show the real availability/authentication problem;
- do not silently switch to an unrelated model.

Free/public model availability and account-authenticated model availability are distinct conditions.

## Future adapters

Future coding-agent adapters may expose different model catalogs/capabilities. The Orlynx session/task contract should stay stable even when adapter-specific discovery differs.
