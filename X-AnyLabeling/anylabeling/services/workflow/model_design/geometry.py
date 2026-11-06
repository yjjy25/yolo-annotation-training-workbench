"""Fixed-topology convolution geometry and native detection-stride checks."""
import math
import re

TEMPLATES = {"yolov8n", "yolov8s", "yolo11n"}


class GeometryConflict(ValueError):
    def __init__(self, kind, path, message, **details):
        super().__init__(message)
        self.diagnostic = {"kind": kind, "path": path, "message": message, **details}
        self.modules = {}
        self.operators = {}


def supported(template, path, module):
    import torch.nn as nn
    return (template in TEMPLATES and re.fullmatch(r"model\.\d+\.conv", path) is not None
            and isinstance(module, nn.Conv2d) and module.padding_mode == "zeros"
            and module.kernel_size[0] == module.kernel_size[1]
            and module.stride[0] == module.stride[1] and module.padding[0] == module.padding[1])


def validate(value):
    if not isinstance(value, dict) or set(value) != {"kernel", "padding", "stride", "policy"}:
        raise ValueError("卷积几何参数须包含 kernel、padding、stride、policy。")
    for field, allowed in (("kernel", (1, 3, 5, 7)), ("padding", range(17)), ("stride", (1, 2))):
        if type(value[field]) is not int or value[field] not in allowed:
            raise ValueError("卷积核须为 1/3/5/7，填充须为 0～16，步幅须为 1 或 2。")
    if value["policy"] not in {"preserve", "manual"}:
        raise ValueError("请选择保持尺寸或手动填充。")


def effective_padding(module, value):
    validate(value)
    if value["policy"] == "manual":
        return value["padding"]
    if value["stride"] != module.stride[0]:
        raise ValueError("保持尺寸模式不能改变步幅，请切换到手动设置。")
    padding = module.padding[0] + module.dilation[0] * (value["kernel"] - module.kernel_size[0]) // 2
    if not 0 <= padding <= 16:
        raise ValueError("无法在支持的填充范围内保持尺寸。")
    if value["padding"] != padding:
        raise ValueError("保持尺寸模式的有效填充与核大小不一致，请重新设置。")
    return padding


def output_size(size, kernel, padding, stride, dilation=1):
    return (size + 2 * padding - dilation * (kernel - 1) - 1) // stride + 1


