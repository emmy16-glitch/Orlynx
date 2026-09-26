#!/usr/bin/env bash
set -euo pipefail

runtime="$HOME/.orlynx/runtime"
mkdir -p "$runtime"
chmod 700 "$HOME/.orlynx" "$runtime"

: "${ORLYNX_CONTROL:?missing ORLYNX_CONTROL}"
: "${ORLYNX_WORKSPACE_TOKEN:?missing ORLYNX_WORKSPACE_TOKEN}"
: "${ORLYNX_WORKSPACE_ID:?missing ORLYNX_WORKSPACE_ID}"
: "${ORLYNX_SESSION_ID:?missing ORLYNX_SESSION_ID}"
: "${ORLYNX_USER_ID:?missing ORLYNX_USER_ID}"
: "${ORLYNX_CONNECTION_ID:?missing ORLYNX_CONNECTION_ID}"
: "${ORLYNX_REPO_ROOT:?missing ORLYNX_REPO_ROOT}"
: "${OPENCODE_SERVER_PASSWORD:?missing OPENCODE_SERVER_PASSWORD}"

export OPENCODE_BIN="/opt/orlynx/bin/opencode"

if test -f "$runtime/bridge.pid"; then
  prior="$(cat "$runtime/bridge.pid" 2>/dev/null || true)"
  if test -n "$prior" && kill -0 "$prior" 2>/dev/null; then
    kill "$prior" 2>/dev/null || true
    for _ in 1 2 3 4 5; do
      kill -0 "$prior" 2>/dev/null || break
      sleep 0.2
    done
  fi
fi

nohup node /opt/orlynx/bridge/index.js >"$runtime/bridge.log" 2>&1 </dev/null &
pid="$!"
printf '%s' "$pid" >"$runtime/bridge.pid"

sleep 1
if ! kill -0 "$pid" 2>/dev/null; then
  tail -c 2000 "$runtime/bridge.log" >&2 || true
  exit 1
fi
