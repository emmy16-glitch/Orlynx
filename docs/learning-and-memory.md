# Orlynx learning and memory

## Mandatory selected-model review

For Build work, deterministic harness verification is necessary but no longer sufficient for finalization. Once acceptance evidence passes, Orlynx explicitly asks the model selected for that task to act as an independent quality/reasoning partner.

The model must challenge unsupported claims, missed requirements, wrong-layer diagnoses, accidental regressions and unnecessary changes. It may use tools to inspect or correct the work and must re-verify anything it changes. Only after that selected-model review can the Build result finalize.

The review is concise and evidence-grounded (for example, `Model → Orlynx: verified — tests and requested behavior are confirmed`); Orlynx does not expose private chain-of-thought. Switching the selected model for a new Build means that model becomes the review/reasoning partner for that Build.

Verified reviews may contribute scoped repository/environment lessons. Those lessons remain user-isolated, relevance-ranked, and subordinate to fresh evidence.

## The important distinction

Orlynx can learn from earlier successful work, but it does **not** retrain, fine-tune or permanently modify the weights of the connected language model.

Its learning system is an Orlynx-owned verified-memory layer.

That distinction matters because “the model learned this” and “Orlynx remembered verified project evidence” are very different technical claims.

## Why Orlynx needs memory

A coding workspace repeatedly encounters repository-specific and environment-specific facts such as:

- a particular app uses an unusual build command;
- a Preview problem came from provider forwarding rather than Vite configuration;
- a repository requires a certain verification sequence;
- a workspace provider exposes a recurring recovery pattern;
- a prior diagnosis was wrong until a specific piece of evidence was checked.

Without memory, every new run starts from zero and may repeat the same investigation.

With uncontrolled memory, however, stale conclusions can pollute future work.

Orlynx therefore learns only from verified resolution and retrieves memory conservatively.

## Current learning pipeline

The current implementation is centered in **apps/api/src/agent-memory.ts** and the harness.

~~~text
Task begins
   ↓
Current prompt + repository/environment evidence
   ↓
Orlynx harness detects a contradiction / missing acceptance criterion
   ↓
One or more Investigation / reflection rounds
   ↓
Real tool evidence is gathered
   ↓
Harness verification passes
   ↓
Final resolution exists
   ↓
Verified lesson may be persisted
~~~

If the task did not require reflection, or verification did not pass, Orlynx does not create a learned lesson from that run.

This is deliberate. Ordinary model prose is not sufficient evidence for durable memory.

## What gets stored

A learned lesson can include:

- scope;
- user ID;
- project ID when repository-scoped;
- originating session ID;
- a short title;
- the original problem;
- the verified resolution;
- supporting evidence;
- search/relevance tags;
- provider metadata when useful;
- success count;
- creation/update timestamps.

The implementation currently supports two practical scopes.

### Repository lessons

Repository lessons apply to the current project.

Examples:

- a repo-specific test command;
- a known Preview peculiarity caused by its framework;
- a recurring build sequence;
- a specific project convention discovered and verified during work.

### Environment lessons

Some lessons describe infrastructure rather than one repository.

Environment memory is created only for patterns related to areas such as:

- Codespaces;
- Render;
- OpenCode;
- Preview forwarding;
- app.github.dev;
- authentication;
- workspaces;
- runners.

Environment memory is still user-scoped.

## Memory isolation

Lessons are keyed and queried under the authenticated user.

Repository lessons also retain project scope.

This prevents one user's debugging history from becoming another user's hidden prompt context.

Memory isolation is part of the product security contract, not a relevance optimization.

## Relevance before influence

Orlynx does not inject every old lesson into every task.

The current retrieval path:

1. loads a bounded set of recent candidate lessons for the user/project;
2. extracts useful tokens from the new prompt;
3. scores overlap with lesson tags, title, problem and resolution;
4. adds a repository-scope boost when project IDs match;
5. adds a smaller environment/provider boost where appropriate;
6. adds limited weight for repeatedly successful lessons;
7. drops zero-overlap lessons;
8. returns only the highest-scoring small set.

The current implementation caps the injected set at five lessons.

This means repository scope alone is not enough. A lesson must still be relevant to the new request.

## How memory is presented to the model

Retrieved lessons are introduced with an explicit warning:

