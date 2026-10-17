"""Validation worker: runs in its own process so the UI thread stays responsive."""
from __future__ import annotations

import json
import sys
import traceback
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[3]))

from anylabeling.services.workflow.validate import run  # noqa: E402


def main():
    if len(sys.argv) < 2:
        print("缺少验证参数。", flush=True)
        return 2
    try:
        payload = json.loads(sys.argv[1])
    except ValueError:
        print("验证参数不是合法 JSON。", flush=True)
        return 2
    try:
        record = run(
            payload["root"],
            payload["weights"],
            device=payload.get("device", "cpu"),
            batch=payload.get("batch", 4),
            imgsz=payload.get("imgsz", 640),
            confidence=payload.get("confidence", 0.25),
            plots=payload.get("plots", True),
            source=payload.get("source", "frozen"),
            custom_path=payload.get("custom_path") or None,
            video_step=payload.get("video_step", 1.0),
            iou=payload.get("iou", 0.7),
        )
    except Exception as error:  # surfaced to the UI as a failed validation
        traceback.print_exc()
        print(f"失败：{error}", flush=True)
        return 1
    print("结果：" + json.dumps(record.get("metrics", {}), ensure_ascii=False), flush=True)
    return 0


if __name__ == "__main__":
    sys.exit(main())
