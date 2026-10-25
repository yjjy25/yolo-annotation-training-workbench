"""Verify archives against current source, without extracting multi-GB runtimes."""
from pathlib import Path, PurePosixPath
import hashlib
import io
import json
import os
import struct
import sys
import tarfile
import zipfile

ROOT = Path(__file__).resolve().parent.parent
BUILD = ROOT / '.packaging'
VERSION = json.loads((ROOT/'desktop/package.json').read_text(encoding='utf-8'))['version']
OUT = ROOT/'发行包'
sys.path.insert(0, str(BUILD/'python-build-modules'))
import zstandard


def checksum(stream):
    return hashlib.file_digest(stream, 'sha256').hexdigest()


def source_files():
    files = {}
    for p in (ROOT/'desktop').iterdir():
        if p.is_file() and p.suffix in {'.cjs','.js','.html','.css','.json','.svg','.png','.ico'} and p.name != 'package-lock.json':
            files['resources/app/'+p.name] = p
    excluded = {'.git','__pycache__','.pytest_cache','.ruff_cache','node_modules','runs','dist','build','.venv','.runtime'}
    for base, dirs, names in os.walk(ROOT/'X-AnyLabeling'):
        dirs[:] = [d for d in dirs if d not in excluded and not d.endswith('.egg-info')]
        for name in names:
            p = Path(base)/name
            if not name.endswith(('.pyc','.egg-link')) and not name.startswith('__editable__'):
                files['resources/workbench/'+p.relative_to(ROOT).as_posix()] = p
    files['resources/workbench/.runtime/launcher.pyw'] = ROOT/'.runtime/launcher.pyw'
    for p in (ROOT/'.runtime/fonts').iterdir():
        if p.is_file(): files['resources/workbench/.runtime/fonts/'+p.name] = p
    files['使用说明.md'] = ROOT/'文档/v0.6_安装说明.md'
    files['SOURCE-LICENSE-GPL3.txt'] = ROOT/'X-AnyLabeling/LICENSE'
    return files


def check_source(name, data, linux=False):
    original = SOURCES[name].read_bytes()
    if linux and name == 'resources/app/studio.css':
        assert data.startswith(original) and b'@font-face' in data[len(original):], name
    else:
        assert hashlib.sha256(data).digest() == hashlib.sha256(original).digest(), name


SOURCES = source_files()
report = {'version':VERSION,'source_files_per_platform':len(SOURCES),'artifacts':[]}
exe = OUT/f'AnnotationWorkbench-{VERSION}-Windows-x64-CPU-GPU.exe'
with exe.open('rb') as f:
    assert f.read(2) == b'MZ'
    f.seek(-16,2)
    length = struct.unpack('<Q',f.read(8))[0]
    assert f.read(8) == b'XALPACK1' and 0 < length < exe.stat().st_size-16
with zipfile.ZipFile(exe) as archive:
    names = archive.namelist()
    assert len(names) == len(set(names))
    assert not any('工作台数据' in PurePosixPath(n).parts for n in names)
    for name in SOURCES:
        check_source(name,archive.read(name))
    assert archive.testzip() is None
print('WINDOWS_CRC_AND_ALL_SOURCE_VERIFIED',len(SOURCES),flush=True)

deb = OUT/f'AnnotationWorkbench-{VERSION}-Ubuntu-amd64.deb'
seen = set()
with deb.open('rb') as f:
    assert f.read(8) == b'!<arch>\n'
    while header := f.read(60):
        assert len(header) == 60 and header[-2:] == b'`\n'
        name = header[:16].decode('ascii').strip().rstrip('/')
        length = int(header[48:58]); end = f.tell()+length
        if name == 'control.tar.gz':
            with tarfile.open(fileobj=io.BytesIO(f.read(length)),mode='r:gz') as control:
                assert ('Version: '+VERSION).encode() in control.extractfile('control').read()
        elif name == 'data.tar.zst':
            with zstandard.ZstdDecompressor().stream_reader(f,closefd=False) as reader:
                with tarfile.open(fileobj=reader,mode='r|') as archive:
                    for entry in archive:
                        assert not entry.name.startswith('/') and '..' not in PurePosixPath(entry.name).parts
                        relative = entry.name.removeprefix('opt/annotation-workbench/')
                        assert '工作台数据' not in PurePosixPath(entry.name).parts and relative != 'portable.flag'
                        if relative in SOURCES:
                            check_source(relative,archive.extractfile(entry).read(),linux=True)
                            seen.add(relative)
                        if relative == 'chrome-sandbox':
                            assert entry.uid == 0 and entry.mode == 0o4755
        f.seek(end+(length&1))
assert seen == set(SOURCES), sorted(set(SOURCES)-seen)
print('DEB_STREAM_AND_ALL_SOURCE_VERIFIED',len(seen),flush=True)
for p in (exe,deb):
    with p.open('rb') as f: digest=checksum(f)
    report['artifacts'].append({'name':p.name,'bytes':p.stat().st_size,'sha256':digest})
    p.with_suffix(p.suffix+'.sha256').write_text(digest+'  '+p.name+'\n',encoding='utf-8')
(OUT/'校验').mkdir(exist_ok=True)
(OUT/'校验'/f'release-{VERSION}.json').write_text(json.dumps(report,ensure_ascii=False,indent=2),encoding='utf-8')
print('RELEASE_VERIFIED',flush=True)
