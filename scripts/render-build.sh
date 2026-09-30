#!/usr/bin/env bash
set -euo pipefail

npm ci --include=dev

npm run build

# Direct free-model chat runs beside the API in production. Keeping this
# runtime in the same Render instance removes a second free-service cold start
# and a public-network/DNS hop from every ordinary conversation.
OPENCODE_RUNTIME_VERSION="${ORLYNX_OPENCODE_RUNTIME_VERSION:-1.18.32}"
rm -rf .render-opencode
npm install --prefix .render-opencode --omit=dev --no-audit --no-fund "opencode-ai@${OPENCODE_RUNTIME_VERSION}"
test -x .render-opencode/node_modules/.bin/opencode
.render-opencode/node_modules/.bin/opencode --version

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

# Verify the actual compiled provider imports through normal Node resolution.
# Dependencies come exclusively from npm ci and the committed lockfile.
npm run verify:provider-runtime --workspace=@orlynx/api
