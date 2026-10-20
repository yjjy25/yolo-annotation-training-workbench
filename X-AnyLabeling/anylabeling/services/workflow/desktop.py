"""Validated operations shared by the integrated Electron editor and workers."""
from pathlib import Path
import copy
import math
import shutil
import uuid

from .project import Project, read_json, write_json, digest
from .presets import preset


def image_path(project, name):
    if not isinstance(name, str) or Path(name).name != name:
        raise ValueError("图片名称无效。")
    path = (project.root / "images" / name).resolve()
    if path.parent != (project.root / "images").resolve() or path not in project.images:
        raise ValueError("请选择当前项目中的图片。")
    return path


def remove_image(project, name, purge=False):
    """Remove an unusable picture (and everything attached to it)."""
    from .video_workspace import resolve_store
    project=resolve_store(project,name)
    path = image_path(project, name)
    return project.remove_image(path, purge=bool(purge))


def remove_images(project, args):
    """Archive dataset images only; validate the entire request before moving files."""
    if Path(args.get("project_root", "")).resolve() != project.root.resolve():
        raise ValueError("项目已切换，请重新选择要移除的图片。")
    available = {p.name for p in project.images}
    if args.get("all") is True:
        if args.get("expected_count") != len(available):
            raise ValueError("图片数量已变化，请重新确认全部移除。")
        names = sorted(available)
    else:
        requested = args.get("names")
        if not isinstance(requested, list) or any(not isinstance(n, str) for n in requested):
            raise ValueError("请选择要移除的图片。")
        names = list(dict.fromkeys(requested))
        if any(n not in available for n in names):
            raise ValueError("部分图片已不存在或不属于当前数据集，请刷新后重新选择。")
    if args.get("purge"):
        raise ValueError("请先移入回收站，再在回收站中确认永久清空。")
    purge = False
    removed, failed = [], []
    for name in names:
        try:
            remove_image(project, name, purge=purge)
            removed.append(name)
        except Exception as error:
            failed.append({"name": name, "error": str(error)})
    return {"count": len(removed), "names": removed, "failed": failed, "purged":purge}


def load_annotation(project, name):
    from .video_workspace import resolve_store
    project=resolve_store(project,name)
    path = image_path(project, name)
    label = project.annotation(path)
    candidate = project.root / "proposals" / "latest" / (path.stem + ".json")
    return {"annotation":read_json(label) if label.exists() else None,
            "base_hash":digest(label), "proposal":read_json(candidate) if candidate.exists() else None}


def accept_candidate(project, name):
    path = image_path(project, name)
    candidate = project.root / "proposals" / "latest" / (path.stem + ".json")
    accepted = candidate.with_suffix(".accepted.json")
    if not candidate.is_file():
        if accepted.is_file() and project.annotation(path).is_file():
            return load_annotation(project, name)
        raise ValueError("此图片的 AI 候选已不存在，请重新生成候选后再接纳。")
    project.accept_proposal(path, read_json(candidate))
    candidate.replace(accepted)
    return load_annotation(project, name)


def save_annotation(project, name, annotation, base_hash, checked=False, automated=False):
    from .video_workspace import resolve_store
    project=resolve_store(project,name)
    path = image_path(project, name)
    destination = project.annotation(path)
    if digest(destination) != base_hash:
        raise ValueError("标注已被其他窗口修改，请重新加载此图片后再编辑。当前编辑内容仍保留在画布中。")
    from PIL import Image
    with Image.open(path) as image:
        width,height = image.size
    data = copy.deepcopy(annotation)
    if project.data.get("video_workspace"):
        checked=False
        if not automated:data.setdefault("tracking",{})["manual_edited"]=True
    if not isinstance(data,dict) or len(data.get("shapes",[])) > 100000:
        raise ValueError("标注数据无效。")
    for shape in data.get("shapes",[]):
        for point in shape.get("points",[]):
            if len(point)!=2 or any(type(v) not in (int,float) or not math.isfinite(v) for v in point):
                raise ValueError("标注包含无效坐标。")
    data.update(version="4.1.3", imagePath="../images/"+path.name, imageData=None,
                imageWidth=width,imageHeight=height,checked=bool(checked))
    if project.data["task"] == "classify":
        chosen=[c for c,v in data.get("flags",{}).items() if v is True]
        if len(chosen)!=1 or chosen[0] not in project.data["classes"]:
            raise ValueError("请为图片选择一个对象类别。")
    else:
        project.validate_annotation(data,path.name)
    if destination.exists():
        project.backup_annotation(destination)
    write_json(destination,data)
    return {"base_hash":digest(destination),"checked":data["checked"]}


def append_class(project, name):
    name = str(name).strip()
    if not name or len(name)>100 or name in {".",".."} or any(c in name for c in '/\\:,，\n\r'):
        raise ValueError("类别名称不能为空，不能包含路径字符、逗号或换行。")
    if name not in project.data["classes"]:
        project.data["classes"].append(name)
        project.save()
    return project.data["classes"]


def create_project(args):
    task = args.get("task")
    template = None
    if task == "pose":
        key = args.get("preset", "human")
        template = preset(key) if key in {"human","dog"} else args.get("template")
    name = str(args.get("name", "")).strip()
    if not name or not args.get("root"):
        raise ValueError("请填写项目名称与项目保存目录。")
    if args.get("source") and args.get("source_kind") == "video":
        source = Path(args["source"])
        if not source.is_file() or source.suffix.lower() not in {".mp4", ".avi", ".mov", ".mkv", ".webm", ".m4v"}:
            raise ValueError("请选择有效的视频文件。")
        return Project.create(args["root"],name,task,args.get("classes",[]),template=template)
    return Project.create(args["root"],name,task,args.get("classes",[]),args.get("source") or None,template)
