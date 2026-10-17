"""Create isolated, self-contained desktop releases without changing dev runtimes."""
from pathlib import Path
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
VERSION=json.loads((ROOT/'desktop/package.json').read_text(encoding='utf-8'))['version']
OUT.mkdir(exist_ok=True)

def progress(message):print(message,flush=True)
def ignore(directory,names):
    excluded={'.git','__pycache__','.pytest_cache','.ruff_cache'}
    return [n for n in names if n in excluded or n.startswith('__editable__') or n.endswith(('.pyc','.egg-link'))]

def source_ignore(directory,names):
    return ignore(directory,names)+[n for n in names if n in {'node_modules','runs','dist','build','.venv','.runtime'}]

def linux_copy(source,destination,filter_function=ignore):
    """Hardlink immutable build inputs on one volume, avoiding WSL metadata churn."""
    destination.mkdir(parents=True,exist_ok=True)
    present=set(os.listdir(destination));entries=list(os.scandir(source))
    excluded=set(filter_function(str(source),[entry.name for entry in entries]))
    for entry in entries:
        if entry.name in excluded:continue
        origin=Path(entry.path);target=destination/entry.name
        if entry.is_symlink():
            if entry.name not in present:target.symlink_to(os.readlink(origin),target_is_directory=entry.is_dir())
        elif entry.is_dir(follow_symlinks=False):linux_copy(origin,target,filter_function)
        elif entry.name not in present:
            try:os.link(origin,target)
            except OSError:shutil.copyfile(origin,target)

def stage(platform):
    target=BUILD/('stage-'+platform+'-'+VERSION)
    target.mkdir(exist_ok=True)
    progress('Copying Electron '+platform)
    if platform=='windows':
        shutil.copytree(ROOT/'desktop/node_modules/electron/dist',target,dirs_exist_ok=True)
        original=target/'electron.exe'
        if original.exists():original.replace(target/'AnnotationWorkbench.exe')
    else:
        with zipfile.ZipFile(BUILD/'downloads/electron-linux.zip') as archive:
            for item in archive.infolist():
                destination=(target/item.filename).resolve()
                if not destination.is_relative_to(target.resolve()):raise ValueError('Unsafe runtime path')
                archive.extract(item,target)
                mode=(item.external_attr>>16)&0o777
                if mode:os.chmod(destination,mode)
        (target/'electron').chmod(0o755)
    app=target/'resources/app'
    app.mkdir(parents=True,exist_ok=True)
    for source in (ROOT/'desktop').iterdir():
        if source.is_file() and source.suffix in {'.cjs','.js','.html','.css','.json','.svg','.png','.ico'} and source.name!='package-lock.json':shutil.copy2(source,app/source.name)
    workbench=target/'resources/workbench'
    workbench.mkdir(parents=True,exist_ok=True)
    progress('Copying full source and portable Python')
    shutil.copytree(ROOT/'X-AnyLabeling',workbench/'X-AnyLabeling',ignore=source_ignore,dirs_exist_ok=True)
    runtime=workbench/'.runtime';runtime.mkdir(exist_ok=True)
    shutil.copy2(ROOT/'.runtime/launcher.pyw',runtime/'launcher.pyw')
    shutil.copytree(ROOT/'.runtime/pretrained',runtime/'pretrained',dirs_exist_ok=True)
    shutil.copytree(ROOT/'.runtime/fonts',runtime/'fonts',dirs_exist_ok=True)
    if platform=='windows':
        shutil.copytree(ROOT/'.runtime/python',runtime/'python',ignore=ignore,dirs_exist_ok=True)
        progress('Copying Windows CPU/CUDA libraries (several GB)')
        shutil.copytree(ROOT/'.venv/Lib/site-packages',workbench/'.venv/Lib/site-packages',ignore=ignore,dirs_exist_ok=True)
    else:
        linux_copy(BUILD/'linux-python',runtime/'linux-python')
        with (app/'studio.css').open('a',encoding='utf-8') as style:
            style.write('\n@font-face{font-family:"Workbench Sans";src:url("../workbench/.runtime/fonts/NotoSansSC.ttf") format("truetype");font-weight:100 900;font-display:swap}body{font-family:"Workbench Sans","DejaVu Sans",sans-serif}\n')
        launcher=target/'启动工作台.sh'
        launcher.write_text('#!/usr/bin/env bash\nset -e\nAPP="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"\ncd "$APP"\nexec "$APP/electron" "$@"\n',encoding='utf-8')
        launcher.chmod(0o755)
        (target/'安装桌面入口.sh').write_text('#!/usr/bin/env bash\nset -e\nAPP="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"\nmkdir -p "$HOME/.local/share/applications"\ncat > "$HOME/.local/share/applications/annotation-workbench.desktop" <<EOF\n[Desktop Entry]\nType=Application\nName=标注训练工作台\nExec="$APP/启动工作台.sh"\nPath=$APP\nTerminal=false\nCategories=Graphics;Science;\nEOF\necho "已添加应用菜单入口。"\n',encoding='utf-8')
        (target/'安装桌面入口.sh').chmod(0o755)
    # Portable data always stays outside the program resources and is not archived.
    (target/'portable.flag').write_text('portable data beside executable\n',encoding='utf-8')
    shutil.copy2(ROOT/'文档/安装后使用.md',target/'使用说明.md')
    shutil.copy2(ROOT/'X-AnyLabeling/LICENSE',target/'SOURCE-LICENSE-GPL3.txt')
    data_home='程序旁的“工作台数据”' if platform=='windows' else '~/.config/AnnotationTrainingWorkbench（DEB 安装）'
    (target/'源码与许可说明.txt').write_text('本包包含 Electron 界面源码与 X-AnyLabeling 扩展源码。\n界面源码位于 resources/app，Python 源码位于 resources/workbench/X-AnyLabeling。\n第三方库许可随运行时一同保留。训练权重另遵循对应提供方的许可。\n用户项目、配置和日志保存位置：'+data_home+'。\n',encoding='utf-8')
    info={'version':VERSION,'platform':platform,'created':time.time(),'upstream_revision':'745f6c355f94cddb06f6965b3a4118f82033e935','python':'3.12','electron':json.loads((ROOT/'desktop/package.json').read_text(encoding='utf-8'))['devDependencies']['electron']}
    (target/'release.json').write_text(json.dumps(info,ensure_ascii=False,indent=2),encoding='utf-8')
    (BUILD/(platform+'-stage.json')).write_text(json.dumps({**info,'stage':str(target)},ensure_ascii=False,indent=2),encoding='utf-8')
    progress('STAGE_READY '+str(target))
    return target

