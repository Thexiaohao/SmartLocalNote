"""Configuration, path constants, and atomic JSON helpers for SmartLocalNote."""

from __future__ import annotations

from copy import deepcopy
from datetime import datetime
import json
import os
from pathlib import Path
import shutil
import socket
import sys
from typing import Any

IS_FROZEN: bool = bool(getattr(sys, "frozen", False))
RESOURCE_DIR: Path = Path(getattr(sys, "_MEIPASS", Path(__file__).resolve().parent)).resolve()
BASE_DIR: Path = Path(sys.executable).resolve().parent if IS_FROZEN else Path(__file__).resolve().parent
DATA_DIR: Path = BASE_DIR / "data"
SNAPSHOTS_DIR: Path = DATA_DIR / ".snapshots"
DEFAULT_NOTES_DIR: Path = DATA_DIR / "notes"
DEMO_SEED_DIR: Path = RESOURCE_DIR / "assets" / "demo_seed"

CONFIG_FILE: Path = DATA_DIR / "config.json"
FILES_INDEX_FILE: Path = DATA_DIR / "files.json"
APPS_FILE: Path = DATA_DIR / "apps.json"
TREE_FILE: Path = DATA_DIR / "knowledge_tree.json"
TASKS_FILE: Path = DATA_DIR / "tasks.json"

DEFAULT_CONFIG: dict[str, Any] = {
    "port": 8765,
    "theme": "light",
    "ai": {
        "base_url": "https://dashscope.aliyuncs.com/compatible-mode/v1",
        "api_key": "",
        "model": "qwen-plus",
        "web_search_param": "enable_search",
    },
    "whitelist_dirs": [],
    "private_files": [],
    "default_notes_dir": "./data/notes",
    "default_progress_excel": "",
}

_DEFAULT_DATA_FILES: dict[Path, Any] = {
    CONFIG_FILE: DEFAULT_CONFIG,
    FILES_INDEX_FILE: {"files": [], "dirs": []},
    APPS_FILE: {"apps": [], "workspaces": []},
    TREE_FILE: {"nodes": []},
    TASKS_FILE: {"tasks": []},
}


def atomic_write_json(path: Path, data: Any) -> None:
    """Atomically write JSON data via a hidden temporary file, fsync, and os.replace."""
    target = Path(path)
    target.parent.mkdir(parents=True, exist_ok=True)
    tmp_path = target.parent / f".{target.name}.tmp"
    try:
        with open(tmp_path, "w", encoding="utf-8") as fh:
            json.dump(data, fh, ensure_ascii=False, indent=2)
            fh.write("\n")
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


