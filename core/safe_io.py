"""Unified local-first safe file I/O gateway for SmartLocalNote.

Enforces:
1. Path whitelist & traversal protection (`resolve_safe_path`).
2. Automatic pre-write `.bak` snapshots in `data/.snapshots/<md5>/` (max 15 per file).
3. Atomic writes via same-directory temp file + `fsync` + `os.replace`.
4. Snapshot listing and one-click rollback (`list_snapshots`, `restore_snapshot`).
5. Per-file privacy lock enforcement (`is_private`, `assert_not_private`, `set_private`).
"""

from __future__ import annotations

from datetime import datetime
import hashlib
import json
import os
from pathlib import Path
import shutil
from typing import Any, Callable

from config import (
    DATA_DIR,
    FILES_INDEX_FILE,
    SNAPSHOTS_DIR,
    atomic_write_json,
    ensure_data_dirs,
    get_default_notes_dir,
    load_config,
    save_config,
)

MAX_SNAPSHOTS_PER_FILE = 15
SUPPORTED_DOC_EXTS = {".md", ".txt", ".pdf", ".xlsx"}

_snapshot_hook: Callable[[dict[str, Any]], None] | None = None


def set_snapshot_hook(callback: Callable[[dict[str, Any]], None] | None) -> None:
    """Register an optional listener invoked whenever a new `.bak` snapshot is created."""
    global _snapshot_hook
    _snapshot_hook = callback


def _norm_str(path: Path) -> str:
    return str(path.resolve())


def load_files_index() -> dict[str, list[str]]:
    """Read `data/files.json` safely."""
    ensure_data_dirs()
    try:
        with open(FILES_INDEX_FILE, "r", encoding="utf-8") as fh:
            raw = json.load(fh)
        if not isinstance(raw, dict):
            return {"files": [], "dirs": []}
        return {
            "files": [str(p) for p in raw.get("files", []) if isinstance(p, str)],
            "dirs": [str(p) for p in raw.get("dirs", []) if isinstance(p, str)],
        }
    except (OSError, json.JSONDecodeError):
        return {"files": [], "dirs": []}


def save_files_index(index: dict[str, list[str]]) -> dict[str, list[str]]:
    """Atomically persist `data/files.json`."""
    ensure_data_dirs()
    cleaned = {
        "files": list(dict.fromkeys(index.get("files", []))),
        "dirs": list(dict.fromkeys(index.get("dirs", []))),
    }
    atomic_write_json(FILES_INDEX_FILE, cleaned)
    return cleaned


def _is_within(child: Path, parent: Path) -> bool:
    try:
        child.resolve().relative_to(parent.resolve())
        return True
    except ValueError:
        return False


def is_path_allowed(target: Path) -> bool:
    """Check whether resolved `target` is inside authorized dirs or explicitly imported files."""
    resolved = target.resolve()

    # Always allow project data/ and configured default notes directory.
    if _is_within(resolved, DATA_DIR) or _is_within(resolved, get_default_notes_dir()):
        return True

    cfg = load_config()
    for raw_dir in cfg.get("whitelist_dirs", []):
        if raw_dir and _is_within(resolved, Path(raw_dir)):
            return True

    idx = load_files_index()
    for raw_dir in idx.get("dirs", []):
        if raw_dir and _is_within(resolved, Path(raw_dir)):
            return True

    resolved_s = str(resolved)
    for raw_file in idx.get("files", []):
        if raw_file:
            try:
                if str(Path(raw_file).resolve()) == resolved_s:
                    return True
            except OSError:
                continue

    return False


def resolve_safe_path(path_str: str, *, must_exist: bool = False) -> Path:
    """Resolve `path_str` and enforce whitelist & path-traversal protection."""
    if not path_str or not isinstance(path_str, str):
        raise ValueError("文件路径不能为空")
    if "\x00" in path_str:
        raise PermissionError("非法路径字符")

    raw_parts = Path(path_str).parts
    resolved = Path(path_str).expanduser().resolve()

    if not is_path_allowed(resolved):
        hint = "检测到越权路径穿越" if ".." in raw_parts else "路径不在授权白名单或已导入列表内"
        raise PermissionError(f"安全拦截：{hint} ({Path(path_str).name})")

    if must_exist and not resolved.exists():
        raise FileNotFoundError(f"文件不存在：{resolved.name}")

    return resolved