def archive_windows():
    target=Path(json.loads((BUILD/'windows-stage.json').read_text(encoding='utf-8'))['stage'])
    payload=BUILD/('windows-'+VERSION+'.zip')
    files=sorted(p for p in target.rglob('*') if p.is_file() and '工作台数据' not in p.relative_to(target).parts)
    total=sum(p.stat().st_size for p in files);done=0;last=0
    with zipfile.ZipFile(payload,'w',compression=zipfile.ZIP_DEFLATED,compresslevel=6,allowZip64=True) as archive:
        for p in files:
            archive.write(p,p.relative_to(target).as_posix());done+=p.stat().st_size
            if time.monotonic()-last>15:progress(f'Compressed {done/1e9:.2f}/{total/1e9:.2f} GB');last=time.monotonic()
    windows_sfx(payload)

def windows_sfx(payload=None):
    payload=payload or BUILD/('windows-'+VERSION+'.zip')
    compiler=Path(os.environ.get('WINDIR','C:/Windows'))/'Microsoft.NET/Framework64/v4.0.30319/csc.exe'
    stub=BUILD/'windows-setup-stub.exe'
    generated=BUILD/'generated';generated.mkdir(exist_ok=True)
    installer=generated/'Installer.cs'
    installer.write_text((BUILD/'Installer.cs').read_text(encoding='utf-8').replace('@VERSION@',VERSION),encoding='utf-8')
    subprocess.run([str(compiler),'/nologo','/codepage:65001','/target:winexe','/platform:x64','/win32icon:'+str(ROOT/'desktop/icon.ico'),'/r:System.Windows.Forms.dll','/r:System.Drawing.dll','/r:System.IO.Compression.dll','/out:'+str(stub),str(installer)],check=True)
    release=OUT/('AnnotationWorkbench-'+VERSION+'-Windows-x64-CPU-GPU.exe')
    temporary=release.with_suffix('.exe.partial')
    with temporary.open('wb') as out:
        for source in (stub,payload):
            with source.open('rb') as stream:shutil.copyfileobj(stream,out,1024*1024)
        out.write(struct.pack('<Q',payload.stat().st_size));out.write(b'XALPACK1')
    temporary.replace(release)
    digest=hashlib.file_digest(release.open('rb'),'sha256').hexdigest()
    release.with_suffix('.exe.sha256').write_text(digest+'  '+release.name+'\n',encoding='utf-8')
    progress('RELEASE_READY '+str(release)+' '+str(release.stat().st_size))

if __name__=='__main__':
    if sys.argv[1]=='stage':stage(sys.argv[2])
    elif sys.argv[1]=='windows-exe':archive_windows()
    elif sys.argv[1]=='windows-sfx':windows_sfx()
