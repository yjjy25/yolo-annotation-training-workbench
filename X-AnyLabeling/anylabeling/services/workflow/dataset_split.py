"""Reproducible, source-aware dataset splits; no image or label is modified.

A connected component is the minimum split unit. Edges come from known video
provenance, identical files/pixels, or strictly verified near-identical pixels.
Visual matching is deliberately conservative and bounded; it is not a semantic
scene detector. Algorithm details and any search limits travel with the snapshot.
"""
from __future__ import annotations

import base64
from collections import defaultdict, deque
from functools import lru_cache
import hashlib
import json
from pathlib import Path
import random

import numpy as np
from PIL import Image, ImageOps

from .project import digest, read_json, write_json

ALGORITHM = "source-components-pixel-verified"
VERSION = 1
MAX_CANDIDATES = 32
POLICY = {
    "video": "whole-source; source-sha256 or recorded-path-size-mtime",
    "pixels": "EXIF-transposed RGB; same dimensions",
    "visual": {"thumbnail_mae_max": 2.0, "pixel_mae_max": 2.0,
               "pixel_rmse_max": 3.0, "pixel_p99_max": 12.0,
               "min_spatial_std": 4.0, "dhash_distance_max": 8,
               "max_candidates_per_image": MAX_CANDIDATES},
    "selection": "seeded exact subset-sum up to 100000 images; bounded greedy above",
}


def _stable(value):
    return hashlib.sha256(json.dumps(value, sort_keys=True, ensure_ascii=False).encode()).hexdigest()


def _stat(path):
    value = path.stat()
    return [value.st_size, value.st_mtime_ns, value.st_ctime_ns, value.st_ino]


def _rgb(path):
    with Image.open(path) as image:
        return ImageOps.exif_transpose(image).convert("RGB")


def _fingerprint(path):
    rgb = _rgb(path)
    pixels = np.asarray(rgb)
    thumb = np.asarray(rgb.resize((32, 32), Image.Resampling.BOX))
    gray = np.asarray(rgb.resize((9, 8), Image.Resampling.BILINEAR).convert("L"))
    dhash = int.from_bytes(np.packbits(gray[:, 1:] > gray[:, :-1]).tobytes(), "big")
    return {"sha256": digest(path), "pixels_sha256": hashlib.sha256(
                str(rgb.size).encode() + pixels.tobytes()).hexdigest(),
            "size": list(rgb.size), "thumbnail": base64.b64encode(thumb.tobytes()).decode(),
            "dhash": dhash, "texture": float(pixels.reshape(-1, 3).std(axis=0).max())}


class _Components:
    def __init__(self, names):
        self.parent = {name: name for name in names}
        self.edges = []

    def find(self, name):
        if self.parent[name] != name:
            self.parent[name] = self.find(self.parent[name])
        return self.parent[name]

    def join(self, a, b, reason, **details):
        left, right = self.find(a), self.find(b)
        if left != right:
            # Sorting roots keeps component IDs independent of union iteration order.
            self.parent[max(left, right)] = min(left, right)
            self.edges.append({"a": a, "b": b, "reason": reason, **details})