def snapshot_dir_for(target_path: Path) -> Path:
    """Return `data/.snapshots/<md5_of_resolved_path>` directory for a file."""
    digest = hashlib.md5(_norm_str(target_path).encode("utf-8")).hexdigest()
    return SNAPSHOTS_DIR / digest


def create_snapshot(target_path: Path, max_keep: int = MAX_SNAPSHOTS_PER_FILE) -> Path | None:
    """Copy existing file to a timestamped `.bak` snapshot and prune snapshots above `max_keep`."""
    resolved = target_path.resolve()
    if not resolved.exists() or not resolved.is_file():
        return None

    snap_dir = snapshot_dir_for(resolved)
    snap_dir.mkdir(parents=True, exist_ok=True)

    stamp = datetime.now().strftime("%Y%m%d_%H%M%S_%f")[:19]  # YYYYMMDD_HHMMSS_fff
    snap_path = snap_dir / f"{stamp}.bak"
    counter = 1
    while snap_path.exists():
        snap_path = snap_dir / f"{stamp}_{counter}.bak"
        counter += 1

    shutil.copy2(resolved, snap_path)

    # Prune oldest snapshots beyond max_keep
    existing = sorted(snap_dir.glob("*.bak"), key=lambda p: p.name)
    if len(existing) > max_keep:
        for old_snap in existing[: len(existing) - max_keep]:
            try:
                old_snap.unlink()
            except OSError:
                pass

    if _snapshot_hook is not None:
        try:
            _snapshot_hook({
                "path": str(resolved),
                "name": resolved.name,
                "snapshot_id": snap_path.name,
            })
        except Exception:
            pass

    return snap_path


def list_snapshots(path_str: str) -> list[dict[str, Any]]:
    """Return descending history of `.bak` snapshots for an allowed file."""
    target = resolve_safe_path(path_str)
    snap_dir = snapshot_dir_for(target)
    if not snap_dir.exists():
        return []

    items: list[dict[str, Any]] = []
    for snap in sorted(snap_dir.glob("*.bak"), key=lambda p: p.name, reverse=True):
        try:
            st = snap.stat()
            items.append({
                "id": snap.name,
                "filename": snap.name,
                "size": st.st_size,
                "created_at": datetime.fromtimestamp(st.st_mtime).isoformat(timespec="seconds"),
            })
        except OSError:
            continue
    return items


def _fsync_file(path: Path) -> None:
    with open(path, "rb") as fh:
        os.fsync(fh.fileno())


def atomic_write_bytes(
    path_str: str | Path,
    data: bytes,
    *,
    snapshot: bool = True,
) -> dict[str, Any]:
    """Atomically write bytes to an authorized file with optional pre-write `.bak` snapshot."""
    target = resolve_safe_path(str(path_str))
    target.parent.mkdir(parents=True, exist_ok=True)

    snap_path = create_snapshot(target) if (snapshot and target.exists()) else None
    tmp_path = target.parent / f".{target.name}.{os.getpid()}.tmp"

    try:
        with open(tmp_path, "wb") as fh:
            fh.write(data)
            fh.flush()
            os.fsync(fh.fileno())
        os.replace(tmp_path, target)
    except BaseException:
        if tmp_path.exists():
            try:
                tmp_path.unlink()
            except OSError:
                pass
        raise

    return {
        "path": str(target),
        "snapshot_id": snap_path.name if snap_path else None,
        "bytes": len(data),
    }


def atomic_write_text(
    path_str: str | Path,
    text: str,
    *,
    encoding: str = "utf-8",
    snapshot: bool = True,
) -> dict[str, Any]:
    """Atomically write UTF-8 text to an authorized file with pre-write snapshot."""
    return atomic_write_bytes(path_str, text.encode(encoding), snapshot=snapshot)


