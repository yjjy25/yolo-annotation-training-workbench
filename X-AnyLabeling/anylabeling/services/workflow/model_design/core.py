"""Explicit construction rules shared by inspection and the training adapter."""
import copy
import hashlib
import inspect
import json
from pathlib import Path

SCHEMA = 1
FAMILIES = [
    ("yolov5u", "YOLOv5u", "v5/yolov5.yaml", "yolov5{}u"),
    ("yolov8", "YOLOv8", "v8/yolov8.yaml", "yolov8{}"),
    ("yolo11", "YOLO11", "11/yolo11.yaml", "yolo11{}"),
    ("yolo12", "YOLO12", "12/yolo12.yaml", "yolo12{}"),
    ("yolo26", "YOLO26", "26/yolo26.yaml", "yolo26{}"),
]
TEMPLATES = {pattern.format(scale): path for _, _, path, pattern in FAMILIES for scale in "nsmlx"}
TEMPLATE_SCALES = {pattern.format(scale): scale for _, _, _, pattern in FAMILIES for scale in "nsmlx"}
MIN_IMAGE_SIZE, MAX_IMAGE_SIZE = 64, 1280
SIZE_PRESETS = [64, 128, 256, 320, 416, 512, 640, 768, 960, 1024, 1280]


def catalog():
    return {"families": [{"id": key, "label": label, "variants": [
        {"id": pattern.format(scale), "scale": scale, "label": f"{scale} · " + (f"YOLOv5{scale}u" if key == "yolov5u" else f"{label}{scale}")}
        for scale in "nsmlx"]} for key, label, _, pattern in FAMILIES],
        "input": {"min": MIN_IMAGE_SIZE, "max": MAX_IMAGE_SIZE, "step": 32, "presets": SIZE_PRESETS}}
ACTIVATIONS = {"SiLU", "ReLU", "LeakyReLU", "GELU", "Identity"}


def content_hash(value):
    return hashlib.sha256(json.dumps(value, sort_keys=True, separators=(",", ":"), allow_nan=False).encode()).hexdigest()


def template_config(name, nc):
    import ultralytics
    import torch
    from ultralytics.utils import YAML
    if name not in TEMPLATES or type(nc) is not int or not 1 <= nc <= 1000:
        raise ValueError("请选择支持的检测模板及有效类别数。")
    path = Path(ultralytics.__file__).parent / "cfg/models" / TEMPLATES[name]
    from .reference import verify_official
    upstream = verify_official(Path(ultralytics.__file__).parent, ultralytics.__version__, "cfg/models/" + TEMPLATES[name])
    cfg = YAML.load(path)
    if TEMPLATE_SCALES[name] not in cfg.get("scales", {}):
        raise ValueError("当前安装模板没有声明所选规模，禁止默认回退。")
    cfg.update(scale=TEMPLATE_SCALES[name], nc=nc)
    package = Path(ultralytics.__file__).parent
    implementations = {name: hashlib.sha256((package/name).read_bytes()).hexdigest()
                       for name in ("nn/tasks.py", "nn/modules/conv.py", "nn/modules/block.py", "nn/modules/head.py")}
    compiler = {name: hashlib.sha256(Path(__file__).with_name(name).read_bytes()).hexdigest()
                for name in ("core.py", "training.py", "worker.py", "reference.py")}
    return cfg, {"path": str(path), "sha256": hashlib.sha256(path.read_bytes()).hexdigest(),
                 "upstream": upstream, "ultralytics": ultralytics.__version__, "torch": str(torch.__version__),
                 "implementations": implementations, "compiler": compiler}


