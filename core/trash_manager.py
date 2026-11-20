"""Dual-mode recycle bin manager for SmartLocalNote (Windows Recycle Bin + built-in trash)."""

from __future__ import annotations

from datetime import datetime
import json
import os
from pathlib import Path
import shutil
import sys
import threading
import time
from typing import Any
import uuid

from config import DATA_DIR, atomic_write_json

TRASH_DIR: Path = DATA_DIR / "trash"
TRASH_FILES_DIR: Path = TRASH_DIR / "files"
TRASH_SETTINGS_FILE: Path = TRASH_DIR / "settings.json"
TRASH_MANIFEST_FILE: Path = TRASH_DIR / "manifest.json"

DEFAULT_TRASH_SETTINGS: dict[str, Any] = {
    "mode": "system",
    "auto_purge_days": 15,
}

_LOCK = threading.RLock()


def _ensure_trash_dirs() -> None:
    TRASH_DIR.mkdir(parents=True, exist_ok=True)
    TRASH_FILES_DIR.mkdir(parents=True, exist_ok=True)
    if not TRASH_SETTINGS_FILE.exists():
        atomic_write_json(TRASH_SETTINGS_FILE, dict(DEFAULT_TRASH_SETTINGS))
    if not TRASH_MANIFEST_FILE.exists():
        atomic_write_json(TRASH_MANIFEST_FILE, {"items": []})


def _load_settings_unlocked() -> dict[str, Any]:
    _ensure_trash_dirs()
    result = dict(DEFAULT_TRASH_SETTINGS)
    try:
        with open(TRASH_SETTINGS_FILE, "r", encoding="utf-8") as fh:
            raw = json.load(fh)
        if isinstance(raw, dict):
            mode = str(raw.get("mode") or "").strip().lower()
            if mode in ("system", "app"):
                result["mode"] = mode
            days = raw.get("auto_purge_days")
            if not isinstance(days, bool) and days is not None:
                try:
                    days_int = int(days)
                    if days_int >= 0:
                        result["auto_purge_days"] = days_int
                except (TypeError, ValueError):
                    pass
    except (OSError, json.JSONDecodeError):
        pass
    return result


def _load_manifest_unlocked() -> dict[str, list[dict[str, Any]]]:
    _ensure_trash_dirs()
    try:
        with open(TRASH_MANIFEST_FILE, "r", encoding="utf-8") as fh:
            raw = json.load(fh)
        if isinstance(raw, dict) and isinstance(raw.get("items"), list):
            return {"items": [it for it in raw["items"] if isinstance(it, dict)]}
    except (OSError, json.JSONDecodeError):
        pass
    return {"items": []}


def _save_manifest_unlocked(manifest: dict[str, list[dict[str, Any]]]) -> None:
    _ensure_trash_dirs()
    atomic_write_json(TRASH_MANIFEST_FILE, {"items": list(manifest.get("items", []))})


def get_settings() -> dict[str, Any]:
    """Return current recycle bin settings."""
    with _LOCK:
        return _load_settings_unlocked()


def update_settings(
    mode: str | None = None,
    auto_purge_days: int | None = None,
) -> dict[str, Any]:
    """Validate and atomically persist recycle bin settings."""
    with _LOCK:
        settings = _load_settings_unlocked()
        if mode is not None:
            clean_mode = str(mode).strip().lower()
            if clean_mode not in ("system", "app"):
                raise ValueError("回收站模式仅支持 system 或 app")
            settings["mode"] = clean_mode

        if auto_purge_days is not None:
            if isinstance(auto_purge_days, bool):
                raise ValueError("自动清理天数必须为非负整数")
            try:
                days_int = int(auto_purge_days)
            except (TypeError, ValueError) as exc:
                raise ValueError("自动清理天数必须为非负整数") from exc
            if days_int < 0:
                raise ValueError("自动清理天数不能为负数")
            settings["auto_purge_days"] = days_int

        _ensure_trash_dirs()
        atomic_write_json(TRASH_SETTINGS_FILE, settings)
        return dict(settings)


