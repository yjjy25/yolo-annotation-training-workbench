"""Video drafts live outside the dataset until explicit human confirmation."""
import copy
from pathlib import Path
import shutil
import uuid

import cv2

from .project import Project, digest, read_json, write_json


def frame_store(project, record=None):
    if project.data.get("video_workspace") or (record is not None and record.get("storage") != "video-work"):
        return project
    root=project.root/"video-work"
    if not (root/"project.json").exists():
        store=Project.create(root,project.data["name"]+" · 视频待确认",project.data["task"],
                             project.data["classes"],template=project.data.get("template"))
    else:
        store=Project(root)
    data=copy.deepcopy(project.data)
    data.update(video_workspace=True,parent_project=str(project.root))
    if store.data!=data:
        store.data=data;store.save()
    return store


def resolve_store(project, name):
    if not project.data.get("video_workspace") and isinstance(name,str) and Path(name).name==name:
        root=project.root/"video-work"
        if not (project.root/"images"/name).exists() and (root/"images"/name).is_file():
            return frame_store(project)
    return project


def frame_name(record, number):
    return f"{record['id']}_{number:09d}.jpg"


def cache_path(project, record, number):
    return frame_store(project,record).root/"proposals"/record["id"]/f"{number:09d}.json"


def archive_future_auto(project, record, start):
    """A corrected seed invalidates later automatic guesses; retain recoverable copies."""
    if record.get("storage")!="video-work":return
    store=frame_store(project,record)
    archive=store.root/"backups"/("retrack_"+uuid.uuid4().hex)
    kept=[];protected=set()
    for frame in record["frames"]:
        label=store.annotation(frame["name"])
        data=read_json(label) if label.exists() else {}
        manual=data.get("tracking",{}).get("manual_edited") or frame["name"] in record.get("accepted",{}) or frame["name"] in record.get("review_frames",[])
        if frame["frame"]<=start or manual:
            kept.append(frame)
            if manual:protected.add(frame["frame"])
            continue
        for folder,path in (("images",store.root/"images"/frame["name"]),("annotations",label)):
            if path.exists():
                target=archive/folder/path.name;target.parent.mkdir(parents=True,exist_ok=True);path.rename(target)
    cache=store.root/"proposals"/record["id"]
    for path in cache.glob('*.json'):
        if int(path.stem)>start and int(path.stem) not in protected:
            target=archive/"predictions"/path.name;target.parent.mkdir(parents=True,exist_ok=True);path.rename(target)
    record["frames"]=kept


def seek_frame(project, args):
    from .tracking import session
    record=session(project,args["id"])
    number=args.get("frame")
    first=record["frames"][0]["frame"] if record["frames"] else round(record["settings"]["start"]*record["fps"])
    stop=round(record["settings"]["end"]*record["fps"]) if record["settings"]["end"] else record["source_frames"]
    if type(number) is not int or number<first or (stop and number>=stop):
        raise ValueError("请选择片段范围内的原始帧。")
    store=frame_store(project,record)
    name=frame_name(record,number)
    path=store.root/"images"/name
    if not path.exists():
        source=Path(record["source"])
        if not source.is_file() or source.stat().st_size!=record["source_bytes"] or source.stat().st_mtime_ns!=record["source_mtime_ns"]:
            raise ValueError("原视频已移动或改变，请恢复原文件后定位。")
        capture=cv2.VideoCapture(str(source))
        try:
            if not capture.isOpened():raise ValueError("视频无法打开。")
            # OpenCV decodes forward from the codec keyframe for frame seeking.
            positioned=capture.set(cv2.CAP_PROP_POS_FRAMES,number)
            if not positioned or abs(capture.get(cv2.CAP_PROP_POS_FRAMES)-number)>.5:
                capture.release();capture=cv2.VideoCapture(str(source))
                for _ in range(number):
                    if not capture.grab():raise ValueError("该视频帧无法定位。")
            ok,image=capture.read()
            if not ok:raise ValueError("该视频帧无法解码。")
            ok,encoded=cv2.imencode('.jpg',image,[cv2.IMWRITE_JPEG_QUALITY,95])
            if not ok:raise ValueError("视频帧编码失败。")
            with path.open('xb') as stream:stream.write(encoded.tobytes())
        finally:
            capture.release()
    label=store.annotation(name)
    cached=cache_path(project,record,number)
    if not label.exists() and cached.exists():
        write_json(label,read_json(cached))
    if not any(f["name"]==name for f in record["frames"]):
        record["frames"].append({"name":name,"frame":number,"seconds":number/record["fps"]})
        record["frames"].sort(key=lambda f:f["frame"])
    record["tracking"].update(status="paused",name=name,frame=number,message="已定位到原始帧，可拖动微调；继续追踪将使用当前修正。")
    write_json(project.root/"videos"/record["id"]/"manifest.json",record)
    return {"id":record["id"],"name":name,"frame":number,"has_annotation":label.exists()}


