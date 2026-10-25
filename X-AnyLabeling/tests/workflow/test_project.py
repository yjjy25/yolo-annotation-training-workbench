import copy
from pathlib import Path
import pytest
from PIL import Image
import yaml

from anylabeling.services.workflow.project import Project, write_json, read_json, digest, validate_template
from anylabeling.services.workflow import desktop
from anylabeling.services.workflow.presets import preset


def make_project(tmp_path, task="detect"):
    template = {"points": ["a", "b", "c"], "edges": [[0, 1], [1, 2]], "pairs": [[0, 2]]} if task == "pose" else None
    project = Project.create(tmp_path / "项目", "测试", task, ["object"], template=template)
    for i in range(4):
        image = project.root / "images" / f"{i}.png"
        Image.new("RGB", (64, 64), (30 * i, 40, 100)).save(image)
        kind = {"detect": "rectangle", "segment": "polygon", "pose": "rectangle", "obb": "rotation", "classify": "rectangle"}[task]
        shapes = [] if task == "classify" else [{"label": "object", "points": [[5,5],[45,5],[45,45],[5,45]], "shape_type": kind, "group_id": 1, "flags": {}, "difficult": False}]
        if task == "pose":
            shapes += [{"label": "a", "points": [[15,15]], "shape_type": "point", "group_id": 1, "difficult": False}, {"label": "c", "points": [[35,35]], "shape_type": "point", "group_id": 1, "difficult": True}]
        write_json(project.annotation(image), {"version": "4.1.3", "imagePath": "../images/" + image.name, "imageData": None, "imageWidth": 64, "imageHeight": 64, "shapes": shapes, "flags": {"object": True}, "checked": i < 3})
    return project


@pytest.mark.parametrize("task", ["detect", "segment", "pose", "obb", "classify"])
def test_snapshot_respects_reviews_splits_and_preserves_originals(tmp_path, task):
    project = make_project(tmp_path, task)
    original = {p.name: digest(p) for p in (project.root / "annotations").glob("*.json")}
    result = project.build_dataset()
    directory = result if task == "classify" else result.parent
    manifest = read_json(directory / "manifest.json")
    assert len(manifest["images"]) == 3  # Draft excluded.
    # splits.json now keeps the requested settings next to the frozen assignment.
    splits = read_json(project.root / "splits.json")
    assert set(splits) == {"settings", "assignments", "grouping"}
    assert splits["grouping"]["version"] == 1
    assignments = splits["assignments"]
    assert len(assignments) == 3
    data = read_json(project.annotation(project.images[3]))
    data["checked"] = True
    write_json(project.annotation(project.images[3]), data)
    project.build_dataset()
    # Already-frozen images keep their split; the newly reviewed one joins train.
    after = read_json(project.root / "splits.json")["assignments"]
    assert all(after[key] == value for key, value in assignments.items())
    assert after[digest(project.images[3])] == "train"
    assert all(digest(project.root / "annotations" / name) == value for name, value in original.items() if name != "3.json")
    if task == "pose":
        cfg = yaml.safe_load(result.read_text(encoding="utf-8"))
        assert cfg["kpt_shape"] == [3,3]
        txt = next((directory / "labels").rglob("*.txt")).read_text()
        numbers = list(map(float, txt.split()))
        assert len(numbers) == 14
        assert numbers[7] == 2 and numbers[10] == 0 and numbers[13] == 1


def test_candidate_is_separate_conflict_checked_and_backed_up(tmp_path):
    project = make_project(tmp_path)
    image = project.images[0]
    path = project.annotation(image)
    proposal = {"base_hash": digest(path), "task": "detect", "classes": project.data["classes"], "template": None, "annotation": copy.deepcopy(read_json(path))}
    before = path.read_bytes()
    write_json(project.root / "proposals" / "p.json", proposal)
    assert path.read_bytes() == before
    changed = read_json(path)
    changed["description"] = "人工新修正"
    write_json(path, changed)
    with pytest.raises(ValueError, match="过期"):
        project.accept_proposal(image, proposal)
    proposal["base_hash"] = digest(path)
    project.accept_proposal(image, proposal)
    assert read_json(path)["checked"] is False
    assert next((project.root / "backups").glob("*.json")).exists()


def test_accept_proposal_recreates_a_missing_backup_folder(tmp_path):
    """A deleted backups/ folder must not break accepting or saving.

    ``shutil.copy2`` does not create its target directory, so a project copied
    without backups/ used to fail with WinError 3 and the accept looked like it
    silently did nothing.
    """
    import shutil as _shutil
    project = make_project(tmp_path)
    image = project.images[0]
    path = project.annotation(image)
    proposal = {"base_hash": digest(path), "task": "detect", "classes": project.data["classes"], "template": None, "annotation": read_json(path)}
    _shutil.rmtree(project.root / "backups")
    assert not (project.root / "backups").exists()
    project.accept_proposal(image, proposal)
    assert (project.root / "backups").exists()
    assert list((project.root / "backups").glob("*.json"))
    # Saving on top of an existing label takes the same path.
    desktop.save_annotation(project, image.name, read_json(path), digest(path), False)
    assert len(list((project.root / "backups").glob("*.json"))) >= 2


