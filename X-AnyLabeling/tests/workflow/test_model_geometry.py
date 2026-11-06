"""Geometry failure diagnostics and replay into the native training model."""
import copy
from types import SimpleNamespace
import pytest

from anylabeling.services.workflow.model_design.core import build, template_config, signature
from anylabeling.services.workflow.model_design.geometry import GeometryConflict, output_size
from anylabeling.services.workflow.model_design.worker import run


@pytest.fixture(autouse=True)
def threads():
    import torch
    previous = torch.get_num_threads()
    torch.set_num_threads(2)
    yield
    torch.set_num_threads(previous)


def request(path="model.0.conv", kernel=3, padding=1, stride=2, policy="manual", template="yolov8n", size=64):
    return dict(template=template, nc=1, imgsz=size, seed=42, action="inspect", edits=[
        dict(id=path, field="geometry", value=dict(kernel=kernel, padding=padding, stride=stride, policy=policy))])


def design(req):
    _, source = template_config(req["template"], 1)
    return {k: v for k, v in dict(req, schema=1, source=source).items() if k != "action"}


@pytest.mark.parametrize("template", ["yolov8n", "yolov8s", "yolo11n"])
def test_stride_recalibrates_all_supported_templates_and_preserves_weights(template):
    d = design(request(stride=1, template=template))
    model = build(d)
    assert model.stride.tolist() == [4, 8, 16]
    assert model.model[-1].stride.tolist() == [4, 8, 16]
    assert model.geometry_checks == {"sizes": [64, 256], "strides": [4, 8, 16]}
    native = build(dict(d, edits=[]))
    assert (native.model[0].conv.weight == model.model[0].conv.weight).all()


def test_manual_padding_reports_actual_318_without_silently_preserving_320(tmp_path):
    result = run(tmp_path, request(kernel=7, padding=1, size=640))
    assert result["shapes"]["model.0.conv"]["output"][-2:] == [318, 318]
    assert not result.get("conflicts")
    assert result["design"]["edits"][0]["value"]["padding"] == 1
    assert "revision" not in result
    assert not (tmp_path / "model_designs/revisions").exists()


def test_internal_stride_change_is_rejected_and_concat_reports_sources(tmp_path):
    with pytest.raises(ValueError, match="尚未开放"):
        build(design(request(path="model.2.cv1.conv", stride=1)))
    result = run(tmp_path, request(path="model.5.conv", stride=1, size=128))
    conflict = result["conflicts"][0]
    assert conflict["path"] == "model.14"
    assert [v[-2:] for v in conflict["inputs"]] == [[32, 32], [16, 16]]
    assert conflict["sources"] == [13, 4]
    assert "revision" not in result
    assert not (tmp_path / "model_designs/revisions").exists()
    assert result["modified"]["graph"][-1]["execution"] is None


@pytest.mark.parametrize("change", [dict(padding=-1), dict(padding=17), dict(stride=0), dict(stride=3), dict(stride=True), dict(kernel=2), dict(policy="unknown")])
def test_invalid_geometry_does_not_build(change):
    with pytest.raises(ValueError):
        build(design(request(**change)))


def test_preserve_policy_requires_correct_explicit_padding_and_original_stride():
    for kwargs in (dict(kernel=7, padding=1, policy="preserve"), dict(stride=1, policy="preserve")):
        with pytest.raises(ValueError, match="模式"):
            build(design(request(**kwargs)))
    model = build(design(request(kernel=7, padding=3, policy="preserve")))
    assert model.model[0].conv.padding == (3, 3)
    assert model.stride.tolist() == [8, 16, 32]


def test_invalid_output_has_precise_operator_path():
    with pytest.raises(GeometryConflict) as caught:
        build(design(request(path="model.7.conv", kernel=7, padding=0)))
    assert caught.value.diagnostic["kind"] == "invalid_conv_output"
    assert caught.value.diagnostic["path"] == "model.7.conv"


def test_stride_geometry_survives_check_yaml_training_rebuild_and_checkpoint(tmp_path):
    import torch
    from ultralytics import YOLO
    from anylabeling.services.workflow.model_design.training import load_training_model, DesignDetectionTrainer
    result = run(tmp_path, dict(request(stride=1), action="check"))
    assert result["checks"]["backward"]
    assert result["geometry_checks"]["strides"] == [4, 8, 16]
    wrapped = load_training_model(result["model_path"])
    trainer = object.__new__(DesignDetectionTrainer)
    trainer.data = dict(nc=1, channels=3, names={0: "object"})
    trainer.args = SimpleNamespace(cls_remap=True)
    restored = trainer.get_model(copy.deepcopy(wrapped.model.yaml), wrapped.model, verbose=False)
    assert signature(restored) == signature(wrapped.model)
    assert restored.stride.tolist() == [4, 8, 16]
    checkpoint = tmp_path / "geometry.pt"
    wrapped.save(checkpoint)
    reloaded = YOLO(checkpoint)
    assert reloaded.model.stride.tolist() == [4, 8, 16]
    reloaded.model.eval()
    with torch.inference_mode():
        output = reloaded.model(torch.zeros(1, 3, 64, 64))[0]
    assert torch.isfinite(output).all()


def test_convolution_formula():
    assert output_size(640, 7, 1, 2) == 318
    assert output_size(640, 7, 3, 2) == 320


def test_unsupported_detection_scales_block_revision_even_when_concat_is_valid(tmp_path):
    req = request(stride=1)
    req["edits"].extend(request(path="model.1.conv", stride=1)["edits"])
    result = run(tmp_path, dict(req, action="check"))
    conflict = result["conflicts"][0]
    assert conflict["kind"] == "invalid_detection_stride"
    assert conflict["measured"] == [[2, 4, 8], [2, 4, 8]]
    assert "revision" not in result
    assert "output" not in result["modified"]["graph"][-1]["execution"]
