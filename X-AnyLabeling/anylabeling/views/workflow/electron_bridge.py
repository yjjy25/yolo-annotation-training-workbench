"""Local stdio IPC and native workspace host for the Electron shell.

Renderer gets no filesystem/process API. Commands are whitelisted here and in
Electron main/preload. X-AnyLabeling continues to own annotation operations.
"""
import ctypes
import json
import os
import sys
import threading
from pathlib import Path

from PyQt6 import QtCore, QtWidgets as W


class ElectronBridge(QtCore.QObject):
    command_received = QtCore.pyqtSignal(dict)

    def __init__(self, window):
        super().__init__(window)
        self.window = window
        self.workflow = window.workflow
        from .desktop_controller import DesktopController
        self.desktop = DesktopController(self)
        self.host = 0 if os.environ.get("XAL_INTEGRATED_EDITOR")=="1" else int(os.environ.get("XAL_EMBED_PARENT", "0"))
        self.visible = False
        self.embedded = False
        self.rect = [240, 92, 1000, 700]
        self.display_scale = 1.0
        self.command_received.connect(self.command, QtCore.Qt.ConnectionType.QueuedConnection)
        threading.Thread(target=self.read_commands, daemon=True).start()
        self.timer = QtCore.QTimer(self)
        self.timer.timeout.connect(self.publish_state)
        self.timer.start(1100)
        self.workflow.header.hide()
        self.workflow.dock.hide()
        if os.environ.get("XAL_OFFSCREEN_TOOLS")=="1":
            from .inline_tools import InlineTools
            self.inline=InlineTools(self)
        QtCore.QTimer.singleShot(0, self.attach)

    def emit(self, event, **data):
        stream = sys.__stdout__
        if stream:
            try:
                stream.write(json.dumps({"event":event, **data}, ensure_ascii=False) + "\n")
                stream.flush()
            except (BrokenPipeError, OSError):
                pass

    def read_commands(self):
        if sys.stdin:
            for line in sys.stdin:
                try:
                    data = json.loads(line)
                    if isinstance(data, dict) and len(line) < 16 * 1024 * 1024:
                        self.command_received.emit(data)
                except (ValueError, OSError):
                    continue
            # Parent pipe closed. Use the regular close path, preserving unsaved-data checks.
            try:
                self.command_received.emit({"action":"close"})
            except RuntimeError:
                # Qt can finish destroying the window before the pipe closes.
                pass

    def attach(self):
        if os.name == "nt" and self.host:
            user32 = ctypes.WinDLL("user32", use_last_error=True)
            user32.SetParent.argtypes = [ctypes.c_void_p, ctypes.c_void_p]
            user32.SetParent.restype = ctypes.c_void_p
            user32.GetWindowLongW.argtypes = [ctypes.c_void_p, ctypes.c_int]
            user32.GetWindowLongW.restype = ctypes.c_long
            user32.SetWindowLongW.argtypes = [ctypes.c_void_p, ctypes.c_int, ctypes.c_long]
            user32.SetWindowPos.argtypes = [ctypes.c_void_p, ctypes.c_void_p, ctypes.c_int, ctypes.c_int, ctypes.c_int, ctypes.c_int, ctypes.c_uint]
            handle = int(self.window.winId())
            self.window.showNormal()
            ctypes.set_last_error(0)
            user32.SetParent(handle, self.host)
            error = ctypes.get_last_error()
            if error:
                self.emit("error", message=f"原生工作区嵌入失败（Win32 {error}），保留独立标注窗口。")
            else:
                style = user32.GetWindowLongW(handle, -16)
                style = (style & ~0x80CF0000) | 0x40000000
                user32.SetWindowLongW(handle, -16, ctypes.c_long(style))
                self.embedded = True
                self.user32 = user32
                self.place()
        self.window.hide()
        qa_project = os.environ.get("XAL_QA_PROJECT")
        if os.environ.get("XAL_ELECTRON_QA") == "1" and qa_project:
            self.workflow.load_project(qa_project)
        self.emit("ready", embedded=self.embedded, window=str(int(self.window.winId())))
        self.publish_state()

    def place(self):
        if self.embedded:
            x,y,width,height = self.rect
            # Chromium has its own native child. NOZORDER left Qt behind it:
            # parent/size diagnostics passed while users saw the loading page.
            self.user32.SetWindowPos(int(self.window.winId()), 0, x, y, max(100,width), max(100,height), 0x0030)

    def show_workspace(self, visible):
        self.visible = visible
        if visible:
            self.window.show()
            self.place()
            QtCore.QTimer.singleShot(120, self.place)
        else:
            self.window.hide()

    def publish_state(self):
        workflow = self.workflow
        project = workflow.project
        data = None
        if project:
            counts = workflow.last_count or project.counts()
            data = {"name":project.data["name"],"root":str(project.root),"task":project.data["task"],"classes":project.data["classes"],"mode":project.data.get("annotation_mode","manual"),"counts":counts,"template":project.data.get("template"),"preset":(project.data.get("template") or {}).get("preset"),"points":len((project.data.get("template") or {}).get("points",[]))}
        dialog = workflow.view.training_dialog
        native_training=bool(dialog and dialog.training_manager.is_training)
        native_exporting=bool(dialog and dialog.export_manager.is_exporting)
        validation=self.desktop.validation
        # Only report validation belonging to the open project.
        if validation.get("project") and (not project or validation["project"]!=str(project.root)):
            validation={"status":"idle","logs":[],"run":None,"metrics":None}
        self.emit("state", project=data, training=self.desktop.training["status"], native_training=native_training, native_exporting=native_exporting, training_info=self.desktop.training, validation_info=validation, export_info=self.desktop.export_job.info, predicting=bool(workflow.process and workflow.process.state()!=QtCore.QProcess.ProcessState.NotRunning), prediction_status=workflow.prediction_status, prediction_log=workflow.log.toPlainText()[-12000:], embedded=self.embedded, visible=self.visible, native_visible=self.window.isVisible(), active_class=getattr(workflow,"active_class",None), candidate=workflow.candidate.text())

    @QtCore.pyqtSlot(dict)
    def command(self, data):
        action = data.get("action")
        try:
            if action == "rpc":
                try:
                    result=self.desktop.call(data.get("method"),data.get("args") or {})
                    self.emit("response",request_id=data.get("request_id"),ok=True,result=result)
                except Exception as error:
                    self.emit("response",request_id=data.get("request_id"),ok=False,error=str(error))
                self.publish_state()
            elif action == "native_input" and hasattr(self,"inline"):
                self.inline.input(data)
            elif action == "native_view" and hasattr(self,"inline"):
                self.inline.show(bool(data.get("visible")),data.get("width",1000),data.get("height",650))
            elif action == "resize":
                rect = data.get("rect")
                if isinstance(rect,list) and len(rect)==4 and all(type(v) is int and -20000<v<40000 for v in rect):
                    self.rect = rect
                    # Host display scale, used only to rasterise the offscreen
                    # workspace sharply; Qt geometry itself stays logical.
                    try:
                        self.display_scale = min(3.0, max(1.0, float(data.get("scale", 1))))
                    except (TypeError, ValueError):
                        self.display_scale = 1.0
                    self.place()
            elif action == "workspace":
                self.show_workspace(bool(data.get("visible")))
            elif action == "mode":
                self.workflow.set_mode(data.get("mode"))
            elif action == "theme":
                mode = data.get("theme")
                if mode in {"light","dark"}:
                    from .theme import apply_electron_theme
                    apply_electron_theme(self.window,mode)
            elif action == "diagnostics" and os.environ.get("XAL_ELECTRON_QA") == "1":
                diagnostic = {"request_id":data.get("request_id"),"embedded":self.embedded,"qt_visible":self.window.isVisible(),"logical_size":[self.window.width(),self.window.height()],"dpr":self.window.devicePixelRatioF(),"requested_rect":self.rect}
                diagnostic.update(python=sys.executable,source=str(Path(__file__).resolve()))
                if hasattr(self,"inline"):
                    diagnostic["inline"]=self.inline.diagnostics()
                if self.embedded:
                    user32=self.user32
                    user32.GetParent.argtypes=[ctypes.c_void_p]
                    user32.GetParent.restype=ctypes.c_void_p
                    diagnostic["parent_matches"]=user32.GetParent(int(self.window.winId()))==self.host
                    from ctypes.wintypes import RECT
                    user32.GetClientRect.argtypes=[ctypes.c_void_p,ctypes.POINTER(RECT)]
                    rectangle=RECT()
                    user32.GetClientRect(self.host,ctypes.byref(rectangle))
                    diagnostic["host_client"]=[rectangle.left,rectangle.top,rectangle.right,rectangle.bottom]
                    user32.GetClientRect(int(self.window.winId()),ctypes.byref(rectangle))
                    diagnostic["workspace_client"]=[rectangle.left,rectangle.top,rectangle.right,rectangle.bottom]
                if self.workflow.project:
                    from anylabeling.services.workflow.project import digest
                    diagnostic["annotation_hashes"]={p.name:digest(p) for p in (self.workflow.project.root/"annotations").glob("*.json")}
                target=Path(os.environ["XAL_WORKBENCH_HOME"])/"native-workspace.png"
                self.window.grab().save(str(target))
                if self.host:
                    W.QApplication.primaryScreen().grabWindow(self.host).save(str(target.with_name("host-composite.png")))
                self.emit("diagnostics",**diagnostic)
            elif action == "close":
                if self.desktop.job and self.desktop.job.state()!=QtCore.QProcess.ProcessState.NotRunning:
                    if W.QMessageBox.question(self.window,"训练仍在运行","关闭会停止当前训练。是否停止训练并退出？")!=W.QMessageBox.StandardButton.Yes:
                        self.emit("close-cancelled")
                        return
                    self.desktop.stop_training()
                self.closing_requested = True
                accepted = self.window.close()
                if not accepted:
                    self.closing_requested = False
                self.emit("closed" if accepted else "close-cancelled")
                if accepted:
                    W.QApplication.quit()
            elif action in {"new_project","open_project","manual","pretrained","train","pose","review","weights","predict","stop_predict","accept","approve","next","folder","tool","image"}:
                self.show_workspace(True)
                workflow = self.workflow
                if action=="new_project": workflow.create_project()
                elif action=="open_project": workflow.open_project()
                elif action=="manual": workflow.set_mode("manual")
                elif action=="pretrained": workflow.set_mode("pretrained"); workflow.choose_pretrained()
                elif action=="train": workflow.set_mode("trained"); workflow.train()
                elif action=="pose": workflow.dock.show(); workflow.tabs.setCurrentIndex(1)
                elif action=="review": workflow.dock.show(); workflow.tabs.setCurrentIndex(2)
                elif action=="weights": workflow.dock.show(); workflow.tabs.setCurrentIndex(2); workflow.choose_weights()
                elif action=="predict": workflow.predict()
                elif action=="stop_predict": workflow.stop_predict()
                elif action=="accept": workflow.accept_candidate()
                elif action=="approve": workflow.approve()
                elif action=="next": workflow.next_unchecked()
                elif action=="folder": workflow.open_folder()
                elif action=="tool" and data.get("tool") in {"rectangle","polygon","rotation","point","line","circle"}: workflow.draw(data["tool"])
                elif action=="image" and workflow.project:
                    name = data.get("name", "")
                    if Path(name).name!=name:
                        raise ValueError("图片名称无效。")
                    path = workflow.project.root / "images" / name
                    if path.is_file() and workflow.view.may_continue():
                        workflow.view.load_file(str(path))
            else:
                self.emit("error", message="不支持的工作台命令。")
                return
            self.publish_state()
        except Exception as error:
            self.emit("error",message=str(error))
