"""Standalone model validation: reuse the frozen split, report metrics and plots.

Training already writes a fixed split into ``splits.json`` and archives an
evaluation snapshot under ``datasets/<stamp>``. Validation re-reads that snapshot
so results stay comparable between runs, and never touches the working
annotations.
"""
from __future__ import annotations

import json
import traceback
from datetime import datetime
from pathlib import Path
import uuid
import yaml

from .project import IMAGE_EXTENSIONS, Project, read_json, write_json


def _latest_dataset(project):
    """Newest frozen dataset snapshot that still exists on disk."""
    root = project.root / "datasets"
    if not root.is_dir():
        return None
    candidates = sorted((p for p in root.iterdir() if p.is_dir()), key=lambda p: p.name)
    for candidate in reversed(candidates):
        if (project.root / "datasets" / candidate.name / "manifest.json").exists():
            return candidate
    return None


def _tidy(value):
    """Turn numpy scalars and arrays into plain JSON-friendly values."""
    if isinstance(value, dict):
        return {str(k): _tidy(v) for k, v in value.items()}
    if isinstance(value, (list, tuple)):
        return [_tidy(v) for v in value]
    if hasattr(value, "item"):
        try:
            return value.item()
        except (TypeError, ValueError):
            pass
    if hasattr(value, "tolist"):
        try:
            return value.tolist()
        except (TypeError, ValueError):
            pass
    if isinstance(value, float):
        return round(value, 6)
    return value


def resolve_source(project, source, custom_path=None):
    """What validation should run on.

    - ``frozen``: the split frozen during training (same numbers as training).
    - ``folder``: any folder of images, copied nothing, read in place.
    - ``image``: a single picture.
    - ``video``: frames sampled at a fixed interval, treated as a folder of images.
    """
    source = (source or "frozen").strip()
    if source == "frozen":
        snapshot = _latest_dataset(project)
        if snapshot is None:
            raise ValueError("还没有可用于验证的数据快照。请先在“模型训练”页用已审核数据训练一次，或改选“自选文件夹 / 单张图片 / 视频”。")
        return {"kind": "dataset", "value": snapshot, "label": "训练时冻结的验证集", "frozen": True}
    if source == "folder":
        folder = Path(custom_path or "")
        if not folder.is_dir():
            raise ValueError("请选择包含图片的文件夹。")
        images = [p for p in sorted(folder.iterdir()) if p.is_file() and p.suffix.lower() in IMAGE_EXTENSIONS]
        if not images:
            raise ValueError(f"该文件夹里没有图片：{folder}")
        return {"kind": "folder", "value": folder, "label": f"自选文件夹（{len(images)} 张）", "frozen": False}
    if source == "image":
        image = Path(custom_path or "")
        if not image.is_file() or image.suffix.lower() not in IMAGE_EXTENSIONS:
            raise ValueError("请选择一张图片。")
        return {"kind": "image", "value": image, "label": f"单张图片：{image.name}", "frozen": False}
    if source == "video":
        video = Path(custom_path or "")
        if not video.is_file():
            raise ValueError("请选择一个视频文件。")
        return {"kind": "video", "value": video, "label": f"视频逐帧预测：{video.name}", "frozen": False}
    raise ValueError("验证对象无效。")


def sample_video(video, target, every_seconds=1.0):
    """Save one frame every ``every_seconds`` so a video can be validated like images."""
    try:
        import cv2
    except ImportError as error:
        raise ValueError(f"读取视频需要 OpenCV：{error}")
    target.mkdir(parents=True, exist_ok=True)
    capture = cv2.VideoCapture(str(video))
    if not capture.isOpened():
        raise ValueError(f"无法打开视频：{video}")
    fps = capture.get(cv2.CAP_PROP_FPS) or 25
    step = max(1, int(round(fps * max(0.05, float(every_seconds)))))
    saved, index, frames = 0, 0, 0
    while True:
        ok, frame = capture.read()
        if not ok:
            break
        if index % step == 0:
            ok, encoded = cv2.imencode(".jpg", frame)
            if not ok:
                capture.release()
                raise ValueError("视频帧无法编码。")
            encoded.tofile(str(target / f"{video.stem}_{saved:05d}.jpg"))
            saved += 1
        index += 1
        frames += 1
    capture.release()
    if not saved:
        raise ValueError("视频里没有取到可用帧。")
    print(f"视频共 {frames} 帧，按每 {every_seconds} 秒抽帧得到 {saved} 张", flush=True)
    return target


