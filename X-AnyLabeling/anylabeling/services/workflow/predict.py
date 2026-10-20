"""Isolated batch prediction: only proposals are written; annotations stay untouched."""
import json
import sys
from pathlib import Path

from .project import Project, digest, template_hash, write_json, read_json


def has_annotation_or_review(path):
    if not path.exists():
        return False
    try:
        data = read_json(path)
        return bool(data.get("checked") or data.get("shapes") or any(value is True for value in data.get("flags", {}).values()))
    except (OSError, ValueError, TypeError, AttributeError):
        # An unreadable label is protected, never treated as empty AI input.
        return True


def run(root, weights, device, confidence, aliases=""):
    project = Project(root)
    all_images = project.images
    images = [image for image in all_images if not has_annotation_or_review(project.annotation(image))]
    skipped = len(all_images) - len(images)
    print(f"共 {len(all_images)} 张，跳过已有标注或已审核 {skipped} 张，待预标注 {len(images)} 张。", flush=True)
    if not images:
        print("没有需要 AI 预标注的图片，未加载模型。", flush=True)
        return
    from ultralytics import YOLO
    model = YOLO(weights)
    task = project.data["task"]
    if model.task != task:
        raise ValueError(f"模型任务为 {model.task}，项目任务为 {task}。")
    names = [model.names[i] for i in range(len(model.names))]
    mapping = {name: name for name in names if name in project.data["classes"]}
    for entry in aliases.replace("；", ";").split(";"):
        if entry.strip():
            source, target = (part.strip() for part in entry.split("=", 1))
            if source not in names or target not in project.data["classes"]:
                raise ValueError(f"类别映射无效：{entry}。请使用模型类别名=项目类别名。")
            mapping[source] = target
    if not mapping:
        raise ValueError("模型类别与项目没有匹配项。请填写类别映射，例如 person=人 或 cat=猫。模型类别：" + ", ".join(names))
    metadata = Path(weights).with_suffix(".workflow.json")
    if task == "pose":
        from .presets import HUMAN
        compatible_human = project.data["template"]["points"] == HUMAN["points"] and model.model.yaml.get("kpt_shape") == [17, 3] and names == ["person"]
        if not compatible_human and (not metadata.exists() or json.loads(metadata.read_text(encoding="utf-8")).get("template_hash") != template_hash(project.data["template"])):
            raise ValueError("姿态模型缺少匹配的骨点元数据。请从本项目训练结果中选择模型。")
    output = project.root / "proposals" / "latest"
    output.mkdir(parents=True, exist_ok=True)
    generated = 0
    for index, image in enumerate(images):
        annotation_path = project.annotation(image)
        base_hash = digest(annotation_path)  # Capture BEFORE inference, for concurrent-edit protection.
        if has_annotation_or_review(annotation_path):
            skipped += 1
            print(f"跳过 {image.name}：已新增人工标注或审核。", flush=True)
            continue
        result = model.predict(str(image), device=device, conf=float(confidence), verbose=False)[0]
        height, width = result.orig_shape
        shapes = []

        def shape(name, kind, points, gid, score=None, difficult=False):
            if kind != "point":
                if name not in mapping:
                    return
                name = mapping[name]
            shapes.append({"label": name, "shape_type": kind, "points": points, "group_id": gid, "score": score, "difficult": difficult, "flags": {}, "attributes": {}, "description": "AI 候选，待人工审核"})

        flags = {}
        if task == "classify":
            winner = names[result.probs.top1]
            flags = {name: mapping.get(winner) == name for name in project.data["classes"]}
        elif task == "obb":
            if result.obb is not None:
                for gid, box in enumerate(result.obb):
                    shape(names[int(box.cls.item())], "rotation", box.xyxyxyxy[0].cpu().tolist(), gid, float(box.conf.item()))
        else:
            if result.boxes is not None:
                for gid, box in enumerate(result.boxes):
                    name = names[int(box.cls.item())]
                    if name not in mapping:
                        continue
                    score = float(box.conf.item())
                    x1, y1, x2, y2 = box.xyxy[0].cpu().tolist()
                    if task == "segment":
                        if result.masks is not None:
                            points = result.masks.xy[gid].tolist()
                            if len(points) >= 3:
                                shape(name, "polygon", points, gid, score)
                    else:
                        shape(name, "rectangle", [[x1, y1], [x2, y1], [x2, y2], [x1, y2]], gid, score)
                    if task == "pose" and result.keypoints is not None:
                        coordinates = result.keypoints.xy[gid].cpu().tolist()
                        if len(coordinates) != len(project.data["template"]["points"]):
                            raise ValueError("模型输出骨点数量与模板不一致。")
                        scores = result.keypoints.conf[gid].cpu().tolist() if result.keypoints.conf is not None else [1.] * len(coordinates)
                        for label, point, point_score in zip(project.data["template"]["points"], coordinates, scores):
                            if point_score >= float(confidence) and 0 <= point[0] <= width and 0 <= point[1] <= height:
                                shape(label, "point", [point], gid, point_score)
        annotation = {"version": "4.1.3", "flags": flags, "shapes": shapes, "imagePath": "../images/" + image.name, "imageData": None, "imageWidth": width, "imageHeight": height, "checked": False}
        proposal = {"model": str(Path(weights).resolve()), "base_hash": base_hash, "task": task, "classes": project.data["classes"], "template": project.data.get("template"), "annotation": annotation}
        if digest(annotation_path) != base_hash or has_annotation_or_review(annotation_path):
            skipped += 1
            print(f"跳过 {image.name}：推理期间标注已变化，保留人工结果。", flush=True)
            continue
        write_json(output / (image.stem + ".json"), proposal)
        generated += 1
        print(f"[{index + 1}/{len(images)}] {image.name}：{len(shapes)} 个图形 → 待审核", flush=True)
    print(f"批量预标注完成：生成 {generated} 张候选，跳过 {skipped} 张。人工正式标注未更改。", flush=True)


if __name__ == "__main__":
    try:
        run(*sys.argv[1:])
    except Exception as error:
        print(f"失败：{error}", flush=True)
        sys.exit(1)
