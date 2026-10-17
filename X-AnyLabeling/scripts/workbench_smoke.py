"""Real short training through upstream workers, using SYNTHETIC QA images only.

The resulting weights verify plumbing, not useful recognition quality.
"""
import json
import os
from pathlib import Path
import subprocess
import sys
import time

from PIL import Image, ImageDraw
from anylabeling.services.workflow.project import Project, write_json, read_json, template_hash


def prepare(root, task):
    template = {"points": ["a", "b", "c"], "edges": [[0,1],[1,2]], "pairs": [[0,2]]} if task == "pose" else None
    project = Project.create(root / task, "合成流程测试，非训练数据", task, ["object"], template=template)
    for i in range(6):
        path = project.root / "images" / f"qa_{i}.png"
        image = Image.new("RGB", (96,96), (15 + i * 18, 35, 55))
        draw = ImageDraw.Draw(image)
        draw.rectangle((15+i,15,70,70), fill=(220,130+i*10,50))
        image.save(path)
        kind = {"detect":"rectangle", "segment":"polygon", "pose":"rectangle", "obb":"rotation", "classify":"rectangle"}[task]
        shapes = [] if task == "classify" else [{"label":"object", "shape_type":kind, "points":[[15,15],[70,15],[70,70],[15,70]], "group_id":1,"difficult":False,"flags":{}}]
        if task == "pose":
            shapes += [{"label":name, "shape_type":"point", "points":[[25+j*15,25+j*15]], "group_id":1, "difficult":False,"flags":{}} for j,name in enumerate(template["points"])]
        write_json(project.annotation(path), {"version":"4.1.3","imagePath":"../images/"+path.name,"imageData":None,"imageWidth":96,"imageHeight":96,"shapes":shapes,"flags":{"object":True},"checked":True})
    return project, project.build_dataset()


def main(root):
    root = Path(root).resolve()
    root.mkdir(parents=True, exist_ok=True)
    import torch
    results = []
    projects = {}
    runs = [("detect","cpu","yolov8n.yaml"),("segment","cpu","yolov8n-seg.yaml"),("pose","cpu","yolov8n-pose.yaml"),("obb","cpu","yolov8n-obb.yaml"),("classify","cpu","yolov8n-cls.yaml")]
    if torch.cuda.is_available():
        runs += [("detect","0","yolov8n.yaml"),("detect","0","yolo11n.yaml")]
    worker = Path(__file__).resolve().parents[1] / "anylabeling/services/auto_training/ultralytics/worker.py"
    for task, device, model in runs:
        if task not in projects:
            projects[task] = prepare(root,task)
        project, dataset = projects[task]
        name = model.removesuffix(".yaml") + "_" + device
        args = {"model":model,"data":str(dataset),"project":str(project.root / "runs"),"name":name,"device":device,"epochs":1,"batch":2,"imgsz":64,"workers":0,"amp":False,"plots":False,"cache":False,"save":True,"val":True}
        payload = root / (name + ".json")
        write_json(payload,{"version":1,"action":"train","args":args,"paths":{"weights_directory":str(project.root / "models")},"options":{"auto_install_packages":False}})
        env = dict(os.environ, PYTHONIOENCODING="utf-8", YOLO_CONFIG_DIR=str(root / "yolo-config"), OMP_NUM_THREADS="2", MKL_NUM_THREADS="2", YOLO_AUTOINSTALL="false")
        started = time.monotonic()
        completed = subprocess.run([sys.executable,"-u",str(worker),str(payload)],cwd=project.root / "models",capture_output=True,text=True,encoding="utf-8",errors="replace",env=env,timeout=300)
        (root / (name + ".log")).write_text(completed.stdout + completed.stderr,encoding="utf-8")
        weights = project.root / "runs" / name / "weights" / "best.pt"
        result = {"task":task,"device":device,"model":model,"exit_code":completed.returncode,"seconds":round(time.monotonic()-started,1),"weights":str(weights),"exists":weights.exists()}
        print(json.dumps(result,ensure_ascii=False),flush=True)
        if completed.returncode:
            print((completed.stdout + completed.stderr)[-2000:],flush=True)
        if task == "pose" and weights.exists():
            write_json(weights.with_suffix(".workflow.json"),{"template_hash":template_hash(project.data["template"]),"classes":project.data["classes"]})
        if weights.exists():
            prediction = subprocess.run([sys.executable,"-u","-m","anylabeling.services.workflow.predict",str(project.root),str(weights),device,"0.01"],capture_output=True,text=True,encoding="utf-8",errors="replace",env=env,timeout=120)
            (root / (name + "_predict.log")).write_text(prediction.stdout+prediction.stderr,encoding="utf-8")
            result["predict_exit"] = prediction.returncode
            if prediction.returncode:
                print((prediction.stdout+prediction.stderr)[-1000:],flush=True)
        results.append(result)
        write_json(root / "results.json",results)
    return 0 if all(r["exit_code"]==0 and r.get("predict_exit")==0 for r in results) else 1


if __name__ == "__main__":
    sys.exit(main(sys.argv[1]))
