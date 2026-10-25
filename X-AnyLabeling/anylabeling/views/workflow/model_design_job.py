"""QProcess ownership keeps model checks off the Qt event loop."""
from pathlib import Path
import os
import sys
import uuid
from PyQt6 import QtCore
from anylabeling.services.workflow.project import write_json, read_json


class ModelDesignJob:
    def __init__(self, parent):
        self.parent = parent
        self.process = None
        self.root = None
        self.output = None

    def start(self, project, args):
        if project.data["task"] != "detect":
            raise ValueError("当前结构编辑仅支持目标检测项目。")
        if self.process and self.process.state() != QtCore.QProcess.ProcessState.NotRunning:
            raise ValueError("结构检查正在运行，请等待或停止。")
        if self.process:
            self.process.deleteLater()
        if set(args) - {"template", "imgsz", "seed", "edits", "action"} or args.get("action") not in {"inspect", "check"}:
            raise ValueError("无效的结构请求。")
        folder = project.root / "model_designs/jobs" / uuid.uuid4().hex
        folder.mkdir(parents=True)
        request = dict(args, nc=len(project.data["classes"]))
        write_json(folder / "request.json", {"root": str(project.root), "request": request})
        self.root, self.output = str(project.root), folder / "result.json"
        self.process = QtCore.QProcess(self.parent)
        environment = QtCore.QProcessEnvironment.systemEnvironment()
        source_root = str(Path(__file__).resolve().parents[3])
        environment.insert("PYTHONPATH", source_root + os.pathsep + os.environ.get("PYTHONPATH", ""))
        environment.insert("PYTHONIOENCODING", "utf-8")
        self.process.setProcessEnvironment(environment)
        self.process.setStandardOutputFile(str(folder / "stdout.log"))
        self.process.setStandardErrorFile(str(folder / "stderr.log"))
        timer = QtCore.QTimer(self.process)
        timer.setSingleShot(True)
        timer.timeout.connect(self.process.kill)
        self.process.finished.connect(timer.stop)
        timer.start(120000)
        self.process.start(sys.executable, ["-m", "anylabeling.services.workflow.model_design.worker",
                                           str(folder / "request.json"), str(self.output)])
        return {"status": "running"}

    def status(self, project):
        if self.root != str(project.root) or not self.output:
            return {"status": "idle"}
        # The worker writes its report before Python/torch finalization exits.
        # Do not enable another edit while start() would still reject the process.
        if self.process.state() != QtCore.QProcess.ProcessState.NotRunning:
            return {"status": "running"}
        if self.output.exists(): return read_json(self.output)
        if self.process.state() == QtCore.QProcess.ProcessState.NotRunning:
            return {"status": "failed", "error": "检查进程未生成结果，请查看 model_designs/jobs 日志。"}
        return {"status": "running"}

    def stop(self):
        if self.process and self.process.state() != QtCore.QProcess.ProcessState.NotRunning:
            self.process.kill()
            self.process.waitForFinished(3000)
