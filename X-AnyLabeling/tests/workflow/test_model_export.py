from pathlib import Path
import json
import pytest
from anylabeling.services.workflow.model_export import options, run, quantize_unicode, inspect_weights
from anylabeling.services.workflow.model_export import maixcam_family, check_maixcam, maixcam_anchors


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
    # Unloadable checkpoints now raise a readable ValueError that keeps the original reason.
    with pytest.raises(ValueError, match='invalid checkpoint'):
        run(tmp_path, args)
    assert Path(args['weights']).read_bytes() == b'original weights'
    records = list((tmp_path / 'exports').glob('*/export.json'))
    assert len(records) == 1
    record = json.loads(records[0].read_text(encoding='utf-8'))
    assert record['status'] == 'failed'
    assert 'Ultralytics' in record['error']


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


def _head(name='Detect', **fields):
    values = dict(nc=3, nl=3, reg_max=16, one2one_cv2=None, one2one_cv3=None)
    values.update(fields)
    return type(name, (), values)()


def _model(modules, head, task='detect'):
    def layer(module):
        return type('Layer', (), {'type': f'ultralytics.nn.modules.{module}'})()
    return type('Model', (), {'task': task, 'model': type('Block', (), {'model': [layer(m) for m in modules] + [head]})()})()


@pytest.mark.parametrize('modules,fields,family,label', [
    (['Conv', 'C2f', 'SPPF'], {}, 'yolov8', 'YOLOv8'),
    (['C3k2', 'C3k', 'C2PSA'], {}, 'yolo11', 'YOLO11'),
    (['Conv', 'C3', 'SPPF'], {}, 'yolov5u', 'YOLOv5u'),
    (['C3k2', 'C2PSA'], dict(reg_max=1, one2one_cv2=[], one2one_cv3=[]), 'yolo26', 'YOLO26'),
])
def test_maixcam_families_are_read_from_real_modules(modules, fields, family, label):
    profile = maixcam_family(_model(modules, _head(**fields)))
    assert (profile['family'], profile['label'], profile['classes']) == (family, label, 3)
    assert profile['head'] == len(modules)


@pytest.mark.parametrize('modules,head_name,task,match', [
    (['Conv', 'C2f'], 'Segment', 'detect', '目标检测'),          # segmentation / pose / OBB heads
    (['Conv', 'C2f'], 'Pose', 'detect', '目标检测'),
    (['Conv', 'C2f'], 'Detect', 'segment', '目标检测'),
    (['Conv', 'SPPF'], 'Detect', 'detect', '无法识别'),          # unknown / old YOLOv5 style network
    (['Conv', 'C2f'], 'Detect', 'detect', '检测头'),             # unsupported reg_max
    (['C3k2'], 'Detect', 'detect', '一对一'),                    # YOLO26 after head fusion: no one2one
])
def test_maixcam_rejects_unsupported_models(modules, head_name, task, match):
    fields = {'检测头': dict(reg_max=8), '一对一': dict(reg_max=1)}.get(match, {})
    model = _model(modules, _head(head_name, **fields), task=task)
    with pytest.raises(ValueError, match=match):
        maixcam_family(model)


def test_maixcam_family_rejects_two_level_heads():
    model = _model(['Conv', 'C2f'], _head(nl=2))
    with pytest.raises(ValueError, match='三个检测尺度'):
        maixcam_family(model)


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
    record = check_maixcam(graph, [224, 320], 3)
    assert record['profile'] == 'yolo26' and len(record['nodes']) == 6
    with pytest.raises(ValueError, match='输入形状'):
        check_maixcam(graph, [320, 224], 3)
    with pytest.raises(ValueError, match='检测分支'):
        check_maixcam(graph, [224, 320], 4)
    graph.graph.node[-1].output[0] = 'ordinary-cv3-output'
    with pytest.raises(ValueError, match='检测分支'):
        check_maixcam(graph, [224, 320], 3)


def _detect_graph(classes=3, count=None, transposed=False, outputs=1):
    import onnx
    from onnx import helper, TensorProto
    anchors = maixcam_anchors([224, 320]) if count is None else count
    value = lambda name, shape: helper.make_tensor_value_info(name, TensorProto.FLOAT, shape)
    shape = [1, anchors, 4 + classes] if transposed else [1, 4 + classes, anchors]
    names = [f'output{i}' for i in range(outputs)]
    nodes = [helper.make_node('Identity', ['images'], [name]) for name in names]
    return helper.make_model(helper.make_graph(nodes, 'detect', [value('images', [1, 3, 224, 320])],
                                               [value(name, shape) for name in names]))


def test_maixcam_standard_detect_output_validation():
    anchors = maixcam_anchors([224, 320])
    assert anchors == 1470  # 224x320 at strides 8/16/32
    record = check_maixcam(_detect_graph(), [224, 320], 3, 'yolov8')
    assert (record['profile'], record['label'], record['status']) == ('yolov8', 'YOLOv8', 'passed')
    assert record['output_shape'] == [1, 7, anchors] and list(record['nodes']) == ['output0']
    with pytest.raises(ValueError, match='转置'):
        check_maixcam(_detect_graph(transposed=True), [224, 320], 3, 'yolov5u')
    with pytest.raises(ValueError, match='通道'):
        check_maixcam(_detect_graph(classes=4), [224, 320], 3, 'yolo11')
    with pytest.raises(ValueError, match='锚点'):
        check_maixcam(_detect_graph(count=anchors - 70), [224, 320], 3, 'yolov8')
    with pytest.raises(ValueError, match='单个输出'):
        check_maixcam(_detect_graph(outputs=2), [224, 320], 3, 'yolov8')
    # nms=True produces [1, 300, 6] for any class count; MaixHub cannot use that.
    with pytest.raises(ValueError, match='NMS'):
        check_maixcam(_detect_graph(classes=2, count=300, transposed=True), [224, 320], 80, 'yolov8')
    with pytest.raises(ValueError, match='输入形状'):
        check_maixcam(_detect_graph(), [320, 224], 3, 'yolov8')