def _video_sources(project, records, cache, warnings):
    """Associate real dataset names, including accepted video-work copies."""
    associations = defaultdict(set)
    manifests = sorted((project.root / "videos").glob("*/manifest.json"))
    # Also understand a standalone video-work project without manufacturing a store.
    if project.data.get("video_workspace") and project.data.get("parent_project"):
        manifests += sorted((Path(project.data["parent_project"]) / "videos").glob("*/manifest.json"))
    sequence_sources = {}
    source_cache = cache.setdefault("sources", {})
    for path in manifests:
        try:
            metadata = read_json(path)
        except (OSError, ValueError):
            warnings.append(f"视频来源记录无法读取：{path.parent.name}，不能确认其跨导入来源。")
            continue
        if metadata.get("status") != "completed":
            continue
        sequence = str(metadata.get("id", path.parent.name))
        source = metadata.get("source")
        # A manifest's known sequence always forms a group, even if source is gone.
        source_key = "sequence:" + sequence
        if source and metadata.get("source_bytes") is not None and metadata.get("source_mtime_ns") is not None:
            signature = [str(source), metadata["source_bytes"], metadata["source_mtime_ns"]]
            source_key = "recorded-source:" + _stable(signature)
            original = Path(source)
            saved = source_cache.get(str(original), {})
            # A previously observed hash remains evidence for the recorded source
            # after that original file moves away from a portable project.
            if saved.get("stat", [])[:2] == signature[1:] and saved.get("sha256"):
                source_key = "source-sha256:" + saved["sha256"]
            try:
                stat = _stat(original)
                if stat[:2] == signature[1:]:
                    saved = source_cache.get(str(original), {})
                    if saved.get("stat") != stat:
                        saved = {"stat": stat, "sha256": digest(original)}
                        source_cache[str(original)] = saved
                    source_key = "source-sha256:" + saved["sha256"]
                elif original.is_file():
                    warnings.append(f"源视频已改变：{metadata.get('source_name', original.name)}；仅按导入时来源记录归组。")
            except OSError:
                # Portable projects often do not include the original video.
                pass
        sequence_sources[sequence] = source_key
        for frame in metadata.get("frames", []):
            name = frame.get("name")
            if name in records:
                associations[name].add(source_key)
        for accepted in metadata.get("accepted", {}).values():
            name = accepted.get("name")
            if name in records:
                associations[name].add(source_key)
    for name, record in records.items():
        sequence = record["annotation"].get("tracking", {}).get("sequence")
        if sequence:
            associations[name].add(sequence_sources.get(str(sequence), "sequence:" + str(sequence)))
    return associations


def _group_images(project, records, cache, warnings):
    groups = _Components(records)
    video_sources = _video_sources(project, records, cache, warnings)
    seen_files, seen_pixels, seen_sources = {}, {}, {}
    for name, record in records.items():
        fp = record["fingerprint"]
        for value, seen, reason in ((fp["sha256"], seen_files, "identical-file"),
                                    (fp["pixels_sha256"], seen_pixels, "identical-pixels")):
            if value in seen:
                groups.join(seen[value], name, reason)
            else:
                seen[value] = name
        for source in sorted(video_sources[name]):
            if source in seen_sources:
                groups.join(seen_sources[source], name, "same-video-source", source=source)
            else:
                seen_sources[source] = name

    # Four dHash bands retrieve candidates. A hash is never sufficient to merge.
    # Bounded queues avoid quadratic scans on repeated textures or uniform data.
    buckets = defaultdict(lambda: deque(maxlen=MAX_CANDIDATES + 1))
    previous_verified = cache.get("verified_pairs", {})
    verified = {}
    truncated = 0

    @lru_cache(maxsize=4)
    def pixels(name):
        return np.asarray(_rgb(project.root / "images" / name), dtype=np.int16)

    for name, record in records.items():
        fp = record["fingerprint"]
        if fp["texture"] < POLICY["visual"]["min_spatial_std"]:
            continue  # Different uniform colours are different images.
        keys = [(tuple(fp["size"]), band, (fp["dhash"] >> (16 * band)) & 0xffff) for band in range(4)]
        candidates = sorted({candidate for key in keys for candidate in buckets[key]
                             if groups.find(candidate) != groups.find(name)})
        if len(candidates) > MAX_CANDIDATES:
            truncated += 1
            candidates = candidates[:MAX_CANDIDATES]
        thumb = np.frombuffer(base64.b64decode(fp["thumbnail"]), dtype=np.uint8).astype(np.int16)
        for candidate in candidates:
            if groups.find(candidate) == groups.find(name):
                continue
            other = records[candidate]["fingerprint"]
            if (fp["dhash"] ^ other["dhash"]).bit_count() > 8:
                continue
            other_thumb = np.frombuffer(base64.b64decode(other["thumbnail"]), dtype=np.uint8).astype(np.int16)
            if float(np.abs(thumb - other_thumb).mean()) > 2.0:
                continue
            pair = ":".join(sorted((fp["sha256"], other["sha256"])))
            result = previous_verified.get(pair)
            if result is None:
                delta = np.abs(pixels(name) - pixels(candidate)).astype(np.float32)
                mae = float(delta.mean())
                rmse = float(np.sqrt(np.square(delta).mean()))
                p99 = float(np.percentile(delta, 99))
                result = {"match": mae <= 2.0 and rmse <= 3.0 and p99 <= 12.0,
                          "mae": round(mae, 6), "rmse": round(rmse, 6), "p99": round(p99, 6)}
            verified[pair] = result
            if result["match"]:
                groups.join(candidate, name, "verified-near-pixels", **result)
        for key in keys:
            if len(buckets[key]) == buckets[key].maxlen:
                truncated += 1
            buckets[key].append(name)
    cache["verified_pairs"] = verified
    if truncated:
        warnings.append("相似图候选达到搜索上限；已知同源与完全重复仍整组划分，但视觉近重复扫描不是穷尽检查。")

    components = defaultdict(list)
    for name in records:
        components[groups.find(name)].append(name)
    edges = defaultdict(list)
    for edge in groups.edges:
        edges[groups.find(edge["a"])].append(edge)
    result = []
    for root, members in sorted(components.items()):
        sources = sorted({source for name in members for source in video_sources[name]})
        reasons = {edge["reason"] for edge in edges[root]}
        if sources:
            reasons.add("same-video-source")
        result.append({"id": "group-" + _stable(members)[:20], "members": members,
                       "reasons": sorted(reasons) or ["independent-image"],
                       "sources": sources, "evidence": edges[root]})
    return result


