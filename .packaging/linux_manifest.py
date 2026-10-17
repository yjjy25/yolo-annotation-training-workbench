from pathlib import Path
import json
import os

root=Path(__file__).resolve().parent
version=json.loads((root.parent/'desktop/package.json').read_text(encoding='utf-8'))['version']
stage=root/('stage-linux-'+version)
items=[]
def visit(directory):
    for entry in os.scandir(directory):
        if entry.name in {'工作台数据','portable.flag','__pycache__'} or entry.name.endswith('.pyc'):continue
        path=Path(entry.path);name=path.relative_to(stage).as_posix()
        if entry.is_symlink():items.append({'name':name,'type':'link','target':os.readlink(path)})
        elif entry.is_dir(follow_symlinks=False):items.append({'name':name,'type':'dir'});visit(path)
        else:items.append({'name':name,'type':'file'})
visit(stage)
(root/'linux-file-manifest.json').write_text(json.dumps(items,ensure_ascii=False),encoding='utf-8')
print('LINUX_MANIFEST_READY',len(items),flush=True)
