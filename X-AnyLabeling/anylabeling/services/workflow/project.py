"""Portable project metadata, validated skeletons and reviewed dataset snapshots."""
from __future__ import annotations

import hashlib
import json
import os
import random
import shutil
import tempfile
import uuid
from datetime import datetime
from pathlib import Path

import yaml

TASKS = {"detect": "目标检测", "segment": "实例分割", "pose": "姿态估计", "obb": "旋转框检测", "classify": "图像分类"}
IMAGE_EXTENSIONS = {".jpg", ".jpeg", ".png", ".bmp", ".webp", ".tif", ".tiff"}


def read_json(path):
    return json.loads(Path(path).read_text(encoding="utf-8"))


def write_json(path, data):
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, temporary = tempfile.mkstemp(prefix=".save-", dir=path.parent)
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as stream:
            json.dump(data, stream, ensure_ascii=False, indent=2)
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(temporary, path)
    finally:
        if os.path.exists(temporary):
            os.unlink(temporary)


def digest(path):
    path = Path(path)
    if not path.exists():
        return None
    with path.open("rb") as stream:
        return hashlib.file_digest(stream, "sha256").hexdigest()


def validate_template(template):
    points = template.get("points", [])
    if not points or len(points) > 256:
        raise ValueError("请输入 1～256 个骨点名称。")
    if any(not isinstance(name, str) or not name.strip() for name in points) or len(set(points)) != len(points):
        raise ValueError("骨点名称不能为空或重复。")
    for key in ("edges", "pairs"):
        seen = set()
        used = set()
        for pair in template.get(key, []):
            if len(pair) != 2 or pair[0] == pair[1] or any(type(i) is not int or not 0 <= i < len(points) for i in pair):
                raise ValueError("连线/左右配对必须引用两个有效且不同的骨点编号。")
            entry = tuple(sorted(pair))
            if entry in seen:
                raise ValueError("连线或配对重复。")
            if key == "pairs" and any(i in used for i in pair):
                raise ValueError("每个骨点只能参与一组左右配对。")
            seen.add(entry)
            used.update(pair)
    return template


def template_hash(template):
    return hashlib.sha256(json.dumps(validate_template(template), sort_keys=True, ensure_ascii=False).encode()).hexdigest()


