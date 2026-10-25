import os
os.environ.setdefault("QT_QPA_PLATFORM", "offscreen")
from PyQt6 import QtCore, QtGui, QtWidgets as W
from anylabeling.resources import resources  # noqa
from anylabeling.views.mainwindow import MainWindow
from anylabeling.views.labeling.shape import Shape
import anylabeling.config as config
from .test_project import make_project


def test_workbench_ignores_canvas_events_after_attributes_are_cleared():
    from anylabeling.views.workflow.workbench import Workbench

    # Model the late events observed during QApplication teardown: the Qt
    # object is alive, but its Python-owned view reference has been cleared.
    controller = Workbench.__new__(Workbench)
    QtCore.QObject.__init__(controller)
    canvas = W.QWidget()
    canvas.installEventFilter(controller)
    for kind in (QtCore.QEvent.Type.Hide, QtCore.QEvent.Type.DeferredDelete):
        assert controller.eventFilter(canvas, QtCore.QEvent(kind)) is False
    canvas.hide()
    canvas.removeEventFilter(controller)


def test_full_window_preserves_actions_and_pose_roundtrip(tmp_path, monkeypatch):
    app = W.QApplication.instance() or W.QApplication([])
    config.current_config_file = "{}"
    config.set_work_directory(str(tmp_path))
    monkeypatch.delenv("XAL_WORKBENCH", raising=False)
    monkeypatch.setenv("XAL_WORKBENCH_HOME", str(tmp_path))
    original = MainWindow(app, config=config.get_config())
    base = {name: (action.text(), action.shortcut().toString()) for name, action in vars(original.labeling_widget.view.actions).items() if isinstance(action, QtGui.QAction)}
    original.close()
    monkeypatch.setenv("XAL_WORKBENCH", "1")
    window = MainWindow(app, config=config.get_config())
    view, workflow = window.labeling_widget.view, window.workflow
    current = {name: (action.text(), action.shortcut().toString()) for name, action in vars(view.actions).items() if isinstance(action, QtGui.QAction)}
    assert base == current
    project = make_project(tmp_path, "pose")
    workflow.load_project(project.root)
    from anylabeling.services.workflow.project import digest
    original_files = {p:digest(p) for p in (project.root / "annotations").glob("*.json")}
    for mode in ("pretrained","trained","manual"):
        workflow.set_mode(mode)
        assert workflow.project.data["annotation_mode"] == mode
        assert all(digest(p)==value for p,value in original_files.items())
    window.resize(1500, 950)
    window.show()
    app.processEvents()
    assert view.image_path
    workflow.start_pose()
    box = Shape(shape_type="rectangle")
    for x, y in [(10,10),(50,10),(50,50),(10,50)]:
        box.add_point(QtCore.QPointF(x,y))
    view.canvas.current = box
    view.canvas.finalise()
    app.processEvents()
    assert workflow.pose_state == "points"
    assert view.canvas.shapes[-1].label == "object"
    assert view.canvas.shapes[-1].group_id == workflow.group_id
    workflow.skip_point()
    assert workflow.point_index == 1
    workflow.cancel_pose()
    view.set_annotation_checked(True)
    assert view.other_data["checked"] is True
    view.set_dirty()
    assert view.other_data["checked"] is False
    window.grab().save(str(tmp_path / "window.png"))
    workflow.timer.stop()
    window.close()
