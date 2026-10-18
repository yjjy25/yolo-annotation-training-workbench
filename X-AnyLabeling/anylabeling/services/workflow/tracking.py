"""Conservative, model-free video propagation with explicit correction stops."""
from __future__ import annotations

import copy
import math
import base64
import time
from pathlib import Path
import sys

import cv2
import numpy as np

from .project import Project, digest, read_json, write_json
from .desktop import image_path, save_annotation
from .video import import_video, sequences
from .video_workspace import frame_store, frame_name, cache_path, archive_future_auto


PROFILES = {
    "strict": {"appearance": .80, "motion": .12, "fb": 1.0},
    "balanced": {"appearance": .68, "motion": .22, "fb": 1.5},
    "relaxed": {"appearance": .55, "motion": .32, "fb": 2.0},
}


class TrackingLost(ValueError):
    """A frame must be corrected before propagation can continue."""


def session(project, identifier):
    for record in sequences(project):
        if record.get("id") == identifier and record.get("tracking"):
            return record
    raise ValueError("请选择当前项目中的追踪视频。")


def create_session(project, args):
    if project.data["task"] == "classify":
        raise ValueError("视频追踪适用于目标框、姿态、分割和旋转框；整图分类请使用视频抽帧。")
    interval = float(args.get("interval", .2))
    if not math.isfinite(interval) or not .02 <= interval <= 60:
        raise ValueError("保存间隔应为 0.02～60 秒。")
    profile = args.get("profile", "balanced")
    if profile not in PROFILES:
        raise ValueError("请选择有效的追踪灵敏度。")
    store=frame_store(project)
    result = import_video(store, {**args, "step": 0, "limit": 1}, lambda _: None)
    record = next(r for r in sequences(store) if r["id"] == result["id"])
    record["kind"] = "tracking"
    record["storage"] = "video-work"
    record["tracking"] = {"status": "ready", "name": result["first"],
                          "message": "标注当前帧中的全部目标，再开始追踪。",
                          "interval": interval, "profile": profile}
    write_json(project.root / "videos" / record["id"] / "manifest.json", record)
    return record


def seed_data(project, record, name):
    if not any(f["name"] == name for f in record["frames"]):
        raise ValueError("起始帧不属于所选视频。")
    store=frame_store(project,record)
    path = image_path(store, name)
    label = store.annotation(path)
    if not label.exists():
        raise ValueError("请先在当前帧标注目标并保存，再开始追踪。")
    data = read_json(label)
    project.validate_annotation(data, name)
    if not data.get("shapes"):
        raise ValueError("当前帧没有目标，请标注目标，或在时间轴选择有目标的帧。")
    if record.get("storage")!="video-work" and data.get("tracking", {}).get("generated") and not data.get("checked"):
        raise ValueError("请先审核该自动帧，或从人工标注帧继续追踪。")
    return data, digest(label)


def advance_session(project, args):
    """Let the annotator seek past a missing target, without inventing labels."""
    record = session(project, args["id"])
    selected = next((f for f in record["frames"] if f["name"] == args["name"]), None)
    if selected is None:
        raise ValueError("当前帧不属于该视频。")
    number = selected["frame"] + max(1, round(record["fps"]))
    end = math.ceil(record["settings"]["end"] * record["fps"]) if record["settings"]["end"] else record["source_frames"]
    if end:
        number = min(number, end - 1)
    if number <= selected["frame"]:
        raise ValueError("已经到达所选视频片段结尾。")
    if record.get("storage")=="video-work":
        from .video_workspace import seek_frame
        return seek_frame(project,{"id":record["id"],"frame":number})
    source = Path(record["source"])
    if not source.is_file() or source.stat().st_size != record["source_bytes"] or source.stat().st_mtime_ns != record["source_mtime_ns"]:
        raise ValueError("原视频已移动或发生变化。")
    capture = cv2.VideoCapture(str(source))
    try:
        for _ in range(number + 1):
            if not capture.grab():
                raise ValueError("无法读取后续画面，可能已到视频结尾。")
        ok, image = capture.retrieve()
        if not ok:
            raise ValueError("视频帧解码失败。")
        name = f"{record['id']}_{number:09d}.jpg"
        path = project.root / "images" / name
        if not path.exists():
            ok, encoded = cv2.imencode(".jpg", image, [cv2.IMWRITE_JPEG_QUALITY, 95])
            if not ok:
                raise ValueError("视频帧保存失败。")
            with path.open("xb") as stream:
                stream.write(encoded.tobytes())
        if not any(f["name"] == name for f in record["frames"]):
            record["frames"].append({"name": name, "frame": number, "seconds": number / record["fps"]})
            record["frames"].sort(key=lambda f: f["frame"])
        record["tracking"].update(status="paused", name=name, message="已前进约 1 秒。目标重新出现后，标注当前帧再继续追踪。")
        write_json(project.root / "videos" / record["id"] / "manifest.json", record)
        return {"id": record["id"], "name": name}
    finally:
        capture.release()


