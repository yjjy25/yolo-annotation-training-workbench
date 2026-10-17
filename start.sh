#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
cd "$ROOT"
ELECTRON="$ROOT/.runtime/linux-desktop/node_modules/electron/dist/electron"
if [[ ! -x "$ROOT/.runtime/linux-venv/bin/python" || ! -x "$ELECTRON" ]]; then
  echo '请先运行 bash setup-linux.sh，准备独立的 Ubuntu 运行环境。'
  exit 1
fi
exec "$ELECTRON" "$ROOT/desktop"
