"""Construction, source identity and Trainer reconstruction regression boundaries."""
import copy
from types import SimpleNamespace
import pytest

from anylabeling.services.workflow.model_design.core import (
    build, template_config, inspect_model, signature, content_hash, checked_configuration, trace_model,
)
from anylabeling.services.workflow.model_design.worker import run


def design(template="yolov8n", edits=None):
    _, source = template_config(template, 1)
    return dict(schema=1, template=template, source=source, nc=1, imgsz=64, seed=42, edits=edits or [])


@pytest.fixture(autouse=True)
def threads():
    import torch
    previous = torch.get_num_threads()
    torch.set_num_threads(2)
    yield
    torch.set_num_threads(previous)


@pytest.mark.parametrize("template", ["yolov8n", "yolo11n"])
def test_no_edit_roundtrip_and_source_coverage(template):
    import torch
    from pathlib import Path
    import ultralytics
    from ultralytics.utils import YAML
    from ultralytics.nn.tasks import DetectionModel
    # Compare against a separately loaded native configuration, not our own builder twice.
    native_path = Path(ultralytics.__file__).parent / "cfg/models" / ({"yolov8n":"v8/yolov8.yaml", "yolo11n":"11/yolo11.yaml"}[template])
    cfg = YAML.load(native_path)
    cfg.update(scale="n", nc=1)
    a = build(design(template))
    with torch.random.fork_rng(devices=[]):
        torch.manual_seed(42)
        b = DetectionModel(copy.deepcopy(cfg), ch=3, verbose=False)
    assert content_hash(signature(a)) == content_hash(signature(b))
    observed=inspect_model(a)
    assert [(row["id"],row["type"]) for row in observed["module_tree"]] == [(path,type(module).__name__) for path,module in a.named_modules(remove_duplicate=False) if path]
    assert all(info["source"].get("sha256") for info in observed["layers"])
    assert [node["from"] for node in observed["graph"]] == [row[0] for row in cfg["backbone"] + cfg["head"]]
    assert sum(node["section"]=="backbone" for node in observed["graph"])==len(a.yaml["backbone"])
    assert observed["graph"][-1]["section"]=="output"
    assert all(node["section"]=="fusion" for node in observed["graph"][len(a.yaml["backbone"]):-1])
    assert all((a.state_dict()[k] == value).all() for k, value in b.state_dict().items())


def test_single_layer_activation_does_not_change_other_instances():
    original = build(design())
    changed = build(design(edits=[dict(id="model.1.act", field="activation", value="ReLU")]))
    assert type(changed.model[1].act).__name__ == "ReLU"
    assert type(changed.model[0].act).__name__ == "SiLU"
    assert type(original.model[1].act).__name__ == "SiLU"
    assert (original.model[1].conv.weight == changed.model[1].conv.weight).all()


def test_trainer_rebuild_replays_all_modifications():
    from anylabeling.services.workflow.model_design.training import DesignDetectionTrainer
    d = design(edits=[dict(id="model.0.conv",field="kernel",value=5),
                      dict(id="model.2.m.0.cv1.act",field="activation",value="ReLU"),
                      dict(id="model.9.m",field="pool_kernel",value=7)])
    model = build(d)
    trainer = object.__new__(DesignDetectionTrainer)
    trainer.data = dict(nc=1, channels=3, names={0:"object"})
    trainer.args = SimpleNamespace(cls_remap=True)
    restored = trainer.get_model(copy.deepcopy(model.yaml), model, verbose=False)
    assert signature(restored) == signature(model)
    assert restored.model[0].conv.kernel_size == (5,5)
    assert restored.model[9].m.kernel_size == 7


def test_checked_snapshot_rejects_tampering_and_wrong_training_input(tmp_path):
    result = run(tmp_path,dict(template="yolov8n",nc=1,imgsz=64,seed=42,edits=[],action="check"))
    path = result["model_path"]
    assert checked_configuration(path,tmp_path,1,64)["checks"]["backward"]
    with pytest.raises(ValueError): checked_configuration(path,tmp_path,1,128)
    from pathlib import Path
    Path(path).write_text(Path(path).read_text()+"\n# external modification\n")
    with pytest.raises(ValueError,match="变化"): checked_configuration(path,tmp_path,1,64)


@pytest.mark.parametrize("patch", [dict(id="__class__",field="activation",value="ReLU"),
    dict(id="model.0.act",field="activation",value="__import__('os')"),
    dict(id="model.0.conv",field="kernel",value=0),
    dict(id="model.22.dfl.conv",field="kernel",value=5)])
