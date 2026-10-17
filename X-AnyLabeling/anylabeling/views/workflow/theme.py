"""Workbench appearance; reversible, with no changes to upstream theme tokens."""
import os
from pathlib import Path
from PyQt6.QtGui import QFont, QFontDatabase
from PyQt6.QtWidgets import QApplication


STYLE = """
QMainWindow { background: #F3F6FA; }
QMenuBar { padding: 4px; font-size: 13px; }
QDockWidget::title { padding: 9px; font-weight: 600; }
QWidget#WorkflowPanel { background: #FFFFFF; }
QWidget#WorkflowPanel QLabel { color: #182B45; }
QWidget#WorkflowPanel QLabel#Heading { font-size: 22px; font-weight: 700; padding-top: 6px; }
QWidget#WorkflowPanel QLabel#Hint { color: #52647B; font-size: 12px; }
QWidget#WorkflowPanel QPushButton { padding: 8px 10px; border: 1px solid #CED8E5; border-radius: 5px; background: #FFFFFF; color: #182B45; text-align: left; }
QWidget#WorkflowPanel QPushButton:hover { background: #EAF1FC; border-color: #245BC4; }
QWidget#WorkflowPanel QPushButton:focus { border: 2px solid #245BC4; }
QWidget#WorkflowPanel QPushButton#Primary { background: #245BC4; color: white; border-color: #245BC4; font-weight: 600; }
QWidget#WorkflowPanel QPushButton:disabled { color: #79879A; background: #F3F6FA; }
QWidget#WorkflowPanel QComboBox { padding: 6px; min-height: 22px; border: 1px solid #CED8E5; border-radius: 4px; }
QWidget#WorkflowPanel QListWidget { border: 1px solid #DDE5EF; border-radius: 4px; }
QWidget#WorkflowPanel QListWidget::item { padding: 6px; }
QWidget#WorkflowPanel QListWidget::item:selected { background: #E0EBFF; color: #182B45; }
QWidget#WorkflowPanel QTabBar::tab { padding: 8px 10px; }
QWidget#WorkflowHeader { background: #FFFFFF; border-bottom: 1px solid #DDE5EF; }
QWidget#WorkflowHeader QLabel { color: #182B45; padding: 6px; }
QWidget#WorkflowHeader QPushButton, QDialog#WorkflowDialog QPushButton { background: white; color: #182B45; border: 1px solid #CED8E5; border-radius: 5px; padding: 8px 12px; }
QWidget#WorkflowHeader QPushButton:hover, QDialog#WorkflowDialog QPushButton:hover { background: #EAF1FC; border-color: #245BC4; }
QWidget#WorkflowHeader QPushButton#Primary, QDialog#WorkflowDialog QPushButton#Primary { background: #245BC4; color: white; border-color: #245BC4; font-weight: 600; }
QDialog#WorkflowDialog { background: #F3F6FA; }
QDialog#WorkflowDialog QLabel#Heading { font-size: 22px; font-weight: 700; color: #182B45; }
QDialog#WorkflowDialog QLineEdit, QDialog#WorkflowDialog QPlainTextEdit, QDialog#WorkflowDialog QComboBox { background: white; border: 1px solid #CED8E5; padding: 7px; border-radius: 4px; }
"""


def apply(window, enabled=True):
    app = QApplication.instance()
    if not hasattr(window, "_original_stylesheet"):
        window._original_stylesheet = app.styleSheet()
        window._original_font = app.font()
    app.setStyleSheet(window._original_stylesheet + (STYLE if enabled else ""))
    if enabled:
        font = QFont(app.font())
        bundled=Path(os.environ.get("XAL_FONT_FILE",""))
        if bundled.is_file():
            identifier=QFontDatabase.addApplicationFont(str(bundled))
            families=QFontDatabase.applicationFontFamilies(identifier)
            if families and os.name!="nt":font.setFamily(families[0])
        if os.name == "nt":
            font_path = Path(os.environ.get("WINDIR", "C:/Windows")) / "Fonts" / "msyh.ttc"
            if font_path.exists() and not QFontDatabase.families():
                QFontDatabase.addApplicationFont(str(font_path))
            font.setFamily("Microsoft YaHei UI")
        font.setPointSize(10)
        app.setFont(font)
    else:
        app.setFont(window._original_font)


