"""Virtual knowledge tree manager (`data/knowledge_tree.json`).

Maps local file paths into a hierarchical knowledge tree and a flattened table
overview without ever moving or modifying the underlying physical files.
"""

from __future__ import annotations

from datetime import datetime
import json
from pathlib import Path
import threading
from typing import Any
import uuid

from config import TREE_FILE, atomic_write_json, ensure_data_dirs

_LOCK = threading.RLock()


def _now_iso() -> str:
    return datetime.now().isoformat(timespec="seconds")


def _norm_file_key(path_str: str) -> str:
    raw = str(path_str or "").strip()
    if not raw:
        return ""
    try:
        return str(Path(raw).expanduser().resolve())
    except OSError:
        return raw


def _load_tree_data() -> dict[str, list[dict[str, Any]]]:
    ensure_data_dirs()
    try:
        with open(TREE_FILE, "r", encoding="utf-8") as fh:
            raw = json.load(fh)
        if not isinstance(raw, dict):
            return {"nodes": []}
        nodes = [n for n in raw.get("nodes", []) if isinstance(n, dict)]
        for node in nodes:
            if not isinstance(node.get("files"), list):
                node["files"] = []
        return {"nodes": nodes}
    except (OSError, json.JSONDecodeError):
        return {"nodes": []}


def _save_tree_data(data: dict[str, list[dict[str, Any]]]) -> dict[str, list[dict[str, Any]]]:
    ensure_data_dirs()
    payload = {"nodes": list(data.get("nodes", []))}
    atomic_write_json(TREE_FILE, payload)
    return payload


def _build_table_rows(nodes: list[dict[str, Any]]) -> list[dict[str, Any]]:
    rows: list[dict[str, Any]] = []
    for node in nodes:
        node_id = str(node.get("id") or "")
        node_name = str(node.get("name") or "")
        for item in node.get("files") or []:
            if not isinstance(item, dict):
                continue
            path_str = str(item.get("path") or "").strip()
            if not path_str:
                continue
            p = Path(path_str)
            rows.append({
                "node_id": node_id,
                "node_name": node_name,
                "path": path_str,
                "file_name": p.name,
                "ext": p.suffix.lower(),
                "status": str(item.get("status") or "学习中"),
                "updated_at": str(item.get("updated_at") or ""),
            })
    return rows


def _find_node(nodes: list[dict[str, Any]], node_id: str) -> dict[str, Any] | None:
    for node in nodes:
        if node.get("id") == node_id:
            return node
    return None


def _would_create_cycle(nodes: list[dict[str, Any]], node_id: str, new_parent_id: str | None) -> bool:
    if new_parent_id is None:
        return False
    if new_parent_id == node_id:
        return True
    by_id = {str(n.get("id")): n for n in nodes if n.get("id")}
    cursor = new_parent_id
    visited: set[str] = set()
    while cursor:
        if cursor == node_id:
            return True
        if cursor in visited:
            break
        visited.add(cursor)
        parent_node = by_id.get(cursor)
        if not parent_node:
            break
        cursor = parent_node.get("parent_id")
    return False


def get_tree() -> dict[str, Any]:
    """Return both hierarchical `nodes` and flattened `table_rows` from `knowledge_tree.json`."""
    with _LOCK:
        data = _load_tree_data()
        nodes = data["nodes"]
        return {
            "nodes": nodes,
            "table_rows": _build_table_rows(nodes),
        }


def create_node(name: str, parent_id: str | None = None) -> dict[str, Any]:
    """Create a new virtual knowledge tree node."""
    clean_name = str(name or "").strip()
    if not clean_name:
        raise ValueError("知识树节点名称不能为空")

    clean_parent = str(parent_id).strip() if parent_id else None
    with _LOCK:
        data = _load_tree_data()
        if clean_parent and _find_node(data["nodes"], clean_parent) is None:
            raise FileNotFoundError(f"父节点不存在：{clean_parent}")

        node = {
            "id": f"node_{uuid.uuid4().hex[:8]}",
            "name": clean_name,
            "parent_id": clean_parent,
            "files": [],
        }
        data["nodes"].append(node)
        _save_tree_data(data)
        return dict(node)


def _bind_file_locked(
    node: dict[str, Any],
    path_str: str,
    status: str = "学习中",
) -> dict[str, Any]:
    raw_path = str(path_str or "").strip()
    if not raw_path:
        raise ValueError("绑定文件路径不能为空")

    norm_key = _norm_file_key(raw_path)
    clean_status = str(status or "学习中").strip() or "学习中"
    now = _now_iso()

    files = node.setdefault("files", [])
    for entry in files:
        if isinstance(entry, dict) and _norm_file_key(str(entry.get("path") or "")) == norm_key:
            entry["path"] = raw_path
            entry["status"] = clean_status
            entry["updated_at"] = now
            return dict(node)

    files.append({
        "path": raw_path,
        "status": clean_status,
        "updated_at": now,
    })
    return dict(node)


