"""Local project packages: verified copies, portable paths, no source mutation."""
from pathlib import Path, PurePosixPath
import hashlib
import json
import os
import shutil
import stat
import tempfile
import uuid
import zipfile
import yaml
from .project import Project, read_json, write_json, digest

META='workbench-transfer.json'


def safe_member(name):
    name=name.replace('\\','/')
    parts=PurePosixPath(name).parts
    if not parts or name.startswith('/') or any(part.split('.')[0].upper() in {'CON','PRN','AUX','NUL',*[f'COM{i}' for i in range(1,10)],*[f'LPT{i}' for i in range(1,10)]} or any(c in part for c in '<>"|?*') or part in {'.','..'} or ':' in part or part.endswith((' ','.')) for part in parts):
        raise ValueError('项目包含有无效路径：'+name)
    return Path(*parts)


def files(root, options):
    pending=[root]
    while pending:
        folder=pending.pop()
        for path in sorted(folder.iterdir()):
            relative=path.relative_to(root);parts=relative.parts
            if path.is_symlink() or getattr(path,'is_junction',lambda:False)():raise ValueError('项目中有链接文件，请先移除链接：'+str(path))
            if path.name==META:continue
            if not options.get('include_recycle',False) and ('removed'==parts[0] or parts[:2]==('video-work','removed')):continue
            if not options.get('include_snapshots',False) and parts[0]=='datasets':continue
            if not options.get('include_results',True) and parts[0] in {'runs','validation','exports','models'}:continue
            if parts[0]=='videos' and len(parts)>1 and (parts[1].startswith('job_') or parts[1].startswith('tracking_job_')):continue
            if path.is_dir():pending.append(path)
            elif path.is_file():yield path,relative


def media_sources(root, options):
    media={};missing=[]
    if not options.get('include_sources',True):return media,missing
    for manifest in (root/'videos').glob('*/manifest.json'):
        data=read_json(manifest);source=data.get('source')
        if not isinstance(source,str) or not source:continue
        path=Path(source)
        if not path.is_absolute():path=root/path
        if not path.is_file():missing.append(source);continue
        path=path.resolve()
        if path.is_relative_to(root):continue
        key=hashlib.sha256(source.encode('utf-8')).hexdigest()[:16]+'-'+path.name
        media[source]=(path,Path('media')/'source-videos'/key)
    return media,list(dict.fromkeys(missing))


def export_project(project, args):
    root=project.root.resolve();target=Path(args.get('target','')).resolve()
    if target.suffix.lower()!='.zip' or target.is_relative_to(root):raise ValueError('请将项目包保存为项目目录之外的 ZIP 文件。')
    if target.exists():raise ValueError('目标项目包已存在，请换一个文件名，避免覆盖。')
    if not target.parent.is_dir():raise ValueError('项目包保存目录不存在。')
    options=args.get('options') or {};entries=list(files(root,options));media,missing=media_sources(root,options)
    entries.extend(media.values());seen=set();unique=[]
    for source,relative in entries:
        if relative.as_posix() not in seen:unique.append((source,relative));seen.add(relative.as_posix())
    temporary=target.with_name('.'+target.name+'.'+uuid.uuid4().hex+'.partial');hashes={};mtimes={};size=0
    try:
        with zipfile.ZipFile(temporary,'x',compression=zipfile.ZIP_DEFLATED,compresslevel=1,allowZip64=True) as archive:
            for source,relative in unique:
                h=hashlib.sha256();mtimes[relative.as_posix()]=source.stat().st_mtime_ns
                with source.open('rb') as stream,archive.open(relative.as_posix(),'w',force_zip64=True) as output:
                    while chunk:=stream.read(1024*1024):output.write(chunk);h.update(chunk);size+=len(chunk)
                hashes[relative.as_posix()]=h.hexdigest()
            metadata={'format':'annotation-workbench-project','version':1,'source_root':str(root),'name':project.data['name'],'hashes':hashes,'mtimes':mtimes,'video_sources':{old:relative.as_posix() for old,(_,relative) in media.items()},'missing_sources':missing,'options':options}
            archive.writestr(META,json.dumps(metadata,ensure_ascii=False))
        temporary.rename(target)
        return {'path':str(target),'files':len(unique),'bytes':size,'package_bytes':target.stat().st_size,'missing_sources':missing}
    finally:
        if temporary.exists():temporary.unlink()


