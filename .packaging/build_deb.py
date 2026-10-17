"""Build an Ubuntu .deb without requiring root or changing the host system."""
from pathlib import Path
import gzip
import hashlib
import io
import json
import os
import sys
import tarfile
import time

ROOT=Path(__file__).resolve().parent.parent
BUILD=ROOT/'.packaging';OUT=ROOT/'发行包';OUT.mkdir(exist_ok=True)
sys.path.insert(0,str(BUILD/'python-build-modules'))
import zstandard
info=json.loads((BUILD/'linux-stage.json').read_text(encoding='utf-8'))
version=info['version'];stage=BUILD/('stage-linux-'+version)
prefix='opt/annotation-workbench'
manifest=json.loads((BUILD/'linux-file-manifest.json').read_text(encoding='utf-8'))
files=sorted(manifest,key=lambda item:item['name'])
total=sum((stage/item['name']).stat().st_size for item in files if item['type']=='file')

def member(path,name,item):
    entry=tarfile.TarInfo(name);entry.uid=entry.gid=0;entry.uname=entry.gname='root';entry.mtime=int(time.time())
    if item['type']=='link':entry.type=tarfile.SYMTYPE;entry.linkname=item['target'];entry.mode=0o777;return entry,None
    if item['type']=='dir':entry.type=tarfile.DIRTYPE;entry.mode=0o755;return entry,None
    entry.size=path.stat().st_size;entry.mode=0o644
    with path.open('rb') as source:magic=source.read(4)
    if magic==b'\x7fELF' or path.suffix=='.sh':entry.mode=0o755
    if path.name=='chrome-sandbox':entry.mode=0o4755
    return entry,path.open('rb')

data=BUILD/'ubuntu-data.tar.zst';done=0;last=0
with data.open('wb') as raw,zstandard.ZstdCompressor(level=5,threads=4).stream_writer(raw) as compressed,tarfile.open(fileobj=compressed,mode='w|',format=tarfile.PAX_FORMAT,copybufsize=1024*1024) as archive:
    for item in files:
        path=stage/item['name']
        entry,source=member(path,prefix+'/'+item['name'],item);archive.addfile(entry,source)
        if source:source.close();done+=entry.size
        if time.monotonic()-last>15:print(f'Ubuntu packed {done/1e9:.2f}/{total/1e9:.2f} GB',flush=True);last=time.monotonic()
    desktop=b'[Desktop Entry]\nType=Application\nName=Annotation Workbench\nName[zh_CN]=\xe6\xa0\x87\xe6\xb3\xa8\xe8\xae\xad\xe7\xbb\x83\xe5\xb7\xa5\xe4\xbd\x9c\xe5\x8f\xb0\nExec=/opt/annotation-workbench/electron\nIcon=/opt/annotation-workbench/resources/app/icon.svg\nTerminal=false\nCategories=Graphics;Science;\n'
    entry=tarfile.TarInfo('usr/share/applications/annotation-workbench.desktop');entry.size=len(desktop);entry.mode=0o644;entry.uid=entry.gid=0;archive.addfile(entry,io.BytesIO(desktop))
control=(f'Package: annotation-workbench\nVersion: {version}\nSection: graphics\nPriority: optional\nArchitecture: amd64\nMaintainer: Annotation Workbench Project\nInstalled-Size: {total//1024}\nDepends: libc6 (>= 2.35), libgtk-3-0 | libgtk-3-0t64, libnss3, libnspr4, libasound2 | libasound2t64, libgbm1, libxss1, libxtst6, libatk1.0-0 | libatk1.0-0t64, libatk-bridge2.0-0 | libatk-bridge2.0-0t64, libgl1, libopengl0, libegl1, libxcb-cursor0, ca-certificates, xdg-utils\nDescription: Integrated annotation and local YOLO training desktop\n Based on X-AnyLabeling with Electron workflow, pose templates and CPU/CUDA training.\n Corresponding source and third party licenses are included.\n').encode()
control_path=BUILD/'ubuntu-control.tar.gz'
with tarfile.open(control_path,'w:gz') as archive:
    entry=tarfile.TarInfo('control');entry.size=len(control);entry.mode=0o644;entry.uid=entry.gid=0;archive.addfile(entry,io.BytesIO(control))

release=OUT/f'AnnotationWorkbench-{version}-Ubuntu-amd64.deb'
temporary=release.with_suffix('.deb.partial')
with temporary.open('wb') as output:
    output.write(b'!<arch>\n')
    for name,source in [('debian-binary',io.BytesIO(b'2.0\n')),('control.tar.gz',control_path.open('rb')),('data.tar.zst',data.open('rb'))]:
        source.seek(0,2);size=source.tell();source.seek(0)
        header=f'{name+"/":<16}{int(time.time()):<12}{0:<6}{0:<6}{"100644":<8}{size:<10}`\n'.encode('ascii')
        assert len(header)==60
        output.write(header)
        while block:=source.read(1024*1024):output.write(block)
        source.close()
        if size%2:output.write(b'\n')
temporary.replace(release)
with release.open('rb') as source:digest=hashlib.file_digest(source,'sha256').hexdigest()
release.with_suffix('.deb.sha256').write_text(digest+'  '+release.name+'\n',encoding='utf-8')
print('RELEASE_READY',release,release.stat().st_size,flush=True)