def _seed_demo_workspace_if_empty() -> None:
    """On first launch of a fresh install/.exe, populate out-of-the-box demo files & indexes."""
    marker = DATA_DIR / ".initialized"
    if marker.exists() or not DEMO_SEED_DIR.exists():
        return
    has_user_notes = any(p.is_file() for p in DEFAULT_NOTES_DIR.iterdir())
    if has_user_notes:
        marker.write_text("seeded\n", encoding="utf-8")
        return

    for src in DEMO_SEED_DIR.iterdir():
        if src.is_file():
            dst = DEFAULT_NOTES_DIR / src.name
            if not dst.exists():
                shutil.copy2(src, dst)

    md_path = (DEFAULT_NOTES_DIR / "高数复习笔记.md").resolve()
    pdf_path = (DEFAULT_NOTES_DIR / "高数重点讲义.pdf").resolve()
    xlsx_path = (DEFAULT_NOTES_DIR / "高数刷题进度表.xlsx").resolve()
    now_iso = datetime.now().isoformat(timespec="seconds")

    cfg = load_config()
    if xlsx_path.exists() and not cfg.get("default_progress_excel"):
        cfg["default_progress_excel"] = str(xlsx_path)
        atomic_write_json(CONFIG_FILE, cfg)

    try:
        apps_raw = json.loads(APPS_FILE.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        apps_raw = {"apps": [], "workspaces": []}
    if not apps_raw.get("apps") and not apps_raw.get("workspaces"):
        atomic_write_json(APPS_FILE, {
            "apps": [
                {"id": "app_demo_calc", "name": "系统计算器", "aliases": ["计算器", "calc"], "path": "calc.exe", "args": ""},
                {"id": "app_demo_notepad", "name": "记事本", "aliases": ["notepad", "文本"], "path": "notepad.exe", "args": ""},
            ],
            "workspaces": [
                {
                    "id": "ws_demo_math",
                    "name": "高数冲刺复习模式",
                    "app_ids": ["app_demo_calc"],
                    "file_paths": [str(p) for p in (md_path, pdf_path, xlsx_path) if p.exists()],
                }
            ],
        })

    try:
        tree_raw = json.loads(TREE_FILE.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        tree_raw = {"nodes": []}
    if not tree_raw.get("nodes"):
        atomic_write_json(TREE_FILE, {
            "nodes": [
                {
                    "id": "node_math_root",
                    "name": "高等数学",
                    "parent_id": None,
                    "files": [
                        {"path": str(md_path), "status": "复习中", "updated_at": now_iso},
                        {"path": str(pdf_path), "status": "复习中", "updated_at": now_iso},
                        {"path": str(xlsx_path), "status": "进行中", "updated_at": now_iso},
                    ],
                },
                {
                    "id": "node_math_ch3",
                    "name": "第三章·中值定理专项",
                    "parent_id": "node_math_root",
                    "files": [{"path": str(pdf_path), "status": "重点攻克", "updated_at": now_iso}],
                },
            ]
        })

    marker.write_text("seeded\n", encoding="utf-8")


def ensure_data_dirs() -> None:
    """Create runtime data directories and safely initialize any missing JSON index files."""
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    SNAPSHOTS_DIR.mkdir(parents=True, exist_ok=True)
    DEFAULT_NOTES_DIR.mkdir(parents=True, exist_ok=True)

    for file_path, default_payload in _DEFAULT_DATA_FILES.items():
        if not file_path.exists():
            atomic_write_json(file_path, deepcopy(default_payload))

    _seed_demo_workspace_if_empty()


def _merge_config(raw: dict[str, Any] | None) -> dict[str, Any]:
    """Merge user config dict over DEFAULT_CONFIG so missing keys never break callers."""
    merged = deepcopy(DEFAULT_CONFIG)
    if not isinstance(raw, dict):
        return merged

    for key, value in raw.items():
        if key == "ai" and isinstance(value, dict):
            merged["ai"].update(value)
        elif key in ("whitelist_dirs", "private_files"):
            merged[key] = list(value) if isinstance(value, list) else []
        elif key == "port":
            try:
                merged["port"] = int(value)
            except (TypeError, ValueError):
                pass
        else:
            merged[key] = value
    return merged


def load_config() -> dict[str, Any]:
    """Load config.json merged with DEFAULT_CONFIG."""
    if not CONFIG_FILE.exists():
        return deepcopy(DEFAULT_CONFIG)
    try:
        with open(CONFIG_FILE, "r", encoding="utf-8") as fh:
            raw = json.load(fh)
    except (OSError, json.JSONDecodeError):
        raw = {}
    return _merge_config(raw)


def save_config(cfg: dict[str, Any]) -> dict[str, Any]:
    """Normalize and atomically persist config.json."""
    ensure_data_dirs()
    merged = _merge_config(cfg)
    atomic_write_json(CONFIG_FILE, merged)
    return merged


def update_config(patch: dict[str, Any]) -> dict[str, Any]:
    """Deep-merge a partial configuration patch into config.json and return saved config."""
    current = load_config()
    if isinstance(patch, dict):
        for key, value in patch.items():
            if key == "ai" and isinstance(value, dict):
                current_ai = current.get("ai")
                if not isinstance(current_ai, dict):
                    current_ai = deepcopy(DEFAULT_CONFIG["ai"])
                current["ai"] = {**current_ai, **value}
            elif value is not None:
                current[key] = value
    return save_config(current)


def get_local_ip() -> str:
    """Return the host's LAN IPv4 address via UDP socket probe, falling back to 127.0.0.1."""
    sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    try:
        sock.settimeout(0.5)
        sock.connect(("8.8.8.8", 80))
        ip = sock.getsockname()[0]
        return ip or "127.0.0.1"
    except OSError:
        return "127.0.0.1"
    finally:
        sock.close()


def get_default_notes_dir() -> Path:
    """Resolve configured default_notes_dir relative to BASE_DIR and ensure it exists."""
    cfg = load_config()
    raw_dir = str(cfg.get("default_notes_dir") or "./data/notes").strip() or "./data/notes"
    candidate = Path(raw_dir)
    if not candidate.is_absolute():
        candidate = BASE_DIR / candidate
    resolved = candidate.resolve()
    resolved.mkdir(parents=True, exist_ok=True)
    return resolved
