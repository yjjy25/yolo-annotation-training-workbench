"""Atomic metadata stays readable under Windows handle contention."""
import ctypes
import os
import threading
import time
from concurrent.futures import ThreadPoolExecutor

import pytest

from anylabeling.services.workflow import project


def test_atomic_json_with_concurrent_reader(tmp_path):
    path = tmp_path / "progress.json"
    project.write_json(path, {"frame": 0, "padding": "x" * 4000})
    stop = threading.Event()

    def reader():
        values = []
        while not stop.is_set():
            value = project.read_json(path)
            assert value["padding"] == "x" * 4000
            values.append(value["frame"])
        return values

    with ThreadPoolExecutor() as pool:
        task = pool.submit(reader)
        try:
            for frame in range(1, 101):
                project.write_json(path, {"frame": frame, "padding": "x" * 4000})
        finally:
            stop.set()
        assert task.result()
    assert project.read_json(path)["frame"] == 100
    assert not list(tmp_path.glob(".save-*"))


@pytest.mark.skipif(os.name != "nt", reason="Windows delete-sharing semantics")
def test_windows_real_handle_temporarily_blocks_replace(tmp_path):
    from ctypes import wintypes
    kernel = ctypes.WinDLL("kernel32", use_last_error=True)
    kernel.CreateFileW.argtypes = [wintypes.LPCWSTR, wintypes.DWORD, wintypes.DWORD,
                                  wintypes.LPVOID, wintypes.DWORD, wintypes.DWORD, wintypes.HANDLE]
    kernel.CreateFileW.restype = wintypes.HANDLE
    kernel.CloseHandle.argtypes = [wintypes.HANDLE]
    path = tmp_path / "progress.json"
    project.write_json(path, {"frame": 1})
    # GENERIC_READ + FILE_SHARE_READ, intentionally excludes FILE_SHARE_DELETE.
    handle = kernel.CreateFileW(str(path), 0x80000000, 1, None, 3, 0, None)
    assert handle != wintypes.HANDLE(-1).value
    released = threading.Event()

    def release():
        time.sleep(.20)
        kernel.CloseHandle(handle)
        released.set()

    thread = threading.Thread(target=release)
    thread.start()
    try:
        project.write_json(path, {"frame": 2})
    finally:
        thread.join()
    assert released.is_set()
    assert project.read_json(path) == {"frame": 2}
    assert not list(tmp_path.glob(".save-*"))


def test_permanent_denial_keeps_original_and_reports_error(tmp_path, monkeypatch):
    path = tmp_path / "progress.json"
    project.write_json(path, {"frame": 1})
    attempts = []

    def denied(*args):
        attempts.append(args)
        raise PermissionError("permanent denial")

    monkeypatch.setattr(project.os, "replace", denied)
    monkeypatch.setattr(project.time, "sleep", lambda _: None)
    with pytest.raises(PermissionError, match="permanent denial"):
        project.write_json(path, {"frame": 2})
    assert len(attempts) == 9
    assert project.read_json(path) == {"frame": 1}
    assert not list(tmp_path.glob(".save-*"))
