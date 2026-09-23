# Session Lifecycle

## Create vs restore
On load the client reads `orlynx:lastSession`. If the session still exists
(`GET /v1/sessions/:id` 200), it is restored — never replaced with a fake fresh
session. Only if restore fails is a new session created.

## Restored state
- `GET messages/files/changes/runs/attachments` + session detail (head SHA, workspace).
- `lastRun` (latest run) drives "Agent working / Done / Failed" without replaying streams.
- Pending `ChangeSet`s render with `baseSha`; `stale` sets render conflict copy.
- Composer draft restored from `orlynx:draft:<sid>`; cleared only after server confirms send.

## Close / reopen ("phone closes" scenario)
Server persists sessions, messages, events (last 2000), changes, runs, attachments
to `data/orlynx.json` on every mutation, so reopen restores: conversation,
project/branch, task state, cloud state (`ready` only if the provider record says
so — a dead bridge never shows "Cloud ready"), missed events (replay from stored
`orlynx:seq:<sid>`), final results. No duplicate activity (dedup by `eventId`).
