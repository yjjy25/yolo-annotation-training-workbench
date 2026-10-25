"""Rebuild installers using SHA256-verified v0.5.2 runtime payloads.

Only application sources, fonts, documentation and version metadata are replaced.
The Windows ZIP keeps unchanged compressed runtime entries byte for byte. This
allows a Linux release host to reuse the existing unsigned .NET extraction stub;
its equal-length version strings are patched without changing assembly layout.
"""
from pathlib import Path
import copy
import hashlib
import json
import os
import shutil
import struct
import subprocess
import sys
import time
import zipfile

ROOT=Path(__file__).resolve().parent.parent
BUILD=ROOT/'.packaging'
OUT=ROOT/'发行包'
VERSION=json.loads((ROOT/'desktop/package.json').read_text())['version']
BASE='0.5.2'

def digest(path):
    h=hashlib.sha256()
    with path.open('rb') as source:
        while block:=source.read(8<<20):h.update(block)
    return h.hexdigest()

def verify_parts(platform):
    assets=json.loads((BUILD/'base-runtime-v0.5.2.json').read_text())
    parts=[a for a in assets if platform in a['name']]
    for a in parts:
        path=BUILD/'downloads'/a['name']
        if not path.is_file() or path.stat().st_size!=a['bytes'] or digest(path)!=a['sha256']:
            raise ValueError('Missing or unverified runtime part: '+a['name'])
    return sorted((BUILD/'downloads'/a['name'] for a in parts))

def join(platform):
    parts=verify_parts(platform)
    target=BUILD/'downloads'/parts[0].name.rsplit('.part',1)[0]
    expected=sum(p.stat().st_size for p in parts)
    if target.exists() and target.stat().st_size==expected:return target
    temp=target.with_suffix(target.suffix+'.partial')
    with temp.open('wb') as out:
        for p in parts:
            with p.open('rb') as source:shutil.copyfileobj(source,out,8<<20)
    temp.replace(target);return target

def sources():
    result={}
    for p in (ROOT/'desktop').iterdir():
        if p.is_file() and p.suffix in {'.cjs','.js','.html','.css','.json','.svg','.png','.ico'} and p.name!='package-lock.json':result['resources/app/'+p.name]=p.read_bytes()
    excluded={'.git','__pycache__','.pytest_cache','.ruff_cache','node_modules','runs','dist','build','.venv','.runtime'}
    for base,dirs,names in os.walk(ROOT/'X-AnyLabeling'):
        dirs[:]=[d for d in dirs if d not in excluded and not d.endswith('.egg-info')]
        for name in names:
            if name.endswith(('.pyc','.egg-link')) or name.startswith('__editable__'):continue
            p=Path(base)/name
            result['resources/workbench/'+p.relative_to(ROOT).as_posix()]=p.read_bytes()
    for name in ['.runtime/launcher.pyw']+[p.relative_to(ROOT).as_posix() for p in (ROOT/'.runtime/fonts').iterdir() if p.is_file()]:result['resources/workbench/'+name]=(ROOT/name).read_bytes()
    result['使用说明.md']=(ROOT/'文档/v0.6_安装说明.md').read_bytes()
    result['SOURCE-LICENSE-GPL3.txt']=(ROOT/'X-AnyLabeling/LICENSE').read_bytes()
    result['源码与许可说明.txt']=('本包包含 Electron 与 X-AnyLabeling 扩展源码及第三方许可。\n界面源码：resources/app；Python 源码：resources/workbench/X-AnyLabeling。\nWindows 用户数据位于程序旁“工作台数据”；Ubuntu DEB 用户数据位于 ~/.config/AnnotationTrainingWorkbench。\n升级前请保存并退出旧版；项目数据不包含在安装包中。\n').encode()
    return result

def metadata(platform,original):
    data=dict(original);data.update(version=VERSION,platform=platform,created=time.time(),base_release='v'+BASE,runtime_reused=True)
    return json.dumps(data,ensure_ascii=False,indent=2).encode()

def patch_stub(stub):
    old=BASE.encode('utf-16-le');new=VERSION.encode('utf-16-le')
    if len(old)!=len(new) or stub[:2]!=b'MZ' or stub.count(old)<1:raise ValueError('Installer stub version cannot be safely patched')
    count=stub.count(old);result=stub.replace(old,new)
    assert len(result)==len(stub) and old not in result
    print('WINDOWS_STUB_VERSION_UPDATED',count,flush=True);return result

