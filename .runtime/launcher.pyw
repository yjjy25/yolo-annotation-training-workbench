"""One-click entry for the full upstream desktop app with additive workflow."""
from pathlib import Path
import os
import sys
import traceback

ROOT = Path(__file__).resolve().parent.parent
# Workers need real standard streams; the GUI itself is still launched via pythonw.
if os.name == "nt" and Path(sys.executable).name.lower() == "pythonw.exe":
    console_python = Path(sys.executable).with_name("python.exe")
    if console_python.exists():
        sys.executable = str(console_python)
RUNTIME = Path(os.environ.get("XAL_PROFILE_HOME", str(ROOT / ".runtime")))
RUNTIME.mkdir(exist_ok=True)
temporary = RUNTIME / "tmp"
temporary.mkdir(exist_ok=True)
os.environ["TEMP"] = str(temporary)
os.environ["TMP"] = str(temporary)
log = (RUNTIME / "startup.log").open("w", encoding="utf-8", buffering=1)
sys.stdout = log
sys.stderr = log
os.environ["XAL_WORKBENCH"] = "1"
os.environ["XAL_WORKBENCH_HOME"] = str(RUNTIME)
os.environ["YOLO_CONFIG_DIR"] = str(RUNTIME / "ultralytics")
font = ROOT / ".runtime" / "fonts" / "NotoSansSC.ttf"
if font.is_file():
    import shutil
    for font_cache in (RUNTIME/"ultralytics",RUNTIME/"ultralytics"/"Ultralytics"):
        font_cache.mkdir(parents=True,exist_ok=True)
        for name in ("Arial.ttf", "Arial.Unicode.ttf"):
            if not (font_cache/name).exists():shutil.copy2(font,font_cache/name)
    os.environ["XAL_FONT_FILE"] = str(font)
os.environ["QT_API"] = "pyqt6"
source_root = str(ROOT / "X-AnyLabeling")
sys.path.insert(0, source_root)
# Module-based workers must use the same bundled source as the GUI, even when
# the portable runtime contains an older installed anylabeling distribution.
os.environ["PYTHONPATH"] = os.pathsep.join(filter(None, [source_root, os.environ.get("PYTHONPATH", "")]))
os.chdir(ROOT / "X-AnyLabeling")

try:
    if os.environ.get("XAL_OFFSCREEN_TOOLS")=="1":
        from PyQt6 import QtCore,QtWidgets
        QtWidgets.QApplication.setAttribute(QtCore.Qt.ApplicationAttribute.AA_DontUseNativeDialogs)
    import yaml
    config = RUNTIME / "config.yaml"
    if not config.exists():
        config.write_text(yaml.safe_dump({"language": "zh_CN", "theme": "light", "auto_save": True, "store_data": False}, allow_unicode=True), encoding="utf-8")
    if os.environ.get("XAL_ELECTRON") == "1":
        settings = yaml.safe_load(config.read_text(encoding="utf-8")) or {}
        settings["theme"] = os.environ.get("XAL_THEME", "dark")
        config = RUNTIME / "electron-config.yaml"
        config.write_text(yaml.safe_dump(settings,allow_unicode=True),encoding="utf-8")
    from anylabeling.app import main
    sys.argv = [sys.argv[0], "--work-dir", str(RUNTIME), "--config", str(config), "--no-auto-update-check"]
    main()
except Exception:
    traceback.print_exc(file=log)
    log.flush()
    if sys.platform == "win32" and os.environ.get("QT_QPA_PLATFORM") != "offscreen" and os.environ.get("XAL_ELECTRON") != "1":
        import ctypes
        ctypes.windll.user32.MessageBoxW(None, f"启动未完成。请查看日志：\n{RUNTIME / 'startup.log'}", "标注训练工作台", 0x10)
    raise
