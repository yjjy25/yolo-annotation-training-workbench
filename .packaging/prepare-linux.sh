#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
BUILD="$ROOT/.packaging"
mkdir -p "$BUILD/tools" "$BUILD/linux-python"
tar -xzf "$BUILD/downloads/uv-linux.tar.gz" -C "$BUILD/tools"
UV="$BUILD/tools/uv-x86_64-unknown-linux-gnu/uv"
export UV_CACHE_DIR="$BUILD/uv-cache"
export UV_PYTHON_INSTALL_DIR="$BUILD/python-install"
export UV_PYTHON_BIN_DIR="$BUILD/tools/bin"
export YOLO_CONFIG_DIR="$BUILD/linux-build-profile/ultralytics"
"$UV" python install 3.12 --no-bin
PY="$($UV python find --managed-python 3.12)"
PREFIX="$($PY -c 'import sys; print(sys.prefix)')"
cp -a "$PREFIX/." "$BUILD/linux-python/"
PY="$BUILD/linux-python/bin/python3.12"
"$PY" -c 'import sys; assert ".packaging/linux-python" in sys.prefix,sys.prefix;print(sys.version)'
"$UV" pip install --python "$PY" --system --break-system-packages 'torch==2.10.0' 'torchvision==0.25.0' --index-url https://download.pytorch.org/whl/cu128
"$UV" pip install --python "$PY" --system --break-system-packages "$ROOT/X-AnyLabeling[cpu]" 'ultralytics==8.4.178' 'polars==1.35.2' onnxslim pip
"$PY" -c 'import torch,PyQt6,ultralytics;print("runtime-ready",torch.__version__,ultralytics.__version__)'