def test_rejects_unregistered_edits(patch):
    with pytest.raises(ValueError): build(design(edits=[patch]))


def test_dependency_change_requires_new_check():
    d=design();d["source"]["sha256"]="invalid"
    with pytest.raises(ValueError,match="来源"): build(d)


def test_noop_kernel_edit_preserves_initial_weights():
    original=build(design())
    unchanged=build(design(edits=[dict(id="model.0.conv",field="kernel",value=3)]))
    assert all((original.state_dict()[key]==value).all() for key,value in unchanged.state_dict().items())


def test_report_does_not_finish_job_before_process_exits(tmp_path):
    from PyQt6 import QtCore
    from anylabeling.views.workflow.model_design_job import ModelDesignJob
    from anylabeling.services.workflow.project import write_json
    job=object.__new__(ModelDesignJob)
    job.root=str(tmp_path);job.output=tmp_path/"result.json"
    write_json(job.output,{"status":"completed","result":{}})
    job.process=SimpleNamespace(state=lambda:QtCore.QProcess.ProcessState.Running)
    assert job.status(SimpleNamespace(root=tmp_path))["status"]=="running"
    job.process=SimpleNamespace(state=lambda:QtCore.QProcess.ProcessState.NotRunning)
    assert job.status(SimpleNamespace(root=tmp_path))["status"]=="completed"


@pytest.mark.parametrize("template,head_sources", [("yolov8n", [15,18,21]), ("yolo11n", [16,19,22])])
def test_native_module_execution_shapes_and_connections(template, head_sources):
    model = build(design(template))
    flags = [m.training for m in model.modules()]
    weights = {k:v.clone() for k,v in model.state_dict().items()}
    trace = trace_model(model, 128)
    assert trace["input"] == [1,3,128,128]
    assert trace["detection_strides"] == [8,16,32]
    assert len(trace["modules"]) == len(model.model)
    assert all(row["connections_verified"] for row in trace["modules"].values())
    assert trace["modules"][0]["output"] == [1,16,64,64]
    assert trace["modules"][1]["output"] == [1,32,32,32]
    last = trace["modules"][len(model.model)-1]
    assert last["sources"] == head_sources
    assert [dims[-2:] for dims in last["input"]] == [[16,16],[8,8],[4,4]]
    assert last["output"][0] == [1,5,336]
    for i,module in enumerate(model.model):
        if type(module).__name__ == "Concat":
            row = trace["modules"][i]
            assert row["output"][1] == sum(dims[1] for dims in row["input"])
            assert all(dims[2:] == row["output"][2:] for dims in row["input"])
    assert flags == [m.training for m in model.modules()]
    assert all((model.state_dict()[k] == value).all() for k,value in weights.items())


def test_design_loader_keeps_explicit_scale_and_edits_without_filename_guess(tmp_path):
    import logging
    from ultralytics.utils import YAML, LOGGER
    from anylabeling.services.workflow.model_design.training import load_training_model
    model = build(design(edits=[dict(id="model.0.conv",field="kernel",value=5),
                               dict(id="model.0.act",field="activation",value="GELU")]))
    path = tmp_path / "model.yaml"
    YAML.save(path, copy.deepcopy(model.yaml))
    messages = []
    class Capture(logging.Handler):
        def emit(self, record): messages.append(record.getMessage())
    handler = Capture()
    LOGGER.addHandler(handler)
    try:
        loaded = load_training_model(str(path))
    finally:
        LOGGER.removeHandler(handler)
    assert loaded.model.yaml["scale"] == "n"
    assert signature(loaded.model) == signature(model)
    assert all((loaded.model.state_dict()[key] == value).all() for key,value in model.state_dict().items())
    assert not any("no model scale passed" in message for message in messages)


def test_catalog_is_unique_and_scales_resolve_without_fallback():
    from anylabeling.services.workflow.model_design.core import catalog, TEMPLATES, TEMPLATE_SCALES, validate_design
    data = catalog()
    assert len(data["families"]) == 5
    ids = [variant["id"] for family in data["families"] for variant in family["variants"]]
    assert len(ids) == len(set(ids)) == len(TEMPLATES) == 25
    for family in data["families"]:
        assert [v["scale"] for v in family["variants"]] == list("nsmlx")
        for variant in family["variants"]:
            config,_ = template_config(variant["id"],1)
            assert config["scale"] == TEMPLATE_SCALES[variant["id"]] == variant["scale"]
    d=design();d["imgsz"]=1280;validate_design(d)
    for bad in (0,63,1279,1281,1312):
        with pytest.raises(ValueError): validate_design(dict(d,imgsz=bad))
    with pytest.raises(ValueError): template_config("yolo11z",1)