def send_to_windows_recycle_bin(path: str) -> tuple[bool, str]:
    """Move a local file or directory to the Windows Recycle Bin via Win32 SHFileOperationW."""
    if sys.platform != "win32":
        return (False, "当前平台不支持 Windows 系统回收站")

    raw = str(path or "").strip()
    if not raw:
        return (False, "文件路径不能为空")

    abs_path = os.path.abspath(raw)
    if not os.path.exists(abs_path):
        return (False, f"路径不存在：{abs_path}")

    import ctypes
    from ctypes import wintypes

    FO_DELETE = 3
    FOF_SILENT = 0x0004
    FOF_NOCONFIRMATION = 0x0010
    FOF_ALLOWUNDO = 0x0040
    FOF_NOERRORUI = 0x0400

    # Use native platform structure alignment (do NOT force _pack_ = 1 on 64-bit Windows)
    class SHFILEOPSTRUCTW(ctypes.Structure):
        _fields_ = [
            ("hwnd", wintypes.HWND),
            ("wFunc", wintypes.UINT),
            ("pFrom", ctypes.c_void_p),
            ("pTo", ctypes.c_void_p),
            ("fFlags", wintypes.WORD),
            ("fAnyOperationsAborted", wintypes.BOOL),
            ("hNameMappings", wintypes.LPVOID),
            ("lpszProgressTitle", wintypes.LPCWSTR),
        ]

    # SHFileOperationW requires pFrom to be double-null-terminated.
    pfrom_buf = ctypes.create_unicode_buffer(abs_path + "\0")
    op = SHFILEOPSTRUCTW(
        hwnd=None,
        wFunc=FO_DELETE,
        pFrom=ctypes.addressof(pfrom_buf),
        pTo=None,
        fFlags=FOF_ALLOWUNDO | FOF_NOCONFIRMATION | FOF_SILENT | FOF_NOERRORUI,
        fAnyOperationsAborted=False,
        hNameMappings=None,
        lpszProgressTitle=None,
    )

    shell32 = ctypes.windll.shell32
    shell32.SHFileOperationW.argtypes = [ctypes.POINTER(SHFILEOPSTRUCTW)]
    shell32.SHFileOperationW.restype = ctypes.c_int

    res = shell32.SHFileOperationW(ctypes.byref(op))
    if res != 0:
        return (False, f"移入系统回收站失败（错误码 0x{res:X}）")
    if op.fAnyOperationsAborted:
        return (False, "系统回收站操作被中止")
    return (True, "")


def _compute_path_size(target: Path) -> int:
    try:
        if target.is_file():
            return int(target.stat().st_size)
        if target.is_dir():
            total = 0
            for child in target.rglob("*"):
                if child.is_file():
                    try:
                        total += int(child.stat().st_size)
                    except OSError:
                        continue
            return total
    except OSError:
        pass
    return 0


def _handle_remove_readonly(func, path, _exc_info) -> None:
    try:
        os.chmod(path, 0o700)
        func(path)
    except OSError:
        pass


def _move_path_with_retry(src: Path, dst: Path, retries: int = 4) -> None:
    import time

    last_err: Exception | None = None
    for attempt in range(retries):
        try:
            shutil.move(str(src), str(dst))
            return
        except OSError as exc:
            last_err = exc
            if src.is_dir() and attempt + 1 >= retries:
                # Fallback copy + recursive delete for Windows folder handles/readonly attributes
                shutil.copytree(str(src), str(dst), dirs_exist_ok=True)
                shutil.rmtree(str(src), onerror=_handle_remove_readonly)
                if not src.exists():
                    return
            time.sleep(0.05 * (attempt + 1))
    if last_err is not None:
        raise last_err


def _delete_stored_path(stored_path_str: str) -> None:
    if not stored_path_str:
        return
    p = Path(stored_path_str)
    if not p.exists():
        return
    try:
        if p.is_dir():
            shutil.rmtree(p, onerror=_handle_remove_readonly)
        else:
            p.unlink(missing_ok=True)
    except OSError:
        pass


