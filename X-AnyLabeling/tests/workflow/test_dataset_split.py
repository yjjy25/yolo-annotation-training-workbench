"""Leakage protection, frozen-split migration, and snapshot provenance."""
import shutil

import numpy as np
from PIL import Image, PngImagePlugin
import pytest

from anylabeling.services.workflow import dataset_split
from anylabeling.services.workflow.project import Project, digest, read_json, write_json


def project_at(tmp_path):
    return Project.create(tmp_path / "project", "split", "detect", ["object"])


def add_image(project, name, pixels, tracking=None):
    image = project.root / "images" / name
    if isinstance(pixels, tuple):
        Image.new("RGB", (64, 64), pixels).save(image)
    else:
        Image.fromarray(pixels).save(image)
    write_json(project.annotation(image), {"version": "4.1.3", "imagePath": "../images/" + name,
               "imageData": None, "imageWidth": 64, "imageHeight": 64, "shapes": [],
               "flags": {}, "checked": True, "tracking": tracking or {}})
    return image


def textured():
    y, x = np.mgrid[0:64, 0:64]
    base = (30 + x * 2 + y).astype(np.uint8)
    return np.stack([base, base, base], axis=-1)


def video(project, identifier, names, source="/missing/source.mp4", accepted=None, **extra):
    data = {"id": identifier, "status": "completed", "source": str(source),
            "source_bytes": 123, "source_mtime_ns": 456,
            "frames": [{"name": name, "frame": i} for i, name in enumerate(names)],
            "accepted": accepted or {}, **extra}
    write_json(project.root / "videos" / identifier / "manifest.json", data)
    return data


def rows(project, options=None):
    folder = project.build_dataset(options).parent
    return folder, read_json(folder / "manifest.json")


def test_same_video_is_indivisible_and_preview_matches_snapshot(tmp_path):
    project = project_at(tmp_path)
    for i in range(7):
        add_image(project, f"{i}.png", (i * 30, 10, 60))
    video(project, "video-a", [f"{i}.png" for i in range(4)])
    video(project, "video-b", [f"{i}.png" for i in range(4, 7)], source="/missing/other.mp4")
    preview = project.split_preview({"count": 2, "mode": "count"})
    assert preview["groups"] == 2 and preview["video_groups"] == 2
    assert preview["target_val"] == 2 and preview["val"] == 3
    assert preview["warnings"]
    _, manifest = rows(project, {"count": 2, "mode": "count"})
    assert sum(row["split"] == "val" for row in manifest["images"]) == preview["val"]
    assert len({row["split"] for row in manifest["images"][:4]}) == 1
    assert len({row["split"] for row in manifest["images"][4:]}) == 1
    assert manifest["source_grouping"]["dataset_revision"] == preview["dataset_revision"]


def test_single_video_blocks_instead_of_splitting_frames(tmp_path):
    project = project_at(tmp_path)
    for i in range(3):
        add_image(project, f"{i}.png", (i * 50, 20, 40))
    video(project, "only", [p.name for p in project.images])
    preview = project.split_preview()
    assert not preview["ready"] and preview["groups"] == 1
    assert "独立来源" in preview["reason"]
    with pytest.raises(ValueError, match="独立来源"):
        project.build_dataset()
    assert not (project.root / "splits.json").exists()
    assert not list((project.root / "datasets").iterdir())


def test_reimported_same_source_and_accepted_copies_share_group(tmp_path):
    project = project_at(tmp_path)
    add_image(project, "reviewed-a.png", (0, 30, 40), {"sequence": "first", "confirmed_from": "frame-a.jpg"})
    add_image(project, "renamed-b.png", (70, 30, 40))
    add_image(project, "unrelated.png", (160, 30, 40))
    video(project, "first", ["frame-a.jpg"], accepted={"frame-a.jpg": {"name": "reviewed-a.png"}}, storage="video-work")
    video(project, "second", ["frame-b.jpg"], accepted={"frame-b.jpg": {"name": "renamed-b.png"}}, storage="video-work")
    plan = dataset_split.create_plan(project)
    group = next(group for group in plan["groups"] if "reviewed-a.png" in group["members"])
    assert set(group["members"]) == {"reviewed-a.png", "renamed-b.png"}
    assert plan["preview"]["groups"] == 2


