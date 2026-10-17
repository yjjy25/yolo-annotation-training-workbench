import copy
import pytest
from anylabeling.resources import resources  # register SVGs for standalone GUI tests
from anylabeling.services.workflow import desktop
from anylabeling.services.workflow.project import read_json, digest
from .test_project import make_project


@pytest.fixture(scope="module",autouse=True)
def qt_application():
    from PyQt6 import QtWidgets as W
    app=W.QApplication.instance() or W.QApplication([])
    yield app


@pytest.mark.parametrize("task",["detect","segment","pose","obb","classify"])
def test_integrated_save_review_roundtrip_and_conflict(tmp_path,task):
    project=make_project(tmp_path,task)
    name=project.images[0].name
    before=desktop.load_annotation(project,name)
    data=copy.deepcopy(before["annotation"])
    data["description"]="来自集成画布"
    data["imageWidth"]=1  # dimensions come from the actual image, never renderer metadata
    result=desktop.save_annotation(project,name,data,before["base_hash"],False)
    after=desktop.load_annotation(project,name)
    assert after["annotation"]["description"]=="来自集成画布"
    assert after["annotation"]["imageWidth"]==64
    assert after["annotation"]["checked"] is False
    assert after["base_hash"]==result["base_hash"]
    assert list((project.root/"backups").glob("*.json"))
    with pytest.raises(ValueError,match="其他窗口"):
        desktop.save_annotation(project,name,data,before["base_hash"],True)
    reviewed=desktop.save_annotation(project,name,data,after["base_hash"],True)
    assert reviewed["checked"] is True


def test_append_class_preserves_indices_and_annotations(tmp_path):
    project=make_project(tmp_path)
    before={p:digest(p) for p in (project.root/"annotations").glob("*.json")}
    assert desktop.append_class(project,"狗")==["object","狗"]
    assert desktop.append_class(project,"狗")==["object","狗"]
    assert all(digest(p)==value for p,value in before.items())
    for bad in ("", "../数据", "a,b", "a\\b", "."):
        with pytest.raises(ValueError):desktop.append_class(project,bad)


def test_editor_rejects_nonfinite_and_outside_images(tmp_path):
    project=make_project(tmp_path)
    before=desktop.load_annotation(project,project.images[0].name)
    data=before["annotation"]
    data["shapes"][0]["points"][0][0]=float("nan")
    with pytest.raises(ValueError,match="无效坐标"):
        desktop.save_annotation(project,project.images[0].name,data,before["base_hash"])
    assert digest(project.annotation(project.images[0]))==before["base_hash"]
    with pytest.raises(ValueError):desktop.load_annotation(project,"../project.json")


def test_pose_choices_only_shown_for_pose_and_dark_form(tmp_path,monkeypatch):
    import os
    os.environ.setdefault("QT_QPA_PLATFORM","offscreen")
    from PyQt6 import QtWidgets as W
    from anylabeling.views.workflow.workbench import CreateProjectDialog
    app=W.QApplication.instance() or W.QApplication([])
    monkeypatch.setenv("XAL_WORKBENCH_HOME",str(tmp_path))
    dialog=CreateProjectDialog(None)
    assert dialog.pose_fields.isHidden()
    for key in ("detect","segment","obb","classify","pose"):
        dialog.task_buttons[key].click()
        assert dialog.task.currentData()==key
        assert dialog.pose_fields.isHidden()==(key!="pose")
    dialog.close()


def test_new_native_forms_have_readable_theme_colors(tmp_path,monkeypatch):
    from types import SimpleNamespace
    from PyQt6 import QtWidgets as W, QtGui
    from anylabeling.views.workflow.theme import apply_electron_theme
    from anylabeling.views.workflow.workbench import CreateProjectDialog
    from anylabeling.views.labeling.utils import theme
    app=W.QApplication.instance() or W.QApplication([])
    original_style,original_palette=app.styleSheet(),app.palette()
    canvas=W.QWidget()
    window=SimpleNamespace(labeling_widget=SimpleNamespace(view=SimpleNamespace(canvas=canvas,_config={})))
    monkeypatch.setenv("XAL_WORKBENCH_HOME",str(tmp_path))
    def luminance(color):
        values=[color.redF(),color.greenF(),color.blueF()]
        return sum(w*(v/12.92 if v<=.04045 else ((v+.055)/1.055)**2.4) for v,w in zip(values,(.2126,.7152,.0722)))
    try:
        for mode in ("dark","light"):
            apply_electron_theme(window,mode)
            dialog=CreateProjectDialog(None)
            dialog.show()
            app.processEvents()
            foreground=luminance(dialog.name.palette().color(QtGui.QPalette.ColorRole.Text))
            background=luminance(dialog.name.palette().color(QtGui.QPalette.ColorRole.Base))
            assert (max(foreground,background)+.05)/(min(foreground,background)+.05)>=4.5
            dialog.close()
    finally:
        app.setStyleSheet(original_style)
        app.setPalette(original_palette)
        theme.init_theme("light")


