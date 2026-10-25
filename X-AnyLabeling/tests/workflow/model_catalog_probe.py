"""Reproducible isolated compatibility matrix; no user data or downloads.

PYTHONPATH=X-AnyLabeling python X-AnyLabeling/tests/workflow/model_catalog_probe.py /tmp/catalog-proof
Each variant runs in a fresh process to release large-scale model allocations.
"""
import json
from pathlib import Path
import subprocess
import sys
import time


def child(folder, template):
    import torch
    from types import SimpleNamespace
    from anylabeling.services.workflow.model_design.worker import run
    from anylabeling.services.workflow.model_design.core import content_hash, signature, TEMPLATE_SCALES
    from anylabeling.services.workflow.model_design.training import DesignDetectionTrainer
    from ultralytics.utils import YAML
    torch.set_num_threads(2)
    result = run(folder, dict(template=template, nc=1, imgsz=64, seed=42, action="check", edits=[
        dict(id="model.1.conv", field="kernel", value=5), dict(id="model.1.act", field="activation", value="ReLU")]))
    trainer = object.__new__(DesignDetectionTrainer)
    trainer.data = dict(nc=1, channels=3, names={0:"object"})
    trainer.args = SimpleNamespace(cls_remap=True)
    rebuilt = trainer.get_model(YAML.load(result["model_path"]), None, verbose=False)
    assert content_hash(signature(rebuilt)) == result["modified"]["signature"]
    assert rebuilt.yaml["scale"] == TEMPLATE_SCALES[template]
    assert rebuilt.model[1].conv.kernel_size == (5,5)
    return dict(template=template, scale=rebuilt.yaml["scale"], parameters=result["modified"]["parameters"],
                checks=result["checks"], connections_verified=all(row["connections_verified"] for row in result["execution"]["modules"].values()),
                trainer_rebuild=True, source=result["design"]["source"], revision=result["model_path"])


if __name__ == "__main__":
    root = Path(sys.argv[1]);root.mkdir(parents=True,exist_ok=True)
    if len(sys.argv)>2:
        (root/(sys.argv[2]+".json")).write_text(json.dumps(child(root,sys.argv[2]),ensure_ascii=False,indent=2))
    else:
        from anylabeling.services.workflow.model_design.core import TEMPLATES
        results=[]
        for template in TEMPLATES:
            started=time.monotonic()
            run=subprocess.run([sys.executable,__file__,str(root),template],capture_output=True,text=True,timeout=180)
            if run.returncode:
                item=dict(template=template,error=run.stderr[-4000:],stdout=run.stdout[-1000:])
            else:
                item=json.loads((root/(template+".json")).read_text())
            item["elapsed"]=round(time.monotonic()-started,2);results.append(item)
            (root/"matrix.json").write_text(json.dumps(results,ensure_ascii=False,indent=2))
            print(template,"FAILED" if "error" in item else "passed",item["elapsed"],flush=True)
        raise SystemExit(1 if any("error" in row for row in results) else 0)
