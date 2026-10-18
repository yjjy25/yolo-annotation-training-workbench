import copy

import pytest

from anylabeling.services.workflow import desktop
from anylabeling.services.workflow.project import read_json
from .test_project import make_project


@pytest.mark.parametrize("task", ["detect", "segment", "obb", "pose", "classify"])
def test_object_occlusion_roundtrip_and_training_export(tmp_path, task):
    project = make_project(tmp_path, task)
    config = project.build_dataset()
    directory = config if task == "classify" else config.parent
    before = {p.relative_to(directory).as_posix(): p.read_bytes() for p in directory.rglob("*.txt")}
    image = project.images[0]
    label = desktop.load_annotation(project, image.name)
    data = copy.deepcopy(label["annotation"])
    if task == "classify":
        flags = data["flags"].copy()
        data["occluded"] = True
    else:
        original = copy.deepcopy(data["shapes"][0])
        data["shapes"][0].setdefault("flags", {})["occluded"] = True
    desktop.save_annotation(project, image.name, data, label["base_hash"], checked=True)
    saved = desktop.load_annotation(project, image.name)["annotation"]
    if task == "classify":
        assert saved["occluded"] is True
        assert saved["flags"] == flags
    else:
        assert saved["shapes"][0]["flags"]["occluded"] is True
        assert saved["shapes"][0]["points"] == original["points"]
        assert saved["shapes"][0]["difficult"] == original["difficult"]
    config = project.build_dataset()
    directory = config if task == "classify" else config.parent
    after = {p.relative_to(directory).as_posix(): p.read_bytes() for p in directory.rglob("*.txt")}
    assert before == after  # Object metadata is not an extra YOLO target.
    assert read_json(project.annotation(image)).get("checked") is True