def test_source_content_hash_merges_copied_videos_and_is_cached(tmp_path, monkeypatch):
    project = project_at(tmp_path)
    paths = [tmp_path / "a.mp4", tmp_path / "b.mp4"]
    for i, path in enumerate(paths):
        path.write_bytes(b"same original recording")
        add_image(project, f"{i}.png", (i * 60, 30, 40))
        stat = path.stat()
        video(project, str(i), [f"{i}.png"], source=path,
              source_bytes=stat.st_size, source_mtime_ns=stat.st_mtime_ns)
    add_image(project, "independent.png", (160, 20, 40))
    assert project.split_preview()["groups"] == 2
    original_digest = dataset_split.digest
    def reject_video_read(path):
        assert not str(path).endswith(".mp4"), "preview must reuse unchanged source hash"
        return original_digest(path)
    monkeypatch.setattr(dataset_split, "digest", reject_video_read)
    assert project.split_preview()["groups"] == 2
    paths[0].unlink()
    assert project.split_preview()["groups"] == 2


def test_exact_pixels_and_low_error_near_duplicates_are_grouped(tmp_path):
    project = project_at(tmp_path)
    image = add_image(project, "a.png", textured())
    add_image(project, "b.png", textured())
    # Same pixels but different PNG metadata/bytes.
    info = PngImagePlugin.PngInfo()
    info.add_text("note", "different encoding")
    Image.open(image).save(project.root / "images" / "b.png", pnginfo=info)
    assert digest(image) != digest(project.root / "images" / "b.png")
    add_image(project, "c.png", textured() + 1)
    add_image(project, "different.png", (170, 50, 30))
    plan = dataset_split.create_plan(project)
    grouped = next(g for g in plan["groups"] if "a.png" in g["members"])
    assert grouped["members"] == ["a.png", "b.png", "c.png"]
    assert {"identical-pixels", "verified-near-pixels"}.issubset(grouped["reasons"])
    _, manifest = rows(project)
    assert len({r["split"] for r in manifest["images"] if r["image"] in grouped["members"]}) == 1


def test_uniform_colours_and_matching_dhash_without_matching_pixels_stay_distinct(tmp_path):
    project = project_at(tmp_path)
    add_image(project, "flat-a.png", (50, 50, 50))
    add_image(project, "flat-b.png", (51, 51, 51))
    add_image(project, "texture-a.png", textured())
    add_image(project, "texture-b.png", textured() + 20)
    assert project.split_preview()["groups"] == 4


def test_cached_previews_do_not_decode_images_and_edit_invalidates_cache(tmp_path, monkeypatch):
    project = project_at(tmp_path)
    add_image(project, "a.png", textured())
    add_image(project, "b.png", textured() + 1)
    add_image(project, "c.png", (200, 10, 20))
    first = project.split_preview()
    original_rgb = dataset_split._rgb
    def reject_decode(path):
        raise AssertionError("unchanged previews should not decode images")
    monkeypatch.setattr(dataset_split, "_rgb", reject_decode)
    assert project.split_preview() == first
    monkeypatch.setattr(dataset_split, "_rgb", original_rgb)
    Image.new("RGB", (64, 64), (10, 180, 30)).save(project.root / "images" / "b.png")
    second = project.split_preview()
    assert second["groups"] == 3 and second["dataset_revision"] != first["dataset_revision"]


def test_old_leaking_split_blocks_until_explicit_repartition_and_keeps_old_snapshot(tmp_path):
    project = project_at(tmp_path)
    for i in range(3):
        add_image(project, f"{i}.png", (i * 80, 20, 40))
    old_directory, old_manifest = rows(project)
    hashes = [digest(p) for p in project.images]
    write_json(project.root / "splits.json", {"settings": project.split_settings(),
               "assignments": {hashes[0]: "train", hashes[1]: "val", hashes[2]: "train"}})
    old_split = (project.root / "splits.json").read_bytes()
    video(project, "newly-known-source", ["0.png", "1.png"])
    preview = project.split_preview()
    assert not preview["ready"] and "跨越旧" in preview["reason"]
    with pytest.raises(ValueError, match="重新划分"):
        project.build_dataset()
    assert (project.root / "splits.json").read_bytes() == old_split
    _, new_manifest = rows(project, {"seed": 43})
    assert read_json(old_directory / "manifest.json") == old_manifest
    assert new_manifest["images"][0]["split"] == new_manifest["images"][1]["split"]