def atomic_save_via_callback(
    path_str: str | Path,
    writer_fn: Callable[[Path], None],
    *,
    snapshot: bool = True,
) -> dict[str, Any]:
    """Safely save binary formats (openpyxl/PyMuPDF) via temp file preserving suffix + fsync + os.replace."""
    target = resolve_safe_path(str(path_str))
    target.parent.mkdir(parents=True, exist_ok=True)

    snap_path = create_snapshot(target) if (snapshot and target.exists()) else None
    # Preserve extension (e.g. .xlsx / .pdf) so format writers recognize it cleanly.
    tmp_path = target.parent / f".{target.stem}.{os.getpid()}.tmp{target.suffix}"

    try:
        writer_fn(tmp_path)
        _fsync_file(tmp_path)
        os.replace(tmp_path, target)
    except BaseException:
        if tmp_path.exists():
            try:
                tmp_path.unlink()
            except OSError:
                pass
        raise

    return {
        "path": str(target),
        "snapshot_id": snap_path.name if snap_path else None,
        "bytes": target.stat().st_size if target.exists() else 0,
    }


def restore_snapshot(path_str: str, snapshot_id: str) -> dict[str, Any]:
    """Snapshot current file state, then atomically restore the chosen `.bak` version."""
    target = resolve_safe_path(path_str)
    if (
        not snapshot_id
        or "/" in snapshot_id
        or "\\" in snapshot_id
        or ".." in snapshot_id
        or not snapshot_id.endswith(".bak")
    ):
        raise ValueError("无效的快照标识")

    snap_path = snapshot_dir_for(target) / snapshot_id
    if not snap_path.exists():
        raise FileNotFoundError(f"快照不存在：{snapshot_id}")

    backup_before_restore = create_snapshot(target) if target.exists() else None
    data = snap_path.read_bytes()
    result = atomic_write_bytes(target, data, snapshot=False)
    result["restored_from"] = snapshot_id
    result["pre_restore_snapshot_id"] = backup_before_restore.name if backup_before_restore else None
    return result


def is_private(path_str: str | Path) -> bool:
    """Return True if the file is protected by the user's privacy lock."""
    try:
        target_s = _norm_str(Path(path_str).expanduser())
    except OSError:
        return False

    cfg = load_config()
    for p in cfg.get("private_files", []):
        try:
            if _norm_str(Path(p).expanduser()) == target_s:
                return True
        except OSError:
            continue
    return False


def assert_not_private(path_str: str | Path) -> Path:
    """Resolve safe path and raise PermissionError if the file has privacy lock enabled."""
    target = resolve_safe_path(str(path_str), must_exist=True)
    if is_private(target):
        raise PermissionError(
            f"隐私锁已拦截：文件「{target.name}」处于隐私保护状态，严禁发送至外部 AI 模型。"
        )
    return target


def set_private(path_str: str, private: bool) -> dict[str, Any]:
    """Enable or disable the per-file privacy lock."""
    target = resolve_safe_path(path_str)
    target_s = _norm_str(target)

    cfg = load_config()
    existing = []
    for p in cfg.get("private_files", []):
        try:
            norm = _norm_str(Path(p).expanduser())
            if norm != target_s:
                existing.append(norm)
        except OSError:
            continue

    if private:
        existing.append(target_s)

    cfg["private_files"] = existing
    save_config(cfg)
    return {"path": target_s, "name": target.name, "private": private}


def register_import(paths: list[str], *, is_dir: bool = False) -> dict[str, Any]:
    """Register local files or directories into `files.json` (and whitelist for dirs) without copying."""
    if not paths:
        raise ValueError("请提供至少一个文件或目录路径")

    index = load_files_index()
    cfg = load_config()
    added_files: list[str] = []
    added_dirs: list[str] = []

    for raw in paths:
        if not raw or "\x00" in raw:
            continue
        p = Path(raw).expanduser().resolve()
        if not p.exists():
            raise FileNotFoundError(f"路径不存在：{raw}")

        if is_dir or p.is_dir():
            ps = str(p)
            if ps not in index["dirs"]:
                index["dirs"].append(ps)
            if ps not in cfg["whitelist_dirs"]:
                cfg["whitelist_dirs"].append(ps)
            added_dirs.append(ps)
        else:
            ps = str(p)
            if ps not in index["files"]:
                index["files"].append(ps)
            added_files.append(ps)

    save_files_index(index)
    save_config(cfg)
    return {
        "added_files": added_files,
        "added_dirs": added_dirs,
        "total_files": len(index["files"]),
        "total_dirs": len(index["dirs"]),
    }