def trash_file(path: str, mode: str | None = None) -> dict[str, Any]:
    """Delete a file or directory to either Windows Recycle Bin or built-in app trash."""
    raw = str(path or "").strip()
    if not raw:
        raise ValueError("文件路径不能为空")

    target = Path(os.path.abspath(raw))
    if not target.exists():
        raise FileNotFoundError(f"文件或文件夹不存在：{target.name}")

    with _LOCK:
        settings = _load_settings_unlocked()
        effective_mode = str(mode).strip().lower() if (mode is not None and str(mode).strip()) else settings["mode"]
        if effective_mode not in ("system", "app"):
            raise ValueError("回收站模式仅支持 system 或 app")

    if effective_mode == "system":
        ok_flag, err_msg = send_to_windows_recycle_bin(str(target))
        if not ok_flag:
            raise ValueError(err_msg or "移入 Windows 系统回收站失败")
        return {
            "ok": True,
            "mode": "system",
            "recycled_to_system": True,
            "message": "已移入 Windows 系统回收站，可随时在系统回收站还原",
        }

    with _LOCK:
        _ensure_trash_dirs()
        trash_id = f"tr_{uuid.uuid4().hex[:10]}"
        kind = "folder" if target.is_dir() else "file"
        ext = "" if kind == "folder" else target.suffix.lower()
        size_bytes = _compute_path_size(target)
        stored_path = (TRASH_FILES_DIR / f"{trash_id}__{target.name}").resolve()
        _move_path_with_retry(target, stored_path)

        item = {
            "id": trash_id,
            "kind": kind,
            "title": target.name,
            "orig_path": str(target),
            "stored_path": str(stored_path),
            "size_bytes": size_bytes,
            "deleted_at": datetime.now().isoformat(timespec="seconds"),
            "ext": ext,
        }
        manifest = _load_manifest_unlocked()
        manifest["items"].append(item)
        _save_manifest_unlocked(manifest)

    return {
        "ok": True,
        "mode": "app",
        "recycled_to_system": False,
        "trash_item": item,
        "message": "已移入内置回收站",
    }


def trash_virtual_item(
    kind: str,
    title: str,
    payload: dict[str, Any],
    source_path: str = "",
) -> dict[str, Any]:
    """Store a deleted virtual item (flash/snippet/mindmap/workspace/app/category/staging) in manifest."""
    clean_kind = str(kind or "").strip()
    if not clean_kind:
        raise ValueError("虚拟条目类型 kind 不能为空")

    payload_dict = dict(payload) if isinstance(payload, dict) else {"value": payload}
    clean_title = str(title or "").strip() or f"未命名{clean_kind}"
    clean_source = str(source_path or "").strip()
    size_bytes = len(json.dumps(payload_dict, ensure_ascii=False).encode("utf-8"))

    with _LOCK:
        manifest = _load_manifest_unlocked()
        item = {
            "id": f"tr_{uuid.uuid4().hex[:10]}",
            "kind": clean_kind,
            "title": clean_title,
            "orig_path": clean_source,
            "source_path": clean_source,
            "stored_path": "",
            "size_bytes": size_bytes,
            "deleted_at": datetime.now().isoformat(timespec="seconds"),
            "ext": "",
            "payload": payload_dict,
        }
        manifest["items"].append(item)
        _save_manifest_unlocked(manifest)
        return {"ok": True, "item": dict(item)}


def purge_expired_items() -> int:
    """Lazily remove expired items older than `auto_purge_days` from manifest and disk."""
    with _LOCK:
        settings = _load_settings_unlocked()
        days = int(settings.get("auto_purge_days", 15))
        if days <= 0:
            return 0

        manifest = _load_manifest_unlocked()
        items = manifest["items"]
        if not items:
            return 0

        cutoff = time.time() - (days * 86400)
        kept: list[dict[str, Any]] = []
        removed_count = 0

        for item in items:
            deleted_raw = str(item.get("deleted_at") or "").strip()
            expired = False
            if deleted_raw:
                try:
                    ts = datetime.fromisoformat(deleted_raw).timestamp()
                    if ts < cutoff:
                        expired = True
                except ValueError:
                    expired = False
            if expired:
                _delete_stored_path(str(item.get("stored_path") or ""))
                removed_count += 1
            else:
                kept.append(item)

        if removed_count > 0:
            manifest["items"] = kept
            _save_manifest_unlocked(manifest)
        return removed_count


