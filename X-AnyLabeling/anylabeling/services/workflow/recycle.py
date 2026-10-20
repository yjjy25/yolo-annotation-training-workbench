"""Recoverable entries for images, models, validation records and video frames."""
from pathlib import Path
from datetime import datetime
import hashlib
import uuid
from .project import read_json, write_json
from .artifacts import safe_path


def record(root, label, mappings, **metadata):
    root=Path(root).resolve()
    entry={'label':label,'at':datetime.now().isoformat(timespec='seconds'),'mappings':[{'source':Path(source).relative_to(root).as_posix(),'destination':Path(destination).relative_to(root).as_posix()} for source,destination in mappings],**metadata}
    path=root/'removed'/'.entries'/(uuid.uuid4().hex+'.json')
    write_json(path,entry)
    return path


def allowed_source(relative):
    parts=Path(relative).parts
    return parts and (parts[0]=='removed' or parts[:2]==('video-work','removed'))


def item(root,key,label,mappings,metadata=None,at=''):
    from .project_storage import inspect
    size,count,signatures=0,0,[]
    normalized=[]
    for mapping in mappings:
        source_rel=mapping['source'];destination_rel=mapping['destination']
        if not allowed_source(source_rel) or Path(destination_rel).parts[0] not in {'images','annotations','proposals','models','runs','validation','video-work'}:
            raise ValueError('回收站记录路径无效。')
        source=safe_path(root,source_rel);safe_path(root,destination_rel)
        if not source.exists():continue
        stats=inspect(root,source);size+=stats['bytes'];count+=stats['files'];signatures.append((source_rel,stats['signature']));normalized.append(mapping)
    if not normalized:return None
    return {'key':key,'label':label,'path':str(safe_path(root,normalized[0]['source'])),'paths':[str(safe_path(root,m['source'])) for m in normalized],'bytes':size,'files':count,'signature':hashlib.sha256(repr(sorted(signatures)).encode()).hexdigest(),'mappings':normalized,'metadata':metadata,'at':at}


def inventory(project):
    root=project.root.resolve();result=[];claimed=set()
    for prefix in ['removed','video-work/removed']:
        base=safe_path(root,prefix)
        if not base.is_dir():continue
        index=safe_path(root,Path(prefix)/'.entries')
        if index.is_dir():
            for path in sorted(index.glob('*.json')):
                try:
                    data=read_json(safe_path(root,path.relative_to(root)))
                    mappings=data['mappings']
                    # Nested video-work stores record paths relative to their store.
                    parent=Path('video-work') if prefix.startswith('video-work') else Path()
                    mappings=[{'source':(parent/m['source']).as_posix(),'destination':(parent/m['destination']).as_posix()} for m in mappings]
                    value=item(root,'entry:'+path.relative_to(root).as_posix(),data.get('label',path.stem),mappings,path.relative_to(root).as_posix(),data.get('at',''))
                    if value:
                        value['restore_data']=data;result.append(value);claimed.update(m['source'] for m in mappings)
                except (OSError,ValueError,KeyError,TypeError):continue
    for kind in ['models','validation']:
        base=safe_path(root,'removed/'+kind)
        if not base.is_dir():continue
        for manifest in sorted(base.glob('*/restore.json')):
            try:
                data=read_json(safe_path(root,manifest.relative_to(root)))
                for key in data.get('keys',[]):
                    original='validation/'+key if kind=='validation' else key
                    paths=[p for p in data.get('files',[]) if Path(p.replace('\\','/'))==Path(original.replace('\\','/')) or (Path(original).suffix=='.pt' and Path(p.replace('\\','/'))==Path(original.replace('\\','/')).with_suffix('.workflow.json'))]
                    mappings=[{'source':(manifest.parent.relative_to(root)/Path(p.replace('\\','/'))).as_posix(),'destination':Path(p.replace('\\','/')).as_posix()} for p in paths]
                    value=item(root,'artifact:'+manifest.parent.relative_to(root).as_posix()+':'+key,('模型：' if kind=='models' else '验证结果：')+key,mappings)
                    if value:result.append(value);claimed.update(m['source'] for m in mappings)
            except (OSError,ValueError,KeyError,TypeError):continue
    for prefix in ['removed','video-work/removed']:
        base=safe_path(root,Path(prefix)/'images')
        if not base.is_dir():continue
        parent=Path('video-work') if prefix.startswith('video-work') else Path()
        for image in sorted(base.iterdir()):
            if image.relative_to(root).as_posix() in claimed or not image.is_file():continue
            mappings=[{'source':image.relative_to(root).as_posix(),'destination':(parent/'images'/image.name).as_posix()}]
            for folder in ['annotations','proposals']:
                archived=safe_path(root,Path(prefix)/folder/(image.stem+'.json'))
                if archived.is_file():mappings.append({'source':archived.relative_to(root).as_posix(),'destination':(parent/folder/('latest' if folder=='proposals' else '')/(image.stem+'.json')).as_posix()})
            try:
                value=item(root,'legacy:'+image.relative_to(root).as_posix(),'图片：'+image.name,mappings)
                if value:result.append(value)
            except (OSError,ValueError):continue
    return sorted(result,key=lambda value:(value.get('at',''),value['key']),reverse=True)


