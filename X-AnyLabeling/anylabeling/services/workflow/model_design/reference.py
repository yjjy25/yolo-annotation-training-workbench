"""Pinned official architecture reference. Do not update from an unreviewed local install.

Retrieved 2026-10-23 from the official ultralytics/ultralytics v8.4.178 tag.
Hashes normalize CRLF to LF only. See 文档/官方结构依据核查_证据_20261023.
Upstream license: AGPL-3.0; https://github.com/ultralytics/ultralytics
"""
UPSTREAM = {'repository': 'https://github.com/ultralytics/ultralytics', 'tag': 'v8.4.178', 'commit': '2849d4f03f63e114382026bab3f68cf52d9c9a1e', 'version': '8.4.178'}
OFFICIAL_FILES = {'cfg/models/v5/yolov5.yaml': '403f1d45ee5ee72b39db05cf2af3499fadb61ffde25f48cfcc4ff6fbed9d671d', 'cfg/models/v8/yolov8.yaml': '405a3c302eb6096103a99af4d82c1d2d8b2bbff469a228c55aac944b2c19672a', 'cfg/models/11/yolo11.yaml': '43d8a7c86acc77282ddf4966d6526e091e5b064c140ed4a6e4c0b68ecbc3784c', 'cfg/models/12/yolo12.yaml': '65e03c2eeca62573cd8d9e719319191e4724b4368a0f35016f629cde008b0b5c', 'cfg/models/26/yolo26.yaml': 'b1d1fa0c69eced64f9939536038bd8d697c32e72200b34187a767de431af7ef0', 'nn/tasks.py': '1048ab8db7504e7c57a77d05bfbd855e9de0ef477e15a5aae8cdb7e8a958246a', 'nn/modules/conv.py': '927d511e0b494307e5e8104893f28addf27425999eab0ec83452bbf1f3b4df17', 'nn/modules/block.py': '3be57fed557f10f76701f66cf91788bc6ec9ce1683f1a34b407aba65847c744f', 'nn/modules/head.py': 'b471bb8a39cc1e38672c20feaa8c28bdf43739adb8eafd14226807b34b31f3ee'}


def verify_official(package, version, template):
    import hashlib
    if version != UPSTREAM["version"]:
        raise ValueError("模型结构依据与当前 Ultralytics 版本不同，需要先核对官方版本再开放构建。")
    selected = [template, "nn/tasks.py", "nn/modules/conv.py", "nn/modules/block.py", "nn/modules/head.py"]
    verified = {}
    for name in selected:
        digest = hashlib.sha256((package / name).read_bytes().replace(b"\r\n", b"\n")).hexdigest()
        if OFFICIAL_FILES.get(name) != digest:
            raise ValueError(f"{name} 与固定官方结构依据不一致，已阻止构建；不能把本机改动自动当作官方结构。")
        verified[name] = digest
    return {**UPSTREAM, "normalized_files": verified}