def test_non_nano_scale_survives_design_wrapper_and_trainer(tmp_path):
    from ultralytics.utils import YAML
    from anylabeling.services.workflow.model_design.training import load_training_model, DesignDetectionTrainer
    from anylabeling.services.workflow.model_design.core import TEMPLATE_SCALES
    model=build(design("yolo26s",edits=[dict(id="model.1.act",field="activation",value="GELU")]))
    path=tmp_path/"model.yaml";YAML.save(path,copy.deepcopy(model.yaml))
    wrapper=load_training_model(str(path))
    assert wrapper.model.yaml["scale"]=="s"
    assert signature(wrapper.model)==signature(model)
    trainer=object.__new__(DesignDetectionTrainer)
    trainer.data=dict(nc=1,channels=3,names={0:"object"});trainer.args=SimpleNamespace(cls_remap=True)
    restored=trainer.get_model(copy.deepcopy(wrapper.model.yaml),None,verbose=False)
    assert restored.yaml["scale"]=="s"
    assert type(restored.model[1].act).__name__=="GELU"


def test_official_reference_normalizes_only_line_endings_and_blocks_changes(tmp_path):
    from pathlib import Path
    import ultralytics
    from anylabeling.services.workflow.model_design.reference import verify_official, UPSTREAM
    package=Path(ultralytics.__file__).parent
    names=['cfg/models/v8/yolov8.yaml','nn/tasks.py','nn/modules/conv.py','nn/modules/block.py','nn/modules/head.py']
    for name in names:
        target=tmp_path/name;target.parent.mkdir(parents=True,exist_ok=True)
        target.write_bytes((package/name).read_bytes().replace(b'\r\n',b'\n'))
    verified=verify_official(tmp_path,UPSTREAM['version'],names[0])
    assert len(verified['normalized_files'])==5
    target=tmp_path/'nn/modules/conv.py';target.write_bytes(target.read_bytes()+b'\n# unreviewed change\n')
    with pytest.raises(ValueError,match='阻止构建'):verify_official(tmp_path,UPSTREAM['version'],names[0])


def test_official_reference_rejects_unreviewed_library_version():
    from pathlib import Path
    import ultralytics
    from anylabeling.services.workflow.model_design.reference import verify_official
    with pytest.raises(ValueError,match='版本不同'):
        verify_official(Path(ultralytics.__file__).parent,'unreviewed-version','cfg/models/v8/yolov8.yaml')


def test_inspect_automatically_measures_leaf_io_and_preserves_shared_call_context(tmp_path):
    result=run(tmp_path,dict(template="yolov8n",nc=1,imgsz=64,seed=42,edits=[],action="inspect"))
    assert result["shapes"]["model.0.conv"]["output"]==[1,16,32,32]
    assert result["shapes"]["model.0.act"]["output"]==[1,16,32,32]
    assert result["shapes"]["model.1.act"]["output"]==[1,32,16,16]
    assert len(result["shapes"]["model.9.m"]["calls"])==3
    assert result["measurement"]["design_hash"]==content_hash(result["design"])
    second=run(tmp_path,dict(template="yolov8n",nc=1,imgsz=128,seed=42,
        edits=[dict(id="model.0.conv",field="kernel",value=5),dict(id="model.0.act",field="activation",value="LeakyReLU")],action="inspect"))
    assert second["shapes"]["model.0.conv"]["output"]==[1,16,64,64]
    assert second["shapes"]["model.0.act"]["output"]==[1,16,64,64]
    assert second["measurement"]["id"]!=result["measurement"]["id"]
    assert second["modified"]["layers"][0]["params"]["kernel"]==[5,5]


def test_checked_eval_io_is_not_overwritten_by_training_check(tmp_path):
    result=run(tmp_path,dict(template="yolov8n",nc=1,imgsz=64,seed=42,edits=[],action="check"))
    assert result["shapes"]["model.0.conv"]["output"][0]==1
    assert result["training_shapes"]["model.0.conv"]["output"][0]==2
    assert result["execution"]["input"]==[1,3,64,64]
