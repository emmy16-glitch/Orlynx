# Live E2E setup

`npm run e2e` is a real, mutating provider test: it creates a workspace, asks the model to write a file, executes tests and pushes an isolated branch. Use a dedicated GitHub account/repository and a controlled Orlynx test deployment. The normal test suite uses deterministic fixtures; it does not establish live provider E2E readiness.

## Authenticated in-app trigger

For an explicitly authorized production verification, use the existing repository `emmy16-glitch/Orlynx`. No additional repository, Render project, database or exported session cookie is required.

1. Temporarily set `ORLYNX_E2E_ENABLED=true` and `ORLYNX_E2E_REPOSITORY=emmy16-glitch/Orlynx` on the API, preserving its other environment variables, and wait for the restart.
2. Sign in through `/v1/github/install` normally. Choose an available OpenCode model.
3. Open Settings and select **Run live E2E**. Keep that page open. The driver creates a fresh dedicated session and generated `orlynx-e2e/<timestamp>` target. Rejected main/master/arbitrary-branch probes run before branch mutation.
4. Once compute is ready, the branch helper verifies actual Git state, creates only the isolated GitHub ref at the existing HEAD (no commit), and persists the matching workspace/session branch. This permits normal repository-freshness checks and task admission.
5. The driver performs a real Build, fixed `npm test`, review, commit and isolated push. It checks the actual Git branch immediately before push. Server verification checks GitHub main/branch/file state plus durable tasks, assistant result, ChangeSet and test/publication receipts. The browser replays the full durable event prefix over SSE.
6. After success or failure, set `ORLYNX_E2E_ENABLED=false`, wait for restart and verify health. Retain the isolated branch temporarily when needed as evidence. Never delete a normal branch.

The trigger only appears while the production gate and exact repository allowlist are enabled, requires normal authentication and same-origin initiation, and never accepts a caller-selected repository or publication branch. Completion of CI alone does not establish live provider readiness. A stalled attempt must be cancelled before rerunning; its records remain evidence.

## Terminal driver

The terminal driver remains available when normal Playwright login is possible. Set the explicit target and allowlisted repository on the authorized deployment; do not fabricate signed cookies.

On a computer with a browser:

```sh
npm ci
npx playwright install chromium
export ORLYNX_API=https://orlynx.onrender.com
export ORLYNX_E2E_REPOSITORY=emmy16-glitch/Orlynx
export ORLYNX_E2E_STORAGE_STATE="$HOME/.orlynx-e2e/storage-state.json"
npm run e2e:login
npm run e2e:setup
npm run e2e
```

Complete GitHub login when the browser opens. The capture command saves only the matching Orlynx cookie, without GitHub cookies or localStorage, outside the repository with mode 0600. It refuses to overwrite a file. Delete an expired file and repeat login. Never commit or upload this file as a workflow artifact.

`e2e:setup` performs non-mutating session, integration and repository authorization checks. It does not test the deployment's privileged branch helper or establish model/execution readiness. The mutating test requires the explicit deployment and repository, sends Build mode, waits through queued/running states and bounds HTTP/SSE requests. Its Playwright cookie selection rejects unrelated domains and expired cookies.

## CI wiring

After capturing a normal session, an administrator with Actions secret write permission can store its contents as a repository/environment secret, then create a manually dispatched workflow that writes the secret to a temporary file (mode 0600), sets `ORLYNX_E2E_STORAGE_STATE` to that path, and runs setup followed by E2E. Use a protected test environment and serialize runs; do not run live mutations on pull-request code with secrets. Remove the file afterward, never log it, and rotate through normal login when it expires. This repository currently provides local setup/run commands; it does not claim an installed CI workflow or secret.
