# End-to-end verification

This is the production release contract for Orlynx.

Passing unit tests is necessary but does not by itself prove that live GitHub, model, runner, Codespaces or Render integrations are healthy.

## Automated repository verification

Every release candidate should run the repository's supported verification commands:

~~~text
npm ci
npm run typecheck
npm test
npm run build
~~~

Do not invent a lint gate when the repository has no lint script.

## Revision truth

A production claim should record:

1. exact Git commit SHA;
2. GitHub Actions result for that SHA;
3. Render deployed revision;
4. startup/health result;
5. live smoke-test evidence for external integrations affected by the change.

## Cross-device conversation scenario

Verify on two separate browsers/devices:

1. connect GitHub on phone;
2. open a repository and send several messages;
3. confirm messages are durable;
4. connect the same GitHub identity on a fresh laptop/browser with empty localStorage;
5. immediately after OAuth, confirm server-owned recent projects/conversations appear without requiring a second reload;
6. open the same repository/branch;
7. confirm the existing conversation resumes instead of a blank duplicate session;
8. send a laptop message;
9. return to the phone and refresh/foreground;
10. confirm the laptop message appears.

The test proves that localStorage is only a convenience pointer.

## Active-run continuation scenario

1. start a Build task;
2. while it is executing, send “also check this”;
3. confirm the new user message is attached to the same run;
4. send another normal follow-up;
5. confirm no fake acknowledgement run appears;
6. allow the task to enter verification;
7. send a late follow-up near finalization;
8. confirm the run continues/requeues under the same task identity and incorporates it before completion.

## Explicit queue scenario

1. start active work;
2. send “queue this” or “do this next”;
3. confirm a separate queued task appears;
4. confirm position/mode are visible;
5. edit the queued prompt;
6. confirm durable chat/history reflects the edit;
7. cancel another queued item;
8. confirm queued work does not run beside active or waiting work;
9. confirm the next task starts automatically after terminal completion.

## Repository freshness scenario

1. prepare a workspace on the correct branch but several commits behind `origin` with a clean working tree;
2. send a Build request;
3. confirm Orlynx fetches the target branch and fast-forwards before the model or any repository tool runs;
4. confirm the activity stream reports the repository update and the task continues against the new HEAD;
5. repeat with uncommitted changes while the branch is behind;
6. confirm Orlynx does not reset, stash, commit, or discard those changes automatically and does not run the model on stale code;
7. repeat with a diverged branch and with a workspace checked out to the wrong branch;
8. confirm both are blocked before execution with exact branch/ahead/behind context;
9. switch Plan → Build and send immediately, before preference persistence finishes;
10. confirm the message admission payload carries Build, not the previous Plan mode.

## Warm Build continuation scenario

1. start or reuse a Build workspace and complete one model/tool turn;
2. immediately send an explanatory Build follow-up such as “how can we improve this architecture?”;
3. confirm the follow-up remains on the same workspace execution plane and same durable conversation;
4. confirm Orlynx does not cold-start the separate direct OpenCode runtime;
5. if the workspace adapter is recovering, confirm one live status explains whether OpenCode is starting, reconnecting or busy;
6. for a legacy Codespace with an unavailable/failed adapter and warm-runner preference enabled, confirm the next Build admission migrates to the runner.

For the direct lane, simulate transient runtime 502/503/504 responses and confirm the status updates through checking/waking/retrying/recovery rather than remaining frozen on one startup label. Confirm the bounded wake timeout fails cleanly if the runtime never recovers.

## Workspace and adapter scenario

### Warm runner

When configured:

1. opening a repository schedules background prewarm;
2. the browser remains usable while compute warms;
3. runner workspace becomes bridge-ready;
4. OpenCode adapter reaches ready independently.

### Codespaces fallback

When runner preparation fails and fallback is enabled:

1. preserve the durable task/session;
2. switch execution provider;
3. create/connect Codespaces;
4. attach the same bridge contract;
5. continue the task without creating a new conversation.

## OpenCode runtime recovery scenario

Verify both a healthy runtime and a simulated stale/missing binary path.

Expected recovery:

1. bridge remains connected;
2. configured OpenCode path fails its version probe;
3. bridge searches known runner/workspace binary locations;
4. if still unavailable, bridge installs the pinned CPU-compatible native package into its private self-heal directory;
5. repaired binary passes the version probe;
6. OpenCode server starts;
7. adapter transitions to ready;
8. the queued Build task resumes.

If network/package infrastructure genuinely prevents repair, Orlynx may still report adapter unavailable, but the workspace itself must remain usable and the error must not be presented as total project loss.

## Preview scenario

1. start the development server;
2. verify listener/port;
3. reject API-only JSON roots as browser Preview;
4. verify provider forwarding;
5. verify browser-resolvable URL;
6. open Preview;
7. for Codespaces + Vite, confirm Orlynx-managed host compatibility works without a repository-specific config edit;
8. ensure a provider forwarding failure does not cause destructive project config changes.

## Investigation / verification scenario

Create a task where the first hypothesis is wrong.

Verify:

1. Investigation 1 shows the Orlynx observation and model's next check;
2. tool evidence appears under the same diagnostic flow;
3. a corrected Investigation follows when needed;
4. private chain-of-thought is never rendered;
5. final completion occurs only when inferred acceptance evidence is satisfied.

## Streaming and reconnect scenario

Verify:

- live model deltas arrive incrementally;
- browser backgrounding does not cancel server work;
- reconnect uses the durable event cursor;
- replay does not duplicate logical tools;
- stale snapshots do not rewind fresher streamed text;
- scrolling upward stops auto-follow;
- New activity returns the user to the latest content.

## GitHub publication scenario

Verify:

- explicit branch target is preserved;
- ambiguous/different branch target is not guessed;
- agent shell has no unrestricted GitHub credentials;
- unsafe/dirty/behind states are rejected as required;
- controlled publication returns durable evidence;
- default-branch publication occurs only through the explicitly authorized Orlynx path;
- PR publication works when the policy/strategy requires it;
- audit records are written.

## Security scenario

Verify:

- unauthorized session access is rejected;
- durable session restore uses the authenticated GitHub user identity;
- a different GitHub user cannot enumerate or open another user's sessions;
- read-only/Ask-first policies are enforced server-side;
- webhook signatures and delivery dedupe work;
- bridge credentials are scoped;
- raw GitHub/provider secrets are absent from browser payloads;
- event payload redaction occurs before persistence;
- historical replay remains sanitized;
- learned lessons are user-isolated.

## Persistence scenario

Hosted production must survive API restart without losing:

- sessions;
- messages;
- queued tasks;
- event history;
- AI preferences;
- workspace records;
- approvals;
- change sets;
- learned lessons.

## Current boundaries

Do not claim a future feature merely because architecture has an extension point.

Examples that remain roadmap-dependent unless separately implemented/verified include additional production coding-agent adapters, team-shared memory, production-outcome learning and general autonomous scheduled maintenance.

See product-vision-and-roadmap.md.
