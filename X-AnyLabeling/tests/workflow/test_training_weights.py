from pathlib import Path

import pytest

from anylabeling.services.workflow.training_weights import resolve_training_weight, training_catalog


def test_project_and_bundled_cache_are_resolved_without_download(tmp_path, monkeypatch):
    project = tmp_path / "project"
    bundle = tmp_path / "bundle"
    bundle.mkdir()
    (project / "models").mkdir(parents=True)
    monkeypatch.setenv("XAL_WORKBENCH_HOME", str(tmp_path / "profile"))
    monkeypatch.setenv("XAL_PRETRAINED_HOME", str(bundle))
    (bundle / "yolo26n.pt").write_bytes(b"bundled")
    assert resolve_training_weight("yolo26n.pt", project) == str((bundle / "yolo26n.pt").resolve())
    (project / "models/yolo26n.pt").write_bytes(b"project")
    assert resolve_training_weight("yolo26n.pt", project) == str((project / "models/yolo26n.pt").resolve())
    assert next(item for item in training_catalog(project, "detect") if item["name"] == "yolo26n.pt")["local"]


def test_missing_or_empty_weights_fail_before_worker_unless_download_enabled(tmp_path, monkeypatch):
    monkeypatch.setenv("XAL_WORKBENCH_HOME", str(tmp_path))
    monkeypatch.setenv("XAL_PRETRAINED_HOME", str(tmp_path / "bundle"))
    (tmp_path / "models").mkdir()
    (tmp_path / "models/yolo26n.pt").touch()
    with pytest.raises(ValueError, match="尚未下载"):
        resolve_training_weight("yolo26n.pt", tmp_path, False)
    assert resolve_training_weight("yolo26n.pt", tmp_path, True) == "yolo26n.pt"
    with pytest.raises(ValueError, match="找不到本地模型"):
        resolve_training_weight(str(tmp_path / "missing/yolo26n.pt"), tmp_path, True)
    with pytest.raises(ValueError, match="请选择"):
        resolve_training_weight("", tmp_path)


def test_task_catalog_does_not_offer_detection_weights_for_pose(tmp_path):
    assert all(item["name"].endswith("-pose.pt") for item in training_catalog(tmp_path, "pose"))


def test_scratch_generates_builtin_yaml_without_downloading(tmp_path):
    assert resolve_training_weight("yolo26n.pt", tmp_path, False, "scratch") == "yolo26n.yaml"
    assert resolve_training_weight("yolov8n-pose.pt", tmp_path, False, "scratch") == "yolov8n-pose.yaml"
    with pytest.raises(ValueError, match="内置模型"):
        resolve_training_weight(str(tmp_path / "custom.pt"), tmp_path, True, "scratch")


def test_downloader_retries_and_atomically_caches_valid_asset(tmp_path, monkeypatch):
    import io
    import zipfile
    import requests
    from anylabeling.services.workflow.training_weights import download_training_weight
    buffer = io.BytesIO()
    with zipfile.ZipFile(buffer, "w") as archive:
        archive.writestr("weights/data", b"x" * 100_001)
    data = buffer.getvalue()
    calls, messages = [], []

    class Response:
        headers = {"Content-Length": str(len(data))}
        def __enter__(self): return self
        def __exit__(self, *args): pass
        def raise_for_status(self): pass
        def iter_content(self, size):
            yield data[:50_000]
            assert not (tmp_path / "yolo26n.pt").exists()
            yield data[50_000:]

    def get(url, **kwargs):
        calls.append(url)
        if len(calls) == 1:
            raise requests.Timeout("simulated timeout")
        return Response()

    monkeypatch.setattr(requests, "get", get)
    path = download_training_weight("yolo26n.pt", tmp_path, messages.append)
    assert Path(path).read_bytes() == data
    assert len(calls) == 2 and all(url.startswith("https://github.com/ultralytics/assets/") for url in calls)
    assert messages and not list(tmp_path.glob("*.part"))
    assert download_training_weight("yolo26n.pt", tmp_path) == path
    assert len(calls) == 2


def test_failed_download_has_clear_error_and_leaves_no_partial_cache(tmp_path, monkeypatch):
    import requests
    from anylabeling.services.workflow.training_weights import download_training_weight
    def fail(*args, **kwargs):
        raise requests.Timeout("simulated timeout")
    monkeypatch.setattr(requests, "get", fail)
    with pytest.raises(RuntimeError, match="自动下载失败"):
        download_training_weight("yolo26n.pt", tmp_path)
    assert not list(tmp_path.iterdir())