def selected(project,args):
    root=project.root.resolve()
    if Path(args.get('project_root','')).resolve()!=root:raise ValueError('项目已切换，请重新打开回收站。')
    choices=args.get('targets')
    if not isinstance(choices,list) or not choices:raise ValueError('请选择回收站内容。')
    available={entry['key']:entry for entry in inventory(project)}
    result=[];seen=set()
    for choice in choices:
        if not isinstance(choice,dict) or choice.get('key') not in available:raise ValueError('回收站内容已变化，请刷新。')
        entry=available[choice['key']]
        if choice.get('signature')!=entry['signature']:raise ValueError('文件在确认后发生变化，请刷新后重新操作。')
        if entry['key'] not in seen:result.append(entry);seen.add(entry['key'])
    return root,result


def restore(project,args):
    root,entries=selected(project,args);done=[];failed=[]
    for entry in entries:
        moved=[];metadata_before={}
        try:
            for mapping in entry['mappings']:
                destination=safe_path(root,mapping['destination'])
                if destination.exists():raise ValueError('恢复目标已存在，未覆盖：'+str(destination))
            data=entry.get('restore_data') or {}
            for mapping in entry['mappings']:
                source=safe_path(root,mapping['source']);destination=safe_path(root,mapping['destination']);destination.parent.mkdir(parents=True,exist_ok=True);source.rename(destination);moved.append((source,destination))
            splits=data.get('split_entries') or {}
            metadata_paths=([root/'splits.json'] if splits else [])+[safe_path(root,Path('videos')/video['id']/'manifest.json') for video in data.get('video_frames',[])]
            metadata_before={p:p.read_bytes() if p.exists() else None for p in metadata_paths}
            if splits:
                split_path=root/'splits.json';current=read_json(split_path) if split_path.exists() else {'assignments':{}}
                for key,value in splits.items():current.setdefault('assignments',{}).setdefault(key,value)
                write_json(split_path,current)
            for video in data.get('video_frames',[]):
                manifest=safe_path(root,Path('videos')/video['id']/'manifest.json');current=read_json(manifest);existing={f['name'] for f in current['frames']}
                current['frames']+= [f for f in video['frames'] if f['name'] not in existing];current['frames'].sort(key=lambda f:f['frame'])
                current['review_frames']=list(dict.fromkeys(current.get('review_frames',[])+video.get('review_names',[])))
                write_json(manifest,current)
            if entry.get('metadata'):safe_path(root,entry['metadata']).unlink()
            done.append(entry['key'])
        except (OSError,ValueError,KeyError,TypeError) as error:
            for path,content in metadata_before.items():
                if content is None:path.unlink(missing_ok=True)
                else:path.write_bytes(content)
            for source,destination in reversed(moved):
                source.parent.mkdir(parents=True,exist_ok=True);destination.rename(source)
            failed.append({'key':entry['key'],'error':str(error)})
    return {'count':len(done),'keys':done,'failed':failed}


def purge(project,args):
    from .project_storage import purge_path
    if args.get('confirm_permanent') is not True:raise ValueError('永久清空必须单独确认，无法恢复。')
    root,entries=selected(project,args);done=[];failed=[];size=0
    for entry in entries:
        try:
            for mapping in entry['mappings']:purge_path(root,safe_path(root,mapping['source']))
            if entry.get('metadata'):safe_path(root,entry['metadata']).unlink()
            done.append(entry['key']);size+=entry['bytes']
        except (OSError,ValueError) as error:failed.append({'key':entry['key'],'error':str(error)})
    return {'count':len(done),'keys':done,'bytes':size,'failed':failed}
