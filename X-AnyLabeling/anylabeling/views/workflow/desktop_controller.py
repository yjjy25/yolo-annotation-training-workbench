"""Integrated editor RPC and local jobs, reusing X-AnyLabeling's YOLO worker."""
import json
import os
from pathlib import Path
import sys
import time

from PyQt6 import QtCore
from anylabeling.services.workflow import desktop as storage
from anylabeling.services.workflow.project import Project, write_json, template_hash


class DesktopController(QtCore.QObject):
    def __init__(self, bridge):
        super().__init__(bridge)
        self.bridge=bridge
        self.workflow=bridge.workflow
        self.job=None
        self.buffer=""
        self.training={"status":"idle","logs":[],"run":None}
        self.validation={"status":"idle","logs":[],"run":None,"metrics":None}
        self.validation_job=None
        self.validation_buffer=""
        # NMS thresholds from the training page. They are deliberately not part of
        # the training payload; they are kept here so the validate page can reuse
        # the value the user last typed.
        self.nms_settings={"iou":0.7,"conf":0.25}

    def project(self):
        if not self.workflow.project:
            raise ValueError("请先新建或打开项目。")
        return self.workflow.project

    def call(self,method,args):
        if method=="prepare_exit":
            self.stop_training()
            self.stop_validation()
            self.workflow.stop_predict()
            view=self.workflow.view
            if view.training_dialog:
                view.training_dialog.training_manager.stop_training(wait=True)
                manager=getattr(view.training_dialog,"export_manager",None)
                if manager:manager.stop_export(wait=True)
                view.training_dialog.environment_manager.cancel()
            if view.dirty and view.image_path:
                recovery=Path(os.environ["XAL_WORKBENCH_HOME"])/"recovery"
                flags={view.flag_widget.item(i).text():view.flag_widget.item(i).checkState()==QtCore.Qt.CheckState.Checked for i in range(view.flag_widget.count())}
                write_json(recovery/("advanced_"+str(time.time_ns())+".json"),{"imagePath":view.image_path,"shapes":[s.to_dict() for s in view.canvas.shapes],"flags":flags,"description":view.other_data.get("description","")})
            self.bridge.closing_requested=True
            # Exit only after drafts and owned jobs are handled above. Do not
            # re-enter modal close/save questions in the hidden Qt event loop.
            QtCore.QTimer.singleShot(150,lambda:QtCore.QCoreApplication.exit(0))
            return True
        if method=="create_project":
            self.ensure_switchable()
            project=storage.create_project(args)
            self.workflow.load_project(project.root)
            return {"root":str(project.root)}
        if method=="open_project":
            self.ensure_switchable()
            self.workflow.load_project(Path(args["path"]).parent)
            return True
        if method=="load_annotation":
            return storage.load_annotation(self.project(),args["name"])
        if method=="save_annotation":
            result=storage.save_annotation(self.project(),args["name"],args["annotation"],args.get("base_hash"),args.get("checked",False))
            self.workflow.last_count=None
            # Keep the original advanced editor in sync with the same files.
            if self.workflow.view.image_path and Path(self.workflow.view.image_path).name==args["name"]:
                if not self.workflow.view.dirty:
                    self.workflow.view.load_file(self.workflow.view.image_path)
            return result
        if method=="remove_image":
            result=storage.remove_image(self.project(),args["name"],args.get("purge",False))
            self.workflow.last_count=None
            # The advanced editor must let go of the file it was showing, otherwise
            # its next save would write the label back for a picture that is gone.
            if self.workflow.view.image_path and Path(self.workflow.view.image_path).name==args["name"]:
                self.workflow.view.image_path=None
                self.workflow.view.reset_state()
            return result
        if method=="add_class":
            classes=storage.append_class(self.project(),args["name"])
            self.workflow.view.load_labels(classes)
            self.workflow.class_box.clear()
            self.workflow.class_box.addItems(classes)
            return classes
        if method=="mode":
            self.workflow.set_mode(args["mode"])
            return True
        if method=="start_training":
            return self.start_training(args)
        if method=="stop_training":
            self.stop_training()
            return True
        if method=="predict":
            self.select_weights(args["weights"])
            self.workflow.device.setCurrentText(str(args.get("device","cpu")))
            self.workflow.confidence.setValue(float(args.get("confidence",.25)))
            self.workflow.aliases.setText(str(args.get("aliases","")))
            self.workflow.predict()
            return True
        if method=="stop_predict":
            self.workflow.stop_predict()
            return True
        if method=="accept":
            project=self.project()
            path=storage.image_path(project,args["name"])
            candidate=project.root/"proposals"/"latest"/(path.stem+".json")
            from anylabeling.services.workflow.project import read_json
            project.accept_proposal(path,read_json(candidate))
            candidate.replace(candidate.with_suffix(".accepted.json"))
            self.workflow.last_count=None
            return storage.load_annotation(project,args["name"])
        if method=="advanced":
            if args.get("panel")=="training" and self.job and self.job.state()!=QtCore.QProcess.ProcessState.NotRunning:
                raise ValueError("训练已在集成训练页运行，请在该页查看日志或停止。")
            if hasattr(self.bridge,"inline"):
                self.bridge.inline.show(True,args.get("width",1000),args.get("height",650))
            else:
                self.bridge.show_workspace(True)
            self.workflow.dock.hide()
            if args.get("name"):
                image=storage.image_path(self.project(),args["name"])
                if str(image)!=self.workflow.view.image_path and self.workflow.view.may_continue():
                    self.workflow.view.load_file(str(image))
            if args.get("panel")=="smart":
                self.workflow.view.auto_labeling_widget.show()
            elif args.get("panel")=="pose":
                self.workflow.tabs.setCurrentIndex(1)
            elif args.get("panel")=="training":
                self.workflow.view.start_training("ultralytics")
            if not hasattr(self.bridge,"inline"):
                self.bridge.window.raise_()
                self.bridge.window.activateWindow()
            return True
        if method=="save_advanced":
            if hasattr(self.bridge,"inline"):
                from PyQt6.QtWidgets import QApplication
                if QApplication.activeModalWidget():
                    raise ValueError("请先完成当前对话框，或点击‘关闭当前面板’取消后再返回。")
            view=self.workflow.view
            if view.dirty:
                view.save_file()
                if view.dirty:raise ValueError("高级标注尚未保存，请完成保存后返回。")
            return True
        if method=="dismiss_advanced" and hasattr(self.bridge,"inline"):
            return self.bridge.inline.dismiss()
        if method=="start_validation":
            return self.start_validation(args)
        if method=="stop_validation":
            self.stop_validation()
            return True
        if method=="model_classes":
            return self.model_classes(args.get("weights",""))
        if method=="split_preview":
            return self.project().split_preview(args)
        raise ValueError("不支持的操作。")

    def model_classes(self,value):
        """Class names a weight file knows, so the alias box can suggest a mapping."""
        value=str(value).strip()
        if not value:
            raise ValueError("请先选择模型。")
        cache=Path(os.environ.get("XAL_WORKBENCH_HOME",""))/"pretrained"/value
        path=Path(value)
        if path.name==value:
            if not cache.is_file():cache=Path(os.environ.get("XAL_PRETRAINED_HOME",str(cache.parent)))/value
            path=cache
        if not path.is_file():
            raise ValueError(f"找不到权重文件：{value}")
        try:
            import torch
            checkpoint=torch.load(str(path),map_location="cpu",weights_only=False)
        except Exception as error:
            raise ValueError(f"无法读取模型类别：{error}")
        names=None
        if isinstance(checkpoint,dict):
            names=checkpoint.get("names")
            model=checkpoint.get("model")
            if names is None and model is not None:
                names=getattr(model,"names",None)
        if isinstance(names,dict):
            names=[names[key] for key in sorted(names,key=lambda item:int(item))]
        if not isinstance(names,(list,tuple)) or not names:
            raise ValueError("这个权重文件没有内置类别名，请在训练结果中选择本项目模型。")
        return [str(name) for name in names]

    def ensure_switchable(self):
        if self.workflow.view.dirty:
            raise ValueError("高级标注有未保存的修改，请先保存后再操作。")
        dialog=self.workflow.view.training_dialog
        if dialog and dialog.training_manager.is_training:
            raise ValueError("高级工具仍在训练，请完成或停止后再操作。")
        if self.workflow.process and self.workflow.process.state()!=QtCore.QProcess.ProcessState.NotRunning:
            raise ValueError("预标注正在运行，请完成或停止后再切换项目。")
        if self.job and self.job.state()!=QtCore.QProcess.ProcessState.NotRunning:
            raise ValueError("训练正在运行，请完成或停止后再切换项目。")

    def select_weights(self,value):
        if self.job and self.job.state()!=QtCore.QProcess.ProcessState.NotRunning:
            raise ValueError("训练仍在运行，请完成或停止后再进行预标注。")
        project=self.project()
        value=str(value).strip()
        if not value:
            raise ValueError("请选择模型。")
        if Path(value).name==value:
            cache=Path(os.environ["XAL_WORKBENCH_HOME"])/"pretrained"/value
            if not cache.is_file():cache=Path(os.environ.get("XAL_PRETRAINED_HOME",str(cache.parent)))/value
            target=project.root/"models"/value
            if cache.is_file() and not target.exists():
                import shutil
                shutil.copy2(cache,target)
            value=str(target)
        if Path(value).is_file() and project.data["task"]=="pose":
            from anylabeling.services.workflow.project import read_json
            import yaml
            args_path=Path(value).parent.parent/"args.yaml"
            if args_path.exists():
                config=yaml.safe_load(args_path.read_text(encoding="utf-8")) or {}
                source=Path(config.get("data",""))
                manifest=source.parent/"manifest.json"
                if not manifest.exists():
                    manifest=project.root/"datasets"/source.parent.name/"manifest.json"
                if manifest.exists():
                    metadata=read_json(manifest)["project"]
                    if metadata.get("template")==project.data.get("template") and metadata["classes"]==project.data["classes"]:
                        write_json(Path(value).with_suffix(".workflow.json"),{"template_hash":template_hash(metadata["template"]),"classes":metadata["classes"]})
        self.workflow.weights.setText(value)

    def start_training(self,args):
        self.ensure_switchable()
        project=self.project()
        model=str(args.get("model", "yolov8n.pt")).strip()
        cache=Path(os.environ["XAL_WORKBENCH_HOME"])/"pretrained"/model
        if not cache.is_file():cache=Path(os.environ.get("XAL_PRETRAINED_HOME",str(cache.parent)))/model
        if cache.is_file():
            model=str(cache)
        values={"epochs":(1,10000,100),"batch":(1,512,4),"imgsz":(32,4096,640),"workers":(0,16,0),"patience":(0,10000,50)}
        options={}
        for key,(low,high,default) in values.items():
            value=args.get(key,default)
            if type(value) is not int or not low<=value<=high:
                raise ValueError(f"训练参数 {key} 必须为 {low}～{high} 的整数。")
            options[key]=value
        device=str(args.get("device","cpu"))
        if device not in {"cpu","0","0,1"}:
            raise ValueError("设备无效。")
        lr=float(args.get("lr0",.01))
        if not 0<lr<=1:
            raise ValueError("初始学习率应大于 0 且不超过 1。")
        # Augmentation and optimiser knobs follow Ultralytics names and ranges, and
        # every key here goes straight into ``model.train()``.
        fractions={"lrf":(0.0001,1,.01),"weight_decay":(0,0.01,.0005),"momentum":(0,1,.937),
                   "mosaic":(0,1,1.),"mixup":(0,1,0.),"scale":(0,1,.5),"translate":(0,1,.1),
                   "fliplr":(0,1,.5),"hsv_h":(0,1,.015),"hsv_s":(0,1,.7),"hsv_v":(0,1,.4)}
        for key,(low,high,default) in fractions.items():
            value=args.get(key,default)
            try:
                number=float(value)
            except (TypeError,ValueError):
                raise ValueError(f"训练参数 {key} 必须是数字。")
            if not low<=number<=high:
                raise ValueError(f"训练参数 {key} 必须在 {low}～{high} 之间。")
            options[key]=number
        # The NMS thresholds are NOT training arguments: ``model.train()`` rejects
        # unknown keys with "Unsupported training arguments". They are validated here
        # so a wrong value still gets a clear message, then remembered for the
        # validation stage, which is the only place they apply.
        for key,(low,high,default) in {"iou":(0.1,0.95,.7),"conf":(0.01,0.99,.25)}.items():
            value=args.get(key,default)
            try:
                number=float(value)
            except (TypeError,ValueError):
                raise ValueError(f"训练参数 {key} 必须是数字。")
            if not low<=number<=high:
                raise ValueError(f"训练参数 {key} 必须在 {low}～{high} 之间。")
            self.nms_settings[key]=number
        optimizer=str(args.get("optimizer","SGD")).strip() or "SGD"
        if optimizer not in {"SGD","Adam","AdamW","NAdam","RAdam","RMSProp","auto"}:
            raise ValueError("优化器无效。")
        options["optimizer"]=optimizer
        dataset=project.build_dataset(args)
        self.training_settings={"split_mode":args.get("split_mode"),"split_ratio":args.get("split_ratio"),"split_count":args.get("split_count"),"split_seed":args.get("split_seed")}
        name="train_"+time.strftime("%Y%m%d_%H%M%S")
        run=project.root/"runs"/name
        options.update(model=model,data=str(dataset),project=str(project.root/"runs"),name=name,device=device,lr0=lr,amp=bool(args.get("amp",False)),plots=True,cache=False,save=True,val=True)
        if project.data["task"]=="pose" and not project.data["template"].get("pairs"):
            options.update(fliplr=0.,flipud=0.)
        payload=project.root/"runs"/(name+".json")
        write_json(payload,{"version":1,"action":"train","args":options,"paths":{"weights_directory":str(project.root/"models")},"options":{"auto_install_packages":False}})
        self.training={"status":"starting","logs":[],"run":str(run),"project":str(project.root),"epochs":options["epochs"]}
        self.job=QtCore.QProcess(self)
        self.job.setProcessChannelMode(QtCore.QProcess.ProcessChannelMode.MergedChannels)
        self.job.setWorkingDirectory(str(project.root/"models"))
        environment=QtCore.QProcessEnvironment.systemEnvironment()
        environment.insert("PYTHONIOENCODING","utf-8")
        environment.insert("YOLO_AUTOINSTALL","false")
        for key in ("YOLO_CONFIG_DIR","XAL_FONT_FILE"):
            if key in os.environ:environment.insert(key,os.environ[key])
        self.job.setProcessEnvironment(environment)
        self.job.readyReadStandardOutput.connect(self.read_training)
        self.job.finished.connect(self.training_finished)
        self.job.errorOccurred.connect(lambda error:self.job_error(str(self.job.errorString())))
        worker=Path(__file__).resolve().parents[2]/"services"/"auto_training"/"ultralytics"/"worker.py"
        self.training_template=project.data.get("template")
        self.training_classes=project.data["classes"][:]
        self.buffer=""
        self.job.start(sys.executable,["-u",str(worker),str(payload)])
        return {"run":str(run)}

    def job_error(self,message):
        self.training.update(status="failed",error=message)
        self.bridge.publish_state()

    def read_training(self):
        import re
        entries=[]
        self.buffer+=bytes(self.job.readAllStandardOutput()).decode("utf-8",errors="replace")
        while "\n" in self.buffer:
            line,self.buffer=self.buffer.split("\n",1)
            prefix="__XANYLABELING_WORKER_EVENT__="
            if line.startswith(prefix):
                try:
                    event=json.loads(line[len(prefix):])
                except ValueError:
                    continue
                if event["event"]=="training_started":self.training["status"]="training"
                if event["event"]=="training_error":self.training.update(status="failed",error=event.get("error"))
                if event["event"]=="training_log":line=event.get("message","")
                else:line=event.get("error",event["event"])
            line=re.sub(r"\x1b\[[0-?]*[ -/]*[@-~]","",line).replace("\r","")
            entries.append(line)
            self.training["logs"].append(line[-2000:])
            self.training["logs"]=self.training["logs"][-150:]
        log_path=Path(self.training["run"]).with_suffix(".log")
        if entries:
            with log_path.open("a",encoding="utf-8") as stream:
                stream.write("\n".join(entries)+"\n")

    def training_finished(self,code,status):
        self.read_training()
        if self.training["status"]!="stopped":
            self.training["status"]="completed" if code==0 else "failed"
        weights=Path(self.training["run"])/"weights"/"best.pt"
        if weights.exists() and self.training_template:
            write_json(weights.with_suffix(".workflow.json"),{"template_hash":template_hash(self.training_template),"classes":self.training_classes})
        self.bridge.publish_state()

    def stop_training(self):
        if self.job and self.job.state()!=QtCore.QProcess.ProcessState.NotRunning:
            self.training["status"]="stopped"
            if os.name=="nt":
                import subprocess
                subprocess.run(["taskkill","/PID",str(int(self.job.processId())),"/T","/F"],capture_output=True,creationflags=0x08000000)
            else:
                self.job.kill()

    def start_validation(self,args):
        """Evaluate a trained weight on the frozen validation split."""
        if self.job and self.job.state()!=QtCore.QProcess.ProcessState.NotRunning:
            raise ValueError("训练正在运行，请先完成或停止训练再验证。")
        if self.validation_job and self.validation_job.state()!=QtCore.QProcess.ProcessState.NotRunning:
            raise ValueError("已有验证在运行。")
        if self.workflow.process and self.workflow.process.state()!=QtCore.QProcess.ProcessState.NotRunning:
            raise ValueError("预标注正在运行，请先停止再验证。")
        project=self.project()
        weights=str(args.get("weights","")).strip()
        if not weights:
            raise ValueError("请选择要验证的模型。")
        cache=Path(os.environ["XAL_WORKBENCH_HOME"])/"pretrained"/weights
        if Path(weights).name==weights:
            if not cache.is_file():cache=Path(os.environ.get("XAL_PRETRAINED_HOME",str(cache.parent)))/weights
            weights=str(cache)
        if not Path(weights).is_file():
            raise ValueError(f"找不到权重文件：{weights}")
        device=str(args.get("device","cpu"))
        if device not in {"cpu","0","0,1"}:
            raise ValueError("设备无效。")
        values={"batch":(1,64,4),"imgsz":(32,4096,640)}
        options={}
        for key,(low,high,default) in values.items():
            value=args.get(key,default)
            if type(value) is not int or not low<=value<=high:
                raise ValueError(f"验证参数 {key} 必须为 {low}～{high} 的整数。")
            options[key]=value
        confidence=float(args.get("confidence",.25))
        if not 0<confidence<1:
            raise ValueError("置信度阈值应在 0 与 1 之间。")
        # IoU threshold for non-maximum suppression: two boxes overlapping more
        # than this are treated as the same detection.
        iou=float(args.get("iou",.7))
        if not 0.1<=iou<=0.95:
            raise ValueError("IoU 阈值应在 0.1 与 0.95 之间。")
        snapshot=self.latest_snapshot(project)
        source=str(args.get("source","frozen"))
        custom=str(args.get("custom_path","") or "")
        if source=="frozen" and snapshot is None:
            raise ValueError("还没有冻结的数据快照。请先在“模型训练”页用已审核数据训练一次，或把验证对象改选为自选文件夹 / 单张图片 / 视频。")
        if source=="folder" and not Path(custom).is_dir():
            raise ValueError("请选择包含图片的文件夹。")
        if source in {"image","video"} and not Path(custom).is_file():
            raise ValueError("请选择要验证的图片或视频文件。")
        runner=Path(__file__).resolve().parents[2]/"services"/"workflow"/"validate_worker.py"
        payload={"root":str(project.root),"weights":weights,"device":device,"batch":options["batch"],"imgsz":options["imgsz"],"confidence":confidence,"iou":iou,"plots":bool(args.get("plots",True)),"source":source,"custom_path":custom,"video_step":float(args.get("video_step",1) or 1)}
        self.validation={"status":"starting","logs":[],"run":str(project.root/"validation"),"project":str(project.root),"metrics":None,"snapshot":snapshot.name if snapshot else None,"source":source}
        self.validation_job=QtCore.QProcess(self)
        self.validation_job.setProcessChannelMode(QtCore.QProcess.ProcessChannelMode.MergedChannels)
        self.validation_job.setWorkingDirectory(str(project.root))
        environment=QtCore.QProcessEnvironment.systemEnvironment()
        environment.insert("PYTHONIOENCODING","utf-8")
        for key in ("YOLO_CONFIG_DIR","XAL_FONT_FILE"):
            if key in os.environ:environment.insert(key,os.environ[key])
        self.validation_job.setProcessEnvironment(environment)
        self.validation_job.readyReadStandardOutput.connect(self.read_validation)
        self.validation_job.finished.connect(self.validation_finished)
        self.validation_job.errorOccurred.connect(lambda error:self.validation_error(str(self.validation_job.errorString())))
        self.validation_buffer=""
        self.validation_job.start(sys.executable,["-u",str(runner),json.dumps(payload,ensure_ascii=False)])
        return {"run":self.validation["run"]}

    def latest_snapshot(self,project):
        root=project.root/"datasets"
        if not root.is_dir():return None
        for candidate in sorted((p for p in root.iterdir() if p.is_dir()),reverse=True):
            if (candidate/"manifest.json").exists():return candidate
        return None

    def read_validation(self):
        if not self.validation_job:return
        import re
        self.validation_buffer+=bytes(self.validation_job.readAllStandardOutput()).decode("utf-8",errors="replace")
        while "\n" in self.validation_buffer:
            line,self.validation_buffer=self.validation_buffer.split("\n",1)
            # Ultralytics prints progress bars with ANSI escapes; keep them out of
            # the rendered log.
            line=re.sub(r"\x1b\[[0-?]*[ -/]*[@-~]","",line).replace("\r","").strip()
            if not line:continue
            self.validation["logs"].append(line[-2000:])
        self.validation["logs"]=self.validation["logs"][-400:]
        if self.validation["status"]=="starting":self.validation["status"]="running"

    def validation_finished(self,code,status):
        self.read_validation()
        if self.validation["status"]!="stopped":
            self.validation["status"]="completed" if code==0 else "failed"
        record=self.read_validation_record()
        if record:self.validation["metrics"]=record.get("metrics")
        if self.validation["status"]=="completed" and not record:
            self.validation["status"]="failed"
            self.validation["logs"].append("验证进程结束，但没有找到结果文件。")
        log_path=Path(self.validation["run"])/"validation.log"
        try:
            log_path.parent.mkdir(parents=True,exist_ok=True)
            log_path.write_text("\n".join(self.validation["logs"]),encoding="utf-8")
        except OSError:
            pass
        self.bridge.publish_state()

    def validation_error(self,message):
        self.validation.update(status="failed")
        self.validation["logs"].append(message)
        self.bridge.publish_state()

    def read_validation_record(self):
        directory=Path(self.validation["run"])
        if not directory.is_dir():return None
        candidates=sorted(directory.glob("*/metrics.json"),reverse=True)
        if not candidates:return None
        try:
            return json.loads(candidates[0].read_text(encoding="utf-8"))
        except (OSError,ValueError):
            return None

    def stop_validation(self):
        if self.validation_job and self.validation_job.state()!=QtCore.QProcess.ProcessState.NotRunning:
            self.validation["status"]="stopped"
            if os.name=="nt":
                import subprocess
                subprocess.run(["taskkill","/PID",str(int(self.validation_job.processId())),"/T","/F"],capture_output=True,creationflags=0x08000000)
            else:
                self.validation_job.kill()
