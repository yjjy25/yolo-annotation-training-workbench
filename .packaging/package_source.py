"""Export a clean GitHub tree and corresponding-source ZIP; exclude private data."""
from pathlib import Path
import hashlib
import json
import os
import shutil
import zipfile

ROOT = Path(__file__).resolve().parent.parent
VERSION = json.loads((ROOT / 'desktop/package.json').read_text(encoding='utf-8'))['version']
OUT = ROOT / '发行包/源码'
OUT.mkdir(parents=True, exist_ok=True)
TARGET = OUT / ('AnnotationWorkbench-' + VERSION)
EXCLUDED = {'.git', '.venv', '.runtime', 'node_modules', '__pycache__', '.pytest_cache', '.ruff_cache', 'build', 'dist', 'runs', '.vscode'}
LOCAL_DOCS = {'磁盘清理记录_20261018.md', '清理确认清单_20261018.md'}
files = []
for folder in ('X-AnyLabeling', 'desktop', '文档', '.github'):
    for base, dirs, names in os.walk(ROOT / folder):
        dirs[:] = [d for d in dirs if d not in EXCLUDED and not d.endswith('.egg-info')]
        files.extend(Path(base)/n for n in names if n not in LOCAL_DOCS and not n.startswith(('磁盘清理记录_', '清理确认清单_')) and not n.endswith(('.pyc', '.pt', '.onnx', '.log')))
files += [ROOT/n for n in ('README.md', 'CHANGELOG.md', 'LICENSE', 'THIRD_PARTY_NOTICES.md', '.gitignore', '.gitattributes', 'setup-windows.ps1', '双击启动.vbs', 'setup-linux.sh', 'start.sh', '.runtime/launcher.pyw', '.runtime/python/python312._pth')]
files += list((ROOT / '.runtime/fonts').glob('*'))
files += [ROOT/'.packaging'/n for n in ('join.ps1','join.sh')]
files += [ROOT/'.packaging'/n for n in ('build_release.py','build_deb.py','linux_manifest.py','prepare-linux.sh','package_source.py','verify_release.py','split_release.py','run_checks.py','Installer.cs','构建说明.md')]
records=[]
for p in sorted(set(files)):
    if not p.is_file():
        raise FileNotFoundError(p)
    relative=p.relative_to(ROOT)
    destination=TARGET/relative
    destination.parent.mkdir(parents=True,exist_ok=True)
    shutil.copy2(p,destination)
    with p.open('rb') as stream: checksum=hashlib.file_digest(stream,'sha256').hexdigest()
    records.append({'path':relative.as_posix(),'size':p.stat().st_size,'sha256':checksum})
(TARGET/'SOURCE_MANIFEST.json').write_text(json.dumps(records,ensure_ascii=False,indent=2),encoding='utf-8')
expected = {r['path'] for r in records} | {'SOURCE_MANIFEST.json'}
actual = {p.relative_to(TARGET).as_posix() for p in TARGET.rglob('*') if p.is_file() and '.git' not in p.relative_to(TARGET).parts}
if actual != expected:
    raise ValueError('Source export has stale files; choose a fresh version directory: '+str(sorted(actual-expected)))
archive_path=OUT/('AnnotationWorkbench-'+VERSION+'-source.zip')
with zipfile.ZipFile(archive_path,'w',zipfile.ZIP_DEFLATED,compresslevel=6) as archive:
    for relative in sorted(expected):
        archive.write(TARGET/relative,relative)
with zipfile.ZipFile(archive_path) as archive:
    assert archive.testzip() is None
print('SOURCE_VERIFIED', len(records), 'files', archive_path.stat().st_size, 'bytes', flush=True)
