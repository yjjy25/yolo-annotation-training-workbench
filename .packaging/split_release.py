"""Split large artifacts for GitHub Releases, with verified reconstruction."""
from pathlib import Path
import hashlib
import json
import shutil

ROOT=Path(__file__).resolve().parent.parent
VERSION=json.loads((ROOT/'desktop/package.json').read_text(encoding='utf-8'))['version']
OUT=ROOT/'发行包/GitHub-Releases'/VERSION
OUT.mkdir(parents=True,exist_ok=True)
records=[]
for p in sorted((ROOT/'发行包').glob('AnnotationWorkbench-'+VERSION+'*')):
    if p.suffix not in {'.exe','.deb'}: continue
    pieces=[]; full=hashlib.sha256(); number=0
    with p.open('rb') as source:
        while True:
            first=source.read(8<<20)
            if not first: break
            number+=1; part=OUT/(p.name+'.part'+str(number).zfill(3))
            size=0; digest=hashlib.sha256()
            with part.open('wb') as target:
                block=first
                while block:
                    target.write(block); full.update(block); digest.update(block); size+=len(block)
                    if size>=2000*1024*1024: break
                    block=source.read(min(8<<20,2000*1024*1024-size))
            pieces.append({'name':part.name,'bytes':size,'sha256':digest.hexdigest()})
    with p.open('rb') as f: assert full.hexdigest()==hashlib.file_digest(f,'sha256').hexdigest()
    records.append({'name':p.name,'bytes':p.stat().st_size,'sha256':full.hexdigest(),'parts':pieces})
(OUT/'parts.json').write_text(json.dumps(records,indent=2),encoding='utf-8')
for record in records:
    (OUT/(record['name']+'.parts.sha256')).write_text(''.join(p['sha256']+'  '+p['name']+'\n' for p in record['parts']),encoding='utf-8')
(OUT/'SHA256SUMS.txt').write_text(''.join(r['sha256']+'  '+r['name']+'\n' for r in records),encoding='utf-8')
for name in ('join.ps1','join.sh'):
    shutil.copy2(ROOT/'.packaging'/name,OUT/name)
(OUT/'join.py').write_text('''from pathlib import Path
import hashlib,json,sys
root=Path(__file__).resolve().parent
for record in json.loads((root/'parts.json').read_text()):
    if len(sys.argv)>1 and not any(arg.lower() in record['name'].lower() for arg in sys.argv[1:]): continue
    target=root/record['name']
    if target.exists(): raise SystemExit('Already exists: '+str(target))
    temporary=target.with_suffix(target.suffix+'.partial'); full=hashlib.sha256()
    with temporary.open('wb') as output:
        for part in record['parts']:
            digest=hashlib.sha256(); size=0
            with (root/part['name']).open('rb') as source:
                while block:=source.read(8<<20): output.write(block); digest.update(block); full.update(block); size+=len(block)
            if size!=part['bytes'] or digest.hexdigest()!=part['sha256']: raise SystemExit('Invalid part: '+part['name'])
    if full.hexdigest()!=record['sha256']: raise SystemExit('Checksum mismatch')
    temporary.rename(target); print('Verified:',target.name)
''',encoding='utf-8')
source=ROOT/'发行包/源码'/('AnnotationWorkbench-'+VERSION+'-source.zip')
if source.is_file():
    shutil.copy2(source,OUT/source.name)
    with source.open('rb') as f: source_hash=hashlib.file_digest(f,'sha256').hexdigest()
    (OUT/(source.name+'.sha256')).write_text(source_hash+'  '+source.name+'\n',encoding='utf-8')
print('GITHUB_PARTS_READY',len(records),'artifacts',flush=True)
