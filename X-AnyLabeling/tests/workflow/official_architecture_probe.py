"""Compare workbench models with downloaded commit-pinned official configurations.

Run with PYTHONPATH=X-AnyLabeling python <this-file> <upstream-folder> <output-folder>.
Fresh subprocess per variant bounds memory. Synthetic forward only; no user data.
"""
from pathlib import Path
import json
import subprocess
import sys


def child(upstream, template):
    import copy, hashlib, math, torch
    from ultralytics.nn.tasks import DetectionModel
    from ultralytics.utils import YAML
    from anylabeling.services.workflow.model_design.core import (
        TEMPLATES,TEMPLATE_SCALES,template_config,build,inspect_model,trace_model,signature,content_hash)
    torch.set_num_threads(2)
    config=YAML.load(upstream/TEMPLATES[template])
    scale=TEMPLATE_SCALES[template];depth,width,cap=config['scales'][scale]
    config.update(scale=scale,nc=80)
    with torch.random.fork_rng(devices=[]):
        torch.manual_seed(42);native=DetectionModel(copy.deepcopy(config),ch=3,verbose=False)
    def state_hash(model):
        digest=hashlib.sha256()
        for key,value in model.state_dict().items():
            digest.update(key.encode());digest.update(value.contiguous().numpy().tobytes())
        return digest.hexdigest()
    native_state=state_hash(native);native_signature=content_hash(signature(native));del native
    _,source=template_config(template,80)
    model=build(dict(schema=1,template=template,source=source,nc=80,imgsz=128,seed=42,edits=[]))
    info=inspect_model(model);trace=trace_model(model,128)
    assert state_hash(model)==native_state
    assert content_hash(signature(model))==native_signature
    rows=config['backbone']+config['head'];assert len(rows)==len(info['graph'])
    repeat_types={'C3','C2f','C3k2','C2PSA','A2C2f'}
    channel_types=repeat_types|{'Conv','SPPF'}
    records=[]
    for i,(row,node,module) in enumerate(zip(rows,info['graph'],model.model)):
        frm,repeats,kind,args=row;execution=trace['modules'][i]
        assert node['from']==frm and node['type']==kind.split('.')[-1]
        assert node['definition']==row
        actual=1
        if kind in repeat_types:
            actual=len(module.m);assert actual==max(round(repeats*depth),1)
        if kind in channel_types:
            channels=math.ceil(min(args[0],cap)*width/8)*8
            assert execution['output'][1]==channels,(template,i,execution['output'],channels)
        if kind=='Concat':
            assert execution['output'][1]==sum(shape[1] for shape in execution['input'])
            assert all(shape[2:]==execution['output'][2:] for shape in execution['input'])
        assert execution['connections_verified']
        records.append(dict(index=i,type=node['type'],source=frm,repeats=actual,input=execution['input'],output=execution['output']))
    head=info['detection'];assert head['sources']==rows[-1][0]
    assert head['strides']==[8,16,32]
    assert head['reg_max']==(1 if template.startswith('yolo26') else 16)
    assert head['dfl']==('Identity' if template.startswith('yolo26') else 'DFL')
    assert head['one2one']==template.startswith('yolo26')
    if template.startswith('yolo26'):
        assert model.model[9].add
        assert head['configured_end2end']
        model.eval();model.end2end=True
        with torch.inference_mode(): one2one=model(torch.zeros(1,3,128,128))[0]
        assert list(one2one.shape)==[1,300,6]
        model.end2end=head['end2end']
    last=trace['modules'][len(rows)-1]
    assert [shape[-2:] for shape in last['input']]==[[16,16],[8,8],[4,4]]
    expected=[1,300,6] if head['end2end'] else [1,84,336]
    assert last['output'][0]==expected,(template,last['output'][0],expected)
    return dict(template=template,scale=scale,scaling=[depth,width,cap],parameters=info['parameters'],
                native_signature_equal=True,native_weights_equal=True,head=head,modules=records,upstream=source['upstream'])


if __name__=='__main__':
    upstream=Path(sys.argv[1]);root=Path(sys.argv[2]);root.mkdir(parents=True,exist_ok=True)
    if len(sys.argv)>3:
        template=sys.argv[3];(root/(template+'.json')).write_text(json.dumps(child(upstream,template),ensure_ascii=False,indent=2))
    else:
        from anylabeling.services.workflow.model_design.core import TEMPLATES
        results=[]
        for template in TEMPLATES:
            process=subprocess.run([sys.executable,__file__,str(upstream),str(root),template],capture_output=True,text=True,timeout=180)
            row=json.loads((root/(template+'.json')).read_text()) if process.returncode==0 else dict(template=template,error=process.stderr[-4000:])
            results.append(row);(root/'official-matrix.json').write_text(json.dumps(results,ensure_ascii=False,indent=2))
            print(template,'FAILED' if 'error' in row else 'passed',flush=True)
        raise SystemExit(1 if any('error' in row for row in results) else 0)
