"""Resume and SHA256-verify the published dependency payloads for v0.6 builds."""
from pathlib import Path
import concurrent.futures,hashlib,json,time,urllib.request
ROOT=Path(__file__).resolve().parent
assets=json.loads((ROOT/'base-runtime-v0.5.2.json').read_text())
def sha256(p):
    h=hashlib.sha256()
    with p.open('rb') as source:
        while block:=source.read(8<<20):h.update(block)
    return h.hexdigest()
def fetch(a):
    target=ROOT/'downloads'/a['name'];target.parent.mkdir(exist_ok=True)
    if target.is_file() and target.stat().st_size==a['bytes'] and sha256(target)==a['sha256']:return str(target)
    temporary=target.with_suffix(target.suffix+'.partial')
    for attempt in range(6):
        size=temporary.stat().st_size if temporary.exists() else 0
        if size==a['bytes']:
            if sha256(temporary)==a['sha256']:
                temporary.replace(target);print('BASE_VERIFIED',a['name'],flush=True);return str(target)
            temporary.unlink();size=0
        if size>a['bytes']:temporary.unlink();size=0
        headers={'User-Agent':'AnnotationWorkbench-v0.6-release'}
        if size:headers['Range']=f'bytes={size}-'
        start=time.monotonic();last=start
        try:
            with urllib.request.urlopen(urllib.request.Request(a['url'],headers=headers),timeout=90) as response:
                if size and response.status!=206:size=0
                if size and not response.headers.get('Content-Range','').startswith(f'bytes {size}-'):raise ValueError('Unexpected range response')
                with temporary.open('ab' if size else 'wb') as out:
                    while block:=response.read(8<<20):
                        out.write(block);size+=len(block);now=time.monotonic()
                        if now-last>15:print(a['name'],f'{size/1e9:.2f}/{a["bytes"]/1e9:.2f} GB',flush=True);last=now
        except Exception as error:print('DOWNLOAD_RETRY',a['name'],str(error),flush=True)
    raise ValueError('Unable to complete verified asset: '+a['name'])
if __name__=='__main__':
    with concurrent.futures.ThreadPoolExecutor(max_workers=4) as pool:
        for p in pool.map(fetch,assets):print('READY',p,flush=True)