def windows():
    base=join('Windows');payload=BUILD/('windows-'+VERSION+'.zip')
    replacements=sources()
    with base.open('rb') as source:
        source.seek(-16,2);size=struct.unpack('<Q',source.read(8))[0]
        if source.read(8)!=b'XALPACK1' or not 0<size<base.stat().st_size-16:raise ValueError('Invalid base installer trailer')
        source.seek(0);stub=patch_stub(source.read(base.stat().st_size-16-size))
    with zipfile.ZipFile(base) as old:
        replacements['release.json']=metadata('windows',json.loads(old.read('release.json')))
        entries=sorted(old.infolist(),key=lambda i:i.header_offset)
        ends={i.filename:(entries[n+1].header_offset if n+1<len(entries) else old.start_dir) for n,i in enumerate(entries)}
        names=set();done=0;last=time.monotonic()
        with payload.open('wb') as destination,zipfile.ZipFile(destination,'w',zipfile.ZIP_DEFLATED,compresslevel=6,allowZip64=True) as new:
            for entry in entries:
                if entry.filename in replacements:continue
                if '工作台数据' in Path(entry.filename).parts:raise ValueError('Unexpected private data in base installer')
                offset=destination.tell();old.fp.seek(entry.header_offset);left=ends[entry.filename]-entry.header_offset
                while left:
                    block=old.fp.read(min(left,8<<20))
                    if not block:raise EOFError('Truncated ZIP entry')
                    destination.write(block);left-=len(block);done+=len(block)
                item=copy.copy(entry);item.header_offset=offset
                new.filelist.append(item);new.NameToInfo[item.filename]=item;new._didModify=True;new.start_dir=destination.tell();names.add(item.filename)
                if time.monotonic()-last>15:print('WINDOWS_RUNTIME_COPIED',round(done/1e9,2),'GB',flush=True);last=time.monotonic()
            for name,data in replacements.items():
                if name in names:raise ValueError('Duplicate ZIP entry')
                new.writestr(name,data);names.add(name)
    OUT.mkdir(exist_ok=True);target=OUT/f'AnnotationWorkbench-{VERSION}-Windows-x64-CPU-GPU.exe';temp=target.with_suffix('.exe.partial')
    with temp.open('wb') as out:
        out.write(stub)
        with payload.open('rb') as source:shutil.copyfileobj(source,out,8<<20)
        out.write(struct.pack('<Q',payload.stat().st_size));out.write(b'XALPACK1')
    temp.replace(target);print('WINDOWS_REBUILT',target,target.stat().st_size,flush=True)

def linux():
    base=join('Ubuntu');extract=BUILD/('base-ubuntu-'+VERSION)
    stage=BUILD/('stage-linux-'+VERSION)
    if not stage.exists():
        extract.mkdir(exist_ok=True);subprocess.run(['dpkg-deb','-x',str(base),str(extract)],check=True)
        (extract/'opt/annotation-workbench').rename(stage)
    original=json.loads((stage/'release.json').read_text())
    changes=sources()
    changes['resources/app/studio.css']+=b'\n@font-face{font-family:"Workbench Sans";src:url("../workbench/.runtime/fonts/NotoSansSC.ttf") format("truetype");font-weight:100 900;font-display:swap}body{font-family:"Workbench Sans","DejaVu Sans",sans-serif}\n'
    changes['release.json']=metadata('linux',original)
    for name,data in changes.items():
        target=stage/name;target.parent.mkdir(parents=True,exist_ok=True);target.write_bytes(data)
    info={'version':VERSION,'platform':'linux','stage':str(stage),'base_release':'v'+BASE}
    (BUILD/'linux-stage.json').write_text(json.dumps(info,indent=2))
    print('LINUX_STAGE_REBUILT',stage,len(changes),'source files',flush=True)
    subprocess.run([sys.executable,str(BUILD/'linux_manifest.py')],check=True)
    subprocess.run([sys.executable,str(BUILD/'build_deb.py')],check=True)

if __name__=='__main__':
    if sys.argv[1]=='windows':windows()
    elif sys.argv[1]=='linux':linux()
    else:raise SystemExit('Usage: rebuild_from_release.py windows|linux')