def test_circle_keeps_independent_width_and_height(tmp_path):
    """A round mark stores [centre, [rx, ry]] and must stay an ellipse.

    The older [centre, edge] labels still have to convert to the same shape they
    always did, otherwise existing projects would silently change.
    """
    project = make_project(tmp_path)
    # Canvas form: [centre, [rx, ry], bottom] keeps width and height independent.
    ellipse = [[100, 100], [30, 10], [100, 110]]
    ring = Project.circle_polygon(ellipse)
    xs = [point[0] for point in ring]
    ys = [point[1] for point in ring]
    assert (round(min(xs)), round(max(xs))) == (70, 130)
    assert (round(min(ys)), round(max(ys))) == (90, 110)

    # Legacy form: the second point is a corner, so the radii come from the offset.
    legacy = [[100, 100], [130, 120]]
    ring = Project.circle_polygon(legacy)
    xs = [point[0] for point in ring]
    ys = [point[1] for point in ring]
    assert (round(min(xs)), round(max(xs))) == (70, 130)
    assert (round(min(ys)), round(max(ys))) == (80, 120)

    # Both forms must pass validation on a detection project.
    for points in (ellipse, [[100, 100], [30, 30], [100, 130]], legacy):
        data = {"imageWidth": 400, "imageHeight": 300, "shapes": [
            {"label": project.data["classes"][0], "shape_type": "circle", "points": points, "group_id": None}]}
        project.validate_annotation(data, "圆形.png")


def test_removing_an_image_takes_its_label_proposal_and_split(tmp_path):
    """An unusable photo must leave the dataset completely.

    Leaving the annotation or the split entry behind kept the picture in the
    training counts even though the file was gone.
    """
    project = make_project(tmp_path)
    image = project.images[0]
    label = project.annotation(image)
    proposal = project.root / "proposals" / "latest" / (image.stem + ".json")
    write_json(proposal, {"annotation": {"shapes": []}})
    write_json(project.root / "splits.json", {"settings": {}, "assignments": {image.stem: "train", "other": "val"}})
    assert label.exists()

    result = project.remove_image(image)

    assert result["name"] == image.name
    assert not image.exists()
    assert not label.exists()
    assert not proposal.exists()
    # Archived by default, so the decision stays reversible.
    assert (project.root / "removed" / "images" / image.name).exists()
    assert (project.root / "removed" / "annotations" / (image.stem + ".json")).exists()
    assert result["split_entries"] == 1
    assignments = read_json(project.root / "splits.json")["assignments"]
    assert image.stem not in assignments
    assert assignments == {"other": "val"}
    assert not any(entry.name == image.name for entry in project.images)


def test_removing_an_image_can_purge_and_rejects_unknown_files(tmp_path):
    project = make_project(tmp_path)
    image = project.images[0]
    project.remove_image(image, purge=True)
    assert not image.exists()
    assert not (project.root / "removed").exists()
    with pytest.raises(ValueError):
        project.remove_image(project.root / "images" / "not-here.png")
    with pytest.raises(ValueError):
        project.remove_image(project.root / "project.json")


def test_duplicate_images_do_not_leak_across_splits(tmp_path):
    project = make_project(tmp_path)
    (project.images[1]).write_bytes(project.images[0].read_bytes())
    directory = project.build_dataset().parent
    images = read_json(directory / "manifest.json")["images"]
    assert images[0]["split"] == images[1]["split"]


def test_unreviewed_missing_label_is_not_negative_sample(tmp_path):
    project = make_project(tmp_path)
    project.annotation(project.images[1]).unlink()
    data = read_json(project.annotation(project.images[2]))
    data["checked"] = False
    write_json(project.annotation(project.images[2]), data)
    with pytest.raises(ValueError, match="至少需要"):
        project.build_dataset()


@pytest.mark.parametrize("template", [{"points":["a","a"]}, {"points":["a","b"],"edges":[[0,2]]}, {"points":["a","b","c"],"pairs":[[0,1],[1,2]]}])
def test_invalid_skeleton_is_rejected(template):
    with pytest.raises(ValueError):
        validate_template(template)


def test_presets_follow_official_keypoint_order():
    import ultralytics
    data_dir = Path(ultralytics.__file__).parent / "cfg" / "datasets"
    for name, filename, expected in (("human", "coco8-pose.yaml", 17), ("dog", "dog-pose.yaml", 24)):
        template = preset(name)
        validate_template(template)
        config = yaml.safe_load((data_dir / filename).read_text(encoding="utf-8"))
        assert len(template["points"]) == expected
        assert template["points"] == config["kpt_names"][0]


def test_import_copies_original_and_detects_stem_collisions(tmp_path):
    source = tmp_path / "source"
    source.mkdir()
    Image.new("RGB", (10,10)).save(source / "a.png")
    before = digest(source / "a.png")
    project = Project.create(tmp_path / "copy", "copy", "detect", ["x"], source)
    assert digest(project.images[0]) == before == digest(source / "a.png")
    Image.new("RGB", (10,10)).save(source / "a.jpg")
    with pytest.raises(ValueError, match="同名"):
        Project.create(tmp_path / "other", "other", "detect", ["x"], source)
