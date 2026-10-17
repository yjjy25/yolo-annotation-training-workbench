import os
from unittest import mock

os.environ.setdefault("QT_QPA_PLATFORM", "offscreen")

import pytest
from PyQt6 import QtWidgets
from PyQt6.QtCore import Qt

from anylabeling.views.labeling.utils.upload import (
    _refresh_uploaded_file_items,
    upload_yolo_annotation,
)


@pytest.mark.parametrize("use_output_dir", [False, True])
def test_refresh_uploaded_file_items_syncs_all_states(
    tmp_path, use_output_dir
):
    app = QtWidgets.QApplication.instance() or QtWidgets.QApplication([])
    labeled_image = tmp_path / "labeled.jpg"
    unlabeled_image = tmp_path / "unlabeled.jpg"
    labeled_image.touch()
    unlabeled_image.touch()
    output_dir = tmp_path / "output" if use_output_dir else None
    if output_dir:
        output_dir.mkdir()
        label_file = output_dir / "labeled.json"
    else:
        label_file = labeled_image.with_suffix(".json")
    label_file.write_text("{}", encoding="utf-8")

    file_list_widget = QtWidgets.QListWidget()
    labeled_item = QtWidgets.QListWidgetItem(str(labeled_image))
    labeled_item.setCheckState(Qt.CheckState.Unchecked)
    file_list_widget.addItem(labeled_item)
    unlabeled_item = QtWidgets.QListWidgetItem(str(unlabeled_image))
    unlabeled_item.setCheckState(Qt.CheckState.Checked)
    file_list_widget.addItem(unlabeled_item)

    widget = mock.Mock()
    widget.output_dir = str(output_dir) if output_dir else None
    widget.file_list_widget = file_list_widget
    widget._label_file_checked.return_value = False

    _refresh_uploaded_file_items(widget)

    assert labeled_item.checkState() == Qt.CheckState.Checked
    assert unlabeled_item.checkState() == Qt.CheckState.Unchecked
    assert widget._set_file_item_checked.call_count == 2
    file_list_widget.close()
    app.processEvents()


@pytest.mark.parametrize(
    ("mode", "converter_method"),
    [
        ("hbb", "yolo_to_custom"),
        ("obb", "yolo_obb_to_custom"),
        ("seg", "yolo_to_custom"),
        ("pose", "yolo_pose_to_custom"),
    ],
)
def test_yolo_upload_checks_recreated_label_item(
    tmp_path, mode, converter_method
):
    app = QtWidgets.QApplication.instance() or QtWidgets.QApplication([])
    image_dir = tmp_path / "images"
    label_dir = tmp_path / "labels"
    image_dir.mkdir()
    label_dir.mkdir()
    image_file = image_dir / "image.jpg"
    image_file.touch()
    (label_dir / "image.txt").write_text(
        "0 0.5 0.5 0.2 0.2\n", encoding="utf-8"
    )
    config_file = tmp_path / ("pose.yaml" if mode == "pose" else "classes.txt")
    config_file.write_text(
        "classes:\n  person:\n    - nose\n" if mode == "pose" else "person\n",
        encoding="utf-8",
    )

    widget = QtWidgets.QWidget()
    widget.filename = str(image_file)
    widget.output_dir = None
    widget.may_continue = mock.Mock(return_value=True)
    widget.load_file = mock.Mock()
    widget._label_file_checked = mock.Mock(return_value=False)
    widget._set_file_item_checked = mock.Mock()
    widget.unique_label_list = mock.Mock()
    widget.unique_label_list.find_items_by_label.return_value = [mock.Mock()]
    widget.file_list_widget = QtWidgets.QListWidget()
    item = QtWidgets.QListWidgetItem(str(image_file))
    item.setCheckState(Qt.CheckState.Unchecked)
    widget.file_list_widget.addItem(item)

    converter = mock.Mock()
    converter.pose_classes = {"person": ["nose"]}

    def create_label(**kwargs):
        with open(kwargs["output_file"], "w", encoding="utf-8") as f:
            f.write("{}")

    getattr(converter, converter_method).side_effect = create_label

    with (
        mock.patch.object(
            QtWidgets.QFileDialog,
            "getOpenFileName",
            return_value=(str(config_file), ""),
        ),
        mock.patch.object(QtWidgets.QDialog, "exec", return_value=1),
        mock.patch.object(
            QtWidgets.QLineEdit, "text", return_value=str(label_dir)
        ),
        mock.patch.object(
            QtWidgets.QCheckBox, "isChecked", return_value=False
        ),
        mock.patch.object(
            QtWidgets.QMessageBox,
            "exec",
            return_value=QtWidgets.QMessageBox.StandardButton.Ok,
        ),
        mock.patch(
            "anylabeling.views.labeling.utils.upload.LabelConverter",
            return_value=converter,
        ),
        mock.patch("anylabeling.views.labeling.utils.upload.Popup"),
    ):
        upload_yolo_annotation(widget, mode, 128)

    assert item.checkState() == Qt.CheckState.Checked
    assert (image_dir / "image.json").is_file()
    getattr(converter, converter_method).assert_called_once()
    widget.load_file.assert_called_once_with(str(image_file))
    widget.file_list_widget.close()
    widget.close()
    app.processEvents()