def gray(image):
    return cv2.cvtColor(image, cv2.COLOR_BGR2GRAY)


def correlation(a, b, mask):
    a, b = a[mask > 0].astype(float), b[mask > 0].astype(float)
    if len(a) < 16 or min(a.std(), b.std()) < 3:
        return 0.0
    return float(np.corrcoef(a, b)[0, 1])


def flow(previous, current, points, tolerance):
    source = np.asarray(points, np.float32).reshape(-1, 1, 2)
    params = dict(winSize=(21, 21), maxLevel=3,
                  criteria=(cv2.TERM_CRITERIA_EPS | cv2.TERM_CRITERIA_COUNT, 30, .01))
    target, status, error = cv2.calcOpticalFlowPyrLK(previous, current, source, None, **params)
    if target is None:
        raise TrackingLost("目标特征丢失，请重新标注。")
    back, reverse, _ = cv2.calcOpticalFlowPyrLK(current, previous, target, None, **params)
    if back is None:
        raise TrackingLost("无法确认目标位置，请重新标注。")
    good = (status.ravel() > 0) & (reverse.ravel() > 0)
    good &= np.linalg.norm(back.reshape(-1, 2) - source.reshape(-1, 2), axis=1) <= tolerance
    good &= error.ravel() < 35
    h, w = current.shape
    xy = target.reshape(-1, 2)
    good &= np.isfinite(xy).all(axis=1) & (xy[:, 0] >= 0) & (xy[:, 0] < w) & (xy[:, 1] >= 0) & (xy[:, 1] < h)
    return xy, good


def shape_outline(shape):
    return Project.circle_polygon(shape["points"]) if shape["shape_type"] == "circle" else shape["points"]


def region_mask(shape, size):
    mask = np.zeros(size, np.uint8)
    cv2.fillPoly(mask, [np.rint(shape_outline(shape)).astype(np.int32)], 255)
    return mask


def transform_points(points, matrix):
    return cv2.transform(np.asarray(points, np.float32).reshape(-1, 1, 2), matrix).reshape(-1, 2)


def clip_outline(points, size):
    """Clip a polygon to the image without inventing off-image training coordinates."""
    h, w = size
    points = np.asarray(points, dtype=float).tolist()
    for axis, bound, lower in ((0, 0., True), (0, float(w), False),
                               (1, 0., True), (1, float(h), False)):
        if not points:
            break
        clipped = []
        previous = points[-1]
        previous_in = previous[axis] >= bound if lower else previous[axis] <= bound
        for point in points:
            inside = point[axis] >= bound if lower else point[axis] <= bound
            if inside != previous_in:
                fraction = (bound - previous[axis]) / (point[axis] - previous[axis])
                intersection = [previous[k] + fraction * (point[k] - previous[k]) for k in (0, 1)]
                intersection[axis] = bound
                clipped.append(intersection)
            if inside:
                clipped.append(point)
            previous, previous_in = point, inside
        points = clipped
    return np.asarray(points, dtype=np.float32).reshape(-1, 2)


def visible_correlation(reference, current, matrix, mask):
    """Ignore pixels whose motion maps outside the new frame, including warp padding."""
    size = (reference.shape[1], reference.shape[0])
    aligned = cv2.warpAffine(current, matrix, size,
                             flags=cv2.INTER_LINEAR | cv2.WARP_INVERSE_MAP)
    valid = cv2.warpAffine(np.full(current.shape, 255, np.uint8), matrix, size,
                           flags=cv2.INTER_NEAREST | cv2.WARP_INVERSE_MAP)
    overlap = cv2.bitwise_and(mask, valid)
    overlap = cv2.erode(overlap, np.ones((3, 3), np.uint8))
    return correlation(reference, aligned, overlap)