def probe(model, size, edits):
    """Stop at Detect input, before any decoding with potentially stale strides."""
    import torch
    from torch import nn
    hooks, rows, operators, active = [], {}, {}, []
    head = model.model[-1]
    states = [(m, m.training) for m in model.modules()]
    features = []

    class ReachedHead(Exception):
        pass

    def shape(x):
        if isinstance(x, torch.Tensor):
            return list(x.shape)
        if isinstance(x, (list, tuple)):
            return [shape(v) for v in x]
        return None

    def before(path):
        def callback(module, args):
            active.append(path)
            x = args[0]
            rows[path] = {"input": shape(x), "sources": [int(module.i) + f if f < 0 else f
                for f in (module.f if isinstance(module.f, list) else [module.f])],
                "connections_verified": False}
            if type(module).__name__ == "Concat":
                dim = module.d % x[0].ndim
                if any(any(a != b for axis, (a, b) in enumerate(zip(x[0].shape, t.shape)) if axis != dim) for t in x[1:]):
                    raise GeometryConflict("concat_spatial_mismatch", path,
                        f"{path}：拼接输入尺寸不一致，请调整上游填充或步幅。", inputs=shape(x), sources=rows[path]["sources"])
            if module is head:
                features.extend(shape(x))
                raise ReachedHead()
        return callback

    def after(path):
        def callback(module, args, output):
            rows[path]["output"] = shape(output)
            active.pop()
        return callback

    def conv_before(path):
        def callback(module, args):
            x = args[0]
            predicted = [output_size(n, k, p, s, d) for n, k, p, s, d in
                         zip(x.shape[-2:], module.kernel_size, module.padding, module.stride, module.dilation)]
            operators[path] = {"input": shape(args), "predicted_output": [x.shape[0], module.out_channels, *predicted]}
            if min(predicted) < 1:
                raise GeometryConflict("invalid_conv_output", path, f"{path}：卷积输出尺寸小于 1。",
                                       inputs=shape(x), predicted_output=predicted)
            # Bound a single activation before allocation; large geometry changes remain experiments.
            if x.shape[0] * module.out_channels * math.prod(predicted) > 32_000_000:
                raise GeometryConflict("resource_limit", path, f"{path}：预计特征张量超过本轮检查上限。",
                                       predicted_output=predicted)
        return callback

    try:
        for i, module in enumerate(model.model):
            path = f"model.{i}"
            hooks.extend([module.register_forward_pre_hook(before(path)), module.register_forward_hook(after(path))])
        for path, module in model.named_modules():
            if isinstance(module, nn.Conv2d):
                hooks.append(module.register_forward_pre_hook(conv_before(path)))
                def record(m, args, out, path=path):
                    operators[path]["output"] = shape(out)
                hooks.append(module.register_forward_hook(record))
        model.eval()
        try:
            with torch.inference_mode():
                model(torch.zeros(1, 3, size, size))
        except ReachedHead:
            pass
        if not features:
            raise GeometryConflict("invalid_detection_stride", f"model.{head.i}", "未测得检测头输入。")
        return features, rows, operators
    except (RuntimeError, ValueError) as error:
        conflict = error if isinstance(error, GeometryConflict) else GeometryConflict(
            "module_execution_failed", active[-1] if active else "model", str(error))
        conflict.diagnostic.update(input_size=size, edits=edits)
        conflict.modules, conflict.operators = rows, operators
        raise conflict from (None if conflict is error else error)
    finally:
        for hook in hooks:
            hook.remove()
        for module, training in states:
            module.training = training


def calibrate(model, design):
    import torch
    size = design["imgsz"]
    sizes = [size, 256 if size != 256 else 128]
    measured = []
    for sample in sizes:
        features, rows, operators = probe(model, sample, design["edits"])
        strides = []
        for dims in features:
            h, w = dims[-2:]
            stride = sample // h
            if sample % h or sample % w or h != w or stride < 1 or stride & (stride - 1):
                conflict = GeometryConflict("invalid_detection_stride", f"model.{model.model[-1].i}",
                    "检测特征不能形成固定的整数倍步长，请调整填充或步幅。", inputs=features, input_size=sample)
                conflict.modules, conflict.operators = rows, operators
                raise conflict
            strides.append(stride)
        measured.append(strides)
    if measured[0] != measured[1] or measured[0] not in ([4, 8, 16], [8, 16, 32], [16, 32, 64]):
        conflict = GeometryConflict("invalid_detection_stride", f"model.{model.model[-1].i}",
            "两种输入的检测步长不一致或超出支持范围。", measured=measured, sizes=sizes)
        conflict.modules, conflict.operators = rows, operators
        raise conflict
    maximum = max(measured[0])
    if size % maximum or size < maximum * 2:
        conflict = GeometryConflict("invalid_detection_stride", f"model.{model.model[-1].i}",
            f"输入尺寸须为 {maximum} 的倍数且不小于 {maximum * 2}。", measured=measured, sizes=sizes)
        conflict.modules, conflict.operators = rows, operators
        raise conflict
    head = model.model[-1]
    strides = torch.tensor(measured[0], dtype=head.stride.dtype, device=head.stride.device)
    head.stride = strides
    model.stride = strides
    head.shape = None
    head.anchors = torch.empty(0, device=strides.device)
    head.strides = torch.empty(0, device=strides.device)
    head.bias_init()
    model.geometry_checks = {"sizes": sizes, "strides": measured[0]}