def accept_frame(project, args):
    from .tracking import session
    from .desktop import save_annotation
    record=session(project,args["id"])
    name=args["name"]
    if record.get("storage")!="video-work":
        raise ValueError("此旧版视频已保存在数据集；请直接在数据集中审核。")
    if not any(f["name"]==name for f in record["frames"]):
        raise ValueError("当前帧不属于此视频。")
    store=frame_store(project,record)
    label=store.annotation(name)
    if not label.is_file():raise ValueError("请先标注并保存该帧。")
    data=read_json(label)
    project.validate_annotation(data,name)
    if not data.get("shapes") and not args.get("negative"):
        raise ValueError("该帧没有目标标注，不能直接作为已确认目标加入数据集。")
    source_hash=digest(label)
    accepted=record.setdefault("accepted",{})
    if name in accepted:
        previous=accepted[name]
        if previous["source_hash"]!=source_hash:
            target_name=previous["name"]
            current_hash=digest(project.annotation(target_name))
            if not args.get("update_confirmed") or not previous.get("target_hash") or current_hash!=previous["target_hash"]:
                raise ValueError("此帧已加入数据集。副本后来被单独修改，或来自旧版记录；请在数据集中保存已确认版本，避免覆盖其他修改。")
            if not (project.root/"images"/target_name).is_file():
                raise ValueError("已确认副本已被移除，请在数据集中检查。")
            data.setdefault("tracking",{}).update(confirmed_from=name,sequence=record["id"],source_hash=source_hash)
            save_annotation(project,target_name,data,current_hash,checked=True,automated=True)
            previous.update(source_hash=source_hash,target_hash=digest(project.annotation(target_name)))
            write_json(project.root/"videos"/record["id"]/"manifest.json",record)
            return {"name":target_name,"count":0,"already":False,"updated":True}
        if (project.root/"images"/previous["name"]).is_file() and project.annotation(previous["name"]).is_file():
            return {"name":previous["name"],"count":0,"already":True}
        raise ValueError("此帧的已确认副本已被移除，请在数据集中检查。")
    stem="reviewed_"+Path(name).stem
    target_name=stem+".jpg";number=1
    while (project.root/"images"/target_name).exists() or project.annotation(target_name).exists():
        number+=1;target_name=f"{stem}_{number}.jpg"
    target=project.root/"images"/target_name
    with target.open('xb') as output:
        try:
            with (store.root/"images"/name).open('rb') as incoming:shutil.copyfileobj(incoming,output)
        except Exception:
            output.close();target.unlink(missing_ok=True);raise
    try:
        data.setdefault("tracking",{}).update(confirmed_from=name,sequence=record["id"],source_hash=source_hash)
        save_annotation(project,target_name,data,None,checked=True,automated=True)
    except Exception:
        target.unlink(missing_ok=True);raise
    accepted[name]={"name":target_name,"source_hash":source_hash,"target_hash":digest(project.annotation(target_name))}
    write_json(project.root/"videos"/record["id"]/"manifest.json",record)
    return {"name":target_name,"count":1,"already":False}


def queue_review(project, args):
    """Expose saved labelled frames to the canvas, without publishing training data."""
    from .tracking import session
    record = session(project, args["id"])
    store = frame_store(project, record)
    names = []
    for frame in record["frames"]:
        name = frame["name"]
        label = store.annotation(name)
        if name not in record.get("accepted", {}) and label.is_file() and read_json(label).get("shapes"):
            names.append(name)
    if not names:
        raise ValueError("没有可送去微调的标注帧，请先标注或追踪。")
    record["review_frames"] = names
    write_json(project.root / "videos" / record["id"] / "manifest.json", record)
    return {"id": record["id"], "names": names, "count": len(names)}


def remove_drafts(project, args):
    """Recoverably remove selected review drafts, including cached predictions."""
    from .video import sequences
    names=args.get("names")
    if not isinstance(names,list) or not names or len(names)>5000 or any(not isinstance(n,str) or Path(n).name!=n for n in names):
        raise ValueError("请选择有效的视频待微调帧。")
    names=list(dict.fromkeys(names))
    selected=set(names)
    records=[r for r in sequences(project) if r.get("kind")=="tracking" and r.get("storage")=="video-work"]
    available={n:r for r in records for n in r.get("review_frames",[]) if n not in r.get("accepted",{}) and any(f["name"]==n for f in r["frames"])}
    if any(n not in available for n in names):
        raise ValueError("部分帧已确认或不在待微调区，请刷新后重试。")
    store=frame_store(project)
    if any(not (store.root/"images"/n).is_file() for n in names):
        raise ValueError("部分视频帧已被移除，请刷新后重试。")
    affected={available[n]["id"]:available[n] for n in names}
    originals=copy.deepcopy(affected)
    archive=store.root/"removed"/("frames_"+uuid.uuid4().hex)
    moved=[]
    try:
        for name in names:
            record=available[name]
            frame=next(f for f in record["frames"] if f["name"]==name)
            for source in (store.root/"images"/name,store.annotation(name),cache_path(project,record,frame["frame"])):
                if source.exists():
                    target=archive/source.relative_to(store.root)
                    target.parent.mkdir(parents=True,exist_ok=True)
                    source.rename(target);moved.append((source,target))
        for record in affected.values():
            record["frames"]=[f for f in record["frames"] if f["name"] not in selected]
            record["review_frames"]=[n for n in record.get("review_frames",[]) if n not in selected]
            if record["tracking"].get("name") in selected:
                nearest=min(record["frames"],key=lambda f:abs(f["frame"]-record["tracking"].get("frame",0)),default=None)
                record["tracking"].update(status="paused",name=nearest["name"] if nearest else None,
                                           message="待微调帧已移入 removed，可选择其他帧或重新标注。")
            write_json(project.root/"videos"/record["id"]/"manifest.json",record)
    except Exception:
        for source,target in reversed(moved):
            target.rename(source)
        for record in originals.values():
            write_json(project.root/"videos"/record["id"]/"manifest.json",record)
        raise
    return {"names":names,"count":len(names),"recovery":str(archive)}
