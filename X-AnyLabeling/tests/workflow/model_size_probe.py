"""Check every advertised input-size preset on YOLOv8n with synthetic data."""
from pathlib import Path
import json
import sys
from anylabeling.services.workflow.model_design.core import SIZE_PRESETS
from anylabeling.services.workflow.model_design.worker import run

root=Path(sys.argv[1]);root.mkdir(parents=True,exist_ok=True)
rows=[]
for size in SIZE_PRESETS:
    result=run(root,dict(template="yolov8n",nc=1,imgsz=size,seed=42,edits=[],action="check"))
    assert result["checks"]["input"]==[2,3,size,size]
    assert result["checks"]["forward"] and result["checks"]["backward"]
    rows.append(dict(imgsz=size,checks=result["checks"],input=result["execution"]["input"],
                     revision=result["model_path"],source=result["design"]["source"]))
    (root/"sizes.json").write_text(json.dumps(rows,ensure_ascii=False,indent=2))
    print(size,"passed",flush=True)
