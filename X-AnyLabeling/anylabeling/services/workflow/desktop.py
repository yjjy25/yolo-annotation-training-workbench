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
    path = image_path(project, name)
    return project.remove_image(path, purge=bool(purge))


def load_annotation(project, name):
    path = image_path(project, name)
    label = project.annotation(path)
    candidate = project.root / "proposals" / "latest" / (path.stem + ".json")
    return {"annotation":read_json(label) if label.exists() else None,
            "base_hash":digest(label), "proposal":read_json(candidate) if candidate.exists() else None}


def save_annotation(project, name, annotation, base_hash, checked=False):
    path = image_path(project, name)
    destination = project.annotation(path)
    if digest(destination) != base_hash:
        raise ValueError("标注已被其他窗口修改，请重新加载此图片后再编辑。当前编辑内容仍保留在画布中。")
    from PIL import Image
    with Image.open(path) as image:
        width,height = image.size
    data = copy.deepcopy(annotation)
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
    if not name or not args.get("root") or not args.get("source"):
        raise ValueError("请填写项目名称、图片目录与项目保存目录。")
    return Project.create(args["root"],name,task,args.get("classes",[]),args["source"],template)
