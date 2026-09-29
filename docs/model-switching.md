# Model switching

Model selection is an Orlynx session preference, not a hardcoded property of the repository or one coding-agent runtime.

## Discovery

The model picker should be populated from real catalog/provider metadata used by the relevant execution path.

For direct Ask/Plan, Orlynx uses the catalog/provider transport described in [direct-chat-architecture.md](direct-chat-architecture.md).

Workspace agent adapters may expose additional adapter-specific model capability.

Orlynx must not invent model names merely to keep the picker populated.

## Selection

The composer keeps model selection visible alongside mode, access and agent selection.

A selected model is identified by a stable provider/model ID where the provider supports that shape.

## Persistence

Selection is persisted server-side per session so another authenticated device can restore the same project state.

Task admission snapshots the effective selection where necessary.

Changing the picker while a run is active must not silently change the model already executing that admitted run.

The new selection normally applies to the next turn.

## No silent fallback

If the selected model becomes unavailable:

- preserve the user's draft and conversation;
- report needs-attention/unavailable state;
- allow the user to select/reconnect another model;
- do not silently switch to an unrelated provider/model.

Provider fallback can be a future explicit policy feature, but it must be visible and governed rather than accidental.

## Direct versus agent-runtime model use

A model that is available for direct text chat is not automatically proof that the selected coding-agent adapter can use it for workspace execution.

Likewise, an adapter may expose model capability that is not appropriate for the lightweight direct lane.

The UI and server should resolve availability against the execution path rather than presenting one misleading universal readiness flag.

## Free/public models

When a provider/catalog marks a model as usable without a stored credential, Orlynx may use that supported public flow.

A provider rejection must be reported accurately.

For example, an upstream 403 public rejection is not automatically a saved-key expiration, and a 429 is rate limiting rather than proof of billing state.

## Switching standard

Model switching must preserve:

- project/session identity;
- message history;
- attachments;
- queued tasks;
- workspace state;
- learned lessons.

Only the intended future model choice changes.