def render_video_predictions(predictions, source, output, screenshot_step=1.0):
    """Stream plotted results into a browser-playable VP8 video with bounded memory."""
    import cv2
    import math
    capture = cv2.VideoCapture(str(source))
    try:
        fps = capture.get(cv2.CAP_PROP_FPS)
    finally:
        capture.release()
    if not math.isfinite(fps) or fps <= 0:
        fps = 25.0
    target = output / "predictions.webm"
    temporary = output / "predictions.partial.webm"
    writer = None
    frames = 0
    step = max(1, round(fps * max(0.0, float(screenshot_step or 0))))
    try:
        for result in predictions:
            image = result.plot()
            if writer is None:
                height, width = image.shape[:2]
                writer = cv2.VideoWriter(str(temporary), cv2.VideoWriter_fourcc(*"VP80"), fps, (width, height))
                if not writer.isOpened():
                    raise ValueError("无法编码验证视频（需要 OpenCV 的 VP8/WebM 支持）。")
            writer.write(image)
            if screenshot_step is not None and frames % step == 0 and frames // step < 16:
                ok, encoded = cv2.imencode(".jpg", image)
                if ok:
                    encoded.tofile(str(output / f"video_frame_{frames:08d}.jpg"))
            frames += 1
            if frames % 100 == 0:
                print(f"已处理视频 {frames} 帧", flush=True)
            yield result
        if not frames:
            raise ValueError("视频里没有取到可用帧。")
        writer.release()
        writer = None
        temporary.replace(target)
    finally:
        if writer is not None:
            writer.release()
        temporary.unlink(missing_ok=True)
        close = getattr(predictions, "close", None)
        if close:
            close()


def collect_predictions(predictions, allowed_names):
    """Count detections per class from a list of Ultralytics prediction results."""
    counts, images, per_image = {}, 0, []
    for result in predictions:
        images += 1
        names = result.names
        found = {}
        boxes = getattr(result, "boxes", None)
        if boxes is None:
            boxes = getattr(result, "obb", None)
        for box in boxes if boxes is not None else []:
            label = names[int(box.cls.item())]
            found[label] = found.get(label, 0) + 1
        for label, number in found.items():
            counts[label] = counts.get(label, 0) + number
        probs = getattr(result, "probs", None)
        if probs is not None:
            found[names[int(probs.top1)]] = 1
            counts[names[int(probs.top1)]] = counts.get(names[int(probs.top1)], 0) + 1
        per_image.append({"image": Path(result.path).name, "objects": sum(found.values()), "by_class": found})
    return {"images": images, "objects": sum(counts.values()), "by_class": counts, "per_image": per_image}