def motion_model(source, target):
    """Prefer stable similarity; use full affine when it explains real width/height change."""
    matrix, inliers = cv2.estimateAffinePartial2D(source, target, method=cv2.RANSAC,
                                                ransacReprojThreshold=2)
    if matrix is None or inliers is None or inliers.mean() < .6:
        raise TrackingLost("目标运动不一致，请重新标注。")
    if len(source) >= 10 and np.min(np.ptp(source, axis=0)) >= 6:
        affine, support = cv2.estimateAffine2D(source, target, method=cv2.RANSAC,
                                              ransacReprojThreshold=2)
        if affine is not None and support is not None and support.mean() >= .7:
            selected = support.ravel() > 0
            simple_error = np.median(np.linalg.norm(transform_points(source[selected], matrix) - target[selected], axis=1))
            affine_error = np.median(np.linalg.norm(transform_points(source[selected], affine) - target[selected], axis=1))
            if affine_error + .03 < simple_error * .85:
                matrix, inliers = affine, support
    return matrix, inliers.ravel() > 0


class Propagator:
    """Track latent full geometry and export only the visible part of each instance.

    Robust affine flow follows independent width/height changes. Geometry remains
    unclipped internally, so touching a boundary does not progressively shrink it.
    Appearance checks use only overlap that is actually visible in both frames.
    """
    def __init__(self, image, annotation, profile="balanced"):
        self.previous = gray(image)
        self.anchor = self.previous.copy()
        self.data = copy.deepcopy(annotation)
        self.rules = PROFILES[profile]
        self.scale_limits = {"strict": (.8, 1.25), "balanced": (.72, 1.4), "relaxed": (.65, 1.55)}[profile]
        self.objects = []
        self.steps = 0
        for index, shape in enumerate(self.data["shapes"]):
            if shape["shape_type"] == "point":
                continue
            mask = region_mask(shape, self.previous.shape)
            if self.features(self.previous, mask) is None:
                raise TrackingLost(f"{shape['label']} 的纹理不足，无法可靠追踪，请调整目标框或更换起始帧。")
            self.objects.append({"index": index, "mask": mask, "matrix": np.eye(3)})
        if not self.objects:
            raise ValueError("需要至少一个目标框或轮廓。")

    @staticmethod
    def features(image, mask):
        # Boundary/background pixels are unreliable when the target grows or leaves.
        interior = cv2.erode(mask, np.ones((3, 3), np.uint8))
        features = cv2.goodFeaturesToTrack(image, 180, .01, 3, mask=interior)
        return features if features is not None and len(features) >= 4 else None

    def step(self, image):
        current = gray(image)
        if current.shape != self.previous.shape:
            raise TrackingLost("视频尺寸发生变化，请重新标注。")
        difference = float(np.abs(cv2.resize(current, (96, 64)).astype(float) -
                                  cv2.resize(self.previous, (96, 64)).astype(float)).mean() / 255)
        if difference > .38:
            raise TrackingLost("相邻画面变化过大或发生切镜，请重新标注。")
        h, w = current.shape
        data = copy.deepcopy(self.data)
        next_matrices = []
        for obj in self.objects:
            shape = self.data["shapes"][obj["index"]]
            mask = region_mask(shape, current.shape)
            features = self.features(self.previous, mask)
            if features is None:
                raise TrackingLost(f"{shape['label']} 可见区域的特征不足，请重新标注。")
            target, good = flow(self.previous, current, features, self.rules["fb"])
            if good.sum() < 4:
                raise TrackingLost(f"{shape['label']} 丢失或被大面积遮挡，请重新标注。")
            source = features.reshape(-1, 2)
            matrix, inliers = motion_model(source[good], target[good])
            scales = np.linalg.svd(matrix[:, :2], compute_uv=False)
            outline = np.asarray(shape_outline(shape), dtype=np.float32)
            centre = outline.mean(axis=0)
            moved = transform_points([centre], matrix)[0]
            diagonal = max(16, np.linalg.norm(np.ptp(outline, axis=0)))
            if (np.linalg.det(matrix[:, :2]) <= 0 or scales.min() < self.scale_limits[0]
                    or scales.max() > self.scale_limits[1] or scales.max() / scales.min() > 1.6
                    or np.linalg.norm(moved - centre) > max(6, diagonal * self.rules["motion"])):
                raise TrackingLost(f"{shape['label']} 位移或大小变化过大，请重新标注。")
            predicted = transform_points(source, matrix)
            expected = ((predicted[:, 0] >= 1) & (predicted[:, 0] < w - 1) &
                        (predicted[:, 1] >= 1) & (predicted[:, 1] < h - 1))
            # Features expected to leave the frame are not counted as lost matches.
            if (good & expected).sum() < max(4, expected.sum() * .5):
                raise TrackingLost(f"{shape['label']} 可见部分匹配不可靠，请重新标注。")
            next_outline = transform_points(outline, matrix)
            clipped = clip_outline(next_outline, current.shape)
            full_area = abs(cv2.contourArea(next_outline))
            visible_area = abs(cv2.contourArea(clipped)) if len(clipped) >= 3 else 0
            if visible_area < max(20, full_area * .18):
                raise TrackingLost(f"{shape['label']} 大部分移出画面，可见区域不足，请重新标注。")
            combined = np.vstack([matrix, [0, 0, 1]]) @ obj["matrix"]
            score = visible_correlation(self.previous, current, matrix, mask)
            anchor_score = visible_correlation(self.anchor, current, combined[:2], obj["mask"])
            if (not math.isfinite(score) or score < self.rules["appearance"]
                    or not math.isfinite(anchor_score) or anchor_score < max(.25, self.rules["appearance"] - .35)):
                raise TrackingLost(f"{shape['label']} 外观变化或追踪漂移，可靠度 {max(0, score):.0%}，请重新标注。")
            indices = [obj["index"]]
            if shape.get("group_id") is not None:
                indices += [i for i, s in enumerate(self.data["shapes"]) if s["shape_type"] == "point" and s.get("group_id") == shape["group_id"]]
            for index in indices:
                old, new = self.data["shapes"][index], data["shapes"][index]
                points = transform_points(old["points"], matrix)
                if old["shape_type"] == "point" and not old.get("difficult"):
                    p, q = old["points"][0], points[0]
                    old_inside = 0 <= p[0] < w and 0 <= p[1] < h
                    new_inside = 0 <= q[0] < w and 0 <= q[1] < h
                    border_distance = min(p[0], p[1], w - 1 - p[0], h - 1 - p[1],
                                          q[0], q[1], w - 1 - q[0], h - 1 - q[1])
                    object_at_edge = ((next_outline.min(axis=0) <= 2).any()
                                      or (next_outline.max(axis=0) >= [w - 2, h - 2]).any())
                    edge_point = border_distance < 16 or (object_at_edge and border_distance < 32)
                    if old_inside and new_inside and edge_point:
                        # LK's landmark patch is incomplete at the border. Keep the
                        # object-supported estimate, explicitly marked as uncertain.
                        new["difficult"] = True
                    elif old_inside and new_inside:
                        local, valid = flow(self.previous, current, old["points"], self.rules["fb"])
                        if not valid.all() or np.linalg.norm(local - points) > max(4, diagonal * .15):
                            raise TrackingLost(f"骨点 {old['label']} 丢失或跳动，请重新标注。")
                        patch_a = cv2.getRectSubPix(self.previous, (11, 11), tuple(map(float, p)))
                        patch_b = cv2.getRectSubPix(current, (11, 11), tuple(map(float, local[0])))
                        if correlation(patch_a, patch_b, np.full((11, 11), 255, np.uint8)) < self.rules["appearance"]:
                            raise TrackingLost(f"骨点 {old['label']} 局部外观不可靠，请重新标注。")
                        points = local
                    elif new_inside:
                        # Re-entering landmarks are estimates until the annotator checks them.
                        new["difficult"] = True
                if old["shape_type"] == "circle":
                    centre = transform_points([old["points"][0]], matrix)[0]
                    rx, ry = Project.circle_radii(old["points"])
                    radii = np.sqrt((matrix[:, :2] ** 2) @ np.array([rx ** 2, ry ** 2]))
                    points = np.array([centre, radii, [centre[0], centre[1] + radii[1]]])
                new["points"] = points.tolist()
            next_matrices.append(combined)
        # Commit atomically only after all objects pass. Keep full geometry in memory.
        exported = copy.deepcopy(data)
        visible_shapes = []
        for shape in exported["shapes"]:
            points = np.asarray(shape["points"], dtype=np.float32)
            kind = shape["shape_type"]
            if kind == "point":
                if not (0 <= points[0, 0] < w and 0 <= points[0, 1] < h):
                    continue  # Out-of-image keypoints export as v=0; never clamp to a fake location.
            else:
                outline = np.asarray(shape_outline(shape), dtype=np.float32)
                truncated = bool((outline < 0).any() or (outline[:, 0] > w).any() or (outline[:, 1] > h).any())
                if kind == "rectangle":
                    low, high = np.clip(outline.min(axis=0), [0, 0], [w, h]), np.clip(outline.max(axis=0), [0, 0], [w, h])
                    points = np.array([low, [high[0], low[1]], high, [low[0], high[1]]])
                elif kind == "polygon" or (kind == "circle" and truncated):
                    points = clip_outline(outline, current.shape)
                    shape["shape_type"] = "polygon"
                elif kind == "rotation":
                    points = np.clip(points, [0, 0], [w, h])
                if truncated:
                    shape["tracking_truncated"] = True
                else:
                    shape.pop("tracking_truncated", None)
            if not np.isfinite(points).all():
                raise TrackingLost(f"{shape['label']} 位置无效，请重新标注。")
            shape["points"] = points.tolist()
            visible_shapes.append(shape)
        exported["shapes"] = visible_shapes
        exported["checked"] = data["checked"] = False
        for obj, matrix in zip(self.objects, next_matrices):
            obj["matrix"] = matrix
        self.previous, self.data = current, data
        self.steps += 1
        return exported