class Project:
    def __init__(self, root):
        self.root = Path(root).resolve()
        self.data = read_json(self.root / "project.json")
        if self.data.get("version") != 1 or self.data.get("task") not in TASKS:
            raise ValueError("项目版本或任务类型不受支持。")
        if self.data["task"] == "pose":
            validate_template(self.data["template"])

    @classmethod
    def create(cls, root, name, task, classes, source=None, template=None):
        root = Path(root).resolve()
        if (root / "project.json").exists():
            raise ValueError("这里已有项目，请使用打开项目。")
        if task not in TASKS or not classes or len(set(classes)) != len(classes):
            raise ValueError("任务无效，或类别为空/重复。")
        if any(not c.strip() or any(ch in c for ch in '/\\:') or c in {".", ".."} for c in classes):
            raise ValueError("类别名称不能为空或包含路径字符。")
        if task == "pose":
            validate_template(template or {})
        for folder in ("images", "annotations", "templates", "proposals", "datasets", "runs", "models", "backups"):
            (root / folder).mkdir(parents=True, exist_ok=True)
        # Copy, never move or edit the source images/annotations. Flatten with collision protection.
        if source:
            source = Path(source).resolve()
            if source == root or root.is_relative_to(source):
                raise ValueError("项目目录不能放在导入图片目录内部，以免循环导入。")
            seen = set()
            files = sorted(p for p in source.rglob("*") if p.is_file() and p.suffix.lower() in IMAGE_EXTENSIONS)
            if not files:
                raise ValueError("所选目录没有支持的图片。")
            for image in files:
                if image.stem.casefold() in seen:
                    raise ValueError("存在同名图片（含不同后缀）。请先区分文件名，避免标注冲突。")
                seen.add(image.stem.casefold())
            for image in files:
                target = root / "images" / image.name
                if target.exists() or (root / "annotations" / (image.stem + ".json")).exists():
                    raise ValueError("目标目录已有同名数据，请选择新的空项目目录。")
            imported = {image: read_json(image.with_suffix(".json")) for image in files if image.with_suffix(".json").exists()}
            for image in files:
                shutil.copy2(image, root / "images" / image.name)
                label = image.with_suffix(".json")
                if image in imported:
                    annotation = imported[image]
                    annotation["imagePath"] = "../images/" + image.name
                    write_json(root / "annotations" / label.name, annotation)
        write_json(root / "project.json", {"version": 1, "name": name, "task": task, "classes": classes, "template": template, "split_seed": 42})
        instance = cls(root)
        instance.save()
        return instance

    @property
    def images(self):
        return sorted(p for p in (self.root / "images").iterdir() if p.is_file() and p.suffix.lower() in IMAGE_EXTENSIONS)

    def annotation(self, image):
        return self.root / "annotations" / (Path(image).stem + ".json")

    def remove_image(self, image, purge=False):
        """Drop a picture that should not be in the dataset at all.

        Used when a photo is unusable (blurred, duplicate, not the target class):
        it must leave the project rather than linger as an unreviewed file that
        keeps asking to be labelled.

        By default the files move to ``removed/`` so the decision stays reversible.
        Pass ``purge=True`` to delete them outright. The image, its annotation, its
        cached proposal and its split assignment all go together, otherwise the
        split preview would keep counting a picture that no longer exists.
        """
        path = Path(image)
        if path.parent != (self.root / "images"):
            path = self.root / "images" / path.name
        if not path.is_file():
            raise ValueError(f"找不到图片：{path.name}")
        stem = path.stem
        content_hash = digest(path)
        # Archived under the same relative layout the project uses, so a restore is
        # a plain copy back.
        targets = [
            (path, self.root / "removed" / "images" / path.name, "images/" + path.name),
            (self.root / "annotations" / (stem + ".json"), self.root / "removed" / "annotations" / (stem + ".json"), "annotations/" + stem + ".json"),
            (self.root / "proposals" / "latest" / (stem + ".json"), self.root / "removed" / "proposals" / (stem + ".json"), "proposals/" + stem + ".json"),
        ]
        removed = []
        for source, destination, label in targets:
            if not source.exists():
                continue
            if purge:
                source.unlink()
            else:
                destination.parent.mkdir(parents=True, exist_ok=True)
                if destination.exists():
                    destination = destination.with_name(destination.stem + "_" + uuid.uuid4().hex[:6] + destination.suffix)
                shutil.move(str(source), str(destination))
            removed.append(label)

        # A stale split entry would inflate the training/validation counts.
        splits_path = self.root / "splits.json"
        dropped = 0
        if splits_path.exists():
            data = read_json(splits_path)
            assignments = data.get("assignments")
            if isinstance(assignments, dict):
                still_present = any(digest(p) == content_hash for p in self.images)
                for key in [k for k in assignments if Path(k).stem == stem or (k == content_hash and not still_present)]:
                    assignments.pop(key)
                    dropped += 1
                if dropped:
                    write_json(splits_path, data)
        return {"name": path.name, "removed": removed, "split_entries": dropped, "purged": bool(purge)}

    def save(self):
        write_json(self.root / "project.json", self.data)
        if self.data["task"] == "pose":
            template = validate_template(self.data["template"])
            config = {"has_visible": True, "classes": {c: template["points"] for c in self.data["classes"]}}
            (self.root / "templates" / "pose.yaml").write_text(yaml.safe_dump(config, allow_unicode=True, sort_keys=False), encoding="utf-8")
            write_json(self.root / "templates" / (template_hash(template) + ".json"), template)

    def counts(self):
        result = {"total": 0, "checked": 0, "draft": 0}
        for image in self.images:
            result["total"] += 1
            path = self.annotation(image)
            if path.exists():
                data = read_json(path)
                result["checked" if data.get("checked") is True else "draft"] += 1
        return result

    def split_settings(self, options=None):
        """Normalise the requested split configuration."""
        options = options or {}
        mode = options.get("split_mode") or options.get("mode") or "ratio"
        if mode not in {"ratio", "count"}:
            mode = "ratio"
        try:
            ratio = float(options.get("split_ratio", options.get("ratio", 20)))
        except (TypeError, ValueError):
            ratio = 20.0
        ratio = min(50.0, max(5.0, ratio))
        try:
            count = int(options.get("split_count", options.get("count", 1)))
        except (TypeError, ValueError):
            count = 1
        count = max(1, count)
        try:
            seed = int(options.get("split_seed", options.get("seed", self.data.get("split_seed", 42))))
        except (TypeError, ValueError):
            seed = 42
        return {"mode": mode, "ratio": ratio, "count": count, "seed": seed}

    def split_preview(self, options=None):
        """How many reviewed images would land in each split, without freezing anything."""
        settings = self.split_settings(options)
        eligible, groups = [], {}
        for image in self.images:
            label = self.annotation(image)
            if label.exists() and read_json(label).get("checked") is True:
                eligible.append(image)
                groups.setdefault(digest(image), []).append(image)
        hashes = sorted(groups)
        if len(hashes) < 2:
            return {"settings": settings, "images": len(eligible), "unique": len(hashes), "train": len(eligible), "val": 0, "ready": False}
        if settings["mode"] == "count":
            validate = min(len(hashes) - 1, int(settings["count"]))
        else:
            validate = min(len(hashes) - 1, max(1, round(len(hashes) * settings["ratio"] / 100)))
        validate = max(1, validate)
        shuffled = list(hashes)
        random.Random(settings["seed"]).shuffle(shuffled)
        validation = set(shuffled[:validate])
        split_path = self.root / "splits.json"
        if split_path.exists():
            frozen = read_json(split_path)
            assignments = frozen.get("assignments", frozen)
            if assignments and (not options or settings == frozen.get("settings")):
                validation = {h for h in hashes if assignments.get(h, "train") == "val"}
        return {
            "settings": settings,
            "images": len(eligible),
            "unique": len(hashes),
            "train": sum(len(groups[h]) for h in hashes if h not in validation),
            "val": sum(len(groups[h]) for h in validation if h in groups),
            "ready": bool(validation) and len(validation) < len(hashes),
        }

    def build_dataset(self, options=None):
        """Freeze reviewed data, retaining existing splits and grouping byte-identical images.

        ``options`` may carry ``mode`` ('ratio' or 'count'), ``ratio`` (percent),
        ``count`` (exact validation images) and ``seed``. When the caller asks for
        a different split than the one already frozen, the assignment is rebuilt
        from scratch; otherwise new images are appended to the training set so
        repeated runs stay comparable.
        """
        from anylabeling.views.labeling.label_converter import LabelConverter
        eligible = []
        for image in self.images:
            label = self.annotation(image)
            if label.exists() and read_json(label).get("checked") is True:
                eligible.append(image)
        if len(eligible) < 2:
            raise ValueError("至少需要两张人工审核通过的图片，用于建立训练集和验证集。")
        groups = {}
        for image in eligible:
            groups.setdefault(digest(image), []).append(image)
        if len(groups) < 2:
            raise ValueError("至少需要两张内容不同的已审核图片。")
        split_path = self.root / "splits.json"
        splits = read_json(split_path) if split_path.exists() else {}
        settings = self.split_settings(options)
        seen = read_json(split_path) if split_path.exists() else {}
        previous = seen.get("settings") if isinstance(seen.get("settings"), dict) else {}
        assignments = seen.get("assignments") if isinstance(seen.get("assignments"), dict) else seen
        recompute = bool(assignments) and bool(options) and settings != previous
        if not assignments or recompute:
            hashes = sorted(groups)
            random.Random(settings["seed"]).shuffle(hashes)
            if settings["mode"] == "count":
                count = max(1, min(len(hashes) - 1, int(settings["count"])))
            else:
                count = max(1, round(len(hashes) * settings["ratio"] / 100))
                count = min(count, len(hashes) - 1)
            assignments = {h: ("val" if i < count else "train") for i, h in enumerate(hashes)}
        else:
            assignments = dict(assignments)
            assignments.update({h: "train" for h in groups if h not in assignments})
        if not all(any(assignments[h] == part for h in groups) for part in ("train", "val")):
            raise ValueError("当前已审核数据未覆盖固定训练集和验证集，请补审对应图片，或调整划分比例/数量。")
        write_json(split_path, {"settings": settings, "assignments": assignments})
        splits = assignments
        stamp = datetime.now().strftime("%Y%m%d_%H%M%S_") + uuid.uuid4().hex[:6]
        target = self.root / "datasets" / stamp
        target.mkdir(parents=True)
        task = self.data["task"]
        converter = LabelConverter(pose_cfg_file=str(self.root / "templates" / "pose.yaml")) if task == "pose" else LabelConverter()
        converter.classes = self.data["classes"]
        manifest = []
        for content_hash, images in groups.items():
            part = splits[content_hash]
            for image in images:
                label = self.annotation(image)
                data = read_json(label)
                if task == "classify":
                    names = [c for c, enabled in data.get("flags", {}).items() if enabled and c in self.data["classes"]]
                    if len(names) != 1:
                        raise ValueError(f"{image.name}：分类任务必须选择一个类别。")
                    destination = target / part / names[0] / image.name
                else:
                    destination = target / "images" / part / image.name
                destination.parent.mkdir(parents=True, exist_ok=True)
                shutil.copy2(image, destination)
                archived = target / "annotations" / label.name
                write_json(archived, data)
                if task != "classify":
                    out = target / "labels" / part / (image.stem + ".txt")
                    out.parent.mkdir(parents=True, exist_ok=True)
                    self.validate_annotation(data, image.name)
                    self.prepare_yolo_annotations(label, out, task, image.name, converter)
                manifest.append({"image": image.name, "image_sha256": content_hash, "label_sha256": digest(label), "split": part})
        config = {"path": target.as_posix(), "train": "images/train", "val": "images/val", "names": dict(enumerate(self.data["classes"]))}
        if task == "pose":
            template = self.data["template"]
            config["kpt_shape"] = [len(template["points"]), 3]
            flip = list(range(len(template["points"])))
            for a, b in template.get("pairs", []):
                flip[a], flip[b] = b, a
            # Training UI disables flipping when pairs are absent.
            config["flip_idx"] = flip if template.get("pairs") else []
        (target / "data.yaml").write_text(yaml.safe_dump(config, allow_unicode=True, sort_keys=False), encoding="utf-8")
        write_json(target / "manifest.json", {"project": self.data, "images": manifest, "source_grouping": "exact-content only; video/scene grouping requires user-supplied split"})
        return target if task == "classify" else target / "data.yaml"

    def task_shapes(self):
        return {"detect": "矩形框、多边形或圆形", "segment": "多边形或圆形", "pose": "矩形框与关键点", "obb": "旋转框", "classify": "整图类别"}[self.data["task"]]

    def prepare_yolo_annotations(self, label, target, task, filename, converter):
        """Write a YOLO label file, converting shapes this task cannot store.

        A detection project may hold polygons and circles; Ultralytics detection
        only understands boxes, so those are written as their bounding box. The
        archived JSON keeps the original geometry.
        """
        data = read_json(label)
        shapes = data.get("shapes", [])
        if task in {"detect", "segment"} and any(s.get("shape_type") in {"polygon", "circle", "rotation"} for s in shapes):
            converted = dict(data)
            shapes = []
            for shape in data.get("shapes", []):
                if shape.get("shape_type") == "circle":
                    points = [list(point) for point in self.circle_polygon(shape["points"])]
                    shape = {**shape, "shape_type": "polygon", "points": points}
                if task == "detect" and shape.get("shape_type") != "rectangle":
                    points = shape["points"]
                    x1, y1 = min(p[0] for p in points), min(p[1] for p in points)
                    x2, y2 = max(p[0] for p in points), max(p[1] for p in points)
                    shape = {**shape, "shape_type": "rectangle", "points": [[x1,y1],[x2,y1],[x2,y2],[x1,y2]]}
                shapes.append(shape)
            converted["shapes"] = shapes
            temporary = label.with_name(label.stem + ".workflow-tmp.json")
            write_json(temporary, converted)
            try:
                converter.custom_to_yolo(str(temporary), str(target), "hbb" if task == "detect" else "seg")
            finally:
                temporary.unlink(missing_ok=True)
            return
        converter.custom_to_yolo(str(label), str(target), {"detect": "hbb", "segment": "seg", "pose": "pose", "obb": "obb"}[task])

    @staticmethod
    def circle_radii(points):
        """The horizontal and vertical radius of a round mark.

        The canvas form is ``[centre, [rx, ry], bottom]``; the older two-point form
        is ``[centre, corner]`` and takes both radii from the offset.
        """
        if len(points) == 3 and isinstance(points[1], (list, tuple)) and len(points[1]) == 2:
            return abs(points[1][0]), abs(points[1][1])
        (cx, cy) = points[0]
        ex, ey = points[1]
        return abs(ex - cx), abs(ey - cy)

    @staticmethod
    def circle_polygon(points, count=32):
        """Outline of a round mark.

        Accepts ``[centre, [rx, ry]]`` (what the canvas writes: the horizontal and
        vertical radius are independent, so an ellipse stays an ellipse) and the
        older ``[centre, edge]`` form, where the edge corner gives both radii.
        """
        if len(points) < 2:
            return points
        (cx, cy) = points[0]
        # The canvas writes [centre, [rx, ry], bottom] so the two radii are
        # independent and the shape is unambiguously not the older [centre, corner]
        # form (a two-point label, whose second point is a corner).
        rx, ry = Project.circle_radii(points)
        rx, ry = rx or 1, ry or 1
        import math
        return [[cx + math.cos(i / count * 2 * math.pi) * rx, cy + math.sin(i / count * 2 * math.pi) * ry] for i in range(count)]

    # Shapes may hang a little past the image edge: a rotated box sweeps wider
    # than its upright self, and refusing that made rotation feel stuck.
    POINT_MARGIN = 1.0

    def validate_annotation(self, data, filename="图片"):
        width, height = data.get("imageWidth", 0), data.get("imageHeight", 0)
        if width <= 0 or height <= 0:
            raise ValueError(f"{filename}：图片尺寸无效。")
        limit_x, limit_y = width + self.POINT_MARGIN, height + self.POINT_MARGIN
        task = self.data["task"]
        # Detection additionally accepts polygons and circles for round or
        # irregular targets; they are converted when the dataset is built.
        allowed = {
            "detect": {"rectangle", "polygon", "rotation", "circle"},
            "segment": {"polygon", "circle"},
            "pose": {"point", "rectangle"},
            "obb": {"rotation"},
            "classify": set(),
        }[task]
        groups = {}
        for shape in data.get("shapes", []):
            kind, name = shape.get("shape_type"), shape.get("label")
            if kind not in allowed:
                raise ValueError(f"{filename}：当前任务不能使用图形 {kind}，请改用{self.task_shapes()}。")
            names = self.data["template"]["points"] if task == "pose" and kind == "point" else self.data["classes"]
            if name not in names:
                raise ValueError(f"{filename}：未知标签 {name}。")
            points = shape.get("points", [])
            # A round mark is [centre, [rx, ry]] (or the older [centre, edge]), so
            # its radii are kept in their own field and the generic coordinate check
            # only applies to the centre and to the other shapes.
            if kind == "circle":
                centre = points[0] if points else None
                if not centre or len(centre) != 2 or not 0 <= centre[0] <= limit_x or not 0 <= centre[1] <= limit_y:
                    raise ValueError(f"{filename}：坐标为空或超出图片。")
            elif not points or any(len(p) != 2 or not 0 <= p[0] <= limit_x or not 0 <= p[1] <= limit_y for p in points):
                raise ValueError(f"{filename}：坐标为空或超出图片。")
            size_ok = {"point": len(points) == 1, "rectangle": len(points) == 4, "rotation": len(points) == 4,
                       "circle": len(points) in (2, 3), "polygon": len(points) >= 3}.get(kind, False)
            if not size_ok:
                raise ValueError(f"{filename}：图形点数不正确。")
            if kind == "circle":
                # Judge the radii, not the raw point spread: the canvas form packs
                # them into a single point, so the bounding box of the numbers says
                # nothing about the outline's area.
                rx, ry = Project.circle_radii(points)
                if rx <= 0 or ry <= 0:
                    raise ValueError(f"{filename}：图形面积为零。")
            elif kind != "point" and (max(p[0] for p in points) <= min(p[0] for p in points) or max(p[1] for p in points) <= min(p[1] for p in points)):
                raise ValueError(f"{filename}：图形面积为零。")
            if task == "pose":
                gid = shape.get("group_id")
                if gid is None:
                    raise ValueError(f"{filename}：姿态实例缺少分组。")
                group = groups.setdefault(gid, [])
                if any(s["label"] == name and s["shape_type"] == kind for s in group):
                    raise ValueError(f"{filename}：实例中存在重复骨点或目标框。")
                group.append(shape)
        if task == "pose" and any(sum(s["shape_type"] == "rectangle" for s in group) != 1 for group in groups.values()):
            raise ValueError(f"{filename}：每个姿态实例必须有一个目标框。")

    def backup_annotation(self, destination):
        """Copy the current label aside before overwriting it.

        ``shutil.copy2`` does not create the target directory, so a project whose
        backups/ folder was deleted (or copied without it) failed here with
        ``WinError 3`` and the accept/save appeared to do nothing at all.
        """
        backup = self.root / "backups" / (destination.stem + "_" + uuid.uuid4().hex[:8] + ".json")
        backup.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(destination, backup)
        return backup

    def accept_proposal(self, image, proposal):
        destination = self.annotation(image)
        if proposal.get("base_hash") != digest(destination):
            raise ValueError("正式标注已经变化，候选结果已过期。请重新推理，避免覆盖人工修改。")
        if proposal.get("task") != self.data["task"] or proposal.get("classes") != self.data["classes"] or proposal.get("template") != self.data.get("template"):
            raise ValueError("项目类别或骨架已改变，请重新推理。")
        if destination.exists():
            self.backup_annotation(destination)
        data = proposal["annotation"]
        data["checked"] = False
        write_json(destination, data)
        return destination
