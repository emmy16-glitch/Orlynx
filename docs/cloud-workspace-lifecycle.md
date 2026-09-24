# Cloud workspace lifecycle

The project conversation stays stable while compute changes underneath it.
`POST /v1/sessions/:id/cloud` creates or starts a real GitHub Codespace and
bootstraps its bridge. The response may be `202` while the state is still
preparing. The client reads the durable workspace on session refresh and keeps
the same conversation.

Explicit states are `not_created`, `creating`, `starting`, `bootstrapping`,
`connecting`, `ready`, `stopping`, `stopped`, and `failed`. Bridge and OpenCode
health are separate fields. `POST .../cloud/reconnect` rotates the scoped bridge
identity and re-runs the out-of-repository bootstrap; `POST .../cloud/stop`
stops the Codespace without deleting chat, tasks, events, changes, or approvals.

Failures use stable user language (start failed, connection interrupted, or AI
could not start) while technical detail remains in authenticated diagnostics.
