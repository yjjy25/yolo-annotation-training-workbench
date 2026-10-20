"""Additive native-Qt workflow. All original annotation and training tools remain."""
from __future__ import annotations

import math
import os
import shutil
from pathlib import Path
import sys

from PyQt6 import QtCore, QtGui, QtWidgets as W
from PyQt6.QtCore import Qt

from anylabeling.services.workflow.project import Project, TASKS, read_json, write_json, validate_template, template_hash
from anylabeling.services.workflow.presets import preset
from .theme import apply as apply_theme


def label(text, heading=False):
    widget = W.QLabel(text)
    widget.setWordWrap(True)
    widget.setObjectName("Heading" if heading else "Hint")
    return widget


def button(text, callback, primary=False):
    widget = W.QPushButton(text)
    if primary:
        widget.setObjectName("Primary")
    widget.clicked.connect(lambda _=False: callback())
    return widget


class SkeletonPreview(W.QWidget):
    def __init__(self, parent=None):
        super().__init__(parent)
        self.names, self.positions, self.edges = [], [], []
        self.start = None
        self.drag = None
        self.connecting = False
        self.setMinimumSize(280, 260)

    def reset(self, names):
        self.names = names
        self.positions = [QtCore.QPointF(.5 + .32 * math.cos(i * math.tau / max(1, len(names))), .5 + .32 * math.sin(i * math.tau / max(1, len(names)))) for i in range(len(names))]
        self.edges = []
        self.start = None
        self.update()

    def point(self, i):
        p = self.positions[i]
        return QtCore.QPointF(p.x() * self.width(), p.y() * self.height())

    def paintEvent(self, event):
        painter = QtGui.QPainter(self)
        painter.setRenderHint(QtGui.QPainter.RenderHint.Antialiasing)
        painter.fillRect(self.rect(), QtGui.QColor("#EDF3FA"))
        painter.setPen(QtGui.QPen(QtGui.QColor("#245BC4"), 2))
        for a, b in self.edges:
            painter.drawLine(self.point(a), self.point(b))
        for i, name in enumerate(self.names):
            point = self.point(i)
            painter.setBrush(QtGui.QColor("#16734B" if i == self.start else "#245BC4"))
            painter.drawEllipse(point, 6, 6)
            painter.setPen(QtGui.QColor("#182B45"))
            painter.drawText(point + QtCore.QPointF(9, -7), str(i + 1) if len(self.names) > 20 else f"{i + 1} {name}")

    def mousePressEvent(self, event):
        hits = [(math.hypot(self.point(i).x() - event.position().x(), self.point(i).y() - event.position().y()), i) for i in range(len(self.names))]
        if not hits or min(hits)[0] > 20:
            return
        index = min(hits)[1]
        if self.connecting:
            if self.start is not None and self.start != index:
                edge = sorted([self.start, index])
                if edge not in self.edges:
                    self.edges.append(edge)
                self.start = None
            else:
                self.start = index
        else:
            self.drag = index
        self.update()

    def mouseMoveEvent(self, event):
        if self.drag is not None:
            self.positions[self.drag] = QtCore.QPointF(min(.95, max(.05, event.position().x() / self.width())), min(.95, max(.05, event.position().y() / self.height())))
            self.update()
        else:
            for i, name in enumerate(self.names):
                if (self.point(i) - event.position()).manhattanLength() < 20:
                    self.setToolTip(f"{i+1} · {name}")
                    return
            self.setToolTip("")

    def mouseReleaseEvent(self, event):
        self.drag = None


class TemplateDialog(W.QDialog):
    def __init__(self, template=None, parent=None):
        super().__init__(parent)
        self.setObjectName("WorkflowDialog")
        self.setWindowTitle("自定义骨架 · 名称、顺序与连线")
        self.resize(820, 530)
        layout = W.QVBoxLayout(self)
        layout.addWidget(label("定义你要标注的位置", True))
        presets = W.QHBoxLayout()
        presets.addWidget(button("载入人体 17 点", lambda: self.use_preset("human")))
        presets.addWidget(button("载入狗 24 点", lambda: self.use_preset("dog")))
        layout.addLayout(presets)
        layout.addWidget(label("每行一个骨点，按标注顺序填写。更新预览后可拖动骨点；连线模式下依次点击两个点。"))
        row = W.QHBoxLayout()
        left = W.QVBoxLayout()
        self.names = W.QPlainTextEdit()
        self.names.setPlaceholderText("底座\n肩关节\n肘关节\n腕关节\n夹爪中心")
        self.names.setPlainText("\n".join((template or {}).get("display", (template or {}).get("points", ["底座", "肩关节", "肘关节", "腕关节", "夹爪中心"]))))
        left.addWidget(self.names)
        left.addWidget(button("更新骨点预览（重置连线）", self.reset))
        self.pairs = W.QLineEdit()
        self.pairs.setPlaceholderText("左右配对，例如 1-2, 3-4；无则留空")
        self.pairs.setText(", ".join(f"{a + 1}-{b + 1}" for a, b in (template or {}).get("pairs", [])))
        left.addWidget(label("左右配对（按列表中从 1 开始的编号）"))
        left.addWidget(self.pairs)
        row.addLayout(left, 1)
        right = W.QVBoxLayout()
        self.preview = SkeletonPreview()
        self.reset()
        if template:
            self.preview.edges = template.get("edges", []).copy()
        right.addWidget(self.preview)
        connect = W.QCheckBox("连线模式：依次点击两个骨点")
        connect.toggled.connect(lambda enabled: setattr(self.preview, "connecting", enabled))
        right.addWidget(connect)
        right.addWidget(button("清除全部连线", lambda: (self.preview.edges.clear(), self.preview.update())))
        row.addLayout(right, 2)
        layout.addLayout(row)
        controls = W.QDialogButtonBox(W.QDialogButtonBox.StandardButton.Save | W.QDialogButtonBox.StandardButton.Cancel)
        controls.accepted.connect(self.validate)
        controls.rejected.connect(self.reject)
        layout.addWidget(controls)
        self.result_template = None
        self.original_template = template
        if template and template.get("positions"):
            self.preview.positions = [QtCore.QPointF(*p) for p in template["positions"]]

    def use_preset(self, key):
        template = preset(key)
        self.original_template = template
        self.names.setPlainText("\n".join(template.get("display", template["points"])))
        self.reset()
        self.preview.edges = template["edges"]
        self.preview.positions = [QtCore.QPointF(*p) for p in template["positions"]]
        self.pairs.setText(", ".join(f"{a+1}-{b+1}" for a,b in template["pairs"]))
        self.preview.update()

    def reset(self):
        self.preview.reset([name.strip() for name in self.names.toPlainText().splitlines() if name.strip()])

    def validate(self):
        try:
            names = [n.strip() for n in self.names.toPlainText().splitlines() if n.strip()]
            if names != self.preview.names:
                raise ValueError("骨点名称已修改，请先更新预览，再设置连线。")
            pairs = [[int(i.strip()) - 1 for i in entry.split("-")] for entry in self.pairs.text().replace("，", ",").split(",") if entry.strip()]
            self.result_template = validate_template({"points": names, "edges": self.preview.edges, "pairs": pairs})
            self.result_template["positions"] = [[p.x(), p.y()] for p in self.preview.positions]
            original = self.original_template or {}
            if names == original.get("display", original.get("points")):
                self.result_template["points"] = original["points"]
                for key in ("display", "preset", "class_name"):
                    if key in original:
                        self.result_template[key] = original[key]
            self.accept()
        except (ValueError, TypeError) as error:
            W.QMessageBox.warning(self, "请检查骨架", str(error))


