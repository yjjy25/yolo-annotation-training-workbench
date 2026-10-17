#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
cd "$ROOT"
PYTHON_BIN="${PYTHON_BIN:-python3}"
"$PYTHON_BIN" -c 'import sys; assert sys.version_info >= (3,11), "需要 Python 3.11 或更高版本，建议 3.12"'
command -v node >/dev/null || { echo '需要 Node.js 22.12 或更高版本。'; exit 1; }
command -v npm >/dev/null || { echo '需要 npm。'; exit 1; }
mkdir -p .runtime
"$PYTHON_BIN" -m venv .runtime/linux-venv
PY="$ROOT/.runtime/linux-venv/bin/python"
"$PY" -m pip install --upgrade pip
if [[ "${1:-cpu}" == gpu ]]; then
  "$PY" -m pip install torch==2.10.0 torchvision==0.25.0 --index-url https://download.pytorch.org/whl/cu128
else
  "$PY" -m pip install torch==2.10.0 torchvision==0.25.0 --index-url https://download.pytorch.org/whl/cpu
fi
"$PY" -m pip install -e './X-AnyLabeling[cpu]' 'ultralytics==8.4.178' 'polars==1.35.2' onnxslim
mkdir -p .runtime/linux-desktop
cat > .runtime/linux-desktop/package.json <<'JSON'
{"name":"local-desktop-runtime","private":true,"dependencies":{"electron":"44.8.0"}}
JSON
npm --prefix .runtime/linux-desktop install --no-audit --no-fund
node .runtime/linux-desktop/node_modules/electron/install.js
echo '准备完成，运行 bash start.sh。GPU 选项仍需设备和驱动检查。'