def describe(module, path):
    import torch.nn as nn
    params, editable = {}, None
    if isinstance(module, nn.Conv2d):
        params = {"kernel": list(module.kernel_size), "in_channels": module.in_channels,
                  "out_channels": module.out_channels, "stride": list(module.stride),
                  "groups": module.groups, "padding": list(module.padding)}
        if module.weight.requires_grad and module.kernel_size[0] == module.kernel_size[1] and module.kernel_size[0] % 2:
            editable = "kernel"
    elif isinstance(module, (nn.MaxPool2d, nn.AvgPool2d)):
        params = {"kernel": module.kernel_size, "stride": module.stride, "padding": module.padding}
        # Only shape-preserving, stride-one pools are supported by this rule.
        if module.stride in (1, (1, 1)) and isinstance(module.kernel_size, int):
            editable = "pool_kernel"
    elif path.endswith(".act") and type(module).__name__ in ACTIVATIONS:
        params = {"activation": type(module).__name__}
        editable = "activation"
    cls = type(module)
    try:
        source = Path(inspect.getsourcefile(cls))
        lines, line = inspect.getsourcelines(cls)
        provenance = {"class": cls.__module__ + "." + cls.__qualname__, "path": str(source),
                      "line": line, "sha256": hashlib.sha256(source.read_bytes()).hexdigest()}
    except (TypeError, OSError):
        provenance = {"class": cls.__module__ + "." + cls.__qualname__, "unavailable": True}
    return {"id": path, "type": cls.__name__, "params": params, "editable": editable,
            "parameters": sum(p.numel() for p in module.parameters(recurse=False)), "source": provenance}


def validate_design(design):
    if not isinstance(design, dict) or set(design) - {"schema", "template", "source", "nc", "imgsz", "seed", "edits"}:
        raise ValueError("模型设计字段无效。")
    if design.get("schema") != SCHEMA:
        raise ValueError("模型设计版本不受支持。")
    if type(design.get("imgsz")) is not int or design["imgsz"] % 32 or not MIN_IMAGE_SIZE <= design["imgsz"] <= MAX_IMAGE_SIZE:
        raise ValueError(f"检查尺寸须为 {MIN_IMAGE_SIZE}～{MAX_IMAGE_SIZE} 内 32 的倍数。")
    if type(design.get("seed")) is not int or not 0 <= design["seed"] < 2**31:
        raise ValueError("初始化种子无效。")
    edits = design.get("edits")
    if not isinstance(edits, list) or len(edits) > 128:
        raise ValueError("最多编辑 128 个算子。")
    seen = set()
    for edit in edits:
        if not isinstance(edit, dict) or set(edit) != {"id", "field", "value"}:
            raise ValueError("编辑必须包含 id、field、value。")
        if not isinstance(edit["id"], str) or edit["id"] in seen:
            raise ValueError("算子标识无效或重复。")
        seen.add(edit["id"])
        if edit["field"] == "activation":
            if edit["value"] not in ACTIVATIONS:
                raise ValueError("不支持的激活函数。")
        elif edit["field"] in {"kernel", "pool_kernel"}:
            if type(edit["value"]) is not int or edit["value"] not in (1, 3, 5, 7):
                raise ValueError("核大小仅支持 1、3、5、7。")
        else:
            raise ValueError("此版本只支持核大小、池化核及指定层激活修改。")
    return design