def _validation_groups(groups, target, seed):
    """Find closest image count without splitting a group; bounded memory/time."""
    shuffled = list(groups)
    random.Random(seed).shuffle(shuffled)
    total = sum(len(group["members"]) for group in groups)
    if total <= 100000:
        reachable, predecessors = 1, {}
        mask = (1 << total) - 1  # Exclude selecting every image.
        for group in shuffled:
            size = len(group["members"])
            additions = ((reachable << size) & mask) & ~reachable
            reachable |= additions
            while additions:
                bit = additions & -additions
                count = bit.bit_length() - 1
                predecessors[count] = (count - size, group["id"])
                additions ^= bit
        count = min(predecessors, key=lambda n: (abs(n - target), n))
        selected = set()
        while count:
            count, identifier = predecessors[count]
            selected.add(identifier)
        return selected
    order = {group["id"]: i for i, group in enumerate(shuffled)}
    by_size = sorted(shuffled, key=lambda g: (-len(g["members"]), order[g["id"]]))
    selected, count = set(), 0
    for group in by_size:
        size = len(group["members"])
        if abs(count + size - target) < abs(count - target) and len(selected) + 1 < len(groups):
            selected.add(group["id"])
            count += size
    # The best single group prevents e.g. an empty result when all groups exceed target.
    best_single = min(shuffled, key=lambda g: abs(len(g["members"]) - target))
    if not selected or abs(len(best_single["members"]) - target) < abs(count - target):
        selected = {best_single["id"]}
        count = len(best_single["members"])
    # One pass of toggles improves uneven groups without unbounded subset search.
    for group in reversed(by_size):
        chosen = group["id"] in selected
        change = -len(group["members"]) if chosen else len(group["members"])
        new_size = len(selected) + (-1 if chosen else 1)
        if 0 < new_size < len(groups) and abs(count + change - target) < abs(count - target):
            if chosen:
                selected.remove(group["id"])
            else:
                selected.add(group["id"])
            count += change
    return selected


