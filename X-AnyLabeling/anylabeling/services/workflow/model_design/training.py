"""Native model objects remain serializable; all training rebuilds replay the design."""
import copy
from pathlib import Path
from ultralytics.models.yolo.detect.train import DetectionTrainer
from ultralytics.utils import YAML
from .core import build, signature, content_hash


class DesignDetectionTrainer(DetectionTrainer):
    def get_model(self, cfg=None, weights=None, verbose=True):
        config = YAML.load(cfg) if isinstance(cfg, (str, Path)) else cfg
        if not isinstance(config, dict) or "workbench_design" not in config:
            return super().get_model(cfg, weights, verbose)
        design = copy.deepcopy(config["workbench_design"])
        if design["nc"] != self.data["nc"] or self.data["channels"] != 3:
            raise ValueError("设计类别数或输入通道与数据集不一致，请重新检查设计。")
        model = self.set_model_names_for_load(build(design))
        if weights is not None:
            if content_hash(signature(weights)) != content_hash(signature(model)):
                raise ValueError("权重结构与设计不匹配，禁止隐式迁移。")
            model.load_state_dict(weights.state_dict(), strict=True)
        return model


def load_training_model(path):
    """Preserve checked design metadata instead of guessing scale from model.yaml."""
    from ultralytics import YOLO
    from ultralytics.utils import DEFAULT_CFG_DICT
    source = Path(path)
    config = YAML.load(source) if source.suffix.lower() in {".yaml", ".yml"} and source.is_file() else None
    if not isinstance(config, dict) or "workbench_design" not in config:
        return YOLO(path)

    class DesignYOLO(YOLO):
        # Mirrors Model._new's wrapper setup, using our pinned native builder.
        # Checkpoints still contain native DetectionModel, never this wrapper.
        def _new(self, cfg, task=None, verbose=False):
            self.cfg, self.task = str(cfg), "detect"
            self.model = build(copy.deepcopy(config["workbench_design"]))
            self.overrides.update(model=self.cfg, task=self.task)
            self.model.args = {**DEFAULT_CFG_DICT, **self.overrides}
            self.model.task = self.task
            self.model_name = self.cfg

    model = DesignYOLO(str(source), task="detect")
    print(f"结构设计已加载：{config['workbench_design']['template']}，规模 {model.model.yaml['scale']}；已恢复参数修改，从零训练。")
    return model


def train_model(model, args):
    if "workbench_design" in getattr(model.model, "yaml", {}):
        if args.get("multi_scale") or args.get("rect") or "," in str(args.get("device", "cpu")):
            raise ValueError("设计模型当前仅支持固定尺寸、CPU 或单卡训练。")
        model.train(trainer=DesignDetectionTrainer, **args)
    else:
        model.train(**args)