class CreateProjectDialog(W.QDialog):
    def __init__(self, parent):
        super().__init__(parent)
        self.setObjectName("WorkflowDialog")
        self.setWindowTitle("新建标注训练项目")
        self.resize(760, 540)
        self.template = None
        layout = W.QVBoxLayout(self)
        layout.addWidget(label("从图片开始，完成标注与训练", True))
        layout.addWidget(label("原始图片与标注保留。项目内集中管理副本、标注、模型和训练结果。"))
        form = W.QFormLayout()
        self.name = W.QLineEdit("我的项目")
        self.task = W.QComboBox()
        for key, text in TASKS.items():
            self.task.addItem(text, key)
        self.classes = W.QLineEdit("目标")
        self.classes.setPlaceholderText("多个类别用逗号分隔")
        self.source = W.QLineEdit()
        self.root = W.QLineEdit()
        home = Path(os.environ.get("XAL_WORKBENCH_HOME", Path.home()))
        default_projects = home.parent / "我的项目"
        self.root.setText(str(default_projects / "我的项目"))
        self.name.textChanged.connect(lambda name: self.root.setText(str(default_projects / (name.strip() or "我的项目"))))
        form.addRow("项目名称", self.name)
        self.task.hide()
        self.task_buttons = {}
        task_row = W.QHBoxLayout()
        group = W.QButtonGroup(self)
        group.setExclusive(True)
        for index,(key,text) in enumerate(TASKS.items()):
            choice = W.QPushButton(text)
            choice.setCheckable(True)
            choice.setChecked(index == 0)
            group.addButton(choice)
            choice.clicked.connect(lambda checked=False,index=index: self.task.setCurrentIndex(index))
            self.task_buttons[key] = choice
            task_row.addWidget(choice)
        form.addRow("任务类型", task_row)
        self.task_hint = label("")
        form.addRow("", self.task_hint)
        form.addRow("对象类别", self.classes)
        form.addRow("", label("填写要识别的对象，例如：人, 狗, 猫。多个类别用逗号分隔；创建后也可追加类别。"))
        for title, field in (("图片文件夹", self.source), ("项目保存目录", self.root)):
            row = W.QHBoxLayout()
            row.addWidget(field)
            row.addWidget(button("选择", lambda field=field: self.browse(field)))
            form.addRow(title, row)
        self.template_button = button("定义姿态骨点模板", self.edit_template)
        self.pose_fields = W.QWidget()
        pose_layout = W.QVBoxLayout(self.pose_fields)
        pose_layout.setContentsMargins(0,0,0,0)
        self.preset_box = W.QComboBox()
        self.preset_box.addItem("自定义骨架", "custom")
        self.preset_box.addItem("人体 · COCO 17 点", "human")
        self.preset_box.addItem("狗 · Dog-Pose 24 点", "dog")
        self.preset_box.currentIndexChanged.connect(self.pick_preset)
        pose_layout.addWidget(label("姿态骨点模板"))
        pose_layout.addWidget(self.preset_box)
        pose_layout.addWidget(self.template_button)
        form.addRow(self.pose_fields)
        self.pose_fields.hide()
        self.preset_box.setEnabled(False)
        self.task.currentIndexChanged.connect(lambda: self.template_button.setEnabled(self.task.currentData() == "pose"))
        self.task.currentIndexChanged.connect(lambda: self.preset_box.setEnabled(self.task.currentData() == "pose"))
        self.task.currentIndexChanged.connect(self.update_task)
        self.template_button.setEnabled(False)
        layout.addLayout(form)
        self.status = label("")
        layout.addWidget(self.status)
        layout.addWidget(button("创建并打开项目", self.create, True))
        self.project = None
        self.update_task()

    def update_task(self):
        task = self.task.currentData()
        self.pose_fields.setVisible(task == "pose")
        descriptions = {"detect":"矩形框标出每个目标，适合计数、定位和目标识别。", "segment":"用多边形勾出每个实例的轮廓，适合精细边界。", "pose":"先框出对象，再按顺序点选关键点；可选人、狗或自定义模板。", "obb":"使用可旋转的框标出有方向的目标。", "classify":"为整张图片选择一个类别，不需要画框。"}
        self.task_hint.setText(descriptions[task])
        for key,choice in self.task_buttons.items():
            choice.setChecked(key == task)

    def pick_preset(self):
        key = self.preset_box.currentData()
        if key == "custom":
            self.template = None
            self.template_button.setText("定义姿态骨点模板")
        else:
            self.template = preset(key)
            self.classes.setText(self.template["class_name"])
            self.template_button.setText(f"已选 {len(self.template['points'])} 个骨点 · 查看/调整")

    def browse(self, field):
        path = W.QFileDialog.getExistingDirectory(self, "选择文件夹")
        if path:
            field.setText(path)

    def edit_template(self):
        dialog = TemplateDialog(self.template, self)
        if dialog.exec():
            self.template = dialog.result_template
            self.template_button.setText(f"已定义 {len(self.template['points'])} 个骨点 · 编辑")

    def create(self):
        try:
            if not self.name.text().strip() or not self.root.text().strip() or not self.source.text().strip():
                raise ValueError("请填写项目名称、图片目录和项目保存目录。")
            classes = [c.strip() for c in self.classes.text().replace("，", ",").split(",") if c.strip()]
            self.status.setText("正在导入副本，请稍候…")
            W.QApplication.processEvents()
            self.project = Project.create(self.root.text(), self.name.text().strip(), self.task.currentData(), classes, self.source.text(), self.template)
            self.accept()
        except Exception as error:
            self.status.setText(str(error))


