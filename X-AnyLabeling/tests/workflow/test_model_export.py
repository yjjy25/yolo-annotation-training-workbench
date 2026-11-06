from pathlib import Path
import json
import pytest
from anylabeling.services.workflow.model_export import options, run, quantize_unicode, inspect_weights
from anylabeling.services.workflow.model_export import maixcam_head, check_maixcam


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


@pytest.mark.parametrize('change', [dict(target='unknown'), dict(format='torchscript'),
                                  dict(precision='int8'), dict(imgsz=224), dict(imgsz=[224]),
                                  dict(imgsz=[True, 320]), dict(imgsz=[240, 320]),
                                  dict(imgsz=[224, 320, 640])])
def test_maixcam_rejects_invalid_configuration(tmp_path, change):
    args = payload(tmp_path, target='maixcam')
    args.update(change)
    with pytest.raises(ValueError):
        options(args)


def test_maixcam_defaults_and_generic_compatibility(tmp_path):
    assert options(payload(tmp_path, target='maixcam'))['imgsz'] == [224, 320]
    config = options(payload(tmp_path))
    assert config['target'] == 'generic' and config['imgsz'] == 640


def test_maixcam_head_rejects_wrong_task_and_missing_branch():
    from types import SimpleNamespace as NS
    head = type('Detect', (), dict(reg_max=1, nl=3, nc=3, one2one_cv2=[], one2one_cv3=[]))()
    model = NS(task='detect', model=NS(model=[None] * 23 + [head]))
    assert maixcam_head(model) == 3
    head.one2one_cv2 = None
    with pytest.raises(ValueError, match='one2one'):
        maixcam_head(model)
    head.one2one_cv2 = []
    model.task = 'segment'
    with pytest.raises(ValueError, match='Detect'):
        maixcam_head(model)


def test_maixcam_exact_profile_and_shape_validation():
    import onnx
    from onnx import helper, TensorProto
    def value(name, shape):
        return helper.make_tensor_value_info(name, TensorProto.FLOAT, shape)
    # Minimal independent Conv branches exercise the profile contract, no trained weights needed.
    nodes, inputs, outputs = [], [value('images', [1, 3, 224, 320])], []
    for branch, channels in ((2, 4), (3, 3)):
        for scale, stride in enumerate((8, 16, 32)):
            name = f'/model.23/one2one_cv{branch}.{scale}/one2one_cv{branch}.{scale}.2/Conv_output_0'
            x, w = f'x{branch}{scale}', f'w{branch}{scale}'
            inputs.extend([value(x, [1, 3, 224 // stride, 320 // stride]), value(w, [channels, 3, 1, 1])])
            nodes.append(helper.make_node('Conv', [x, w], [name]))
            outputs.append(value(name, [1, channels, 224 // stride, 320 // stride]))
    graph = helper.make_model(helper.make_graph(nodes, 'profile', inputs, outputs))
    # Profile input must be a single static RGB tensor; internal test tensors are initializers.
    import numpy as np
    for item in inputs[1:]:
        graph.graph.initializer.append(onnx.numpy_helper.from_array(np.zeros([d.dim_value for d in item.type.tensor_type.shape.dim], dtype=np.float32), item.name))
    del graph.graph.input[1:]
    assert len(check_maixcam(graph, [224, 320], 3)['nodes']) == 6
    with pytest.raises(ValueError, match='输入形状'):
        check_maixcam(graph, [320, 224], 3)
    with pytest.raises(ValueError, match='检测分支'):
        check_maixcam(graph, [224, 320], 4)
    graph.graph.node[-1].output[0] = 'ordinary-cv3-output'
    with pytest.raises(ValueError, match='检测分支'):
        check_maixcam(graph, [224, 320], 3)
