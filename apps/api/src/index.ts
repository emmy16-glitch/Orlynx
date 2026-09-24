import { app } from './app.js';
import { githubAppConfigured } from './github.js';

const PORT = Number(process.env.PORT || 4000);

// Startup banner: report GitHub App readiness without logging secret values.
const required = ['ORLYNX_PUBLIC_URL', 'GITHUB_APP_ID', 'GITHUB_APP_SLUG', 'GITHUB_APP_CLIENT_SECRET', 'GITHUB_APP_PRIVATE_KEY', 'GITHUB_WEBHOOK_SECRET'];
const missing = required.filter((name) => !process.env[name]);
if (githubAppConfigured()) {
  console.log('[orlynx-api] GitHub App is configured. Users connect via /v1/github/install.');
} else {
  console.log(`[orlynx-api] GitHub App is NOT fully configured (missing: ${missing.join(', ') || 'invalid ORLYNX_PUBLIC_URL'}). GitHub routes fail closed until server secrets are set.`);
}

app.listen(PORT, () => console.log(`[orlynx-api] listening on http://localhost:${PORT}`));