class Workbench(QtCore.QObject):
    def __init__(self, window):
        super().__init__(window)
        self.window = window
        self.view = window.labeling_widget.view
        self.project = None
        self.pose_state = None
        self.group_id = None
        self.point_index = 0
        self.pose_image = None
        self.process = None
        self.prediction_status = "idle"
        self.last_image = None
        self.last_count = None
        self.refresh_counter = 0
        self.proposal = None
        self.view.workflow = self
        self.view.canvas.installEventFilter(self)
        self.view.canvas.shape_moved.connect(self.cancel_pose)
        self.build_ui()
        self.timer = QtCore.QTimer(self)
        self.timer.timeout.connect(self.refresh)
        self.timer.start(700)
        self.recent = Path(os.environ.get("XAL_WORKBENCH_HOME", Path.home())) / "recent-project.json"
        if self.recent.exists():
            try:
                self.load_project(read_json(self.recent)["root"])
            except Exception as error:
                self.hint.setText(f"上次项目未能打开：{error}。请选择打开项目。")
        apply_theme(window)

    def build_ui(self):
        self.dock = W.QDockWidget("项目工作台 · 标注 / 训练 / 审核", self.window)
        self.dock.setObjectName("IntegratedWorkflow")
        self.dock.setMinimumWidth(290)
        body = W.QWidget()
        body.setObjectName("WorkflowPanel")
        layout = W.QVBoxLayout(body)
        layout.setContentsMargins(16, 12, 16, 12)
        self.title = label("标注与训练", True)
        layout.addWidget(self.title)
        self.summary = label("完整原版工具已保留。新建项目开始，或直接使用原菜单。")
        layout.addWidget(self.summary)
        self.mode_box = W.QComboBox()
        self.mode_box.addItem("方式一 · 直接人工标注", "manual")
        self.mode_box.addItem("方式二 · 预训练模型预标注", "pretrained")
        self.mode_box.addItem("方式三 · 训练后预标注", "trained")
        self.mode_box.currentIndexChanged.connect(lambda: self.set_mode(self.mode_box.currentData()))
        layout.addWidget(self.mode_box)
        self.tabs = W.QTabWidget()
        layout.addWidget(self.tabs)
        project_page, pose_page, review_page = W.QWidget(), W.QWidget(), W.QWidget()
        self.tabs.addTab(project_page, "项目")
        self.tabs.addTab(pose_page, "骨架")
        self.tabs.addTab(review_page, "审核")
        self.tabs.setTabVisible(1, False)
        project_layout = W.QVBoxLayout(project_page)
        project_layout.addWidget(button("新建项目", self.create_project, True))
        project_layout.addWidget(button("打开项目", self.open_project))
        project_layout.addWidget(label("三种方式：直接人工标注 / 预训练模型直接预标注 / 少量标注训练后再预标注。"))
        project_layout.addWidget(label("标注工具 · 始终使用原版画布"))
        for text, mode in (("目标检测 · 画矩形框", "rectangle"), ("实例分割 · 画多边形", "polygon"), ("旋转框 · 定向目标", "rotation")):
            project_layout.addWidget(button(text, lambda mode=mode: self.draw(mode)))
        project_layout.addWidget(button("图像分类 · 选择类别", self.classify))
        project_layout.addWidget(button("姿态估计 · 开始一个实例", self.start_pose))
        project_layout.addWidget(label("训练支持检测、分割、姿态、旋转框和分类。模型与参数在原训练窗口中设置。"))
        project_layout.addWidget(button("用已审核数据训练", self.train, True))
        project_layout.addWidget(button("打开原版训练窗口", lambda: self.view.start_training("ultralytics")))
        project_layout.addWidget(button("打开项目文件夹", self.open_folder))
        project_layout.addStretch()
        pose_layout = W.QVBoxLayout(pose_page)
        pose_layout.addWidget(button("编辑自定义骨架模板", self.edit_template))
        self.class_box = W.QComboBox()
        pose_layout.addWidget(self.class_box)
        self.points = W.QListWidget()
        pose_layout.addWidget(self.points)
        self.points.itemDoubleClicked.connect(self.select_point)
        pose_layout.addWidget(label("画框后按提示连续点选。双击列表可重标骨点；拖动微调请先结束点选。"))
        pose_layout.addWidget(button("开始新实例（先画框）", self.start_pose, True))
        self.occluded = W.QCheckBox("当前骨点被遮挡，但位置可判断")
        pose_layout.addWidget(self.occluded)
        pose_layout.addWidget(button("位置未知 · 跳过此点", self.skip_point))
        pose_layout.addWidget(button("结束点选 · 拖动微调", self.cancel_pose))
        review_layout = W.QVBoxLayout(review_page)
        review_layout.addWidget(label("先选择本项目训练的 PT 权重。AI 候选单独保存，正式标注不被批量覆盖。"))
        self.weights = W.QLineEdit()
        self.weights.setPlaceholderText("本项目 runs 下的 best.pt")
        review_layout.addWidget(self.weights)
        review_layout.addWidget(button("选择训练权重", self.choose_weights))
        review_layout.addWidget(button("选择预训练模型 · 直接预标注", self.choose_pretrained))
        self.aliases = W.QLineEdit()
        self.aliases.setPlaceholderText("可选类别映射：person=人; dog=狗")
        self.aliases.setToolTip("模型类别名=项目类别名；多个映射用分号分隔。与项目同名的类别自动匹配，其余忽略。")
        review_layout.addWidget(self.aliases)
        self.device = W.QComboBox()
        self.device.addItems(["cpu", "0"])
        self.device.setToolTip("cpu：处理器；0：第一张 NVIDIA GPU，须通过训练环境自检")
        review_layout.addWidget(self.device)
        self.confidence = W.QDoubleSpinBox()
        self.confidence.setRange(.01, .99)
        self.confidence.setValue(.25)
        self.confidence.setSingleStep(.05)
        review_layout.addWidget(label("预标注置信度（仍需人工检查漏检）"))
        review_layout.addWidget(self.confidence)
        review_layout.addWidget(button("批量生成 AI 候选", self.predict, True))
        review_layout.addWidget(button("停止批量预标注", self.stop_predict))
        self.candidate = label("当前图片尚无候选")
        review_layout.addWidget(self.candidate)
        review_layout.addWidget(button("接受当前候选并微调", self.accept_candidate))
        review_layout.addWidget(button("审核通过并下一张", self.approve, True))
        review_layout.addWidget(button("跳到下一张待审核", self.next_unchecked))
        self.log = W.QPlainTextEdit()
        self.log.setReadOnly(True)
        self.log.setMaximumBlockCount(300)
        self.log.setMaximumHeight(140)
        review_layout.addWidget(self.log)
        self.hint = label("先建立项目；目标检测与分割也可随时使用原工具栏。")
        layout.addWidget(self.hint)
        self.dock.setWidget(body)
        # Scroll rather than clip controls on small laptop screens.
        scroll = W.QScrollArea()
        scroll.setWidgetResizable(True)
        scroll.setFrameShape(W.QFrame.Shape.NoFrame)
        scroll.setWidget(body)
        self.dock.setWidget(scroll)
        self.window.addDockWidget(Qt.DockWidgetArea.RightDockWidgetArea, self.dock)
        self.window.resizeDocks([self.dock], [330], Qt.Orientation.Horizontal)
        menu = self.window.menuBar().addMenu("一体化工作台")
        menu.addAction(self.dock.toggleViewAction())
        menu.addAction("新建项目", self.create_project)
        menu.addAction("打开项目", self.open_project)
        menu.addAction("训练已审核数据", self.train)
        theme = menu.addAction("工作台美化主题")
        theme.setCheckable(True)
        theme.setChecked(True)
        theme.toggled.connect(lambda enabled: apply_theme(self.window, enabled))
        menu.addAction("关于完整原版功能", lambda: W.QMessageBox.information(self.window, "原功能完整保留", "原文件、编辑、工具、导入、导出、模型和训练菜单均保留。\n新增工作台可通过本菜单隐藏；原快捷键不做替换。"))
        self.window.setWindowTitle("X-AnyLabeling · 标注训练工作台")
        header = W.QWidget()
        header.setObjectName("WorkflowHeader")
        header_layout = W.QHBoxLayout(header)
        header_layout.setContentsMargins(12, 8, 12, 8)
        header_layout.addWidget(label("标注与训练工作台", True))
        header_layout.addStretch()
        header_layout.addWidget(button("新建项目", self.create_project, True))
        header_layout.addWidget(button("直接人工标注", self.start_manual))
        header_layout.addWidget(button("预训练模型预标注", self.choose_pretrained))
        header_layout.addWidget(button("训练与迭代", self.train))
        self.window.centralWidget().layout().insertWidget(0, header)
        self.header = header
        self.view.label_instruction.setWordWrap(True)
        self.view.label_instruction.setMinimumWidth(0)
        self.view.label_instruction.setSizePolicy(W.QSizePolicy.Policy.Ignored, W.QSizePolicy.Policy.Preferred)

    def set_mode(self, mode):
        if mode not in {"manual", "pretrained", "trained"}:
            raise ValueError("未知标注方式。")
        self.cancel_pose()
        with QtCore.QSignalBlocker(self.mode_box):
            self.mode_box.setCurrentIndex(self.mode_box.findData(mode))
        if self.project:
            self.project.data["annotation_mode"] = mode
            self.project.save()
        self.tabs.setCurrentIndex(0 if mode == "manual" else 2)
        messages = {"manual":"直接人工标注：无需模型；使用原工具画框、分割或标骨点。", "pretrained":"预训练模型预标注：选择权重与类别映射，生成全部图片的候选，再人工审核。", "trained":"训练后预标注：先审核少量图片，用它们训练，再选生成的权重预标注并审核。"}
        self.hint.setText(messages[mode] + " 切换方式不会清空标注。")

    def error(self, error):
        W.QMessageBox.warning(self.window, "操作未完成", str(error))

    def require_project(self):
        if not self.project:
            self.error("请先新建或打开项目。原软件功能仍可直接从原菜单使用。")
            return False
        return True

    def create_project(self):
        if not self.view.may_continue():
            return
        dialog = CreateProjectDialog(self.window)
        if dialog.exec():
            self.load_project(dialog.project.root)

    def start_manual(self):
        if not self.project:
            self.create_project()
        self.tabs.setCurrentIndex(0)
        self.dock.show()
        self.hint.setText("直接使用框、多边形、旋转框或姿态工具。无需模型，完成后再决定是否训练。")

    def open_project(self):
        path, _ = W.QFileDialog.getOpenFileName(self.window, "打开项目的 project.json", "", "项目 (project.json)")
        if path:
            try:
                self.load_project(Path(path).parent)
            except Exception as error:
                self.error(error)

    def load_project(self, root, load_image=True):
        if not self.view.may_continue():
            return
        project = Project(root)
        self.cancel_pose()
        self.project = project
        self.prediction_status = "idle"
        self.log.clear()
        self.tabs.setTabVisible(1, project.data["task"] == "pose")
        self.view.output_dir = str(project.root / "annotations")
        self.view._config["labels"] = project.data["classes"]
        self.view.load_labels(project.data["classes"])
        self.class_box.clear()
        self.class_box.addItems(project.data["classes"])
        self.view.import_image_folder(str(project.root / "images"), load=load_image)
        self.title.setText(project.data["name"])
        self.last_image = None
        self.last_count = None
        write_json(self.recent, {"root": str(project.root)})
        self.refresh()
        self.set_mode(project.data.get("annotation_mode", "manual"))

    def open_folder(self):
        if self.require_project():
            QtGui.QDesktopServices.openUrl(QtCore.QUrl.fromLocalFile(str(self.project.root)))

    def draw(self, mode):
        if self.view.image_path:
            self.cancel_pose()
            self.view.toggle_draw_mode(False, create_mode=mode)
        else:
            self.error("请先导入或打开一张图片。")

    def classify(self):
        if not self.require_project() or not self.view.image_path:
            return
        name, ok = W.QInputDialog.getItem(self.window, "图像分类", "选择整张图片的类别", self.project.data["classes"], 0, False)
        if ok:
            self.view.load_flags({c: c == name for c in self.project.data["classes"]})
            self.view.set_dirty()

    def edit_template(self):
        if not self.require_project():
            return
        if self.project.data["task"] != "pose":
            self.error("请新建姿态项目以定义骨点；当前项目继续使用其原有任务。")
            return
        if any((self.project.root / "annotations").glob("*.json")):
            self.error("此模板已有标注。为保护骨点语义，当前版本请新建姿态项目使用新模板。")
            return
        dialog = TemplateDialog(self.project.data["template"], self.window)
        if dialog.exec():
            self.project.data["template"] = dialog.result_template
            self.project.save()
            self.refresh()

    def start_pose(self):
        if not self.require_project() or not self.view.image_path:
            return
        if self.project.data["task"] != "pose":
            self.error("当前项目不是姿态任务，请新建姿态项目。原点标注仍可直接使用。")
            return
        self.pose_state = "box"
        self.pose_image = self.view.image_path
        self.view.toggle_draw_mode(False, create_mode="rectangle")
        self.tabs.setCurrentIndex(1)
        self.hint.setText("先画出一个完整目标框，随后按顺序点击骨点。")

    def on_new_shape(self):
        if self.pose_state != "box" or self.pose_image != self.view.image_path or self.view.canvas.shapes[-1].shape_type != "rectangle":
            return False
        shape = self.view.canvas.shapes[-1]
        self.group_id = max([s.group_id for s in self.view.canvas.shapes if isinstance(s.group_id, int)] + [-1]) + 1
        shape.label = self.class_box.currentText()
        shape.group_id = self.group_id
        self.view.add_label(shape)
        self.view.set_dirty()
        self.view.canvas.store_shapes()
        self.point_index = 0
        self.pose_state = "points"
        QtCore.QTimer.singleShot(0, lambda: self.view.toggle_draw_mode(True))
        self.update_point_hint()
        return True

    def cancel_pose(self, *_):
        if self.pose_state:
            self.pose_state = None
            self.hint.setText("点选已结束。可使用原画布拖动、撤销和保存。")
            self.view.toggle_draw_mode(True)

    def update_point_hint(self):
        names = self.project.data["template"]["points"]
        if self.point_index >= len(names):
            self.cancel_pose()
            self.hint.setText("骨点已标完。检查位置、调整目标框后，在审核页确认整张图。")
            return
        self.points.setCurrentRow(self.point_index)
        displays = self.project.data["template"].get("display", names)
        self.hint.setText(f"当前骨点：{displays[self.point_index]}（{self.point_index + 1}/{len(names)}）。直接点击图片，或跳过未知点。")

    def skip_point(self):
        if self.pose_state == "points":
            self.point_index += 1
            self.update_point_hint()

    def select_point(self, item):
        if not self.project or self.project.data["task"] != "pose" or not self.view.image_path:
            return
        selected = self.view.canvas.selected_shapes
        if selected and selected[0].group_id is not None:
            self.group_id = selected[0].group_id
        if self.group_id is None or not any(s.group_id == self.group_id and s.shape_type == "rectangle" for s in self.view.canvas.shapes):
            self.error("请先选中目标框，再双击要重标的骨点。")
            return
        self.pose_state = "points"
        self.pose_image = self.view.image_path
        self.point_index = self.points.row(item)
        self.update_point_hint()

    def eventFilter(self, obj, event):
        if obj is self.view.canvas and self.pose_state == "points":
            if self.pose_image != self.view.image_path:
                self.cancel_pose()
                return False
            if event.type() == QtCore.QEvent.Type.MouseButtonPress and event.button() == Qt.MouseButton.LeftButton:
                from anylabeling.views.labeling.shape import Shape
                position = obj.transform_pos(event.position())
                if not (0 <= position.x() < obj.pixmap.width() and 0 <= position.y() < obj.pixmap.height()):
                    return True
                name = self.project.data["template"]["points"][self.point_index]
                existing = next((s for s in obj.shapes if s.group_id == self.group_id and s.label == name and s.shape_type == "point"), None)
                if existing:
                    existing.points = [position]
                    existing.difficult = self.occluded.isChecked()
                    obj.store_shapes()
                else:
                    shape = Shape(label=name, shape_type="point", group_id=self.group_id, difficult=self.occluded.isChecked())
                    shape.add_point(position)
                    self.view.load_shapes([shape], replace=False)
                self.view.set_dirty()
                obj.update()
                self.point_index += 1
                self.update_point_hint()
                return True
            if event.type() in (QtCore.QEvent.Type.MouseButtonRelease, QtCore.QEvent.Type.MouseButtonDblClick):
                return True
        return super().eventFilter(obj, event)

    def paint_overlay(self, painter):
        if not self.project or not self.view.image_path:
            return
        painter.save()
        scale = max(self.view.canvas.scale, .01)
        if self.project.data["task"] == "pose":
            template = self.project.data["template"]
            instances = {}
            for shape in self.view.canvas.shapes:
                if shape.shape_type == "point" and shape.visible and shape.points:
                    instances.setdefault(shape.group_id, {})[shape.label] = shape.points[0]
            pen = QtGui.QPen(QtGui.QColor("#48B7E8"), 2 / scale)
            painter.setPen(pen)
            for points in instances.values():
                for a, b in template.get("edges", []):
                    left, right = template["points"][a], template["points"][b]
                    if left in points and right in points:
                        painter.drawLine(points[left], points[right])
        if self.proposal:
            if Path(self.proposal["annotation"]["imagePath"]).name != Path(self.view.image_path).name:
                painter.restore()
                return
            painter.setPen(QtGui.QPen(QtGui.QColor("#FFAE42"), 2 / scale, Qt.PenStyle.DashLine))
            for shape in self.proposal["annotation"]["shapes"]:
                points = [QtCore.QPointF(*p) for p in shape["points"]]
                if shape["shape_type"] == "point":
                    for point in points:
                        painter.drawEllipse(point, 4 / scale, 4 / scale)
                elif len(points) >= 2:
                    painter.drawPolygon(QtGui.QPolygonF(points))
        painter.restore()

    def refresh(self):
        if not self.project:
            return
        image = self.view.image_path
        if image and Path(image).parent.resolve() != (self.project.root / "images").resolve():
            self.cancel_pose()
            self.summary.setText("当前打开了项目外图片。原工具可用；回到项目后才能使用项目训练/审核。")
            return
        if image != self.last_image:
            self.pose_state = None
            self.group_id = None
            self.last_image = image
        try:
            self.refresh_counter += 1
            if self.last_count is None or self.refresh_counter % 10 == 0:
                self.last_count = self.project.counts()
            counts = self.last_count
            self.summary.setText(f"{TASKS[self.project.data['task']]}  /  {counts['total']} 张图片\n已审核 {counts['checked']}  ·  草稿 {counts['draft']}  ·  未标注 {counts['total'] - counts['checked'] - counts['draft']}")
            template = self.project.data.get("template") or {}
            names = template.get("display", template.get("points", []))
            if [self.points.item(i).text() for i in range(self.points.count())] != names:
                self.points.clear()
                self.points.addItems(names)
            candidate = self.project.root / "proposals" / "latest" / (Path(image).stem + ".json") if image else None
            self.proposal = read_json(candidate) if candidate and candidate.exists() else None
            self.candidate.setText(f"当前候选：{len(self.proposal['annotation']['shapes'])} 个图形（橙色虚线），待人工确认" if self.proposal else "当前图片尚无候选")
            self.view.canvas.update()
        except (OSError, ValueError, KeyError) as error:
            self.hint.setText(str(error))

    def train(self):
        if not self.require_project():
            return
        if self.process and self.process.state() != QtCore.QProcess.ProcessState.NotRunning:
            self.error("批量预标注正在运行，请先停止或等待完成。")
            return
        if not self.view.may_continue():
            return
        if self.view.training_dialog and self.view.training_dialog.training_manager.is_training:
            self.view.start_training("ultralytics")
            return
        try:
            dataset = self.project.build_dataset()
            self.view.start_training("ultralytics")
            dialog = self.view.training_dialog
            if dialog is None:
                return
            dialog.ensure_config_tab_initialized()
            task = {"detect": "Detect", "segment": "Segment", "pose": "Pose", "obb": "OBB", "classify": "Classify"}[self.project.data["task"]]
            if dialog.selected_task_type != task:
                dialog.on_task_type_selected(task)
            widgets = dialog.config_widgets
            values = {"data": str(dataset), "project": str(self.project.root / "runs"), "name": "train_" + QtCore.QDateTime.currentDateTime().toString("yyyyMMdd_HHmmss"), "env": sys.executable}
            suffix = {"detect": "", "segment": "-seg", "pose": "-pose", "obb": "-obb", "classify": "-cls"}[self.project.data["task"]]
            initial = "yolov8n" + suffix + ".pt"
            cached = Path(os.environ.get("XAL_WORKBENCH_HOME", Path.home())) / "pretrained" / initial
            if not cached.is_file():
                cached = Path(os.environ.get("XAL_PRETRAINED_HOME", str(cached.parent))) / initial
            values["model"] = str(cached) if cached.is_file() else initial
            if self.project.data["task"] == "pose":
                values["pose_config"] = str(self.project.root / "templates" / "pose.yaml")
                if not self.project.data["template"].get("pairs"):
                    for key in ("fliplr", "flipud"):
                        if key in widgets:
                            widgets[key].setValue(0.)
            for key, value in values.items():
                if key in widgets:
                    widgets[key].setText(value)
            if not hasattr(dialog, "workflow_model_choices"):
                dialog.workflow_model_choices = W.QComboBox()
                widgets["model"].parentWidget().layout().addRow("预训练模型快捷选择：", dialog.workflow_model_choices)
                def select_initial(index):
                    name = dialog.workflow_model_choices.itemText(index)
                    cache = Path(os.environ.get("XAL_WORKBENCH_HOME", Path.home())) / "pretrained" / name
                    if not cache.is_file():
                        cache = Path(os.environ.get("XAL_PRETRAINED_HOME", str(cache.parent))) / name
                    widgets["model"].setText(str(cache) if cache.is_file() else name)
                dialog.workflow_model_choices.activated.connect(select_initial)
            dialog.workflow_model_choices.clear()
            dialog.workflow_model_choices.addItems([family + suffix + ".pt" for family in ("yolov8n", "yolov8s", "yolo11n", "yolo11s", "yolo26n")])
            if "workers" in widgets:
                widgets["workers"].setValue(0)
            if "batch" in widgets:
                widgets["batch"].setValue(4)
            if "only_checked_files" in widgets:
                widgets["only_checked_files"].setChecked(True)
            dialog.names = self.project.data["classes"]
            dialog.go_to_specific_tab(1)
            dialog.setWindowTitle("训练中心 · 检测 / 分割 / 姿态 / 旋转框 / 分类")
            self.localize_training(dialog)
            self.hint.setText("已生成独立的已审核数据快照。请检查模型、设备和参数后开始训练。")
        except Exception as error:
            self.error(error)

    def choose_weights(self):
        if not self.require_project():
            return
        path, _ = W.QFileDialog.getOpenFileName(self.window, "选择本项目的训练权重", str(self.project.root / "runs"), "训练权重 (*.pt)")
        if path:
            self.weights.setText(path)
            # Register only a checkpoint proven to originate from a matching snapshot.
            run_dir = Path(path).parent.parent
            args_file = run_dir / "args.yaml"
            if self.project.data["task"] == "pose" and args_file.exists():
                import yaml
                args = yaml.safe_load(args_file.read_text(encoding="utf-8"))
                dataset = Path(args.get("data", ""))
                manifest = dataset.parent / "manifest.json"
                if not manifest.exists():
                    manifest = self.project.root / "datasets" / dataset.parent.name / "manifest.json"
                if manifest.exists():
                    metadata = read_json(manifest)["project"]
                    if metadata.get("template") == self.project.data["template"] and metadata["classes"] == self.project.data["classes"]:
                        write_json(Path(path).with_suffix(".workflow.json"), {"template_hash": template_hash(metadata["template"]), "classes": metadata["classes"]})

    def choose_pretrained(self):
        if not self.project:
            self.create_project()
            if not self.project:
                return
        suffix = {"detect": "", "segment": "-seg", "pose": "-pose", "obb": "-obb", "classify": "-cls"}[self.project.data["task"]]
        choices = [name + suffix + ".pt" for name in ("yolov8n", "yolov8s", "yolo11n", "yolo11s", "yolo26n")]
        selected, ok = W.QInputDialog.getItem(self.window, "选择预训练模型", "首次使用需要下载权重；也可选择本地 PT 文件。\n自定义/狗骨架须使用匹配骨点的训练权重。", choices, 0, False)
        if ok:
            target = self.project.root / "models" / selected
            cached = Path(os.environ.get("XAL_WORKBENCH_HOME", Path.home())) / "pretrained" / selected
            if not cached.is_file():
                cached = Path(os.environ.get("XAL_PRETRAINED_HOME", str(cached.parent))) / selected
            if cached.is_file() and not target.exists():
                shutil.copy2(cached, target)
            self.weights.setText(str(target))
            if self.project.data["task"] in {"detect", "segment", "pose"}:
                import yaml
                import importlib.util
                spec = importlib.util.find_spec("ultralytics")
                config = Path(spec.origin).parent / "cfg" / "datasets" / "coco.yaml"
                source_names = list(yaml.safe_load(config.read_text(encoding="utf-8"))["names"].values()) if self.project.data["task"] != "pose" else ["person"]
                missing = [name for name in self.project.data["classes"] if name not in source_names]
                mapping = []
                for name in missing:
                    source, accepted = W.QInputDialog.getItem(self.window, "预训练类别映射", f"项目类别“{name}”对应模型中的哪个类别？\n选择后只预标注对应目标；其他类别仍可人工标注。", ["暂不自动标注此类"] + source_names, 0, False)
                    if accepted and source != "暂不自动标注此类":
                        mapping.append(f"{source}={name}")
                self.aliases.setText("; ".join(mapping))
            self.tabs.setCurrentIndex(2)

    @staticmethod
    def localize_training(dialog):
        names = {"Project:":"输出目录：", "Name:":"训练名称：", "Env:":"运行环境：", "Model:":"初始权重（可选）：", "Data:":"数据快照：", "Pose Config:":"骨点定义：", "Device:":"训练设备：", "Dataset Ratio:":"工作区划分比例：", "Epochs:":"训练轮数：", "Batch:":"每批图片：", "Image Size:":"图片尺寸：", "Workers:":"加载进程：", "Classes:":"类别索引：", "Browse":"选择", "Single Class":"合并为单类别"}
        tips = {"epochs":"完整学习训练数据多少次。先短试跑，再正式训练。", "batch":"每次处理的图片数；显存不足时减小。", "imgsz":"输入图片边长。更大可能需要更多显存。", "model":"可选择预训练 PT 权重或以前训练的权重。需与任务类型匹配。", "lr0":"初始学习率。没有经验时保留默认设置。", "data":"来自人工审核的数据快照。已有数据快照不使用工作区划分滑块。"}
        for item in dialog.findChildren(W.QLabel):
            if item.text() in names:
                item.setText(names[item.text()])
        for item in dialog.findChildren(W.QAbstractButton):
            if item.text() in names:
                item.setText(names[item.text()])
        for key, tip in tips.items():
            if key in dialog.config_widgets:
                dialog.config_widgets[key].setToolTip(tip)

    def predict(self):
        if not self.require_project() or not self.weights.text().strip():
            self.error("请先选择训练权重。")
            return
        if not self.view.may_continue():
            return
        if self.process and self.process.state() != QtCore.QProcess.ProcessState.NotRunning:
            return
        if self.view.training_dialog and self.view.training_dialog.training_manager.is_training:
            self.error("训练正在运行，请等待结束后再批量预标注。")
            return
        self.process = QtCore.QProcess(self)
        self.process.setWorkingDirectory(str(self.project.root / "models"))
        self.process.setProcessChannelMode(QtCore.QProcess.ProcessChannelMode.MergedChannels)
        env = QtCore.QProcessEnvironment.systemEnvironment()
        env.insert("PYTHONIOENCODING", "utf-8")
        self.process.setProcessEnvironment(env)
        self.process.readyReadStandardOutput.connect(self.read_process)
        self.process.finished.connect(self.prediction_finished)
        self.process.errorOccurred.connect(self.prediction_error)
        self.log.clear()
        self.prediction_status = "running"
        self.process.start(sys.executable, ["-u", "-m", "anylabeling.services.workflow.predict", str(self.project.root), self.weights.text().strip(), self.device.currentText(), str(self.confidence.value()), self.aliases.text()])

    def prediction_finished(self, code, _status):
        if self.prediction_status != "stopped":
            self.prediction_status = "completed" if code == 0 else "failed"
        self.log.appendPlainText("任务完成，候选待审核。" if code == 0 else "任务停止或失败，请查看上方原因。")
        self.refresh()

    def prediction_error(self, _error):
        if self.prediction_status != "stopped":self.prediction_status = "failed"
        self.log.appendPlainText("进程无法运行：" + self.process.errorString())

    def read_process(self):
        self.log.appendPlainText(bytes(self.process.readAllStandardOutput()).decode("utf-8", errors="replace").rstrip())

    def stop_predict(self):
        if self.process and self.process.state() != QtCore.QProcess.ProcessState.NotRunning:
            self.prediction_status = "stopped"
            self.process.kill()
            self.process.waitForFinished(3000)

    def accept_candidate(self):
        self.refresh()
        if not self.require_project() or not self.proposal or not self.view.image_path:
            self.error("当前图片没有可接受的 AI 候选。")
            return
        if not self.view.may_continue():
            return
        answer = W.QMessageBox.question(self.window, "接受 AI 候选", "将候选作为当前图片的编辑草稿。已有标注会先备份；请继续检查漏检并人工审核。是否继续？")
        if answer != W.QMessageBox.StandardButton.Yes:
            return
        try:
            self.project.accept_proposal(self.view.image_path, self.proposal)
            self.last_count = None
            path = self.project.root / "proposals" / "latest" / (Path(self.view.image_path).stem + ".json")
            path.rename(path.with_suffix(".accepted.json"))
            image = self.view.image_path
            self.view.load_file(image)
            self.refresh()
        except Exception as error:
            self.error(error)

    def approve(self):
        if not self.require_project() or not self.view.image_path:
            return
        try:
            if not self.manages_current_image():
                raise ValueError("当前图片不属于此项目。")
            shapes = [s.to_dict() for s in self.view.canvas.shapes]
            data = {"shapes": shapes, "imageWidth": self.view.image.width(), "imageHeight": self.view.image.height()}
            if self.project.data["task"] != "classify":
                self.project.validate_annotation(data)
            else:
                enabled = [self.view.flag_widget.item(i) for i in range(self.view.flag_widget.count()) if self.view.flag_widget.item(i).checkState() == Qt.CheckState.Checked]
                if len(enabled) != 1 or enabled[0].text() not in self.project.data["classes"]:
                    raise ValueError("分类任务请先选择一个有效类别。")
            if not shapes and self.project.data["task"] != "classify":
                if W.QMessageBox.question(self.window, "确认无目标", "当前图片没有标注。确认图片中确实没有目标，作为负样本？") != W.QMessageBox.StandardButton.Yes:
                    return
            self.cancel_pose()
            self.view.set_annotation_checked(True)
            self.last_count = None
            if self.view.other_data.get("checked") is True and not self.view.dirty:
                self.next_unchecked()
            self.refresh()
        except Exception as error:
            self.error(error)

    def next_unchecked(self):
        self.view.open_next_unchecked_image()

    def manages_current_image(self):
        return bool(self.project and self.view.image_path and Path(self.view.image_path).parent.resolve() == (self.project.root / "images").resolve())
