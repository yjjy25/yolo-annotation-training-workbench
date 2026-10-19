from pathlib import Path
import json
import pytest
from anylabeling.services.workflow.model_export import options, run, quantize_unicode, inspect_weights


def payload(tmp_path, **kwargs):
    weights = tmp_path / 'original.pt'
    if not weights.exists():
        weights.write_bytes(b'original weights')
    return dict(weights=str(weights), **kwargs)


@pytest.mark.parametrize('change', [dict(format='bad'), dict(precision='bad'), dict(format='torchscript', precision='int8'), dict(imgsz=33), dict(imgsz=True), dict(calibration_limit=0), dict(weights='missing.pt')])
def test_invalid_export_options(tmp_path, change):
    args = payload(tmp_path)
    args.update(change)
    with pytest.raises(ValueError):
        options(args)


def test_int8_needs_real_images(tmp_path):
    with pytest.raises(ValueError, match='校准'):
        options(payload(tmp_path, precision='int8'))
    with pytest.raises(ValueError, match='没有'):
        options(payload(tmp_path, precision='int8', calibration=str(tmp_path)))


@pytest.mark.parametrize('kind,expected', [('half', 'FP16'), ('float', 'FP32'), ('mixed', 'FP16 / FP32')])
def test_inspect_actual_weight_precision(tmp_path, kind, expected):
    import torch
    model = torch.nn.Linear(2, 2)
    if kind in {'half', 'mixed'}:
        model.half()
    if kind == 'mixed':
        model.register_buffer('extra', torch.ones(1, dtype=torch.float32))
    path = tmp_path / '权重.pt'
    with open(path, 'wb') as stream:
        torch.save({'model': model}, stream)
    info = inspect_weights(path)
    assert info['precision'] == expected
    assert info['mixed'] == (kind == 'mixed')


def test_calibration_limit_and_subdirectories(tmp_path):
    folder = tmp_path / 'nested'
    folder.mkdir()
    for name in ['a.jpg', 'b.PNG', 'c.txt']:
        (folder / name).touch()
    config = options(payload(tmp_path, precision='int8', calibration=str(tmp_path), calibration_limit=1))
    assert config['calibration'] == [str(folder / 'a.jpg')]


def test_failure_preserves_original_and_records_failure(tmp_path, monkeypatch):
    import ultralytics
    def fail(_):
        raise RuntimeError('invalid checkpoint')
    monkeypatch.setattr(ultralytics, 'YOLO', fail)
    args = payload(tmp_path)
    with pytest.raises(RuntimeError, match='invalid checkpoint'):
        run(tmp_path, args)
    assert Path(args['weights']).read_bytes() == b'original weights'
    records = list((tmp_path / 'exports').glob('*/export.json'))
    assert len(records) == 1
    assert json.loads(records[0].read_text(encoding='utf-8'))['status'] == 'failed'


def test_unicode_shape_inference_and_restoration(tmp_path):
    import onnx
    from onnx import helper, TensorProto
    folder = tmp_path / '中文路径'
    folder.mkdir()
    graph = helper.make_graph([helper.make_node('Identity', ['x'], ['y'])], 'test',
                              [helper.make_tensor_value_info('x', TensorProto.FLOAT, [1])],
                              [helper.make_tensor_value_info('y', TensorProto.FLOAT, [1])])
    model = helper.make_model(graph)
    source, output = folder / 'model.onnx', folder / 'inferred.onnx'
    onnx.save(model, str(source))
    original = onnx.shape_inference.infer_shapes_path
    def quantizer(*args, **kwargs):
        onnx.shape_inference.infer_shapes_path(str(source), str(output))
        onnx.checker.check_model(onnx.load(str(output)))
        raise RuntimeError('test cleanup on failure')
    with pytest.raises(RuntimeError, match='cleanup'):
        quantize_unicode(onnx, quantizer, model, str(output), None)
    assert onnx.shape_inference.infer_shapes_path is original
