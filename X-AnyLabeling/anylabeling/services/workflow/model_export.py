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
    size = args.get('imgsz', 640)
    if type(size) is not int or not 32 <= size <= 4096 or size % 32:
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
        for module in ('onnx', 'onnxruntime'):
            if importlib.util.find_spec(module) is None:
                raise ValueError(f'当前 Python 环境缺少 {module}，请安装此导出依赖后重试。')
    return dict(weights=str(weights), format=fmt, precision=precision, imgsz=size,
                calibration=[str(p) for p in calibration], calibration_limit=limit)


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
        print(f"转换 {model.task} → {config['format']} / {config['precision']}，尺寸 {config['imgsz']}", flush=True)
        kwargs = dict(format=config['format'], imgsz=config['imgsz'], device='cpu', batch=1,
                      half=False, dynamic=False)
        if config['format'] == 'onnx':
            kwargs.update(opset=17, simplify=False)
        exported = Path(export_torchscript(model, kwargs) if config['format'] == 'torchscript' else model.export(**kwargs)).resolve()
        if not exported.is_file() or folder not in exported.parents:
            raise ValueError('导出器未生成预期的结果文件。')
        output = folder / ('model-' + config['precision'] + exported.suffix)
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
            if config['precision'] != 'fp16':
                import numpy as np
                import onnxruntime as ort
                session = ort.InferenceSession(str(output), providers=['CPUExecutionProvider'])
                session.run(None, {session.get_inputs()[0].name: np.zeros((1, 3, config['imgsz'], config['imgsz']), dtype=np.float32)})
        else:
            import torch
            with open(output, 'rb') as stream:
                traced = torch.jit.load(stream, map_location='cpu')
            with torch.inference_mode():
                traced(torch.zeros(1, 3, config['imgsz'], config['imgsz']))
        record.update(status='completed', output=str(output), bytes=output.stat().st_size,
                      sha256=sha256(output), task=model.task, names=model.names,
                      note='INT8 为静态 QDQ 量化；请在目标设备上重新验证精度。FP16 需目标推理引擎支持半精度算子。')
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
