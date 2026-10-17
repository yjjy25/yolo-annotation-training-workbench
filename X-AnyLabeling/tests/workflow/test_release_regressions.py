"""Release regressions involving data integrity and portable validation."""
from types import SimpleNamespace

import pytest

from anylabeling.services.workflow.project import digest, read_json, write_json
from anylabeling.services.workflow.validate import collect_predictions
from .test_project import make_project


@pytest.mark.parametrize("kind", ["polygon", "rotation", "circle"])
def test_detect_shapes_export_one_real_box_without_changing_original(tmp_path, kind):
    project = make_project(tmp_path)
    label = project.annotation(project.images[0])
    data = read_json(label)
    data["shapes"][0]["shape_type"] = kind
    if kind == "circle":
        data["shapes"][0]["points"] = [[25,25],[20,15],[25,40]]
    write_json(label, data)
    original = digest(label)
    cfg = project.build_dataset()
    values = (next(cfg.parent.glob("labels/*/0.txt"))).read_text().split()
    assert len(values) == 5
    assert all(0 <= float(v) <= 1 for v in values[1:])
    assert digest(label) == original


def test_segment_circle_is_not_silently_dropped(tmp_path):
    project = make_project(tmp_path, "segment")
    label = project.annotation(project.images[0])
    data = read_json(label)
    data["shapes"][0].update(shape_type="circle", points=[[25,25],[20,15],[25,40]])
    write_json(label, data)
    cfg = project.build_dataset()
    values = next(cfg.parent.glob("labels/*/0.txt")).read_text().split()
    assert len(values) == 65


def test_remove_cleans_real_hash_but_keeps_surviving_duplicate_assignment(tmp_path):
    project = make_project(tmp_path)
    project.build_dataset()
    image = project.images[0]
    content_hash = digest(image)
    duplicate = image.with_name("duplicate.png")
    duplicate.write_bytes(image.read_bytes())
    project.remove_image(image)
    assert content_hash in read_json(project.root / "splits.json")["assignments"]
    project.remove_image(duplicate)
    assert content_hash not in read_json(project.root / "splits.json")["assignments"]


def test_preview_matches_frozen_split_after_new_reviews(tmp_path):
    project = make_project(tmp_path)
    project.build_dataset()
    label = project.annotation(project.images[-1])
    data = read_json(label)
    data["checked"] = True
    write_json(label, data)
    frozen = read_json(project.root / "splits.json")["assignments"]
    # Deliberately retain a non-default split to distinguish it from reshuffling.
    hashes = list(frozen)
    frozen.update({h: "val" if i < 2 else "train" for i, h in enumerate(hashes)})
    settings = project.split_settings()
    write_json(project.root / "splits.json", {"settings": settings, "assignments": frozen})
    preview = project.split_preview(settings)
    cfg = project.build_dataset(settings)
    manifest = read_json(cfg.parent / "manifest.json")
    assert preview["val"] == sum(row["split"] == "val" for row in manifest["images"])


def test_prediction_summary_supports_rotated_boxes_and_classification():
    box = SimpleNamespace(cls=SimpleNamespace(item=lambda: 0))
    obb = SimpleNamespace(path="rotated.png", names={0:"dog"}, boxes=None, obb=[box], probs=None)
    cls = SimpleNamespace(path="class.png", names={0:"cat"}, boxes=None, probs=SimpleNamespace(top1=0))
    result = collect_predictions(iter([obb, cls]), [])
    assert result["images"] == 2
    assert result["by_class"] == {"dog": 1, "cat": 1}


def test_validation_relocates_snapshot_config(tmp_path, monkeypatch):
    import sys
    import yaml
    from anylabeling.services.workflow import validate
    project = make_project(tmp_path)
    cfg = project.build_dataset()
    data = yaml.safe_load(cfg.read_text(encoding="utf-8"))
    data["path"] = "Z:/old-machine/missing-snapshot"
    cfg.write_text(yaml.safe_dump(data), encoding="utf-8")
    weights = project.root / "models" / "test.pt"
    weights.touch()
    class Model:
        task = "detect"
        def __init__(self, *_): pass
        def val(self, **args):
            config = yaml.safe_load(open(args["data"], encoding="utf-8"))
            assert config["path"] == cfg.parent.as_posix()
            return SimpleNamespace(speed={})
    monkeypatch.setitem(sys.modules, "ultralytics", SimpleNamespace(YOLO=Model))
    validate.run(project.root, weights, plots=False)
    assert yaml.safe_load(cfg.read_text(encoding="utf-8"))["path"] == "Z:/old-machine/missing-snapshot"
