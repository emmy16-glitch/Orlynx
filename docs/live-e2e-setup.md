# Live E2E setup

`npm run e2e` is a real, mutating provider test: it creates a workspace, asks the model to write a file, executes tests and pushes an isolated branch. Use a dedicated GitHub account/repository and a controlled Orlynx test deployment. The normal test suite uses deterministic fixtures; it does not establish live provider E2E readiness.

## Current audit findings

On 2026-10-03, the repository had no live E2E workflow, the current cloud environment had no test session configured, and Render listed no separate Orlynx test control plane. GitHub Actions secrets/variables inspection returned 403 for the connected integration, so their presence is unknown. Production's authenticated E2E branch gate was not inspected or changed.

## Configure the controlled deployment

Provision a test control plane with its own database and GitHub App OAuth callback, normal provider credentials and available compute. Set `ORLYNX_E2E_ENABLED=true` there. Keep the production deployment's test helper disabled. Authorize the dedicated test repository through the normal GitHub connection. Do not share production database sessions or bypass login by creating signed cookies.

On a computer with a browser:

```sh
npm ci
npx playwright install chromium
export ORLYNX_API=https://YOUR-TEST-DEPLOYMENT
export ORLYNX_E2E_REPOSITORY=YOUR-ACCOUNT/YOUR-TEST-REPOSITORY
export ORLYNX_E2E_STORAGE_STATE="$HOME/.orlynx-e2e/storage-state.json"
npm run e2e:login
npm run e2e:setup
npm run e2e
```

Complete GitHub login when the browser opens. The capture command saves only the matching Orlynx cookie, without GitHub cookies or localStorage, outside the repository with mode 0600. It refuses to overwrite a file. Delete an expired file and repeat login. Never commit or upload this file as a workflow artifact.

`e2e:setup` performs non-mutating session, integration and repository authorization checks. It does not test the deployment's privileged branch helper or establish model/execution readiness. The mutating test requires the explicit deployment and repository, sends Build mode, waits through queued/running states and bounds HTTP/SSE requests. Its Playwright cookie selection rejects unrelated domains and expired cookies.

## CI wiring

After capturing a normal session, an administrator with Actions secret write permission can store its contents as a repository/environment secret, then create a manually dispatched workflow that writes the secret to a temporary file (mode 0600), sets `ORLYNX_E2E_STORAGE_STATE` to that path, and runs setup followed by E2E. Use a protected test environment and serialize runs; do not run live mutations on pull-request code with secrets. Remove the file afterward, never log it, and rotate through normal login when it expires. This repository currently provides local setup/run commands; it does not claim an installed CI workflow or secret.
