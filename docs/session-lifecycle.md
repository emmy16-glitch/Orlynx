# Session lifecycle

An Orlynx session belongs to an authenticated GitHub identity and project, not to a browser tab or a single phone.

## Creation

Opening an authorized repository creates a session with:

- user identity
- project/repository identity
- GitHub installation
- branch
- durable conversation
- AI preferences
- optional workspace

The server persists this state in Postgres in production.

## Restore

The browser may keep the last session ID in localStorage only as a convenience pointer. It is not authoritative.

On startup Orlynx:

1. tries the local pointer when present;
2. if it is missing or stale, requests the most recently updated session for the authenticated user;
3. restores messages, task state, changes, attachments, AI preferences and workspace state from the server;
4. reconnects the event stream from the last known sequence.

This allows a session started on one phone/browser to be recovered on another authenticated device.

## Tasks and interruption

Tasks use durable states such as queued, running, waiting, completed, failed and cancelled. The workspace can continue working while the browser is backgrounded. When the user returns, the UI refreshes the authoritative session snapshot and replays events after its cursor.

No success state is inferred from a client-side timer.

## AI preferences

Model, mode and permission profile are persisted per session. A device switch therefore does not silently reset Build/Plan/Ask or access level.

## Disconnects

Disconnecting GitHub removes Orlynx's active GitHub connection but does not delete conversation history. Repository operations fail closed until the user reconnects.

Stopping a cloud workspace does not delete the Orlynx session.

## Retention

Operational dedupe receipts for GitHub webhooks are pruned after 30 days. Completed/failed bridge commands are pruned after 7 days. Conversation/session data, approvals and audit history remain durable until a product-level deletion/retention policy is explicitly applied; Orlynx must not silently discard user history.
