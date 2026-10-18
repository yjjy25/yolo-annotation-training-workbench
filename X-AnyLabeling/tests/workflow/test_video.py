import math
from pathlib import Path

import cv2
import numpy as np
import pytest

from anylabeling.services.workflow import desktop
from anylabeling.services.workflow.project import Project, digest, read_json
from anylabeling.services.workflow.video import import_video, options, sequences


def video_fixture(path):
    writer = cv2.VideoWriter(str(path), cv2.VideoWriter_fourcc(*"MJPG"), 10, (96, 64))
    assert writer.isOpened()
    for i in range(30):
        image = np.full((64, 96, 3), i * 7, dtype=np.uint8)
        cv2.putText(image, str(i), (20, 40), cv2.FONT_HERSHEY_SIMPLEX, 1, (255, 0, 0), 2)
        writer.write(image)
    writer.release()


@pytest.fixture
def source(tmp_path):
    path = tmp_path / "中文视频.avi"
    video_fixture(path)
    return path


def test_video_range_provenance_and_preserved_source(tmp_path, source):
    project = Project.create(tmp_path / "project", "video", "detect", ["object"])
    before = digest(source)
    updates = []
    result = import_video(project, {"path": str(source), "start": .5, "end": 2, "step": .5}, updates.append)
    assert result["count"] == 3
    record = sequences(project)[0]
    assert [f["frame"] for f in record["frames"]] == [5, 10, 15]
    assert [f["seconds"] for f in record["frames"]] == [.5, 1, 1.5]
    assert record["source"] == str(source)
    assert len(project.images) == 3
    assert not list((project.root / "annotations").glob("*.json"))
    assert digest(source) == before
    again = import_video(project, {"path": str(source), "limit": 1, "step": 0}, updates.append)
    assert again["limited"] is True
    assert len(project.images) == 4
    assert again["first"] != result["first"]


def test_every_frame_limit_and_cancel(tmp_path, source):
    project = Project.create(tmp_path / "project", "video", "pose", ["object"], template={"points": ["p"]})
    updates = []
    result = import_video(project, {"path": str(source), "step": 0, "limit": 4}, updates.append)
    assert [f["frame"] for f in sequences(project)[0]["frames"]] == [0, 1, 2, 3]
    before = {p.name: digest(p) for p in project.images}
    calls = 0
    def cancelled():
        nonlocal calls
        calls += 1
        return calls > 5
    assert import_video(project, {"path": str(source), "step": 0}, updates.append, cancelled) is None
    assert updates[-1]["status"] == "stopped"
    assert {p.name: digest(p) for p in project.images} == before
    assert len(sequences(project)) == 1


@pytest.mark.parametrize("args", [{"step": -1}, {"start": math.nan}, {"end": math.inf}, {"limit": 0}, {"limit": 5001}, {"limit": 1.5}, {"start": 2, "end": 1}])
def test_invalid_options(args):
    with pytest.raises(ValueError):
        options(args)


def test_invalid_video_and_empty_range_do_not_add_data(tmp_path, source):
    project = Project.create(tmp_path / "project", "video", "detect", ["object"])
    for args in ({"path": str(source), "start": 100}, {"path": str(tmp_path / "absent.mp4")}):
        with pytest.raises(ValueError):
            import_video(project, args, lambda _: None)
    assert project.images == []


def test_create_project_from_video_without_image_folder(tmp_path, source):
    project = desktop.create_project({"root": str(tmp_path / "project"), "name": "video", "task": "pose", "classes": ["person"], "preset": "human", "source_kind": "video", "source": str(source)})
    assert project.images == []
    assert len(project.data["template"]["points"]) == 17