def test_theme_switches_back_and_forth_on_widgets_created_later(tmp_path,monkeypatch,qt_application):
    """dark -> light -> dark must keep reaching Qt widgets.

    Widgets created after the first switch used to have their base stylesheet
    remembered but never recoloured, so the advanced tools stayed frozen in
    whichever theme was active when they were built.
    """
    from types import SimpleNamespace
    from PyQt6 import QtWidgets as W
    from anylabeling.views.workflow.theme import apply_electron_theme
    from anylabeling.views.labeling.utils import theme
    from anylabeling.services.workflow.project import read_json, digest  # noqa
    app = qt_application
    monkeypatch.setenv("XAL_WORKBENCH_HOME", str(tmp_path))
    canvas = W.QWidget()
    window = SimpleNamespace(
        labeling_widget=SimpleNamespace(
            view=SimpleNamespace(canvas=canvas, _config={})
        )
    )
    app.setStyleSheet("")
    panel = W.QWidget()
    panel.setStyleSheet("QWidget { background: #FFFFFF; color: #182B45; }")
    saved, palette = app.styleSheet(), app.palette()
    try:
        apply_electron_theme(window, "dark")
        assert "#ffffff" not in panel.styleSheet().lower()
        apply_electron_theme(window, "light")
        assert panel.styleSheet() == "QWidget { background: #FFFFFF; color: #182B45; }"
        apply_electron_theme(window, "dark")
        assert "#ffffff" not in panel.styleSheet().lower()
        apply_electron_theme(window, "light")
        assert panel.styleSheet() == "QWidget { background: #FFFFFF; color: #182B45; }"
    finally:
        panel.close()
        app.setStyleSheet(saved)
        app.setPalette(palette)
        theme.init_theme("light")
        if hasattr(app, "_workflow_light_palette"):
            del app._workflow_light_palette


def test_inline_frame_is_rasterised_at_the_host_display_scale(tmp_path):
    """The offscreen Qt platform reports dpr=1; the frame must still be 2x.

    A 1x bitmap stretched over a 2x panel was the blur (and, once the size
    clamp kicked in, the jumping canvas) users saw in the advanced tools.
    """
    from types import SimpleNamespace
    from PyQt6 import QtCore, QtWidgets as W
    from anylabeling.views.workflow.inline_tools import InlineTools
    QApplication = W.QApplication.instance() or W.QApplication([])
    frames = []
    host = W.QWidget()
    bridge = QtCore.QObject()
    bridge.window = host
    bridge.display_scale = 2.0
    bridge.emit = lambda event, **data: frames.append(data)
    host.resize(200, 150)
    tools = InlineTools(bridge)
    tools.timer.stop()
    try:
        tools.show(True, 200, 150)
        assert frames, "showing the panel must emit a frame"
        # show() clamps the window, so compare against the real window size.
        expected = (host.width() * 2, host.height() * 2)
        assert (frames[-1]["width"], frames[-1]["height"]) == expected
        assert tools.render_scale() == 2.0
        # An unchanged workspace must not be re-emitted at full rate.
        emitted = len(frames)
        tools.frame()
        assert len(frames) == emitted
    finally:
        tools.enabled = False
        tools.timer.stop()
        host.close()


def test_validation_reads_the_frozen_snapshot_and_reports_metrics(tmp_path,qt_application,monkeypatch):
    """Validation must reuse the training snapshot and never touch annotations."""
    from types import SimpleNamespace
    from anylabeling.services.workflow import validate
    project=make_project(tmp_path,"pose")
    monkeypatch.setenv("XAL_WORKBENCH_HOME",str(tmp_path))
    snapshot=project.root/"datasets"/"20260101_000000_snap"
    snapshot.mkdir(parents=True)
    (snapshot/"manifest.json").write_text("{}",encoding="utf-8")
    (snapshot/"data.yaml").write_text("path: .\nnames:\n  0: object\n",encoding="utf-8")
    assert validate._latest_dataset(project)==snapshot

    class Box:
        map50=0.71234
        map=0.51234
        mp=0.8
        mr=0.65

    fake=SimpleNamespace(box=Box(),speed={"inference":12.345},save_dir=str(snapshot))
    metrics=validate.summarize(fake,"detect")
    assert metrics["mAP@0.5"]==0.7123
    assert metrics["精确率"]==0.8
    assert metrics["任务"]=="detect"
    assert metrics["每张耗时(ms)"]==12.35

    # Result plots are matched by prefix so pose/seg curves are not missed.
    for name in ("results.png","BoxPR_curve.png","PosePR_curve.png","confusion_matrix.png","val_batch0_pred.jpg"):
        (snapshot/name).write_bytes(b"png")
    names=[entry["name"] for entry in validate.collect_plots(snapshot)]
    assert "BoxPR_curve.png" in names and "PosePR_curve.png" in names

    record={"at":"2026-01-01T00:00:00","weights":"w.pt","device":"cpu","metrics":metrics,"plots":validate.collect_plots(snapshot)}
    from anylabeling.services.workflow.project import write_json
    write_json(project.root/"validation"/"20260101_000000"/"metrics.json",record)
    history=validate.history(project)
    assert history and history[0]["id"]=="20260101_000000"
    assert history[0]["metrics"]["mAP@0.5"]==0.7123


