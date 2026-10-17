"""Native-Qt screenshot/check harness. Uses synthetic QA projects only."""
from pathlib import Path
import os
import sys

os.environ.setdefault("QT_QPA_PLATFORM", "offscreen")
ROOT = Path(sys.argv[1]).resolve()
ROOT.mkdir(parents=True, exist_ok=True)
os.environ["XAL_WORKBENCH"] = "1"
os.environ["XAL_WORKBENCH_HOME"] = str(ROOT)
from PyQt6 import QtCore, QtGui, QtWidgets as W, QtTest
from anylabeling.resources import resources  # noqa
import anylabeling.config as config
from anylabeling.views.mainwindow import MainWindow
from anylabeling.views.workflow.workbench import TemplateDialog
from anylabeling.services.workflow.presets import preset

app = W.QApplication([])
if os.name == "nt":
    QtGui.QFontDatabase.addApplicationFont(str(Path(os.environ["WINDIR"]) / "Fonts/msyh.ttc"))
    app.setFont(QtGui.QFont("Microsoft YaHei UI", 10))
translator = QtCore.QTranslator()
translator.load(":/languages/translations/zh_CN.qm")
app.installTranslator(translator)
config.current_config_file = "{}"
config.set_work_directory(str(ROOT))
window = MainWindow(app, config=config.get_config())
window.show()
app.processEvents()
window.resize(1366, 768)
app.processEvents()
window.grab().save(str(ROOT / "01-workspace-1366.png"))
print("WORKSPACE_SIZE",window.width(),window.height(),flush=True)
for name in ("human", "dog"):
    dialog = TemplateDialog(preset(name), window)
    dialog.show()
    app.processEvents()
    dialog.grab().save(str(ROOT / f"02-template-{name}.png"))
    dialog.close()
if len(sys.argv) > 2:
    window.workflow.load_project(sys.argv[2])
    app.processEvents()
    window.resize(1366,768)
    for index,name in enumerate(("project","pose","review")):
        window.workflow.tabs.setCurrentIndex(index)
        app.processEvents()
        window.grab().save(str(ROOT / ("03-"+name+".png")))
    window.workflow.train()
    QtTest.QTest.qWait(3500)
    dialog = window.labeling_widget.view.training_dialog
    if dialog:
        dialog.resize(1200,800)
        app.processEvents()
        dialog.grab().save(str(ROOT / "04-training.png"))
        print("TRAIN_CONFIG",{k:dialog.config_widgets[k].text() for k in ("data","model","project","pose_config")},flush=True)
        dialog.close()
window.workflow.timer.stop()
window.close()
