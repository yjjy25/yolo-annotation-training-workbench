"""Content-addressed image storage for frozen dataset snapshots.

``Project.build_dataset`` used to ``shutil.copy2`` every reviewed picture into
every new snapshot, so a project with N snapshots stored N complete copies of
the same JPEGs.  A snapshot must stay byte-identical to what was reviewed --
that is the whole point of freezing a split -- so ``images/`` stays an
independent editable copy while every snapshot image becomes a hard link to a
single shared object under ``datasets/.objects/<sha256[:2]>/<sha256><ext>``.

Hard links are invisible to Ultralytics, to the manifest digest checks and to
ZIP export.  Deleting a snapshot cannot destroy an object still referenced by
another snapshot (the inode survives), and deleting ``.objects`` itself leaves
every snapshot intact.  On filesystems without hard-link support we fall back
to a regular copy, so behaviour degrades gracefully rather than breaking.
"""
from __future__ import annotations

import hashlib
import json
import os
import re
import shutil
import tempfile
import uuid
from pathlib import Path

OBJECTS_DIR = ".objects"


def sha256(path):
    with Path(path).open("rb") as stream:
        return hashlib.file_digest(stream, "sha256").hexdigest()


def object_path(root, key, suffix=""):
    return Path(root) / "datasets" / OBJECTS_DIR / key[:2] / (key + suffix.lower())


def _link(source, destination):
    """Create ``destination`` as a hard link. False when links are unavailable."""
    try:
        os.link(source, destination)
        return True
    except (OSError, NotImplementedError, AttributeError):
        return False


def _ensure_object(root, source, key, suffix, promote=False):
    """Return the shared object for ``key``, creating it exclusively once.

    ``promote=True`` turns an already frozen snapshot file into the object
    without copying a byte.  It must never be used for ``images/`` sources:
    those stay editable, so building a snapshot must keep an independent copy.
    """
    obj = object_path(root, key, suffix)
    if obj.is_file() and sha256(obj) == key:
        return obj, True
    obj.parent.mkdir(parents=True, exist_ok=True)
    if promote and _link(source, obj):
        return obj, False
    handle, temporary = tempfile.mkstemp(prefix=".incoming-", dir=obj.parent)
    os.close(handle)
    temp = Path(temporary)
    try:
        shutil.copy2(source, temp)
        if sha256(temp) != key:
            raise ValueError("图片在生成快照期间发生变化，请重新生成数据集。")
        try:
            os.link(temp, obj)  # Exclusive: never replaces a live shared object.
        except FileExistsError:
            pass
        except OSError:
            if not obj.is_file():
                os.replace(temp, obj)
        if not obj.is_file() or sha256(obj) != key:
            raise OSError("无法建立共享图片对象，请检查磁盘权限。")
        return obj, False
    finally:
        temp.unlink(missing_ok=True)


def publish_image(root, source, destination, expected_digest=None):
    """Place one snapshot image, reusing the shared object when possible.

    Returns ``"linked"`` when the snapshot holds a hard link, ``"copied"`` on a
    filesystem without hard-link support.  ``expected_digest`` is the plan's
    fingerprint and is verified on both the object and the published file.
    """
    source, destination = Path(source), Path(destination)
    key = expected_digest or sha256(source)
    obj, _ = _ensure_object(root, source, key, source.suffix)
    destination.parent.mkdir(parents=True, exist_ok=True)
    if destination.exists():
        raise FileExistsError(f"快照图片已存在：{destination}")
    if _link(obj, destination):
        mode = "linked"
    else:
        shutil.copy2(obj, destination)
        mode = "copied"
    if sha256(destination) != key:
        raise ValueError(f"快照图片校验失败：{destination.name}")
    return mode


def _probe_links(directory):
    """Check hard-link support before touching any existing snapshot file."""
    handle, temporary = tempfile.mkstemp(prefix=".probe-", dir=directory)
    os.close(handle)
    source = Path(temporary)
    target = source.with_name(source.name + ".link")
    try:
        source.write_bytes(b"probe")
        if not _link(source, target):
            return False
        return (source.stat().st_dev, source.stat().st_ino) == (target.stat().st_dev, target.stat().st_ino)
    finally:
        target.unlink(missing_ok=True)
        source.unlink(missing_ok=True)


def _snapshot_images(datasets):
    from .project import IMAGE_EXTENSIONS

    files, orphans, snapshots = [], [], 0
    for snapshot in sorted(p for p in datasets.iterdir() if p.is_dir() and not p.name.startswith(".")):
        # Snapshot layouts changed over time (images/train, train/<class>, ...);
        # walk the whole snapshot so legacy exports are compacted too.
        found = 0
        for path in sorted(snapshot.rglob("*")):
            if not path.is_file() or path.suffix.lower() not in IMAGE_EXTENSIONS:
                continue
            found += 1
            if path.name.startswith("."):
                orphans.append(path)
            else:
                files.append(path)
        if found:
            snapshots += 1
    return files, orphans, snapshots


