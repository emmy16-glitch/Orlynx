# End-to-end verification

This document describes the production verification contract. Do not treat stale
local screenshots or passing unit tests as proof that the live product works.

## Automated CI

Every pull request and push to `main` runs:

```text
npm ci
npm run typecheck
npm test
npm run build
```

The repository currently has no separate lint script, so CI does not invent one.

## Core production scenario

A release is not considered healthy until the important path is verified against
the deployed application where credentials/permissions allow:

1. open Orlynx on mobile;
2. connect GitHub through the real GitHub App flow;
3. choose an authorized repository;
4. open the chat-first project workspace;
5. connect the real AI account/runtime if needed;
6. select model, mode and access level;
7. start a real Codespace when execution is required;
8. confirm bridge + OpenCode readiness;
9. send a task and receive normalized live activity;
10. background/lock the phone and return;
11. replay missed SSE events without duplicates;
12. inspect files and changes;
13. approve and commit;
14. publish safely to GitHub;
15. for default-branch work, create a real `orlynx/*` branch and pull request;
16. reload or open another authenticated device and recover the session.

## Production components that are real

The current architecture contains real implementations for:

- GitHub App install/OAuth flow and authorized repository listing;
- short-lived installation tokens and signed webhooks;
- durable Postgres control-plane storage;
- encrypted stored user/provider credentials;
- GitHub Codespaces lifecycle provider;
- authenticated outbound workspace bridge;
- OpenCode process/runtime inside the workspace;
- PTY terminal;
- filesystem read/write and attachment transfer;
- Git status/diff/commit/push;
- preview-port discovery;
- durable ordered event replay;
- approval records and audit log.

There is intentionally no production demo/native agent fallback.

## Mobile/reconnect checks

Manual or browser-automation verification should cover at least:

- 360px, 390px and 412px widths;
- keyboard open/close with composer visible;
- long streaming task while reading older chat;
- New activity affordance without forced scroll;
- Wi-Fi → cellular transition;
- background/sleep for several minutes during a running task;
- foreground reconnect and event replay;
- offline draft preservation;
- Android back navigation;
- model/mode/access bottom-sheet/popover behavior.

## Security checks

Verify:

- repository APIs reject unauthenticated/unauthorized access;
- read-only and approval policies are enforced server-side;
- webhook signatures are verified;
- duplicate `X-GitHub-Delivery` IDs are ignored durably;
- GitHub/provider/bridge secrets never appear in browser payloads or logs;
- default-branch direct push is denied in the bridge;
- PR publication uses the real GitHub API;
- audit entries exist for approvals, commits, workspace actions and publication.

## Production-data checks

In Vercel production, durable state must not depend on local filesystem, process
memory or browser localStorage. `DATABASE_URL`/Postgres is authoritative. Local
JSON is development/test fallback only.

Operational retention currently prunes:

- processed webhook-delivery receipts after 30 days;
- completed/failed bridge-command rows after 7 days.

Conversation and audit retention are intentionally not deleted automatically until
a user-facing deletion/retention policy is defined.

## Remaining verification boundaries

Push notifications are not yet claimed as implemented. Do not show an Enable
notifications product control until a real Web Push subscription and delivery
backend exists.

Additional agent runtimes are also not claimed as implemented. OpenCode is the
production runtime behind the adapter boundary.