def run(project, args, report, cancelled=lambda: False, preview=None):
    mode=args.get("mode", "direct")
    if mode not in {"direct", "play"}:
        raise ValueError("请选择逐帧播放或直接追踪。")
    if mode=="play" and preview is None:
        raise ValueError("逐帧播放需要预览连接。")
    record = session(project, args["id"])
    store=frame_store(project,record)
    manifest = project.root / "videos" / record["id"] / "manifest.json"
    annotation, seed_hash = seed_data(project, record, args["name"])
    if args.get("seed_hash", seed_hash) != seed_hash:
        raise ValueError("起始标注发生变化，请重新开始追踪。")
    source = Path(record["source"])
    if not source.is_file() or source.stat().st_size != record["source_bytes"] or source.stat().st_mtime_ns != record["source_mtime_ns"]:
        raise ValueError("原视频已移动或发生变化，请恢复原视频后继续。")
    tracking = record["tracking"]
    tracking["mode"] = mode
    start = next(f for f in record["frames"] if f["name"] == args["name"])["frame"]
    fps = record["fps"]
    stride = max(1, round(tracking["interval"] * fps))
    stop = math.ceil(record["settings"]["end"] * fps) if record["settings"]["end"] else record["source_frames"]
    generated, index, last_name = 0, start, args["name"]

    def status(state, message, name=last_name):
        tracking.update(status=state, message=message, name=name, frame=index, generated=generated)
        write_json(manifest, record)
        result = {**tracking, "id": record["id"]}
        report(result)
        return result

    def publish(frame, number, data=None):
        name = frame_name(record,number)
        destination = store.root / "images" / name
        label=store.annotation(name)
        old=read_json(label) if label.exists() else None
        if destination.exists() or old is not None:
            if record.get("storage")!="video-work" or (old is not None and (old.get("tracking",{}).get("manual_edited") or name in record.get("accepted",{}))):
                return name, False
        if not destination.exists():
            ok, encoded = cv2.imencode(".jpg", frame, [cv2.IMWRITE_JPEG_QUALITY, 95])
            if not ok:raise ValueError("视频帧保存失败。")
            with destination.open("xb") as stream:stream.write(encoded.tobytes())
        if not any(f["name"]==name for f in record["frames"]):
            record["frames"].append({"name": name, "frame": number, "seconds": number / fps})
        record["frames"].sort(key=lambda f: f["frame"])
        write_json(manifest, record)
        if data is not None:
            data["tracking"] = {"generated": True, "algorithm": "LK-adaptive-affine-visible-overlap-v2", "sequence": record["id"], "seed": args["name"], "seed_hash": seed_hash, "frame": number}
            save_annotation(store, name, data, digest(label), checked=False,automated=True)
        return name, True

    def stop_current(message, state="stopped"):
        nonlocal last_name, generated
        if index > start:
            last_name, created = publish(image, index, data)
            generated += int(created)
        return status(state, message, last_name)

    capture = cv2.VideoCapture(str(source))
    try:
        if not capture.isOpened():
            raise ValueError("无法打开原视频。")
        # Decode to exact seed frame rather than relying on codec keyframe seek.
        for number in range(start + 1):
            if cancelled():
                return status("stopped", "已暂停。重新打开已标注帧可继续。", last_name)
            if not capture.grab():
                raise ValueError("起始视频帧无法解码。")
        ok, image = capture.retrieve()
        if not ok:
            raise ValueError("起始视频帧无法解码。")
        try:
            tracker = Propagator(image, annotation, tracking["profile"])
        except TrackingLost as error:
            return status("paused", str(error), last_name)
        archive_future_auto(project,record,start)
        status("running", "正在逐帧追踪，按保存间隔写入待审核标注。", last_name)
        while not stop or index + 1 < stop:
            if cancelled():
                return stop_current("已暂停，当前有效帧与已有自动标注已保留。审核后可继续。")
            ok, next_image = capture.read()
            if not ok:
                if stop and index + 1 < stop:
                    raise ValueError(f"原帧 {index + 1} 解码失败，已停止；已有标注保留。")
                break
            image = next_image
            index += 1
            current_name=frame_name(record,index)
            existing=store.annotation(current_name)
            if record.get("storage")=="video-work" and existing.exists():
                previous=read_json(existing)
                if previous.get("tracking",{}).get("manual_edited") or current_name in record.get("accepted",{}):
                    return status("paused","遇到人工修正或已确认帧，已保留内容。检查该帧后继续。",current_name)
            try:
                data = tracker.step(image)
            except TrackingLost as error:
                name, _ = publish(image, index)
                return status("paused", str(error) + " 当前帧不写入自动标注；标完后继续。", name)
            if record.get("storage")=="video-work":
                data["tracking"]={"generated":True,"algorithm":"LK-adaptive-affine-visible-overlap-v2","sequence":record["id"],"seed":args["name"],"seed_hash":seed_hash,"frame":index}
                data.update(checked=False,imagePath="../images/"+current_name,imageData=None)
                write_json(cache_path(project,record,index),data)
            if (index - start) % stride == 0:
                name, created = publish(image, index, data)
                if not created:
                    return status("paused", "遇到已有帧或标注，已保留原内容。检查当前帧后继续。", name)
                last_name = name
                generated += 1
            if mode=="play":
                report({**tracking,"status":"running","frame":index,"generated":generated,
                        "preview_frame":index,"fps":fps,"id":record["id"],"name":last_name,
                        "message":"逐帧播放中，每帧显示后继续追踪。"})
                try:
                    if not preview(image, index, data):
                        return stop_current("已暂停播放，当前有效帧已保存，审核后可继续。")
                except TrackingLost as error:
                    return stop_current(str(error), "paused")
            if index % 10 == 0:
                status("running", "正在追踪，自动结果已保存为待审核。", last_name)
            # Bound cumulative deformation and disk growth even in difficult scenes.
            if index - start >= round(fps * 30) or generated >= 500:
                name, _ = publish(image, index)
                return status("paused", "已到 30 秒或 500 帧检查点，请检查当前帧后继续，避免累计漂移。", name)
        if index > start and not any(f["frame"] == index for f in record["frames"]):
            last_name, created = publish(image, index, data)
            generated += int(created)
        return status("completed", "已追踪到所选片段结尾。自动帧已保存，请审核后用于训练。", last_name)
    finally:
        capture.release()