def build(design):
    import torch
    from torch import nn
    from ultralytics.nn.tasks import DetectionModel
    validate_design(design)
    cfg, source = template_config(design["template"], design["nc"])
    if not isinstance(design.get("source"), dict) or any(design["source"].get(k) != source[k] for k in ("sha256", "ultralytics", "torch", "implementations", "compiler", "upstream")):
        raise ValueError("模板或运行库来源已改变，请重新创建并检查设计。")
    with torch.random.fork_rng(devices=[]):
        torch.manual_seed(design["seed"])
        model = DetectionModel(copy.deepcopy(cfg), ch=3, verbose=False)
        modules = dict(model.named_modules(remove_duplicate=False))
        for edit in design["edits"]:
            path, field, value = edit["id"], edit["field"], edit["value"]
            old = modules.get(path)
            if old is None or describe(old, path)["editable"] != field:
                raise ValueError(f"{path}：不支持该参数修改。")
            if (field == "kernel" and old.kernel_size == (value, value)) or (field == "pool_kernel" and old.kernel_size == value) or (field == "activation" and type(old).__name__ == value):
                continue  # A no-op edit must not secretly reinitialize a convolution.
            if field == "kernel":
                padding = tuple(p + d * (value - k) // 2 for p, d, k in zip(old.padding, old.dilation, old.kernel_size))
                if min(padding) < 0:
                    raise ValueError(f"{path}：该核大小不能保持空间尺寸。")
                new = nn.Conv2d(old.in_channels, old.out_channels, value, old.stride, padding,
                                old.dilation, old.groups, old.bias is not None, old.padding_mode)
            elif field == "activation":
                new = {"SiLU": nn.SiLU, "ReLU": nn.ReLU, "LeakyReLU": nn.LeakyReLU,
                       "GELU": nn.GELU, "Identity": nn.Identity}[value]()
            elif isinstance(old, nn.MaxPool2d):
                new = nn.MaxPool2d(value, stride=1, padding=value//2, dilation=old.dilation,
                                   return_indices=old.return_indices, ceil_mode=old.ceil_mode)
            else:
                new = nn.AvgPool2d(value, stride=1, padding=value//2, ceil_mode=old.ceil_mode,
                                   count_include_pad=old.count_include_pad, divisor_override=old.divisor_override)
            parent, attr = path.rsplit(".", 1)
            setattr(model.get_submodule(parent), attr, new)
        model.yaml["workbench_design"] = copy.deepcopy(design)
    return model


def signature(model):
    return [{"id": p, "type": type(m).__name__, "config": describe(m, p)["params"]}
            for p, m in model.named_modules(remove_duplicate=False) if p and not list(m.children())]


def inspect_model(model):
    layers = [describe(m, p) for p, m in model.named_modules(remove_duplicate=False) if p and not list(m.children())]
    definitions = model.yaml["backbone"] + model.yaml["head"]
    graph = [{"definition": definitions[i], "id": f"model.{i}", "type": type(m).__name__, "from": m.f,
              "parameters": sum(p.numel() for p in m.parameters()),
              "children": [{"name": name, "type": type(child).__name__} for name, child in m.named_children()],
              "source": describe(m, f"model.{i}")["source"],
              "section": "backbone" if i < len(model.yaml["backbone"]) else
                         "output" if type(m).__name__ == "Detect" else "fusion"} for i, m in enumerate(model.model)]
    tree = [{"id": path, "type": type(module).__name__,
             "residual": getattr(module, "add", None) if isinstance(getattr(module, "add", None), bool) else None,
             "pool_repeats": getattr(module, "n", None) if type(module).__name__ == "SPPF" else None}
            for path, module in model.named_modules(remove_duplicate=False) if path]
    head = model.model[-1]
    detection = {"type": type(head).__name__, "reg_max": head.reg_max,
                 "dfl": type(head.dfl).__name__, "end2end": head.end2end,
                 "configured_end2end": bool(model.yaml.get("end2end", False)),
                 "inference_branch": "one2one" if head.end2end else "one2many",
                 "one2one": getattr(head, "one2one_cv2", None) is not None,
                 "strides": head.stride.tolist(), "sources": head.f}
    return {"detection": detection, "module_tree": tree, "layers": layers, "graph": graph, "parameters": sum(p.numel() for p in model.parameters()),
            "signature": content_hash(signature(model))}


def trace_model(model, imgsz):
    """Observe native forward execution; verify every top-level input by object identity.

    This records module boundaries, not a fabricated leaf-operation graph. Functional
    split/concat/residual operations inside a module remain in its actual forward source.
    """
    import torch
    states = [(module, module.training) for module in model.modules()]
    hooks, outputs, rows, operators, parents = [], {}, {}, {}, []

    def shape(value):
        if isinstance(value, torch.Tensor):
            return list(value.shape)
        if isinstance(value, (list, tuple)):
            return [shape(item) for item in value]
        if isinstance(value, dict):
            return {str(key): shape(item) for key, item in value.items()}
        return None

    images = torch.zeros(1, 3, imgsz, imgsz)
    def before(index):
        def callback(module, args):
            refs = module.f if isinstance(module.f, list) else [module.f]
            actual = list(args[0]) if isinstance(module.f, list) else [args[0]]
            sources = [index + ref if ref < 0 else ref for ref in refs]
            expected = [images if source == -1 else outputs[source] for source in sources]
            if len(actual) != len(expected) or any(a is not b for a, b in zip(actual, expected)):
                raise ValueError(f"model.{index}：运行时输入与声明连线不一致。")
            rows[index] = {"sources": sources, "input": shape(args[0]), "connections_verified": True}
        return callback

    def after(index):
        def callback(module, args, output):
            outputs[index] = output
            rows[index]["output"] = shape(output)
        return callback

    def leaf_record(names):
        def callback(module, args, output):
            sample = {"input": shape(args), "output": shape(output), "mode": "eval"}
            matched = [name for name in names if parents and name.rsplit(".", 1)[0] == parents[-1]]
            resolved = matched[0] if len(matched) == 1 else names[0] if len(names) == 1 else None
            if resolved is not None:
                entry = operators.get(resolved)
                if entry is None:
                    operators[resolved] = sample
                else:
                    if "calls" not in entry:
                        entry = {"calls": [entry], "mode": "eval"}
                        operators[resolved] = entry
                    entry["calls"].append(sample)
            else:
                entry = operators.setdefault(names[0], {"shared_module_paths": names, "calls": [], "mode": "eval"})
                entry["calls"].append(sample)
                for name in names[1:]:
                    operators[name] = {"shared_calls_ref": names[0], "mode": "eval"}
        return callback

    def enter(names):
        def callback(module, args):
            prefix = parents[-1] + "." if parents else ""
            matches = [name for name in names if name.startswith(prefix)]
            parents.append(matches[0] if len(matches) == 1 else names[0])
        return callback

    def leave(module, args, output):
        parents.pop()

    try:
        leaves, containers = {}, {}
        for path, module in model.named_modules(remove_duplicate=False):
            if path:
                group = containers if list(module.children()) else leaves
                group.setdefault(id(module), (module, []))[1].append(path)
        for module, names in containers.values():
            hooks.extend([module.register_forward_pre_hook(enter(names)), module.register_forward_hook(leave)])
        for module, names in leaves.values():
            hooks.append(module.register_forward_hook(leaf_record(names)))
        for index, module in enumerate(model.model):
            hooks.extend([module.register_forward_pre_hook(before(index)), module.register_forward_hook(after(index))])
        model.eval()
        with torch.inference_mode():
            model(images)
        return {"input": list(images.shape), "axes": "NCHW", "mode": "eval",
                "scope": "一次合成输入的原生前向计算；模块级连接逐项按张量对象核对。",
                "operators": operators, "modules": rows, "detection_strides": model.stride.tolist()}
    finally:
        for hook in hooks:
            hook.remove()
        for module, training in states:
            module.training = training


def checked_configuration(path, root, nc, imgsz):
    """Accept only a saved, unmodified checked revision belonging to this project."""
    path = Path(path).resolve()
    revisions = (Path(root) / "model_designs/revisions").resolve()
    if not path.is_relative_to(revisions) or path.name != "model.yaml":
        raise ValueError("设计模型必须来自当前项目中检查通过的修订。")
    from ..project import read_json, digest
    report = read_json(path.with_name("report.json"))
    design = validate_design(report["design"])
    if report.get("model_sha256") != digest(path) or report.get("design_hash") != content_hash(design):
        raise ValueError("设计文件已变化，请重新检查并保存。")
    if design["nc"] != nc or design["imgsz"] != imgsz:
        raise ValueError("类别数或训练尺寸与检查修订不同，请重新检查设计。")
    if not all(report.get("checks", {}).get(k) is True for k in ("forward", "backward")):
        raise ValueError("此设计未通过前向及反向检查。")
    _, source = template_config(design["template"], nc)
    if any(design["source"].get(k) != source[k] for k in ("sha256", "ultralytics", "torch", "implementations", "compiler", "upstream")):
        raise ValueError("运行库或模板已变化，请重新检查。")
    return report