def create_plan(project, options=None):
    """Return a deterministic plan shared by preview and snapshot construction."""
    split_file = project.root / "splits.json"
    frozen = read_json(split_file) if split_file.exists() else {}
    settings = project.split_settings(options if options else frozen.get("settings"))
    previous = frozen.get("assignments", frozen)
    if not isinstance(previous, dict):
        previous = {}
    previous = {key: value for key, value in previous.items() if value in ("train", "val")}
    recompute = bool(previous) and bool(options) and settings != frozen.get("settings")
    cache_path = project.root / ".cache" / "split-fingerprints.json"
    try:
        cache = read_json(cache_path) if cache_path.exists() else {}
    except (OSError, ValueError):
        cache = {}
    cache_before = _stable(cache)
    if cache.get("version") != VERSION:
        cache = {"version": VERSION}
    image_cache, current_cache = cache.get("images", {}), {}
    warnings, records, errors = [], {}, []
    for image in project.images:
        label = project.annotation(image)
        if not label.exists():
            continue
        annotation = read_json(label)
        if annotation.get("checked") is not True:
            continue
        try:
            stat = _stat(image)
            saved = image_cache.get(image.name, {})
            fp = saved.get("fingerprint") if saved.get("stat") == stat else None
            if fp is None:
                fp = _fingerprint(image)
            current_cache[image.name] = {"stat": stat, "fingerprint": fp}
            records[image.name] = {"annotation": annotation, "label_sha256": digest(label), "fingerprint": fp}
        except (OSError, ValueError) as error:
            errors.append(f"{image.name} 无法解码或读取：{error}")
    groups = _group_images(project, records, cache, warnings)
    cache["images"] = current_cache
    if cache != {"version": VERSION}:
        try:
            # Only rewrite a changed cache; frequent preview is otherwise read-only.
            if not cache_path.exists() or _stable(cache) != cache_before:
                write_json(cache_path, cache)
        except (OSError, ValueError):
            warnings.append("指纹缓存无法保存；下次检查需要重新读取图片。")
    total = len(records)
    target = (int(settings["count"]) if settings["mode"] == "count"
              else max(1, round(total * settings["ratio"] / 100)))
    target = min(max(0, total - 1), target)
    assignments = dict(previous) if not recompute else {}
    reason = ""
    if errors:
        reason = "；".join(errors)
    elif len(groups) < 2:
        reason = "至少需要两个独立来源组。当前已审核图片属于同一视频或相同/近重复内容；请增加另一独立视频或图片来源，不能拆开同组来建立验证集。"
    if previous and not recompute:
        conflicts = []
        for group in groups:
            parts = {previous[records[n]["fingerprint"]["sha256"]] for n in group["members"]
                     if records[n]["fingerprint"]["sha256"] in previous}
            if len(parts) > 1:
                conflicts.append(group["id"])
            part = next(iter(parts)) if len(parts) == 1 else "train"
            for name in group["members"]:
                assignments[records[name]["fingerprint"]["sha256"]] = part
        if conflicts:
            reason = (f"检测到 {len(conflicts)} 个来源/相似组跨越旧训练集与验证集（可能由新增帧连接旧分组）。"
                      "为避免泄漏已停止构建；请调整划分比例/数量/种子后重新划分。旧数据集与原图标注保持不变。")
    elif len(groups) >= 2:
        validation = _validation_groups(groups, target, settings["seed"])
        for group in groups:
            part = "val" if group["id"] in validation else "train"
            for name in group["members"]:
                assignments[records[name]["fingerprint"]["sha256"]] = part
    for group in groups:
        for name in group["members"]:
            assignments.setdefault(records[name]["fingerprint"]["sha256"], "train")
    validation_count = sum(assignments[r["fingerprint"]["sha256"]] == "val" for r in records.values())
    if not reason and not 0 < validation_count < total:
        reason = "当前已审核数据未覆盖固定训练集和验证集，请补审对应图片，或调整划分比例/数量/种子重新划分。"
    if validation_count != target and not reason:
        warnings.append(f"目标验证 {target} 张，实际 {validation_count} 张；整组保护或已有固定划分会使实际数量偏离目标。")
    if previous and recompute:
        warnings.append("本次参数已改变，将建立新的分组划分；已有数据集快照保持不变，新旧划分的实验结果不能直接归因于模型改动。")
    revision = _stable({"images": {n: [r["fingerprint"]["sha256"], r["label_sha256"]] for n, r in records.items()},
                        "groups": groups, "settings": settings, "assignments": assignments})
    preview = {"settings": settings, "images": total, "unique": len({r["fingerprint"]["sha256"] for r in records.values()}),
               "train": total - validation_count, "val": validation_count, "ready": not bool(reason),
               "groups": len(groups), "video_groups": sum(bool(g["sources"]) for g in groups),
               "similar_groups": sum(any(r in {"identical-file", "identical-pixels", "verified-near-pixels"} for r in g["reasons"]) for g in groups),
               "target_val": target, "actual_ratio": round(100 * validation_count / total, 2) if total else 0,
               "warnings": list(dict.fromkeys(warnings)), "reason": reason,
               "algorithm": ALGORITHM, "version": VERSION, "dataset_revision": revision}
    return {"preview": preview, "records": records, "groups": groups, "assignments": assignments,
            "metadata": {"algorithm": ALGORITHM, "version": VERSION, "policy": POLICY,
                         "groups": groups, "dataset_revision": revision, "summary": preview}}
