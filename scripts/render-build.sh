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

OPENCODE_VERSION="${OPENCODE_VERSION:-1.18.32}"
rm -rf .render-opencode
npm install --prefix .render-opencode --omit=dev --no-audit --no-fund "opencode-ai@${OPENCODE_VERSION}"
ln -sf ../.render-opencode/node_modules/.bin/opencode .render-bin/opencode
.render-bin/opencode --version
