#!/usr/bin/env bash
set -euo pipefail
# Optional prepared runtime. No provider is provisioned and no paid API is required.
MINI_REPOSITORY_ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
MINI_RUNTIME_ROOT="${ORLYNX_MINI_SWE_RUNTIME_ROOT:-$MINI_REPOSITORY_ROOT/.runner-mini-swe}"
python3 -m venv "$MINI_RUNTIME_ROOT"
"$MINI_RUNTIME_ROOT/bin/pip" install --disable-pip-version-check 'mini-swe-agent==2.4.6'
MSWEA_SILENT_STARTUP=1 "$MINI_RUNTIME_ROOT/bin/python" -c 'import minisweagent; from minisweagent.agents.default import DefaultAgent; assert minisweagent.__version__ == "2.4.6"'
