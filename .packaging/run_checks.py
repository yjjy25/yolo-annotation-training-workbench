"""Run GUI test modules in isolated processes so Qt state cannot cross modules."""
from pathlib import Path
import json
import os
import re
import subprocess
import sys

ROOT=Path(__file__).resolve().parent.parent
OUT=ROOT/'.packaging/checks-041'
OUT.mkdir(exist_ok=True)
results=[]
tests=sorted((ROOT/'X-AnyLabeling/tests/workflow').glob('test_*.py'))
tests+=sorted((ROOT/'X-AnyLabeling/tests/test_auto_training').glob('test_*.py'))
for index,test in enumerate(tests):
    log=OUT/(test.stem+'.log')
    with log.open('w',encoding='utf-8') as output:
        process=subprocess.run([sys.executable,'-m','pytest',str(test),'-q','--tb=short','--color=no','--basetemp='+str(OUT/('tmp-'+str(index)))],cwd=ROOT/'X-AnyLabeling',env={**os.environ,'QT_QPA_PLATFORM':'offscreen','PYTHONIOENCODING':'utf-8'},stdout=output,stderr=subprocess.STDOUT,timeout=120)
    text=log.read_text(encoding='utf-8',errors='replace')
    passed=re.findall(r'(\d+) passed',text)
    result={'test':test.relative_to(ROOT).as_posix(),'exit':process.returncode,'passed':int(passed[-1]) if passed else 0}
    results.append(result)
    print(json.dumps(result),flush=True)
report={'passed':sum(r['passed'] for r in results),'ok':all(r['exit']==0 for r in results),'modules':results}
(OUT/'results.json').write_text(json.dumps(report,indent=2),encoding='utf-8')
print('TOTAL',json.dumps({k:v for k,v in report.items() if k!='modules'}),flush=True)
sys.exit(0 if report['ok'] else 1)