def test_training_payload_never_carries_nms_thresholds(tmp_path,qt_application,monkeypatch):
    """``model.train()`` rejects unknown keys, so conf/iou must not reach it.

    Passing them made every training run die with "Unsupported training arguments:
    conf, iou" before a single epoch ran.
    """
    from PyQt6 import QtCore
    from anylabeling.services.workflow import desktop as storage
    from anylabeling.services.workflow.project import read_json
    from anylabeling.views.workflow.desktop_controller import DesktopController
    # This test inspects the payload, so avoid launching a real asynchronous
    # trainer whose signals outlive the lightweight test bridge.
    started=[]
    monkeypatch.setattr(QtCore.QProcess,"start",lambda self,*args:started.append(args))
    project=make_project(tmp_path,"detect")
    monkeypatch.setenv("XAL_WORKBENCH_HOME",str(tmp_path))
    # Review every picture so a snapshot can be built.
    for image in project.images:
        storage.save_annotation(project,image.name,{"shapes":[{"label":project.data["classes"][0],"shape_type":"rectangle",
            "points":[[1,1],[9,1],[9,9],[1,9]],"group_id":None,"flags":{},"difficult":False,"description":"","attributes":{}}],
            "flags":{}},storage.digest(project.annotation(image)),True)

    class Bridge(QtCore.QObject):
        workflow=type("W",(),{"project":project,"view":type("V",(),{"image_path":None,"dirty":False,"training_dialog":None})(),"process":type("P",(),{"state":staticmethod(lambda:QtCore.QProcess.ProcessState.NotRunning)})(),"last_count":None,"weights":type("L",(),{"setText":lambda *a:None})()})()
        def send(self,*a,**k):pass
        closing_requested=False
    controller=DesktopController(Bridge())
    controller.start_training({"model":"yolov8n.pt","device":"cpu","epochs":1,"batch":1,"imgsz":64,
        "workers":0,"patience":1,"lr0":0.01,"optimizer":"SGD","iou":0.45,"conf":0.35})
    try:
        assert started
        payloads=sorted((project.root/"runs").glob("*.json"))
        assert payloads,"a training payload should have been written"
        args=read_json(payloads[-1])["args"]
        assert "iou" not in args and "conf" not in args, args.keys()
        assert args["epochs"]==1 and args["optimizer"]=="SGD"
        # The thresholds are still validated and remembered for the validate page.
        assert controller.nms_settings=={"iou":0.45,"conf":0.35}
    finally:
        controller.stop_training()


def test_training_rejects_out_of_range_nms_thresholds(tmp_path,qt_application,monkeypatch):
    from PyQt6 import QtCore
    from anylabeling.services.workflow import desktop as storage
    from anylabeling.views.workflow.desktop_controller import DesktopController
    project=make_project(tmp_path,"detect")
    monkeypatch.setenv("XAL_WORKBENCH_HOME",str(tmp_path))
    class Bridge(QtCore.QObject):
        workflow=type("W",(),{"project":project,"view":type("V",(),{"image_path":None,"dirty":False,"training_dialog":None})(),"process":type("P",(),{"state":staticmethod(lambda:QtCore.QProcess.ProcessState.NotRunning)})(),"last_count":None,"weights":type("L",(),{"setText":lambda *a:None})()})()
        def send(self,*a,**k):pass
        closing_requested=False
    controller=DesktopController(Bridge())
    for bad in ({"iou":0.05},{"iou":1.5},{"conf":0.0},{"conf":1.0}):
        with pytest.raises(ValueError):
            controller.start_training({"model":"yolov8n.pt","device":"cpu","epochs":1,"batch":1,"imgsz":64,**bad})


def test_closing_optional_native_window_keeps_integrated_engine(tmp_path,monkeypatch):
    from types import SimpleNamespace
    from PyQt6 import QtWidgets as W
    from anylabeling.views.mainwindow import MainWindow
    import anylabeling.config as config
    app=W.QApplication.instance() or W.QApplication([])
    config.current_config_file="{}"
    config.set_work_directory(str(tmp_path))
    monkeypatch.delenv("XAL_WORKBENCH",raising=False)
    monkeypatch.setenv("XAL_WORKBENCH_HOME",str(tmp_path))
    monkeypatch.setenv("XAL_INTEGRATED_EDITOR","1")
    window=MainWindow(app,config=config.get_config())
    window.electron_bridge=SimpleNamespace(closing_requested=False,visible=True)
    window.show()
    app.processEvents()
    assert window.close() is False  # hide the supplemental window, don't quit the engine
    assert not window.isVisible()
    window.electron_bridge.closing_requested=True
    assert window.close() is True