def summarize(results, task):
    """Pick the headline numbers out of an Ultralytics validation result."""
    metrics = {}
    box = getattr(results, "box", None)
    if box is not None:
        for key, label in (("map50", "mAP@0.5"), ("map", "mAP@0.5:0.95"), ("mp", "精确率"), ("mr", "召回率")):
            value = getattr(box, key, None)
            if value is not None:
                metrics[label] = round(float(value), 4)
    seg = getattr(results, "seg", None)
    if seg is not None:
        for key, label in (("map50", "掩膜 mAP@0.5"), ("map", "掩膜 mAP@0.5:0.95")):
            value = getattr(seg, key, None)
            if value is not None:
                metrics[label] = round(float(value), 4)
    pose = getattr(results, "pose", None)
    if pose is not None:
        for key, label in (("map50", "关键点 mAP@0.5"), ("map", "关键点 mAP@0.5:0.95")):
            value = getattr(pose, key, None)
            if value is not None:
                metrics[label] = round(float(value), 4)
    obb = getattr(results, "obb", None)
    if obb is not None:
        for key, label in (("map50", "旋转框 mAP@0.5"), ("map", "旋转框 mAP@0.5:0.95")):
            value = getattr(obb, key, None)
            if value is not None:
                metrics[label] = round(float(value), 4)
    top1 = getattr(results, "top1", None)
    if top1 is not None:
        metrics["Top-1 准确率"] = round(float(top1), 4)
    top5 = getattr(results, "top5", None)
    if top5 is not None:
        metrics["Top-5 准确率"] = round(float(top5), 4)
    speed = getattr(results, "speed", None)
    if isinstance(speed, dict):
        metrics["每张耗时(ms)"] = round(sum(float(v) for v in speed.values()), 2)
    metrics["任务"] = task
    return metrics


def collect_plots(directory, limit=16):
    """Result images Ultralytics wrote for this run.

    Names are matched by prefix/suffix rather than exactly: detectors write
    ``confusion_matrix.png`` while pose and segmentation runs prefix the curves
    with the task name (``BoxPR_curve.png``, ``PosePR_curve.png``).
    """
    directory = Path(directory)
    if not directory.is_dir():
        return []
    patterns = [
        "results.png",
        "*confusion_matrix.png",
        "*confusion_matrix_normalized.png",
        "*PR_curve.png",
        "*F1_curve.png",
        "*P_curve.png",
        "*R_curve.png",
        "val_batch*_pred.jpg",
        "val_batch*_labels.jpg",
    ]
    found, seen = [], set()
    for pattern in patterns:
        for path in sorted(directory.glob(pattern)):
            if path.name in seen or not path.is_file():
                continue
            seen.add(path.name)
            found.append({"name": path.name, "size": path.stat().st_size, "modified": path.stat().st_mtime})
            if len(found) >= limit:
                return found
    if not found:
        for path in sorted(directory.glob("*.png")) + sorted(directory.glob("*.jpg")):
            if path.is_file():
                found.append({"name": path.name, "size": path.stat().st_size, "modified": path.stat().st_mtime})
                if len(found) >= limit:
                    break
    return found[:limit]


def history(project):
    """Previous validation runs, newest first.

    A run writes ``validation/<stamp>/metrics.json``; the glob matches that
    layout explicitly instead of any stray JSON in the folder.
    """
    directory = project.root / "validation"
    if not directory.is_dir():
        return []
    records = []
    for path in sorted(directory.glob("*/metrics.json"), reverse=True):
        try:
            data = read_json(path)
        except (ValueError, OSError):
            continue
        records.append(
            {
                "id": path.parent.name,
                "weights": data.get("weights"),
                "device": data.get("device"),
                "at": data.get("at"),
                "metrics": data.get("metrics", {}),
                "video": data.get("video"),
                "plots": [entry["name"] if isinstance(entry, dict) else str(entry) for entry in data.get("plots", [])],
            }
        )
    return records