def test_new_frames_inherit_video_group_split_including_validation(tmp_path):
    project = project_at(tmp_path)
    for i in range(3):
        add_image(project, f"{i}.png", (i * 80, 20, 40))
    video(project, "sequence", ["0.png"])
    write_json(project.root / "splits.json", {"settings": project.split_settings(),
               "assignments": {digest(project.images[0]): "val", digest(project.images[1]): "train"}})
    add_image(project, "new-frame.png", (210, 10, 60))
    video(project, "sequence", ["0.png", "new-frame.png"])
    preview = project.split_preview()
    assert preview["val"] == 2
    _, manifest = rows(project)
    by_name = {r["image"]: r for r in manifest["images"]}
    assert by_name["new-frame.png"]["split"] == "val"
    assert by_name["0.png"]["split"] == "val"


def test_new_bridge_between_frozen_groups_blocks(tmp_path):
    project = project_at(tmp_path)
    add_image(project, "a.png", textured())
    add_image(project, "b.png", textured() + 3)
    add_image(project, "independent.png", (200, 10, 20))
    write_json(project.root / "splits.json", {"settings": project.split_settings(),
               "assignments": {digest(project.root / "images" / "a.png"): "train",
                               digest(project.root / "images" / "b.png"): "val"}})
    assert project.split_preview()["ready"]
    add_image(project, "bridge.png", textured() + 1)
    preview = project.split_preview()
    assert not preview["ready"] and "新增帧" in preview["reason"]


def test_export_hashes_match_snapshot_and_failed_export_preserves_split(tmp_path):
    project = project_at(tmp_path)
    for i in range(3):
        add_image(project, f"{i}.png", (i * 80, 20, 40))
    sources = {p.name: digest(p) for p in project.images}
    labels = {p.name: digest(project.annotation(p)) for p in project.images}
    directory, manifest = rows(project)
    for row in manifest["images"]:
        assert row["image_sha256"] == sources[row["image"]]
        assert row["label_sha256"] == row["archived_label_sha256"] == labels[row["image"]]
        assert row["exported_label_sha256"] == digest(directory / row["exported_label"])
        assert digest(project.annotation(row["image"])) == labels[row["image"]]
    frozen = (project.root / "splits.json").read_bytes()
    annotation = read_json(project.annotation("0.png"))
    annotation["shapes"] = [{"shape_type": "rectangle", "label": "unknown", "points": [[1, 1], [5, 1], [5, 5], [1, 5]]}]
    write_json(project.annotation("0.png"), annotation)
    with pytest.raises(ValueError, match="未知标签"):
        project.build_dataset({"seed": 123})
    assert (project.root / "splits.json").read_bytes() == frozen
    assert list((project.root / "datasets").iterdir()) == [directory]


def test_group_count_selection_finds_attainable_image_target():
    groups = [{"id": str(i), "members": list(range(size))} for i, size in enumerate((6, 4, 3))]
    selected = dataset_split._validation_groups(groups, 7, 42)
    assert sum(len(g["members"]) for g in groups if g["id"] in selected) == 7


def test_near_duplicate_candidate_search_is_bounded_and_reports_limit(tmp_path):
    project = project_at(tmp_path)
    # Shared dHash bands but clearly different RGB pixels.
    for i in range(40):
        pixels = textured().copy()
        pixels[:, :, 1] = (pixels[:, :, 1].astype(int) + i * 4).clip(0, 255).astype(np.uint8)
        add_image(project, f"{i:02}.png", pixels)
    preview = project.split_preview()
    assert any("上限" in text for text in preview["warnings"])