def list_trash() -> dict[str, Any]:
    """Lazily purge expired items and return all trash entries sorted newest-first."""
    with _LOCK:
        purge_expired_items()
        settings = _load_settings_unlocked()
        manifest = _load_manifest_unlocked()
        items = sorted(
            manifest["items"],
            key=lambda it: str(it.get("deleted_at") or ""),
            reverse=True,
        )
        total_bytes = sum(int(it.get("size_bytes") or 0) for it in items)
        return {
            "items": items,
            "settings": settings,
            "stats": {
                "count": len(items),
                "total_bytes": total_bytes,
            },
        }


def _resolve_restore_collision(orig_path: Path) -> Path:
    if not orig_path.exists():
        return orig_path
    if orig_path.is_dir() or not orig_path.suffix:
        candidate = orig_path.parent / f"{orig_path.name}_恢复"
        counter = 2
        while candidate.exists():
            candidate = orig_path.parent / f"{orig_path.name}_恢复_{counter}"
            counter += 1
        return candidate

    candidate = orig_path.parent / f"{orig_path.stem}_恢复{orig_path.suffix}"
    counter = 2
    while candidate.exists():
        candidate = orig_path.parent / f"{orig_path.stem}_恢复_{counter}{orig_path.suffix}"
        counter += 1
    return candidate


def restore_item(trash_id: str) -> dict[str, Any]:
    """Restore a file/folder back to disk or pop a virtual item payload for caller restoration."""
    target_id = str(trash_id or "").strip()
    if not target_id:
        raise ValueError("trash_id 不能为空")

    with _LOCK:
        manifest = _load_manifest_unlocked()
        items = manifest["items"]
        matched_idx = -1
        for idx, it in enumerate(items):
            if it.get("id") == target_id:
                matched_idx = idx
                break
        if matched_idx < 0:
            raise FileNotFoundError(f"回收站条目不存在：{target_id}")

        item = dict(items[matched_idx])
        kind = str(item.get("kind") or "")

        if kind in ("file", "folder"):
            stored = Path(str(item.get("stored_path") or ""))
            if not stored.exists():
                raise FileNotFoundError(f"回收站暂存文件已丢失：{item.get('title') or target_id}")
            orig_raw = str(item.get("orig_path") or "").strip()
            if not orig_raw:
                raise ValueError("缺少原始路径，无法还原")
            orig_path = Path(orig_raw)
            orig_path.parent.mkdir(parents=True, exist_ok=True)
            target_path = _resolve_restore_collision(orig_path)
            shutil.move(str(stored), str(target_path))

            items.pop(matched_idx)
            _save_manifest_unlocked(manifest)
            return {
                "ok": True,
                "kind": kind,
                "restored_path": str(target_path),
                "item": item,
            }

        items.pop(matched_idx)
        _save_manifest_unlocked(manifest)
        return {
            "ok": True,
            "kind": kind,
            "item": item,
        }


def empty_trash(trash_id: str = "") -> dict[str, Any]:
    """Permanently delete a single trash entry or empty the entire built-in recycle bin."""
    target_id = str(trash_id or "").strip()
    with _LOCK:
        manifest = _load_manifest_unlocked()
        items = manifest["items"]

        if target_id:
            remaining: list[dict[str, Any]] = []
            removed = 0
            for it in items:
                if it.get("id") == target_id:
                    _delete_stored_path(str(it.get("stored_path") or ""))
                    removed += 1
                else:
                    remaining.append(it)
            if removed == 0:
                raise FileNotFoundError(f"回收站条目不存在：{target_id}")
            manifest["items"] = remaining
            _save_manifest_unlocked(manifest)
            return {"ok": True, "removed_count": removed}

        removed_count = len(items)
        for it in items:
            _delete_stored_path(str(it.get("stored_path") or ""))
        if TRASH_FILES_DIR.exists():
            for stray in TRASH_FILES_DIR.iterdir():
                _delete_stored_path(str(stray))
        manifest["items"] = []
        _save_manifest_unlocked(manifest)
        return {"ok": True, "removed_count": removed_count}