def compact_snapshots(root, apply=False):
    """Merge byte-identical snapshot images into hard links to shared objects.

    ``apply=False`` (default) is a read-only estimate: it hashes every snapshot
    image and reports how much disk space ``apply=True`` would reclaim.  No
    image content is ever deleted -- after applying, each unique byte string
    still exists once in ``.objects`` and every snapshot path still points at
    those exact bytes.  Hidden stray files are reported but never touched.
    """
    root = Path(root)
    datasets = root / "datasets"
    if not datasets.is_dir():
        raise ValueError("项目里没有 datasets 目录。")
    files, orphans, snapshots = _snapshot_images(datasets)
    groups = {}
    for path in files:
        groups.setdefault(sha256(path), []).append(path)
    total_bytes = sum(path.stat().st_size for path in files)
    unique_bytes = sum(members[0].stat().st_size for members in groups.values())
    # Count real disk blocks, not logical sizes: already-linked snapshots must
    # report zero reclaimable bytes after compaction.
    physical = {}
    for path in files:
        stat = path.stat()
        physical[(stat.st_dev, stat.st_ino)] = stat.st_size
    physical_bytes = sum(physical.values())
    objects_dir = datasets / OBJECTS_DIR
    object_count = sum(1 for path in objects_dir.rglob("*") if path.is_file()) if objects_dir.is_dir() else 0
    report = {"snapshots": snapshots, "images": len(files), "unique": len(groups),
              "total_bytes": total_bytes, "unique_bytes": unique_bytes,
              "physical_bytes": physical_bytes,
              "reclaimable_bytes": max(0, physical_bytes - unique_bytes),
              "orphan_files": len(orphans),
              "orphan_bytes": sum(path.stat().st_size for path in orphans),
              "objects": object_count,
              "applied": False, "linked": 0, "already_linked": 0, "failed": [],
              "supported": True}
    if not apply or not files:
        return report
    if not _probe_links(datasets):
        report["supported"] = False
        report["failed"] = [{"path": "", "error": "当前文件系统不支持硬链接，未改动任何文件。"}]
        return report

    for key, members in groups.items():
        suffix = members[0].suffix
        obj, _ = _ensure_object(root, members[0], key, suffix, promote=True)
        identity = (obj.stat().st_dev, obj.stat().st_ino)
        for path in members:
            if (path.stat().st_dev, path.stat().st_ino) == identity:
                report["already_linked"] += 1
                continue
            temporary = path.with_name("." + path.name + ".link-" + uuid.uuid4().hex[:8])
            try:
                if not _link(obj, temporary):
                    raise OSError("无法创建硬链接。")
                os.replace(temporary, path)
                report["linked"] += 1
            except OSError as error:
                temporary.unlink(missing_ok=True)
                report["failed"].append({"path": str(path), "error": str(error)})
    pruned = prune_objects(root, apply=True)
    report["pruned_objects"] = pruned["removed"]
    report["pruned_bytes"] = pruned["bytes"]
    report["applied"] = True
    return report


def prune_objects(root, apply=False):
    """Drop shared objects that no surviving snapshot references.

    Called after a failed ``build_dataset`` rollback and after compaction, so
    an aborted export cannot leave a gigabyte of unreachable JPEGs behind.
    Conservative by design: if any snapshot manifest is missing or unreadable,
    nothing is removed.
    """
    root = Path(root)
    datasets = root / "datasets"
    objects = datasets / OBJECTS_DIR
    report = {"objects": 0, "orphans": 0, "bytes": 0, "removed": 0, "applied": False, "skipped": False}
    if not objects.is_dir():
        return report
    keys, incomplete = set(), False
    for snapshot in datasets.iterdir():
        if not snapshot.is_dir() or snapshot.name.startswith("."):
            continue
        manifest = snapshot / "manifest.json"
        if not manifest.is_file():
            incomplete = True
            continue
        try:
            rows = json.loads(manifest.read_text(encoding="utf-8")).get("images", [])
            keys.update(row["image_sha256"] for row in rows if isinstance(row, dict) and isinstance(row.get("image_sha256"), str))
        except (OSError, ValueError, TypeError):
            incomplete = True
    candidates = [path for path in objects.rglob("*")
                  if path.is_file() and re.fullmatch(r"[0-9a-f]{64}", path.stem)]
    # A live snapshot holding a hard link keeps the inode alive; never remove
    # such an object even if its manifest key is missing or outdated.
    orphans = [path for path in candidates
               if path.stem not in keys and path.stat().st_nlink <= 1]
    report.update(objects=len(candidates), orphans=len(orphans),
                  bytes=sum(path.stat().st_size for path in orphans), skipped=incomplete)
    if incomplete or not apply:
        return report
    for path in orphans:
        path.unlink(missing_ok=True)
    for folder in sorted((path for path in objects.iterdir() if path.is_dir()), reverse=True):
        try:
            folder.rmdir()  # Only empty prefix folders disappear.
        except OSError:
            pass
    try:
        objects.rmdir()  # Leave no empty hidden folder behind after a rollback.
    except OSError:
        pass
    report["removed"] = len(orphans)
    report["applied"] = True
    return report
