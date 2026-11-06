"""Frozen snapshots must stay byte-exact without storing N copies of every image."""
import shutil

import pytest
from PIL import Image

from anylabeling.services.workflow.project import Project, digest, read_json, write_json
from anylabeling.services.workflow import snapshot_store


def make_project(root, count=3):
    project = Project.create(root / "项目", "快照去重测试", "detect", ["object"])
    for index in range(count):
        image = project.root / "images" / f"{index}.png"
        Image.new("RGB", (64, 64), (30 * index, 40, 100)).save(image)
        write_json(project.annotation(image), {
            "version": "4.1.3", "imagePath": "../images/" + image.name, "imageData": None,
            "imageWidth": 64, "imageHeight": 64,
            "shapes": [{"label": "object", "points": [[5, 5], [45, 5], [45, 45], [5, 45]],
                        "shape_type": "rectangle", "group_id": 1, "flags": {}, "difficult": False}],
            "flags": {}, "checked": True})
    return project


def identity(path):
    stat = path.stat()
    return stat.st_dev, stat.st_ino


def test_new_snapshots_share_one_object_but_originals_stay_independent(tmp_path):
    project = make_project(tmp_path)
    first = project.build_dataset().parent
    second = project.build_dataset().parent
    assert first != second
    a, b = next(first.rglob("0.png")), next(second.rglob("0.png"))
    source = project.root / "images" / "0.png"
    assert digest(a) == digest(b) == digest(source)
    assert identity(a) == identity(b), "两份快照应共享同一份图片数据"
    assert identity(a) != identity(source), "images/ 必须保持独立，编辑图库不能污染快照"
    assert snapshot_store.object_path(project.root, digest(a), ".png").is_file()
    manifest = read_json(second / "manifest.json")
    assert any(item["image_sha256"] == digest(b) for item in manifest["images"])


def test_compact_merges_legacy_copies_without_losing_content(tmp_path):
    project = make_project(tmp_path)
    datasets = project.root / "datasets"
    source = project.root / "images" / "0.png"
    for stamp in ("20260101_000000_aaaaaa", "20260102_000000_bbbbbb"):
        for part in ("train", "val"):
            folder = datasets / stamp / "images" / part
            folder.mkdir(parents=True)
            shutil.copy2(source, folder / "0.png")
    stray = datasets / "20260101_000000_aaaaaa" / "images" / "train" / ".IMG_0.hidden.jpg"
    stray.write_bytes(b"stray" * 100)
    original_bytes = source.read_bytes()

    estimate = snapshot_store.compact_snapshots(project.root)
    assert estimate["images"] == 4 and estimate["unique"] == 1
    assert estimate["reclaimable_bytes"] > 0 and estimate["applied"] is False
    assert estimate["orphan_files"] == 1
    assert all(path.read_bytes() == original_bytes for path in datasets.rglob("0.png"))

    applied = snapshot_store.compact_snapshots(project.root, apply=True)
    assert applied["applied"] is True and applied["failed"] == []
    # One member is promoted into the object store (no copy), the rest are linked.
    assert applied["linked"] + applied["already_linked"] == 4
    images = list(datasets.rglob("0.png"))
    assert len(images) == 4
    assert all(identity(path) == identity(images[0]) for path in images)
    assert all(path.read_bytes() == original_bytes for path in images)
    assert stray.read_bytes() == b"stray" * 100, "隐藏残留文件不应被改动"

    again = snapshot_store.compact_snapshots(project.root, apply=True)
    assert again["linked"] == 0 and again["already_linked"] == 4
    assert again["reclaimable_bytes"] == 0


def test_publish_falls_back_to_copy_when_links_are_unavailable(tmp_path, monkeypatch):
    monkeypatch.setattr(snapshot_store, "_link", lambda source, destination: False)
    project = make_project(tmp_path)
    snapshot = project.build_dataset().parent
    frozen, source = next(snapshot.rglob("0.png")), project.root / "images" / "0.png"
    assert digest(frozen) == digest(source)
    assert identity(frozen) != identity(source)


def test_deleting_object_store_does_not_break_existing_snapshots(tmp_path):
    project = make_project(tmp_path)
    snapshot = project.build_dataset().parent
    frozen = next(snapshot.rglob("0.png"))
    before = frozen.read_bytes()
    shutil.rmtree(project.root / "datasets" / ".objects")
    assert frozen.read_bytes() == before
    assert digest(frozen) == digest(project.root / "images" / "0.png")


def test_compacting_a_single_snapshot_promotes_without_copying(tmp_path):
    project = make_project(tmp_path)
    datasets = project.root / "datasets"
    source = project.root / "images" / "0.png"
    legacy = datasets / "20260101_000000_aaaaaa" / "images" / "train"
    legacy.mkdir(parents=True)
    shutil.copy2(source, legacy / "0.png")
    frozen = legacy / "0.png"
    inode_before, size_before = identity(frozen), frozen.stat().st_size

    report = snapshot_store.compact_snapshots(project.root, apply=True)
    assert report["reclaimable_bytes"] == 0 and report["applied"] is True
    assert identity(frozen) == inode_before, "已有快照文件应被直接提升为共享对象，不应复制"
    objects = [path for path in (datasets / ".objects").rglob("*") if path.is_file()]
    assert len(objects) == 1 and identity(objects[0]) == inode_before
    assert frozen.stat().st_nlink >= 2
    assert frozen.stat().st_size == size_before and frozen.read_bytes() == source.read_bytes()


def test_failed_build_leaves_no_unreachable_objects(tmp_path):
    project = make_project(tmp_path)
    annotation = project.annotation("0.png")
    data = read_json(annotation)
    data["shapes"] = [{"shape_type": "rectangle", "label": "unknown",
                       "points": [[1, 1], [5, 1], [5, 5], [1, 5]]}]
    write_json(annotation, data)
    with pytest.raises(ValueError, match="未知标签"):
        project.build_dataset()
    objects = project.root / "datasets" / ".objects"
    assert not objects.is_dir() or not any(path.is_file() for path in objects.rglob("*"))
