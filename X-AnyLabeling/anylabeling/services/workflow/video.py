"""Local video-to-annotation frames with source provenance and cancellable staging."""
from __future__ import annotations

import math
from pathlib import Path
import sys
import uuid

from .project import Project, read_json, write_json


def options(args):
    values = {}
    for key, default in (("start", 0), ("end", 0), ("step", 1)):
        value = float(args.get(key, default))
        if not math.isfinite(value) or value < 0:
            raise ValueError("起止时间和抽帧间隔必须为非负数字。")
        values[key] = value
    limit = args.get("limit", 500)
    if type(limit) is not int or not 1 <= limit <= 5000:
        raise ValueError("每次可导入 1～5000 帧。")
    if values["end"] and values["end"] <= values["start"]:
        raise ValueError("结束时间应大于开始时间，填 0 表示直到结尾。")
    return {**values, "limit": limit}


def import_video(project, args, report, cancelled=lambda: False):
    import cv2

    settings = options(args)
    source = Path(args.get("path", "")).resolve()
    if not source.is_file() or source.suffix.lower() not in {".mp4", ".avi", ".mov", ".mkv", ".webm", ".m4v"}:
        raise ValueError("请选择 MP4、AVI、MOV、MKV、WEBM 或 M4V 视频。")
    capture = cv2.VideoCapture(str(source))
    try:
        if not capture.isOpened():
            raise ValueError("视频无法解码，请尝试转为 H.264 MP4 后重新导入。")
        fps = capture.get(cv2.CAP_PROP_FPS)
        if not math.isfinite(fps) or fps <= 0:
            raise ValueError("无法读取有效帧率，不能可靠地生成帧号和时间。")
        total = max(0, int(capture.get(cv2.CAP_PROP_FRAME_COUNT)))
        first = int(math.ceil(settings["start"] * fps))
        stop = int(math.ceil(settings["end"] * fps)) if settings["end"] else None
        stride = max(1, int(round(settings["step"] * fps)))
        identifier = "video_" + uuid.uuid4().hex
        directory = project.root / "videos" / identifier
        stage = directory / "staged"
        stage.mkdir(parents=True)
        frames = []
        metadata = {"id": identifier, "source": str(source), "source_name": source.name,
                    "source_bytes": source.stat().st_size, "source_mtime_ns": source.stat().st_mtime_ns,
                    "fps": fps, "source_frames": total, "settings": settings, "frames": frames}
        index = 0
        # Decode sequentially: arbitrary codec seek often lands on a keyframe.
        while (stop is None or index < stop) and len(frames) < settings["limit"]:
            if cancelled():
                report({"status": "stopped", "count": len(frames), "message": "已取消，暂存帧未加入数据集。"})
                return None
            if not capture.grab():
                break
            if index >= first and (index - first) % stride == 0:
                ok, frame = capture.retrieve()
                if not ok:
                    raise ValueError(f"第 {index} 帧解码失败，未导入本批次。")
                ok, encoded = cv2.imencode(".jpg", frame, [cv2.IMWRITE_JPEG_QUALITY, 95])
                if not ok:
                    raise ValueError("视频帧编码失败。")
                name = f"{identifier}_{index:09d}.jpg"
                encoded.tofile(str(stage / name))
                frames.append({"name": name, "frame": index, "seconds": index / fps})
                if len(frames) == 1 or len(frames) % 10 == 0:
                    report({"status": "running", "count": len(frames), "frame": index, "seconds": index / fps})
            index += 1
        if not frames:
            raise ValueError("所选时间范围没有可读取的视频帧。")
        if cancelled():
            report({"status": "stopped", "count": len(frames), "message": "已取消，暂存帧未加入数据集。"})
            return None
        metadata["limited"] = len(frames) == settings["limit"]
        # Persist provenance before publishing; never overwrite an image or label.
        metadata["status"] = "importing"
        write_json(directory / "manifest.json", metadata)
        moved = []
        try:
            for frame in frames:
                target = project.root / "images" / frame["name"]
                if target.exists():
                    raise ValueError("存在同名帧，导入已停止。")
                (stage / frame["name"]).rename(target)
                moved.append(target)
            metadata["status"] = "completed"
            write_json(directory / "manifest.json", metadata)
        except Exception:
            for target in moved:
                target.rename(stage / target.name)
            raise
        result = {"status": "completed", "count": len(frames), "id": identifier,
                  "first": frames[0]["name"], "limited": metadata["limited"]}
        report(result)
        return result
    finally:
        capture.release()


def sequences(project):
    return [read_json(p) for p in sorted((project.root / "videos").glob("*/manifest.json"))
            if read_json(p).get("status") == "completed"]


def main(payload):
    args = read_json(payload)
    report_path = Path(payload).with_name("progress.json")
    try:
        import_video(Project(args["root"]), args, lambda value: write_json(report_path, value),
                     lambda: Path(payload).with_name("cancel").exists())
    except Exception as error:
        write_json(report_path, {"status": "failed", "error": str(error)})
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1]))