def main(payload):
    args = read_json(payload)
    report_path = Path(payload).with_name("progress.json")
    def present(image, frame, annotation):
        ok, encoded=cv2.imencode(".jpg",image,[cv2.IMWRITE_JPEG_QUALITY,85])
        if not ok:
            raise TrackingLost("预览帧编码失败，已暂停。")
        data=copy.deepcopy(annotation)
        data.update(imageWidth=image.shape[1],imageHeight=image.shape[0],checked=False)
        preview_path=Path(payload).with_name(f"preview-{frame}.json")
        write_json(preview_path,{"frame":frame,"annotation":data,
                   "image_url":"data:image/jpeg;base64,"+base64.b64encode(encoded.tobytes()).decode("ascii")})
        deadline=time.monotonic()+20
        ack=Path(payload).with_name(f"preview-ack-{frame}")
        while not ack.exists():
            if Path(payload).with_name("cancel").exists():
                return False
            if time.monotonic()>deadline:
                raise TrackingLost("逐帧播放预览未响应，已暂停；已有结果保留。")
            time.sleep(.02)
        for path in (preview_path,ack):
            try:path.unlink(missing_ok=True)
            except OSError:pass
        return True
    try:
        run(Project(args["root"]), args, lambda value: write_json(report_path, value),
            lambda: Path(payload).with_name("cancel").exists(),
            present if args.get("mode")=="play" else None)
    except Exception as error:
        write_json(report_path, {"status": "failed", "error": str(error), "id": args.get("id")})
        try:
            project = Project(args["root"])
            record = session(project, args["id"])
            record["tracking"].update(status="failed", message=str(error))
            write_json(project.root / "videos" / record["id"] / "manifest.json", record)
        except Exception:
            pass
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1]))
