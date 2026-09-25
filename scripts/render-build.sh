#!/usr/bin/env bash
set -euo pipefail

npm ci --include=dev
npm run build

GH_VERSION="${GH_VERSION:-2.80.0}"
case "$(uname -m)" in
  x86_64|amd64) GH_ARCH="amd64" ;;
  aarch64|arm64) GH_ARCH="arm64" ;;
  *) echo "Unsupported architecture for GitHub CLI: $(uname -m)" >&2; exit 1 ;;
esac

ARCHIVE="gh_${GH_VERSION}_linux_${GH_ARCH}"
mkdir -p .render-bin /tmp/orlynx-gh
curl -fsSL "https://github.com/cli/cli/releases/download/v${GH_VERSION}/${ARCHIVE}.tar.gz" -o /tmp/orlynx-gh.tgz
tar -xzf /tmp/orlynx-gh.tgz -C /tmp/orlynx-gh
cp "/tmp/orlynx-gh/${ARCHIVE}/bin/gh" .render-bin/gh
chmod +x .render-bin/gh
.render-bin/gh --version

# Direct chat uses the same lightweight AI SDK provider layer that OpenCode
# uses internally. Do not install or spawn the full OpenCode CLI in the API
# process; it exceeds the free Render instance's CPU/RAM budget.
rm -rf .render-opencode .render-ai
rm -f .render-bin/opencode
npm install --prefix .render-ai --omit=dev --no-audit --no-fund \
  "ai@6.0.168" \
  "@ai-sdk/openai-compatible@2.0.41" \
  "@ai-sdk/openai@3.0.88" \
  "@ai-sdk/anthropic@3.0.111" \
  "@ai-sdk/google@3.0.73"
