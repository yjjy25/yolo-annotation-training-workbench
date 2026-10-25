"""Isolated inspect/check process. Reports contain actual model and source evidence."""
import copy
import json
from pathlib import Path
import sys
import traceback
from types import SimpleNamespace
import uuid
import inspect
import shutil
from datetime import datetime, timezone

from .core import build, inspect_model, template_config, content_hash, trace_model
from ..project import write_json, digest


def run(root, request):
    import torch
    from ultralytics.utils import DEFAULT_CFG_DICT, YAML
    torch.set_num_threads(2)
    template, nc = request["template"], request["nc"]
    _, source = template_config(template, nc)
    design = {"schema": 1, "template": template, "source": source, "nc": nc,
              "imgsz": request.get("imgsz", 128), "seed": request.get("seed", 42),
              "edits": request.get("edits", [])}
    baseline_design = {**design, "edits": []}
    baseline = build(baseline_design)
    base_info = inspect_model(baseline)
    del baseline  # Release baseline weights before forward/backward for larger scales.
    model = build(design)
    info = inspect_model(model)
    execution = trace_model(model, design["imgsz"])
    for index, node in enumerate(info["graph"]):
        node["execution"] = execution["modules"][index]
    operator_shapes = execution.pop("operators")
    result = {"measurement": {"measured_at": datetime.now(timezone.utc).isoformat(), "mode": "eval",
                              "design_hash": content_hash(design), "id": uuid.uuid4().hex},
              "shapes": operator_shapes, "execution": execution, "design": design, "baseline": base_info, "modified": info,
              "parameter_delta": info["parameters"] - base_info["parameters"],
              "initialization": "随机初始化；兼容层同种子，改核层重新初始化；未加载预训练权重。"}
    result["source_code"] = {}
    for path, module in model.named_modules(remove_duplicate=False):
        if path and (not list(module.children()) or path in {row["id"] for row in info["graph"]}):
            cls = type(module)
            key = cls.__module__ + "." + cls.__qualname__
            if key not in result["source_code"]:
                try: result["source_code"][key] = inspect.getsource(cls)
                except (TypeError, OSError): result["source_code"][key] = "当前安装包未提供该类的 Python 源码。"
    if request.get("action") == "inspect":
        return result
    before = copy.deepcopy(model.state_dict())
    captures = {}
    hooks = []
    def record(names):
        def callback(module, inputs, output):
            def shape(value):
                if isinstance(value, torch.Tensor): return list(value.shape)
                if isinstance(value, (list, tuple)): return [shape(v) for v in value]
                return None
            sample = {"input": shape(inputs), "output": shape(output)}
            if len(names) == 1:
                captures[names[0]] = sample
            else:
                entry = captures.setdefault(names[0], {"shared_module_paths": names, "calls": [],
                    "note": "共享实例的调用记录；不把最后一次调用冒充每个路径的尺寸。"})
                entry["calls"].append(sample)
                for name in names[1:]:
                    captures[name] = {"shared_calls_ref": names[0]}
        return callback
    module_paths = {}
    for path, module in model.named_modules(remove_duplicate=False):
        if path and (not list(module.children()) or path in {row["id"] for row in info["graph"]}):
            module_paths.setdefault(id(module), (module, []))[1].append(path)
    for module, names in module_paths.values():
        hooks.append(module.register_forward_hook(record(names)))
    try:
        size = design["imgsz"]
        with torch.random.fork_rng(devices=[]):
            torch.manual_seed(design["seed"])
            images = torch.rand(2, 3, size, size)
        model.eval()
        with torch.inference_mode():
            output = model(images)[0]
        if not torch.isfinite(output).all():
            raise ValueError("前向输出包含非有限数值。")
        model.args = SimpleNamespace(**DEFAULT_CFG_DICT)
        model.train()
        batch = {"img": images, "batch_idx": torch.tensor([0., 1.]),
                 "cls": torch.zeros(2, 1), "bboxes": torch.tensor([[.5,.5,.25,.25],[.4,.4,.2,.2]])}
        loss, _ = model(batch)
        loss.sum().backward()
        gradients = [p.grad for p in model.parameters() if p.grad is not None]
        if not gradients or not torch.isfinite(loss).all() or not all(torch.isfinite(g).all() for g in gradients):
            raise ValueError("损失或梯度检查未通过。")
        result["checks"] = {"forward": True, "backward": True, "gradient_tensors": len(gradients),
                            "input": [2, 3, size, size], "scope": "合成数据检查，不代表真实训练或精度验证。"}
        result["training_shapes"] = captures  # Keep eval IO consistent with the automatic preview.
    finally:
        for hook in hooks: hook.remove()
        model.load_state_dict(before, strict=True)
        model.zero_grad(set_to_none=True)
    revision = "rev_" + uuid.uuid4().hex
    folder = Path(root) / "model_designs" / "revisions" / revision
    folder.mkdir(parents=True, exist_ok=False)
    sources = folder / "sources"
    sources.mkdir()
    source_files = {Path(__file__), Path(__file__).with_name("core.py"), Path(__file__).with_name("training.py"), Path(__file__).with_name("reference.py"), Path(source["path"])}
    source_files.update(Path(source["path"]).parents[3] / name for name in source["implementations"])
    source_files.update(Path(row["source"]["path"]) for row in info["layers"] if "path" in row["source"])
    source_manifest = []
    for index, path in enumerate(sorted(source_files)):
        target = sources / f"{index:02d}_{path.name}"
        shutil.copy2(path, target)
        source_manifest.append({"original": str(path), "snapshot": target.relative_to(folder).as_posix(), "sha256": digest(target)})
    write_json(sources / "manifest.json", source_manifest)
    cfg = copy.deepcopy(model.yaml)
    YAML.save(folder / "model.yaml", cfg)
    result.update(revision=revision, model_path=str(folder / "model.yaml"),
                  design_hash=content_hash(design), model_sha256=digest(folder / "model.yaml"))
    write_json(folder / "report.json", result)
    write_json(folder / "graph.json", design)
    return result


if __name__ == "__main__":
    payload, output = map(Path, sys.argv[1:3])
    try:
        data = json.loads(payload.read_text(encoding="utf-8"))
        write_json(output, {"status": "completed", "result": run(data["root"], data["request"])})
    except Exception as error:
        write_json(output, {"status": "failed", "error": str(error), "traceback": traceback.format_exc()})
        raise SystemExit(1)