def run(root, weights, device="cpu", batch=4, imgsz=640, confidence=0.25, plots=True,
        source="frozen", custom_path=None, video_step=1.0, iou=0.7):
    """Validate ``weights`` on the frozen split, a folder, one image or a video.

    The frozen split reuses the training snapshot so numbers stay comparable.
    The other sources run plain prediction and report what the model found, which
    is what "does it work on my new pictures" needs.
    """
    from ultralytics import YOLO

    project = Project(root)
    task = project.data["task"]
    weights_path = Path(weights)
    if not weights_path.is_file():
        raise ValueError(f"找不到权重文件：{weights}")
    target = resolve_source(project, source, custom_path)

    stamp = datetime.now().strftime("%Y%m%d_%H%M%S_") + uuid.uuid4().hex[:8]
    output = project.root / "validation" / stamp
    output.mkdir(parents=True, exist_ok=True)

    model = YOLO(str(weights_path))
    if model.task != task:
        raise ValueError(f"模型任务为 {model.task}，项目任务为 {task}，无法用于本次验证。")
    print(f"验证对象：{target['label']}", flush=True)

    metrics = {}
    predictions = None
    if target["kind"] == "dataset":
        snapshot = target["value"]
        data_arg = str(snapshot) if task == "classify" else str(snapshot / "data.yaml")
        if task != "classify":
            # A project may have moved to another drive or computer since training.
            config = yaml.safe_load((snapshot / "data.yaml").read_text(encoding="utf-8"))
            config["path"] = snapshot.as_posix()
            relocated = output / "data.yaml"
            relocated.write_text(yaml.safe_dump(config, allow_unicode=True, sort_keys=False), encoding="utf-8")
            data_arg = str(relocated)
        results = model.val(
            data=data_arg,
            split="val",
            device=device,
            batch=int(batch),
            imgsz=int(imgsz),
            conf=float(confidence),
            iou=float(iou),
            plots=bool(plots),
            project=str(project.root / "validation"),
            name=stamp,
            exist_ok=True,
            verbose=True,
        )
        metrics = summarize(results, task)
        plot_dirs = [Path(getattr(results, "save_dir", output)), output, weights_path.parent, weights_path.parent.parent]
    else:
        source_path = target["value"]
        video = target["kind"] == "video"
        predictions = model.predict(
            stream=True,
            source=str(source_path),
            device=device,
            imgsz=int(imgsz),
            conf=float(confidence),
            iou=float(iou),
            save=bool(plots) and not video,
            project=str(project.root / "validation"),
            name=stamp,
            exist_ok=True,
            verbose=True,
        )
        if video:
            predictions = render_video_predictions(predictions, source_path, output, video_step if plots else None)
        summary = collect_predictions(predictions, project.data["classes"])
        metrics = {
            "验证图片数": summary["images"],
            "检出目标数": summary["objects"],
            "平均每张目标数": round(summary["objects"] / summary["images"], 2) if summary["images"] else 0,
            "任务": task,
        }
        if video:
            metrics["验证帧数"] = metrics.pop("验证图片数")
            for index, row in enumerate(summary["per_image"]):
                row["frame"] = index
        for name, number in sorted(summary["by_class"].items(), key=lambda item: -item[1]):
            metrics[f"检出·{name}"] = number
        plot_dirs = [output] if video else [output, output / "frames", weights_path.parent]
        if summary["images"]:
            empty = sum(1 for row in summary["per_image"] if row["objects"] == 0)
            metrics["无检出图片数"] = empty
        write_json(output / "predictions.json", summary)

    plots_found, plots_dir = [], plot_dirs[0]
    for directory in plot_dirs:
        plots_found = collect_plots(directory)
        if plots_found:
            plots_dir = directory
            break
    record = {
        "at": datetime.now().isoformat(timespec="seconds"),
        "weights": str(weights_path),
        "device": device,
        # Recorded so two runs with different thresholds stay comparable.
        "confidence": float(confidence),
        "iou": float(iou),
        "source": target["kind"],
        "source_label": target["label"],
        "source_path": str(target["value"]),
        "frozen": target["frozen"],
        "metrics": metrics,
        "plots_directory": str(plots_dir),
        "plots": plots_found,
        "video": "predictions.webm" if target["kind"] == "video" else None,
        "video_audio": False,
    }
    write_json(output / "metrics.json", record)
    for key, value in metrics.items():
        print(f"{key}：{value}", flush=True)
    print(f"验证完成，结果保存在 {output}", flush=True)
    return record


if __name__ == "__main__":
    import sys

    try:
        run(*sys.argv[1:])
    except Exception as error:
        traceback.print_exc()
        print(f"失败：{error}", flush=True)
        sys.exit(1)
