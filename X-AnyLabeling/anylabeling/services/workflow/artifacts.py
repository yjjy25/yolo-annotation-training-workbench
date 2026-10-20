"""Recoverable removal of project-owned model weights and validation results."""
from pathlib import Path
from datetime import datetime
import uuid
from .project import read_json, write_json


def safe_path(root, relative):
    root = Path(root).resolve()
    parts = Path(relative).parts
    if not parts or Path(relative).is_absolute() or any(p in {'.','..'} for p in parts):
        raise ValueError('路径无效。')
    target = root.joinpath(*parts)
    if not target.resolve().is_relative_to(root):
        raise ValueError('只能删除当前项目内的文件。')
    cursor = root
    for part in parts:
        cursor = cursor / part
        if cursor.is_symlink() or getattr(cursor, 'is_junction', lambda:False)():
            raise ValueError('不能删除链接指向的文件。')
    return target


def inventory(project, kind):
    root = project.root.resolve()
    result = []
    if kind == 'models':
        runs = safe_path(root, 'runs')
        if runs.is_dir():
            for run in sorted(runs.iterdir()):
                key = f'runs/{run.name}/weights'
                try:
                    folder = safe_path(root, key)
                    if folder.is_dir() and any(p.is_file() and p.suffix == '.pt' for p in folder.iterdir()):
                        result.append({'key':key,'label':run.name,'path':str(folder),'weights':str(folder/'best.pt'),'detail':'训练模型权重（含 best.pt、last.pt）；保留训练曲线和日志'})
                except ValueError:
                    continue
        models = safe_path(root, 'models')
        if models.is_dir():
            for weight in sorted(models.rglob('*.pt')):
                key = weight.relative_to(root).as_posix()
                try:
                    target = safe_path(root, key)
                    if target.is_file():
                        result.append({'key':key,'label':weight.name,'path':str(target),'weights':str(target),'detail':'项目内模型权重及对应骨点元数据'})
                except ValueError:
                    continue
    elif kind == 'validation':
        base = safe_path(root, 'validation')
        if base.is_dir():
            for folder in sorted(base.iterdir()):
                key = folder.name
                try:
                    target = safe_path(root, 'validation/'+key)
                    metrics = read_json(target/'metrics.json')
                    result.append({'key':key,'label':str(metrics.get('at') or key),'path':str(target),'detail':'验证指标、结果图、结果视频及日志'})
                except (OSError, ValueError):
                    continue
    else:
        raise ValueError('不支持的删除类型。')
    return result


def archive(project, args):
    root = project.root.resolve()
    if Path(args.get('project_root','')).resolve() != root:
        raise ValueError('项目已切换，请刷新后重新选择。')
    kind = args.get('kind')
    requested = args.get('keys')
    if not isinstance(requested,list) or not requested or any(not isinstance(k,str) for k in requested):
        raise ValueError('请选择要删除的项目。')
    keys = list(dict.fromkeys(requested))
    available = {item['key']:item for item in inventory(project,kind)}
    if any(key not in available for key in keys):
        raise ValueError('部分项目已不存在或不属于当前项目，请刷新后重试。')
    sources = []
    for key in keys:
        source = safe_path(root, 'validation/'+key if kind=='validation' else key)
        group = [source]
        if source.is_file():
            sidecar = source.with_suffix('.workflow.json')
            if sidecar.exists():
                group.append(safe_path(root, sidecar.relative_to(root)))
        sources.append((key,group))
    archive_relative = Path('removed') / kind / (datetime.now().strftime('%Y%m%d-%H%M%S')+'-'+uuid.uuid4().hex[:8])
    destination = safe_path(root, archive_relative)
    destination.mkdir(parents=True)
    write_json(destination/'restore.json',{'project_root':str(root),'kind':kind,'keys':keys,'files':[str(s.relative_to(root)) for _,group in sources for s in group]})
    removed, failed = [], []
    for key,group in sources:
        moved = []
        try:
            for source in group:
                target = safe_path(root, archive_relative/source.relative_to(root))
                target.parent.mkdir(parents=True,exist_ok=True)
                source.rename(target)
                moved.append((source,target))
            removed.append(key)
        except OSError as error:
            for source,target in reversed(moved):
                target.rename(source)
            failed.append({'key':key,'error':str(error)})
    write_json(destination/'restore.json',{'project_root':str(root),'kind':kind,'keys':removed,'files':[str(s.relative_to(root)) for key,group in sources if key in removed for s in group]})
    return {'count':len(removed),'keys':removed,'failed':failed,'archive':str(destination)}
