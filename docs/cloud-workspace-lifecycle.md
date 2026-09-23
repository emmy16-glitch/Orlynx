# Cloud Workspace Lifecycle

States: `none → preparing → ready`, `ready → stopped`, any → `failed`
(`reconnecting` surfaces in the header when the event stream — the health signal —
drops; a dead bridge can never display "Cloud ready").

## Seamless transition
`[Work on cloud]` → same conversation stays mounted → `CloudTransition`
(Work on cloud → Preparing → Connecting → Ready) → `Cloud ready` badge.
Attachments materialize server-side (`materializeForRuntime`); the user never
transfers files manually. Stop keeps conversation + changes; the button copy says
"Conversation and changes are kept."

## Failure
Cloud `failed` / stream `reconnecting` / run `failed` → `AgentErrorCard`:
what failed, what is safe ("changes are preserved"), `[Reconnect workspace]`
`[View logs]`. No VS Code, no redirect, no SKU/port vocabulary.