def _light_palette(app):
    """Remembers the pre-dark palette so dark -> light can actually be undone.

    ``get_dark_palette()`` returns None outside dark mode, so the previous code
    fell back to ``standardPalette()`` and had no way back to the palette the
    app was built with. After one dark switch many Qt widgets stayed dark in
    light mode, which read as "the theme will not switch".
    """
    if not hasattr(app, "_workflow_light_palette"):
        from PyQt6.QtGui import QPalette
        app._workflow_light_palette = QPalette(app.palette())
    return app._workflow_light_palette


def apply_electron_theme(window, mode):
    """Live appearance adapter; stores original widget styles for safe recoloring."""
    import re
    from PyQt6.QtGui import QPalette, QColor
    from PyQt6.QtWidgets import QWidget
    from anylabeling.views.labeling.utils import theme as upstream
    from anylabeling.views.labeling.utils import style as native_style
    app = QApplication.instance()
    light_palette = _light_palette(app)
    previous = dict(upstream.get_theme())
    factories = [getattr(native_style,name) for name in (
        "get_dock_style", "get_panel_style", "get_plain_text_edit_style",
        "get_checkbox_indicator_style", "get_settings_button_style",
        "get_toolbar_scroll_area_style", "get_dialog_style",
        "get_cancel_btn_style", "get_ok_btn_style")]
    original_styles = {factory():factory for factory in factories}
    for widget in app.allWidgets():
        if widget.styleSheet() and not hasattr(widget,"_workflow_base_style"):
            widget._workflow_base_style = (widget.styleSheet(),previous)
            widget._workflow_style_factory = original_styles.get(widget.styleSheet())
    upstream.init_theme(mode)
    active = dict(upstream.get_theme())
    active.update(primary="#E9A23B",primary_hover="#F2B85A",primary_pressed="#CA8528",selection="#B87922",highlight="#E9A23B")
    upstream._active_theme = active
    dark_palette = upstream.get_dark_palette()
    if dark_palette is None:
        # Light mode: put back exactly what the app started with.
        app.setPalette(QPalette(light_palette))
    else:
        # Fusion honours an explicit palette on every platform; the native
        # Windows style ignores parts of it and leaves widgets half-themed.
        if app.style().objectName().lower() != "fusion":
            app.setStyle("Fusion")
        app.setPalette(dark_palette)
    for widget in app.allWidgets():
        # Widgets created after the first switch carry no base style yet. Capture
        # it now and fall straight through to the recolour below: remembering only
        # and skipping left them painted in the previous theme forever.
        if not hasattr(widget,"_workflow_base_style") and widget.styleSheet():
            widget._workflow_base_style = (widget.styleSheet(), previous)
            widget._workflow_style_factory = original_styles.get(widget.styleSheet())
        if hasattr(widget,"_workflow_base_style"):
            factory = getattr(widget,"_workflow_style_factory",None)
            if factory:
                widget.setStyleSheet(factory())
                continue
            style, original = widget._workflow_base_style
            if mode == "light":
                widget.setStyleSheet(style)
                continue
            colors = {str(value).lower():active[key] for key,value in original.items() if key in active}
            def recolor(match):
                prop, value = match.group(1), match.group(2)
                # White is both a background and selection text in upstream.
                if value.lower() == "#ffffff":
                    target = active["background"] if "background" in prop else active["selection_text"]
                else:
                    target = colors.get(value.lower(),value)
                return prop + target
            widget.setStyleSheet(re.sub(r"((?:[\w-]+)\s*:\s*)(#[0-9A-Fa-f]{6})\b",recolor,style))
    replacements = {"#F3F6FA":active["surface"],"#FFFFFF":active["background"],"#182B45":active["text"],"#52647B":active["text_secondary"],"#245BC4":"#D99A31","#EAF1FC":active["surface_hover"],"#E0EBFF":active["surface_hover"],"#CED8E5":active["border"],"#DDE5EF":active["border"]}
    extended = STYLE
    for source,target in replacements.items():
        extended = extended.replace(source,target)
    # Use explicit semantic colors for forms created AFTER theme activation too.
    # Literal `white` in the legacy extension otherwise wins over the palette.
    form_style = """
    QDialog#WorkflowDialog { background: BG; color: FG; }
    QDialog#WorkflowDialog QLabel { color: FG; background: transparent; }
    QDialog#WorkflowDialog QLabel#Hint { color: MUTED; }
    QDialog#WorkflowDialog QLabel#Heading { color: FG; font-size: 21px; }
    QDialog#WorkflowDialog QLineEdit, QDialog#WorkflowDialog QPlainTextEdit,
    QDialog#WorkflowDialog QComboBox, QWidget#WorkflowPanel QComboBox,
    QWidget#WorkflowPanel QLineEdit, QWidget#WorkflowPanel QPlainTextEdit {
        background: INPUT; color: FG; border: 1px solid EDGE;
        border-radius: 6px; padding: 7px; selection-background-color: SELECT;
        selection-color: #ffffff;
    }
    QDialog#WorkflowDialog QComboBox QAbstractItemView,
    QWidget#WorkflowPanel QComboBox QAbstractItemView {
        background: INPUT; color: FG; selection-background-color: SELECT;
        selection-color: #ffffff; padding: 4px;
    }
    QDialog#WorkflowDialog QPushButton, QDialog#WorkflowDialog QToolButton {
        background: INPUT; color: FG; border: 1px solid EDGE;
        border-radius: 6px; padding: 8px 12px;
    }
    QDialog#WorkflowDialog QPushButton:hover { background: HOVER; border-color: ACCENT; }
    QDialog#WorkflowDialog QPushButton:checked { background: HOVER; border: 2px solid ACCENT; }
    QDialog#WorkflowDialog QPushButton#Primary, QWidget#WorkflowPanel QPushButton#Primary {
        background: ACCENT; color: #241807; border-color: ACCENT; font-weight: 600;
    }
    QDialog#WorkflowDialog QLineEdit:focus, QDialog#WorkflowDialog QComboBox:focus {
        border: 2px solid ACCENT;
    }
    QDialog#WorkflowDialog QPushButton:disabled, QDialog#WorkflowDialog QComboBox:disabled {
        background: BG; color: MUTED; border-color: EDGE;
    }
    """
    for token,value in {"INPUT":active["background_secondary"],"MUTED":active["text_secondary"],"SELECT":active["selection"],"ACCENT":active["primary"],"HOVER":active["surface_hover"],"EDGE":active["border"],"BG":active["surface"],"FG":active["text"]}.items():
        form_style=form_style.replace(token,value)
    app.setStyleSheet(upstream.get_app_stylesheet()+extended+form_style)
    window._electron_theme_mode = mode
    # Floating widgets that sit directly on the canvas (not inside a themed
    # panel) carry their own hard-coded card colours and need an explicit refresh.
    try:
        from anylabeling.views.labeling.widgets.canvas_adjustment import (
            CanvasAdjustmentWidget,
        )
        for widget in app.allWidgets():
            if isinstance(widget, CanvasAdjustmentWidget):
                widget.apply_theme(mode, active)
    except Exception:
        pass
    canvas = window.labeling_widget.view.canvas
    # The canvas paints its own background; give it a complete palette per mode
    # instead of only recolouring Window, which left it half dark after a switch.
    if not hasattr(canvas, "_workflow_light_palette"):
        canvas._workflow_light_palette = QPalette(canvas.palette())
    if mode == "dark":
        canvas_palette = QPalette(canvas._workflow_light_palette)
        canvas_palette.setColor(QPalette.ColorRole.Window, QColor("#16181D"))
        canvas_palette.setColor(QPalette.ColorRole.Base, QColor("#16181D"))
        canvas_palette.setColor(QPalette.ColorRole.WindowText, QColor("#E6E8EE"))
        canvas_palette.setColor(QPalette.ColorRole.Text, QColor("#E6E8EE"))
    else:
        canvas_palette = QPalette(canvas._workflow_light_palette)
        canvas_palette.setColor(QPalette.ColorRole.Window, QColor("#E4E8EF"))
        canvas_palette.setColor(QPalette.ColorRole.Base, QColor("#FFFFFF"))
        canvas_palette.setColor(QPalette.ColorRole.WindowText, QColor("#182B45"))
        canvas_palette.setColor(QPalette.ColorRole.Text, QColor("#182B45"))
    canvas.setPalette(canvas_palette)
    window.labeling_widget.view._config["theme"] = mode
    for widget in app.allWidgets():
        widget.update()
