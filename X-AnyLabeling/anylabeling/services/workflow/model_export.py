"""Isolated YOLO export with reproducible calibration and immutable source weights."""
import hashlib
import importlib.util
import json
from pathlib import Path
import shutil
import sys
import uuid
from datetime import datetime

IMAGES = {'.jpg', '.jpeg', '.png', '.bmp', '.webp', '.tif', '.tiff'}


def inspect_weights(value):
    """Report actual floating tensor types; the .pt suffix alone says no precision."""
    import torch
    weights = Path(str(value)).resolve()
    if not weights.is_file() or weights.suffix.lower() != '.pt':
        raise ValueError('请选择存在的本地 PT 权重。')
    checkpoint = torch.load(str(weights), map_location='cpu', weights_only=False)
    model = checkpoint.get('ema') if isinstance(checkpoint, dict) else None
    if model is None:
        model = checkpoint.get('model') if isinstance(checkpoint, dict) else checkpoint
    if hasattr(model, 'parameters'):
        import itertools
        tensors = itertools.chain(model.parameters(), model.buffers())
    elif isinstance(model, dict):
        tensors = model.values()
    elif isinstance(checkpoint, dict):
        state = checkpoint.get('state_dict', checkpoint)
        tensors = state.values() if isinstance(state, dict) else []
    else:
        tensors = []
    types = sorted({str(t.dtype).removeprefix('torch.') for t in tensors
                    if isinstance(t, torch.Tensor) and t.is_floating_point()})
    names = {'float32': 'FP32', 'float16': 'FP16', 'bfloat16': 'BF16', 'float64': 'FP64'}
    precision = ' / '.join(names.get(dtype, dtype) for dtype in types) or '未知'
    return {'format': 'PyTorch PT', 'precision': precision, 'mixed': len(types) > 1,
            'dtypes': types, 'weights': str(weights)}


def options(args):
    weights = Path(str(args.get('weights', ''))).expanduser().resolve()
    if not weights.is_file() or weights.suffix.lower() != '.pt':
        raise ValueError('请选择存在的本地 YOLO PT 权重。')
    fmt, precision = args.get('format', 'onnx'), args.get('precision', 'fp32')
    if fmt not in {'onnx', 'torchscript'} or precision not in {'fp32', 'fp16', 'int8'}:
        raise ValueError('转换格式或精度无效。')
    if fmt == 'torchscript' and precision != 'fp32':
        raise ValueError('TorchScript 当前支持 FP32；量化请选择 ONNX。')
    target = args.get('target', 'generic')
    if target not in {'generic', 'maixcam'}:
        raise ValueError('转换模式无效。')
    if target == 'maixcam' and (fmt != 'onnx' or precision != 'fp32'):
        raise ValueError('MaixCAM 模式使用 ONNX FP32；INT8 量化请在 MaixHub 完成。')
    size = args.get('imgsz', [224, 320] if target == 'maixcam' else 640)
    sizes = size if target == 'maixcam' and isinstance(size, list) and len(size) == 2 else [size]
    if (target == 'maixcam' and len(sizes) != 2 or
            any(type(value) is not int or not 32 <= value <= 4096 or value % 32 for value in sizes)):
        raise ValueError('图片尺寸应为 32～4096 之间的 32 的倍数。')
    limit = args.get('calibration_limit', 100)
    if type(limit) is not int or not 1 <= limit <= 1000:
        raise ValueError('校准数量应为 1～1000 的整数。')
    calibration = []
    if precision == 'int8':
        folder = Path(str(args.get('calibration', '')))
        if not args.get('calibration') or not folder.is_dir():
            raise ValueError('INT8 需要选择有代表性的真实校准图片文件夹。')
        calibration = sorted(p.resolve() for p in folder.rglob('*') if p.is_file() and p.suffix.lower() in IMAGES)[:limit]
        if not calibration:
            raise ValueError('校准文件夹内没有支持的图片。')
    if fmt == 'onnx':
        for module in ('onnx', 'onnxruntime') + (('onnxslim',) if target == 'maixcam' else ()):
            if importlib.util.find_spec(module) is None:
                raise ValueError(f'当前 Python 环境缺少 {module}，请安装此导出依赖后重试。')
    return dict(weights=str(weights), format=fmt, precision=precision, imgsz=size, target=target,
                calibration=[str(p) for p in calibration], calibration_limit=limit)


