"""Append image copies to an existing project without replacing prior work."""
from pathlib import Path
import shutil
import uuid

from PIL import Image

from .project import IMAGE_EXTENSIONS, digest, read_json, write_json


def import_images(project, args):
    if args.get("paths"):
        files = sorted({Path(p).resolve() for p in args["paths"]})
    else:
        folder = Path(args.get("path", "")).resolve()
        if not args.get("path") or not folder.is_dir():
            raise ValueError("请选择图片文件夹或图片文件。")
        if folder == project.root or folder.is_relative_to(project.root) or project.root.is_relative_to(folder):
            raise ValueError("请从项目目录之外导入图片，避免重复导入项目或备份。")
        files = sorted(p for p in folder.rglob("*") if p.is_file() and p.suffix.lower() in IMAGE_EXTENSIONS)
    if not files:
        raise ValueError("所选来源没有支持的图片。")
    if len(files) > 10000:
        raise ValueError("单批最多导入 10000 张图片，请分批导入。")
    if any(not p.is_file() or p.suffix.lower() not in IMAGE_EXTENSIONS or p.is_relative_to(project.root) for p in files):
        raise ValueError("请选择项目目录之外的有效图片文件。")
    directory = project.root / "imports" / ("images_" + uuid.uuid4().hex)
    stage = directory / "staged"
    stage.mkdir(parents=True)
    images=project.images
    by_name={p.name.casefold():p for p in images}
    existing = {p.stem.casefold() for p in images}
    existing.update(p.stem.casefold() for p in (project.root / "annotations").glob("*.json"))
    planned, skipped = [], 0
    for source in files:
        same_name = by_name.get(source.name.casefold())
        if same_name is not None and digest(same_name) == digest(source):
            skipped += 1
            continue
        stem, number = source.stem, 1
        while stem.casefold() in existing:
            number += 1
            stem = f"{source.stem}_{number}"
        name = stem + source.suffix.lower()
        existing.add(stem.casefold())
        try:
            with Image.open(source) as image:
                width, height = image.size
                image.verify()
        except Exception as error:
            raise ValueError(f"图片无法解码：{source.name}。本批次尚未加入数据集。") from error
        shutil.copy2(source, stage / name)
        annotation = None
        if source.with_suffix(".json").is_file():
            annotation = read_json(source.with_suffix(".json"))
            annotation.update(imagePath="../images/"+name, imageData=None, imageWidth=width, imageHeight=height, checked=False)
            if project.data["task"] == "classify":
                chosen = [c for c, value in annotation.get("flags", {}).items() if value is True]
                if len(chosen) != 1 or chosen[0] not in project.data["classes"]:
                    raise ValueError(f"{source.name} 的分类标签与当前项目不匹配。")
            else:
                project.validate_annotation(annotation, source.name)
            write_json(stage / (stem + ".json"), annotation)
        planned.append({"source": str(source), "name": name, "annotation": annotation is not None})
    created = []
    try:
        for entry in planned:
            targets = [(stage / entry["name"], project.root / "images" / entry["name"])]
            if entry["annotation"]:
                label_name = Path(entry["name"]).stem + ".json"
                targets.append((stage / label_name, project.root / "annotations" / label_name))
            for source, destination in targets:
                # Exclusive open protects even against an unexpected second writer.
                with destination.open("xb") as output:
                    created.append(destination)
                    with source.open("rb") as incoming:
                        shutil.copyfileobj(incoming, output)
        result = {"count": len(planned), "skipped": skipped, "first": planned[0]["name"] if planned else None,
                  "renamed": sum(Path(e["source"]).name != e["name"] for e in planned)}
        write_json(directory / "manifest.json", {**result, "files": planned, "status": "completed"})
        for entry in planned:
            (stage / entry["name"]).unlink(missing_ok=True)
            (stage / (Path(entry["name"]).stem + ".json")).unlink(missing_ok=True)
        stage.rmdir()
        return result
    except Exception:
        for path in reversed(created):
            path.unlink(missing_ok=True)
        raise
