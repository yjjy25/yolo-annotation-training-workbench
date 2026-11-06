"""Resolve training weights before creating a dataset or starting a worker."""
import os
from pathlib import Path


def weight_roots(project_root):
    roots = [Path(project_root) / "models"]
    if os.environ.get("XAL_WORKBENCH_HOME"):
        roots.append(Path(os.environ["XAL_WORKBENCH_HOME"]) / "pretrained")
    if os.environ.get("XAL_PRETRAINED_HOME"):
        roots.append(Path(os.environ["XAL_PRETRAINED_HOME"]))
    return roots


def local_weight(value, project_root):
    path = Path(value)
    # Bare names refer to project and application caches. Explicit paths must
    # resolve exactly, never fall back to a different model with the same name.
    candidates = [root / value for root in weight_roots(project_root)] if path.name == value else [path]
    return next((str(p.resolve()) for p in candidates if p.is_file() and p.stat().st_size > 0), None)


def training_catalog(project_root, task):
    suffix = {"detect": "", "segment": "-seg", "pose": "-pose", "obb": "-obb", "classify": "-cls"}[task]
    return [{"name": base + suffix + ".pt", "local": bool(local_weight(base + suffix + ".pt", project_root))}
            for base in ("yolov8n", "yolov8s", "yolo11n", "yolo11s", "yolo26n")]


def resolve_training_weight(value, project_root, allow_download=True, initialization="pretrained"):
    if not value:
        raise ValueError("请选择初始权重。")
    if initialization not in {"pretrained", "scratch"}:
        raise ValueError("请选择预训练权重或从零训练。")
    if initialization == "scratch":
        names = {item["name"] for task in ("detect", "segment", "pose", "obb", "classify")
                 for item in training_catalog(project_root, task)}
        if value not in names:
            raise ValueError("从零训练请选择列表中的内置模型；本地权重请使用预训练权重模式。")
        return value.removesuffix(".pt") + ".yaml"
    local = local_weight(value, project_root)
    if local:
        return local
    known = {item["name"] for task in ("detect", "segment", "pose", "obb", "classify")
             for item in training_catalog(project_root, task)}
    if value not in known:
        raise ValueError(f"找不到本地模型文件：{value}，请重新选择本地初始权重。")
    if allow_download:
        return value
    available = [item["name"] for item in training_catalog(project_root, "detect") if item["local"]]
    hint = "可用检测权重：" + "、".join(available) + "。" if available else ""
    raise ValueError(f"{value} 尚未下载。{hint}请选择已缓存或本地权重，或勾选允许从 GitHub 下载；下载需要能访问 GitHub。")


def download_training_weight(name, directory, progress=lambda message: None):
    """Download an official asset with bounded retries and atomic cache writes."""
    import time
    import uuid
    import zipfile
    import requests

    known = {item["name"] for task in ("detect", "segment", "pose", "obb", "classify")
             for item in training_catalog(directory, task)}
    if name not in known:
        raise ValueError(f"不支持自动下载的模型：{name}")
    target = Path(directory) / name
    target.parent.mkdir(parents=True, exist_ok=True)
    if target.is_file() and target.stat().st_size > 0:
        return str(target.resolve())
    url = f"https://github.com/ultralytics/assets/releases/download/v8.4.0/{name}"
    partial = target.with_name(target.name + "." + uuid.uuid4().hex + ".part")
    last_error = None
    deadline = time.monotonic() + 180
    try:
        for attempt in range(1, 3):
            progress(f"正在从官方 GitHub 下载 {name}（第 {attempt}/2 次）…")
            try:
                with requests.get(url, stream=True, timeout=(8, 15)) as response:
                    response.raise_for_status()
                    total = int(response.headers.get("Content-Length", 0))
                    received, last_update = 0, 0
                    with partial.open("wb") as stream:
                        for chunk in response.iter_content(256 * 1024):
                            if time.monotonic() > deadline:
                                raise TimeoutError("下载超过 180 秒")
                            stream.write(chunk)
                            received += len(chunk)
                            now = time.monotonic()
                            if now - last_update >= .5:
                                detail = f" / {total / 1048576:.1f} MB" if total else " MB"
                                progress(f"正在下载 {name}：{received / 1048576:.1f}{detail}")
                                last_update = now
                    if (total and received != total) or received < 100_000 or not zipfile.is_zipfile(partial):
                        raise ValueError("权重下载不完整或文件格式无效")
                partial.replace(target)
                progress(f"{name} 下载完成，正在加载模型…")
                return str(target.resolve())
            except (requests.RequestException, OSError, ValueError) as error:
                last_error = error
                if time.monotonic() >= deadline:
                    break
        raise RuntimeError(f"{name} 自动下载失败：{type(last_error).__name__}。请检查 GitHub 连接后重试，或选择本地权重；也可选择“从零训练”自动生成模型结构。") from last_error
    finally:
        partial.unlink(missing_ok=True)