- treat them as verified prior experience;
- do not treat them as infallible rules;
- compare them with the current environment;
- trust fresh verified evidence if there is a conflict.

This is one of the most important design choices in the learning system.

Memory should accelerate investigation, not force reality to match history.

## Fresh evidence always wins

Suppose an earlier lesson says:

> Preview failures in this environment were caused by provider forwarding.

A later task may fail because the application itself now binds incorrectly.

Orlynx should use the old lesson as a hypothesis shortcut, check current evidence, and discard or revise the hypothesis when the new evidence disagrees.

The intended priority is:

~~~text
fresh verified evidence
    >
current observed state
    >
relevant prior lesson
    >
model assumption
~~~

## Secret handling

Before learning, memory content is cleaned and bounded.

The memory cleaner redacts common forms of:

- bearer credentials;
- tokens;
- passwords;
- secrets;
- API keys.

The event pipeline also redacts secret-like data before durable storage and streaming, and historical evidence is sanitized again before it can participate in reflection.

No redaction system should be treated as a license to intentionally place secrets in prompts or logs. The correct architecture is still to keep credentials out of model-visible evidence whenever possible.

## What Orlynx does not learn automatically

The current memory layer does not automatically learn:

- the user's general personality;
- arbitrary preferences from every chat message;
- unverified coding opinions;
- raw terminal output as a permanent rule;
- failed hypotheses;
- hidden model chain-of-thought;
- another user's lessons;
- a universal rule simply because it worked once in one repository.

Those would create a much less trustworthy system.

## Relationship to Investigation blocks

Investigation blocks are the observable diagnosis loop.

A typical sequence is:

~~~text
Investigation 1
Orlynx: Preview port exists, but the browser URL is still unavailable.
Model: Check provider forwarding before editing Vite config.
Evidence: forwarding state does not expose the port.

Investigation 2
Orlynx: forwarding has now been established.
Model: verify the browser-renderable URL.
Evidence: HTML Preview responds successfully.

Verification: passed
Lesson: provider forwarding should be checked before project config changes for this pattern.
~~~

Only the verified result is a candidate for durable lesson memory.

## Success count and repeated evidence

A stable lesson identity is derived from user, scope, project, verification target and tags.

When equivalent verified lessons recur, the stored lesson can gain success history rather than creating endless duplicates.

Success history may slightly improve retrieval ranking, but it does not convert the lesson into absolute truth.

## Memory lifecycle standard

Future memory improvements must preserve these rules:

1. **verified before remembered**;
2. **user isolation**;
3. **relevance before injection**;
4. **bounded context**;
5. **secret minimization**;
6. **fresh evidence beats memory**;
7. **no hidden cross-project contamination**;
8. **memory can be corrected**;
9. **the model is not described as retrained when it is not**;
10. **memory behavior must be testable and observable.**

## Future learning direction

The long-term system can become more capable without abandoning those rules.

Potential future stages include:

### Structured lesson types

Instead of one general lesson form, Orlynx can maintain typed memories such as:

- repository convention;
- build/test recipe;
- infrastructure recovery pattern;
- Preview pattern;
- dependency compatibility;
- deployment procedure;
- user-approved project preference.

### Confidence and decay

Lessons can gain explicit confidence, last-verified time, failure count and decay.

A once-correct environment fact should gradually lose influence if it has not been revalidated.

### Contradiction-driven correction

If fresh evidence repeatedly disproves a lesson, Orlynx should downgrade or replace it rather than merely ignoring it for one run.

### Repository knowledge graph

Verified relationships among services, packages, commands, tests, routes and deployment targets can become structured project knowledge.

That knowledge should still be derived from inspectable evidence.

### Team memory

For team workspaces, selected verified project knowledge could become shared organizational memory with explicit provenance and access controls.

User-private memory and team-shared memory must remain separate concepts.

### Learning from production outcomes

Eventually, Orlynx can connect deployment health, CI results and monitored regressions back to the change that caused them.

That would allow a stronger form of learning:

~~~text
planned change
→ code change
→ tests
→ deploy
→ production observation
→ verified outcome
→ durable lesson
~~~

This is a roadmap direction, not a claim that production-outcome learning is implemented today.

## The standard

The goal is not for Orlynx to “remember everything.”

The goal is for it to remember the **smallest amount of verified information that makes future work materially better without making the system less truthful**.
