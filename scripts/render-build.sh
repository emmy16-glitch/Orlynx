#!/usr/bin/env bash
set -euo pipefail

npm ci --include=dev

npm run build

GH_VERSION="${GH_VERSION:-2.101.0}"
case "$(uname -m)" in
  x86_64|amd64)
    GH_ARCH="amd64"
    GH_SHA256="9bca2d1c16825f109907a23307628a2f0698fbf99662b73a5cf0b020293072b8"
    ;;
  aarch64|arm64)
    GH_ARCH="arm64"
    GH_SHA256="b57e8063f18862647c9d22727c32e9da1b963f8bf9db648fe123a6975695640f"
    ;;
  *) echo "Unsupported architecture for GitHub CLI: $(uname -m)" >&2; exit 1 ;;
esac

if [ "$GH_VERSION" != "2.101.0" ]; then
  echo "Unsupported GitHub CLI version override: $GH_VERSION (expected pinned 2.101.0)" >&2
  exit 1
fi

ARCHIVE="gh_${GH_VERSION}_linux_${GH_ARCH}"
mkdir -p .render-bin /tmp/orlynx-gh
curl -fsSL --retry 3 --connect-timeout 10 "https://github.com/cli/cli/releases/download/v${GH_VERSION}/${ARCHIVE}.tar.gz" -o /tmp/orlynx-gh.tgz
printf '%s  %s\n' "$GH_SHA256" /tmp/orlynx-gh.tgz | sha256sum -c -
tar -xzf /tmp/orlynx-gh.tgz -C /tmp/orlynx-gh
cp "/tmp/orlynx-gh/${ARCHIVE}/bin/gh" .render-bin/gh
chmod +x .render-bin/gh
.render-bin/gh --version

# Verify the actual compiled provider imports through normal Node resolution.
# Dependencies come exclusively from npm ci and the committed lockfile.
npm run verify:provider-runtime --workspace=@orlynx/api