def maixcam_head(model):
    """Only offer the YOLO26 Detect profile verified with MaixHub's public route."""
    layers = model.model.model
    head = layers[-1]
    if (model.task != 'detect' or type(head).__name__ != 'Detect' or len(layers) != 24
            or getattr(head, 'reg_max', None) != 1 or getattr(head, 'nl', None) != 3
            or getattr(head, 'one2one_cv2', None) is None
            or getattr(head, 'one2one_cv3', None) is None):
        raise ValueError('MaixCAM 模式当前仅支持标准 YOLO26 Detect（model.23、三尺度、保留 one2one 权重）。'
                         '此权重不匹配；其他模型请使用通用模式，或按 Sipeed 文档单独适配。')
    return int(head.nc)


def check_maixcam(graph, size, classes):
    """Verify exact tensor names and shapes consumed by the YOLO26 cloud profile."""
    import onnx
    graph = onnx.shape_inference.infer_shapes(graph)
    shapes = {v.name: [d.dim_value for d in v.type.tensor_type.shape.dim]
              for v in [*graph.graph.input, *graph.graph.value_info, *graph.graph.output]}
    if len(graph.graph.input) != 1 or shapes[graph.graph.input[0].name] != [1, 3, *size]:
        raise ValueError('MaixCAM 输入形状与指定的高、宽不符，请使用 32 的倍数。')
    convolutions = {name for node in graph.graph.node if node.op_type == 'Conv' for name in node.output}
    required = {}
    for branch, channels in ((2, 4), (3, classes)):
        for scale, stride in enumerate((8, 16, 32)):
            name = f'/model.23/one2one_cv{branch}.{scale}/one2one_cv{branch}.{scale}.2/Conv_output_0'
            expected = [1, channels, size[0] // stride, size[1] // stride]
            if name not in convolutions or shapes.get(name) != expected:
                raise ValueError(f'MaixHub YOLO26 检测分支不匹配：{name}；预期 {expected}，实际 {shapes.get(name)}。'
                                 '请检查 Ultralytics 版本及 one2one 分支，不能将普通 ONNX 直接改名。')
            required[name] = expected
    return dict(profile='yolo26', nodes=required, input_shape=[1, 3, *size], status='passed')


def sha256(path):
    with open(path, 'rb') as stream:
        return hashlib.file_digest(stream, 'sha256').hexdigest()


def quantize_unicode(onnx, quantizer, model, output, reader, **kwargs):
    """ORT uses ONNX's C++ path API, which mishandles Chinese Windows paths.

    This worker is isolated; use the in-memory API for the duration of quantization.
    """
    original = onnx.shape_inference.infer_shapes_path
    def infer(source, target='', check_type=False, strict_mode=False, data_prop=False):
        inferred = onnx.shape_inference.infer_shapes(onnx.load(str(source)), check_type=check_type,
                                                   strict_mode=strict_mode, data_prop=data_prop)
        onnx.save(inferred, str(target or source))
    try:
        onnx.shape_inference.infer_shapes_path = infer
        return quantizer(model, output, reader, **kwargs)
    finally:
        onnx.shape_inference.infer_shapes_path = original


def export_torchscript(model, kwargs):
    """Keep Ultralytics metadata/trace preparation, write archives with Python I/O."""
    import torch
    classes = (torch.jit.ScriptModule, torch.jit.RecursiveScriptModule)
    originals = [cls.save for cls in classes]
    def save(module, filename, **options):
        with open(filename, 'wb') as stream:
            stream.write(module._c.save_to_buffer(**options))
    try:
        for cls in classes:
            cls.save = save
        return model.export(**kwargs)
    finally:
        for cls, original in zip(classes, originals):
            cls.save = original


def run(root, args):
    config = options(args)
    folder = Path(root).resolve() / 'exports' / (datetime.now().strftime('%Y%m%d-%H%M%S') + '-' + uuid.uuid4().hex[:8])
    folder.mkdir(parents=True, exist_ok=False)
    record = dict(config, status='running', run=str(folder), source_sha256=sha256(config['weights']))
    def save():
        (folder / 'export.json').write_text(json.dumps(record, ensure_ascii=False, indent=2), encoding='utf-8')
    save()
    print('EXPORT_RUN:' + str(folder), flush=True)
    try:
        from ultralytics import YOLO
        # Ultralytics writes beside its input: use a private copy for every job.
        source = folder / 'source.pt'
        shutil.copy2(config['weights'], source)
        model = YOLO(str(source))
        classes = maixcam_head(model) if config['target'] == 'maixcam' else None
        print(f"转换 {model.task} → {config['format']} / {config['precision']}，尺寸 {config['imgsz']}", flush=True)
        kwargs = dict(format=config['format'], imgsz=config['imgsz'], device='cpu', batch=1,
                      half=False, dynamic=False)
        if config['format'] == 'onnx':
            kwargs.update(opset=17, simplify=False)
        if config['target'] == 'maixcam':
            # Explicit False is essential: current Ultralytics disables one2one for nms=None.
            kwargs.update(simplify=True, nms=False)
            print('MaixCAM / Pro：准备 YOLO26 one2one ONNX；云端量化需另行提交 MaixHub。', flush=True)
        record['export_args'] = kwargs
        save()
        exported = Path(export_torchscript(model, kwargs) if config['format'] == 'torchscript' else model.export(**kwargs)).resolve()
        if not exported.is_file() or folder not in exported.parents:
            raise ValueError('导出器未生成预期的结果文件。')
        output = folder / (('maixcam-yolo26' if config['target'] == 'maixcam' else 'model') + '-' + config['precision'] + exported.suffix)
        if config['precision'] == 'fp16':
            import onnx
            from onnxruntime.transformers.float16 import convert_float_to_float16
            from onnxruntime.transformers.onnx_model import OnnxModel
            converted = convert_float_to_float16(onnx.load(str(exported)), keep_io_types=True)
            OnnxModel(converted).topological_sort()
            onnx.checker.check_model(converted)
            onnx.save(converted, str(output))
        elif config['precision'] == 'int8':
            import onnx
            import cv2
            import numpy as np
            import onnxruntime as ort
            from onnxruntime.quantization import CalibrationDataReader, QuantFormat, QuantType, quantize_static
            from ultralytics.data.augment import LetterBox, classify_transforms
            session = ort.InferenceSession(str(exported), providers=['CPUExecutionProvider'])
            input_name = session.get_inputs()[0].name
            size = config['imgsz']
            classification = classify_transforms(size=size) if model.task == 'classify' else None
            class Reader(CalibrationDataReader):
                def __init__(self):
                    self.paths = iter(config['calibration'])
                def get_next(self):
                    path = next(self.paths, None)
                    if path is None:
                        return None
                    print('校准：' + path, flush=True)
                    image = cv2.imread(path)
                    if image is None:
                        raise ValueError('校准图片无法读取：' + path)
                    if classification:
                        from PIL import Image
                        tensor = classification(Image.fromarray(cv2.cvtColor(image, cv2.COLOR_BGR2RGB))).numpy()[None]
                    else:
                        image = LetterBox((size, size), auto=False)(image=image)
                        tensor = np.ascontiguousarray(image[:, :, ::-1].transpose(2, 0, 1)[None], dtype=np.float32) / 255.0
                    return {input_name: tensor}
            quantize_unicode(onnx, quantize_static, onnx.load(str(exported)), str(output), Reader(), quant_format=QuantFormat.QDQ,
                            activation_type=QuantType.QUInt8, weight_type=QuantType.QInt8,
                            per_channel=True, op_types_to_quantize=['Conv', 'MatMul', 'Gemm'])
        else:
            exported.rename(output)
        if config['format'] == 'onnx':
            import onnx
            onnx.checker.check_model(str(output))
            if config['target'] == 'maixcam':
                record['maixcam_check'] = check_maixcam(onnx.load(str(output)), config['imgsz'], classes)
            if config['precision'] != 'fp16':
                import numpy as np
                import onnxruntime as ort
                session = ort.InferenceSession(str(output), providers=['CPUExecutionProvider'])
                size = config['imgsz'] if isinstance(config['imgsz'], list) else [config['imgsz']] * 2
                results = session.run(None, {session.get_inputs()[0].name: np.zeros((1, 3, *size), dtype=np.float32)})
                if not all(np.isfinite(value).all() for value in results):
                    raise ValueError('CPU 推理结果包含非有限数值，导出未通过检查。')
                record['output_shapes'] = [list(value.shape) for value in results]
        else:
            import torch
            with open(output, 'rb') as stream:
                traced = torch.jit.load(stream, map_location='cpu')
            with torch.inference_mode():
                traced(torch.zeros(1, 3, config['imgsz'], config['imgsz']))
        if sha256(config['weights']) != record['source_sha256']:
            raise ValueError('源权重在转换期间发生变化，请重新选择权重后导出。')
        if config['target'] == 'maixcam':
            import ultralytics
            record['ultralytics_version'] = ultralytics.__version__
            record['guide'] = str(folder / 'MaixCAM使用说明.md')
            names = model.names
            labels = [names[i] for i in range(classes)]
            (folder / 'labels.txt').write_text('\n'.join(labels) + '\n', encoding='utf-8')
            (folder / 'MaixCAM使用说明.md').write_text(
                '# MaixCAM / MaixCAM Pro\n\n'
                f'上传 `{output.name}` 至 https://maixhub.com/toolbox/convert/maixcam ，选择 YOLO26 和实际板型。\n\n'
                f'输入：高 {size[0]} × 宽 {size[1]}，RGB / 255、按比例缩放补边；类别顺序见 labels.txt。\n\n'
                '准备 20～100 张有代表性的真实图片 ZIP（≤100 MB、无需标注），在 MaixHub 完成 INT8 量化。'
                '下载并将 .mud 与 .cvimodel 一起部署。\n\n'
                '本地已检查 ONNX、六个 one2one 节点及尺寸、CPU 推理；未进行云端编译和板端精度验证。'
                '最终 ONNX 输出可为 [1,300,6]，MaixHub 使用内部检测节点。\n\n'
                '此模式面向 MaixCAM / Pro，MaixCAM2 请按官方对应文档重新适配。\n'
                '官方说明：https://wiki.sipeed.com/maixpy/doc/zh/ai_model_converter/online_converter.html\n', encoding='utf-8')
        record.update(status='completed', output=str(output), bytes=output.stat().st_size,
                      sha256=sha256(output), task=model.task, names=model.names,
                      note=('MaixHub YOLO26 六节点与 CPU 检查通过；尚需云端量化与板端验证。' if config['target'] == 'maixcam' else
                            'INT8 为静态 QDQ 量化；请在目标设备上重新验证精度。FP16 需目标推理引擎支持半精度算子。'))
        save()
        source.unlink()  # Only remove our own temporary weight copy after success.
        if exported.exists() and exported != output:
            exported.unlink()
        print('完成：' + str(output), flush=True)
        return record
    except Exception as error:
        record.update(status='failed', error=str(error))
        save()
        raise


if __name__ == '__main__':
    sys.path.insert(0, str(Path(__file__).resolve().parents[3]))
    try:
        payload = json.loads(Path(sys.argv[1]).read_text(encoding='utf-8'))
        result = run(payload['root'], payload)
        print('EXPORT_RESULT:' + json.dumps(result, ensure_ascii=False), flush=True)
    except Exception as error:
        import traceback
        traceback.print_exc()
        print('失败：' + str(error), flush=True)
        sys.exit(1)
