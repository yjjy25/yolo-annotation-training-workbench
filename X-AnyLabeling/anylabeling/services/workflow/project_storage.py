"""Explicit permanent cleanup of confirmed project-owned files only."""
from pathlib import Path
import hashlib
import os
from .artifacts import safe_path


def inspect(root, target):
    root = root.resolve()
    rows, size, count = [], 0, 0
    pending = [target]
    while pending:
        item = pending.pop()
        item = safe_path(root, item.relative_to(root))
        stat = item.stat()
        relative = item.relative_to(root).as_posix()
        if item.is_dir():
            rows.append((relative, 'directory', stat.st_mtime_ns))
            pending.extend(item.iterdir())
        elif item.is_file():
            rows.append((relative, stat.st_size, stat.st_mtime_ns))
            size += stat.st_size
            count += 1
        else:
            raise ValueError('清理目标包含不支持的文件类型。')
    signature = hashlib.sha256(repr(sorted(rows)).encode('utf-8')).hexdigest()
    return {'bytes':size, 'files':count, 'signature':signature}


def image_plan(project, args):
    root = project.root.resolve()
    available = {p.name for p in project.images}
    if args.get('all') is True:
        if args.get('expected_count') != len(available):
            raise ValueError('图片数量已变化，请重新确认。')
        names = sorted(available)
    else:
        names = args.get('names')
        if not isinstance(names,list) or not names or any(not isinstance(n,str) or n not in available for n in names):
            raise ValueError('图片已不存在或不属于当前数据集，请刷新。')
        names = list(dict.fromkeys(names))
    targets, states = [], []
    for name in names:
        stem = Path(name).stem
        for relative in [Path('images')/name, Path('annotations')/(stem+'.json'), Path('proposals/latest')/(stem+'.json')]:
            target = safe_path(root, relative)
            if target.exists():
                data = inspect(root,target)
                targets.append({'path':str(target), **data})
                states.append((relative.as_posix(), data['signature']))
    signature = hashlib.sha256(repr(sorted(states)).encode('utf-8')).hexdigest()
    return {'project_root':str(root),'names':names,'paths':[t['path'] for t in targets],'bytes':sum(t['bytes'] for t in targets),'files':sum(t['files'] for t in targets),'signature':signature}


def inventory(project):
    root = project.root.resolve()
    from .recycle import inventory as recycle_inventory
    records=recycle_inventory(project)
    labels={'images':'数据集图片','annotations':'标注','models':'项目模型','videos':'视频抽帧与追踪缓存','video-work':'视频微调工作区','datasets':'训练数据快照','runs':'训练权重与结果','validation':'验证结果','removed':'回收站','backups':'标注备份','proposals':'AI 候选'}
    usage=[];total=0;count=0;other=0;incomplete=[]
    # Walk every top-level entry once, including project metadata and unlisted folders.
    for child in sorted(root.iterdir()):
        key=child.name
        try:
            stats=inspect(root,child);total+=stats['bytes'];count+=stats['files']
            if key in labels:usage.append({'label':labels[key],'key':key,'bytes':stats['bytes']})
            else:other+=stats['bytes']
        except (OSError,ValueError):
            incomplete.append(key)
            usage.append({'label':labels.get(key,key),'key':key,'bytes':None})
    if other:usage.append({'label':'配置及其他文件','key':'other','bytes':other})
    return {'project_root':str(root),'targets':records,'usage':usage,'total_bytes':total,'total_files':count,'incomplete':incomplete}


def purge_path(root, target):
    target = safe_path(root,target.relative_to(root))
    if target.is_dir():
        for child in target.iterdir():
            purge_path(root,child)
        target.rmdir()
    else:
        target.unlink()


def cleanup(project, args):
    from .recycle import purge
    return purge(project,args)