def _unbind_file_locked(node: dict[str, Any], path_str: str) -> dict[str, Any]:
    raw_path = str(path_str or "").strip()
    if not raw_path:
        raise ValueError("解绑文件路径不能为空")

    norm_key = _norm_file_key(raw_path)
    files = node.get("files") or []
    node["files"] = [
        entry
        for entry in files
        if not (isinstance(entry, dict) and _norm_file_key(str(entry.get("path") or "")) == norm_key)
    ]
    return dict(node)


def bind_file(node_id: str, path_str: str, status: str = "学习中") -> dict[str, Any]:
    """Bind a physical file path to a knowledge tree node (or update its status)."""
    target_id = str(node_id or "").strip()
    if not target_id:
        raise ValueError("node_id 不能为空")

    with _LOCK:
        data = _load_tree_data()
        node = _find_node(data["nodes"], target_id)
        if node is None:
            raise FileNotFoundError(f"知识树节点不存在：{target_id}")
        updated = _bind_file_locked(node, path_str=path_str, status=status)
        _save_tree_data(data)
        return updated


def unbind_file(node_id: str, path_str: str) -> dict[str, Any]:
    """Unbind a file path from a knowledge tree node without deleting the physical file."""
    target_id = str(node_id or "").strip()
    if not target_id:
        raise ValueError("node_id 不能为空")

    with _LOCK:
        data = _load_tree_data()
        node = _find_node(data["nodes"], target_id)
        if node is None:
            raise FileNotFoundError(f"知识树节点不存在：{target_id}")
        updated = _unbind_file_locked(node, path_str=path_str)
        _save_tree_data(data)
        return updated


def update_node(
    node_id: str,
    name: str | None = None,
    parent_id: str | None = None,
    bind_path: str | None = None,
    unbind_path: str | None = None,
    status: str | None = None,
) -> dict[str, Any]:
    """Update a knowledge tree node (rename, reparent, bind/unbind file, or update file status)."""
    target_id = str(node_id or "").strip()
    if not target_id:
        raise ValueError("node_id 不能为空")

    with _LOCK:
        data = _load_tree_data()
        nodes = data["nodes"]
        node = _find_node(nodes, target_id)
        if node is None:
            raise FileNotFoundError(f"知识树节点不存在：{target_id}")

        if name is not None:
            clean_name = str(name).strip()
            if not clean_name:
                raise ValueError("节点名称不能为空")
            node["name"] = clean_name

        if parent_id is not None:
            clean_parent = str(parent_id).strip() or None
            if clean_parent is not None and _find_node(nodes, clean_parent) is None:
                raise FileNotFoundError(f"父节点不存在：{clean_parent}")
            if _would_create_cycle(nodes, target_id, clean_parent):
                raise ValueError("不能将节点移动到自身或子节点下")
            node["parent_id"] = clean_parent

        if unbind_path:
            _unbind_file_locked(node, unbind_path)

        if bind_path:
            _bind_file_locked(node, bind_path, status=status or "学习中")
        elif status is not None and not unbind_path:
            # Update status of all bound files in this node when no bind_path was given
            clean_status = str(status).strip()
            if clean_status:
                now = _now_iso()
                for entry in node.get("files") or []:
                    if isinstance(entry, dict):
                        entry["status"] = clean_status
                        entry["updated_at"] = now

        _save_tree_data(data)
        return dict(node)


def delete_node(node_id: str) -> dict[str, Any]:
    """Delete a virtual node and promote any direct children cleanly to its parent."""
    target_id = str(node_id or "").strip()
    if not target_id:
        raise ValueError("node_id 不能为空")

    with _LOCK:
        data = _load_tree_data()
        target_node = _find_node(data["nodes"], target_id)
        if target_node is None:
            raise FileNotFoundError(f"知识树节点不存在：{target_id}")

        fallback_parent = target_node.get("parent_id")
        remaining: list[dict[str, Any]] = []
        for node in data["nodes"]:
            if node.get("id") == target_id:
                continue
            if node.get("parent_id") == target_id:
                node["parent_id"] = fallback_parent
            remaining.append(node)

        data["nodes"] = remaining
        _save_tree_data(data)

    return {"id": target_id, "deleted": True}
