#!/usr/bin/env python3
"""Report and reclaim duplicated JPEGs in frozen dataset snapshots.

Dry run by default::

    python scripts/compact_snapshots.py "E:/项目/我的项目"

Apply (turns duplicate copies into hard links to shared objects)::

    python scripts/compact_snapshots.py "E:/项目/我的项目" --apply

Nothing is deleted: every unique byte string is kept once in
``datasets/.objects`` and every snapshot path keeps pointing at those exact
bytes.  Run with the project's own Python environment (the one that has the
anylabeling package importable).
"""
from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from anylabeling.services.workflow.snapshot_store import compact_snapshots  # noqa: E402


def human(size):
    value = float(size)
    for unit in ("B", "KB", "MB", "GB", "TB"):
        if value < 1024 or unit == "TB":
            return f"{value:.0f} {unit}" if unit == "B" else f"{value:.2f} {unit}"
        value /= 1024


def main():
    parser = argparse.ArgumentParser(description="压缩项目 datasets 快照中的重复图片")
    parser.add_argument("project", help="项目根目录（含 images/ 与 datasets/）")
    parser.add_argument("--apply", action="store_true", help="实际执行；默认只预演不改文件")
    parser.add_argument("--json", action="store_true", help="以 JSON 输出报告")
    args = parser.parse_args()
    root = Path(args.project).expanduser().resolve()
    if not (root / "datasets").is_dir():
        parser.error(f"没有找到 datasets 目录：{root}")
    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(encoding="utf-8")
    report = compact_snapshots(root, apply=args.apply)
    if args.json:
        print(json.dumps(report, ensure_ascii=False))
        return 0 if not report["failed"] else 1
    print(f"项目：{root}")
    print(f"快照 {report['snapshots']} 份 / 图片 {report['images']} 张 / 唯一内容 {report['unique']} 份")
    print(f"当前实占 {human(report['physical_bytes'])} → 去重后约 {human(report['unique_bytes'])}（可释放 {human(report['reclaimable_bytes'])}）")
    print(f"注：{report['images']} 个快照文件的逻辑大小合计 {human(report['total_bytes'])}，硬链接共享后不重复占磁盘")
    if report["orphan_files"]:
        print(f"另有隐藏残留文件 {report['orphan_files']} 个 / {human(report['orphan_bytes'])}（本次不处理）")
    if not args.apply:
        print("[预演] 未改动任何文件。确认后再加 --apply 执行。")
        if report["reclaimable_bytes"] == 0:
            print("提示：当前没有可合并的重复副本；--apply 会把现有快照接入共享对象库，之后新建快照不再复制整批图片。")
    elif not report["supported"]:
        print("[未执行] 当前文件系统不支持硬链接，文件保持原样。")
    else:
        print(f"已合并 {report['linked']} 个重复副本（原本已共享 {report['already_linked']} 个），失败 {len(report['failed'])} 个。")
        print(f"共享对象 {report['objects']} 份；清理无引用对象 {report.get('pruned_objects', 0)} 个。")
        for failure in report["failed"][:10]:
            print(f"  失败：{failure['path']} — {failure['error']}")
    return 0 if not report["failed"] else 1


if __name__ == "__main__":
    raise SystemExit(main())