def rebase(root, target, source_root, media):
    old=source_root.replace('\\','/').rstrip('/')
    mapping={key.replace('\\','/'):str(target/safe_member(value)) for key,value in media.items()}
    def convert(value):
        if isinstance(value,dict):return {key:convert(item) for key,item in value.items()}
        if isinstance(value,list):return [convert(item) for item in value]
        if isinstance(value,str):
            normalized=value.replace('\\','/')
            if normalized in mapping:return mapping[normalized]
            if old and (normalized.casefold()==old.casefold() or normalized.casefold().startswith(old.casefold()+'/')):
                relative=normalized[len(old):].lstrip('/')
                return str(target/safe_member(relative)) if relative else str(target)
        return value
    before={p.relative_to(root).as_posix():digest(p) for folder in ['annotations','video-work/annotations'] for p in (root/folder).glob('*.json')}
    for path in root.rglob('*'):
        if not path.is_file() or path.name==META or path.suffix.lower() not in {'.json','.yaml','.yml'}:continue
        try:
            data=read_json(path) if path.suffix=='.json' else yaml.safe_load(path.read_text(encoding='utf-8'))
            updated=convert(data)
            if updated!=data:
                if path.suffix=='.json':write_json(path,updated)
                else:path.write_text(yaml.safe_dump(updated,allow_unicode=True,sort_keys=False),encoding='utf-8')
        except (ValueError,UnicodeError,yaml.YAMLError):continue
    # Hash guards distinguish real edits from path changes made during import.
    for manifest in (root/'videos').glob('*/manifest.json'):
        data=read_json(manifest);changed=False
        for frame,accepted in data.get('accepted',{}).items():
            source_name='video-work/annotations/'+Path(frame).stem+'.json'
            target_name='annotations/'+Path(accepted['name']).stem+'.json'
            if source_name in before and accepted.get('source_hash')==before[source_name]:
                new_hash=digest(root/source_name)
                if accepted['source_hash']!=new_hash:
                    accepted['source_hash']=new_hash;changed=True
                    if target_name in before:
                        label=read_json(root/target_name)
                        if label.get('tracking',{}).get('source_hash')==before[source_name]:
                            label['tracking']['source_hash']=new_hash;write_json(root/target_name,label)
            if target_name in before and accepted.get('target_hash')==before[target_name]:
                new_hash=digest(root/target_name)
                if accepted['target_hash']!=new_hash:accepted['target_hash']=new_hash;changed=True
        if changed:write_json(manifest,data)
    after={name:digest(root/name) for name in before}
    for prefix in ['', 'video-work/']:
        for proposal in (root/(prefix+'proposals/latest')).glob('*.json'):
            try:
                data=read_json(proposal);name=prefix+'annotations/'+proposal.stem+'.json'
                if name in before and data.get('base_hash')==before[name] and before[name]!=after[name]:data['base_hash']=after[name];write_json(proposal,data)
            except (ValueError,OSError):continue


def import_project(args):
    source=Path(args.get('source','')).resolve();target=Path(args.get('target','')).resolve()
    if target.exists():raise ValueError('目标目录已存在，请使用新的项目文件夹，避免覆盖。')
    if source.is_dir() and (target.is_relative_to(source) or source.is_relative_to(target)):
        raise ValueError('导入目标不能与来源目录相互包含。')
    target.parent.mkdir(parents=True,exist_ok=True)
    stage=Path(tempfile.mkdtemp(prefix='.'+target.name+'-import-',dir=target.parent));metadata={};count=0;size=0
    try:
        if source.is_dir():
            project=Project(source);options=args.get('options') or {};metadata={'source_root':str(source),'name':project.data['name']}
            entries=list(files(source,options));media,missing=media_sources(source,options);entries.extend(media.values());metadata['video_sources']={old:relative.as_posix() for old,(_,relative) in media.items()};metadata['missing_sources']=missing
            for original,relative in entries:
                safe_member(relative.as_posix());destination=stage/relative;destination.parent.mkdir(parents=True,exist_ok=True);shutil.copy2(original,destination)
                if digest(original)!=digest(destination):raise ValueError('文件复制校验失败：'+relative.as_posix())
                count+=1;size+=destination.stat().st_size
        elif source.is_file() and source.suffix.lower()=='.zip':
            with zipfile.ZipFile(source) as archive:
                entries=archive.infolist();names=set()
                for entry in entries:
                    relative=safe_member(entry.filename)
                    if stat.S_ISLNK(entry.external_attr>>16):raise ValueError('项目包不能包含链接文件。')
                    folded=relative.as_posix().casefold()
                    if folded in names:raise ValueError('项目包中存在重名文件。')
                    names.add(folded)
                if META in archive.namelist():
                    metadata=json.loads(archive.read(META))
                    if metadata.get('format')!='annotation-workbench-project' or metadata.get('version')!=1:raise ValueError('项目包格式不受支持。')
                if 'project.json' not in archive.namelist():raise ValueError('项目包根目录没有 project.json，请使用本软件导出的项目包。')
                required=sum(entry.file_size for entry in entries)
                if required>shutil.disk_usage(target.parent).free:raise ValueError('目标磁盘空间不足。')
                hashes=metadata.get('hashes')
                if hashes is not None and set(hashes)!={entry.filename for entry in entries if not entry.is_dir() and entry.filename!=META}:raise ValueError('项目包文件清单不一致。')
                for entry in entries:
                    if entry.filename==META:continue
                    relative=safe_member(entry.filename);destination=stage/relative
                    if entry.is_dir():destination.mkdir(parents=True,exist_ok=True);continue
                    destination.parent.mkdir(parents=True,exist_ok=True);h=hashlib.sha256()
                    with archive.open(entry) as stream,destination.open('xb') as output:
                        while chunk:=stream.read(1024*1024):output.write(chunk);h.update(chunk)
                    if hashes is not None and h.hexdigest()!=hashes[entry.filename]:raise ValueError('项目包文件校验失败：'+entry.filename)
                    if entry.filename in metadata.get('mtimes',{}):
                        stamp=metadata['mtimes'][entry.filename]
                        if type(stamp) is not int:raise ValueError('项目包时间戳无效。')
                        os.utime(destination,ns=(stamp,stamp))
                    count+=1;size+=entry.file_size
        else:raise ValueError('请选择有效项目文件夹或 ZIP 项目包。')
        Project(stage)
        for folder in ['images','annotations','templates','proposals','datasets','runs','models','backups']:(stage/folder).mkdir(exist_ok=True)
        rebase(stage,target,metadata.get('source_root',''),metadata.get('video_sources') or {})
        stage.rename(target)
        project=Project(target)
        return {'root':str(target),'name':project.data['name'],'images':len(project.images),'files':count,'bytes':size,'missing_sources':metadata.get('missing_sources',[])}
    finally:
        # Only the generated staging directory is disposable; never the source or target.
        if stage.exists() and stage.parent==target.parent and stage.name.startswith('.'+target.name+'-import-'):shutil.rmtree(stage)
