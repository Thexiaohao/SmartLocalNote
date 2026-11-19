"""Local application launcher, .lnk resolver, desktop window capture, and workspace manager."""

from __future__ import annotations

import json
import os
from pathlib import Path
import shlex
import shutil
import subprocess
import sys
import threading
from typing import Any
import uuid

from config import APPS_FILE, atomic_write_json, ensure_data_dirs

_LOCK = threading.RLock()

_IGNORED_PROCESS_NAMES = {
    "explorer",
    "applicationframehost",
    "textinputhost",
    "shellexperiencehost",
    "startmenuexperiencehost",
    "searchhost",
    "lockapp",
    "systemsettings",
    "smartlocalnote",
    "python",
    "pythonw",
    "uvicorn",
}


def _normalize_app_path(path_str: str) -> str:
    """Normalize an executable/shortcut path for consistent deduplication."""
    raw = str(path_str or "").strip()
    if not raw:
        return ""
    norm = os.path.normpath(raw)
    if sys.platform == "win32":
        return norm.lower()
    return norm.lower() if (len(norm) >= 2 and norm[1] == ":") else norm


def _load_apps_data() -> dict[str, list[dict[str, Any]]]:
    ensure_data_dirs()
    try:
        with open(APPS_FILE, "r", encoding="utf-8") as fh:
            raw = json.load(fh)
        if not isinstance(raw, dict):
            return {"apps": [], "workspaces": []}
        apps = [item for item in raw.get("apps", []) if isinstance(item, dict)]
        workspaces = [item for item in raw.get("workspaces", []) if isinstance(item, dict)]
        return {"apps": apps, "workspaces": workspaces}
    except (OSError, json.JSONDecodeError):
        return {"apps": [], "workspaces": []}


def _save_apps_data(data: dict[str, list[dict[str, Any]]]) -> dict[str, list[dict[str, Any]]]:
    ensure_data_dirs()
    payload = {
        "apps": list(data.get("apps", [])),
        "workspaces": list(data.get("workspaces", [])),
    }
    atomic_write_json(APPS_FILE, payload)
    return payload


def resolve_lnk(path_str: str) -> tuple[str, str]:
    """Resolve a Windows `.lnk` shortcut via PowerShell WScript.Shell COM."""
    raw = str(path_str or "").strip()
    if not raw:
        return ("", "")

    if sys.platform == "win32" and raw.lower().endswith(".lnk"):
        escaped = raw.replace("'", "''")
        ps_cmd = (
            "$s=(New-Object -ComObject WScript.Shell).CreateShortcut('{path}');"
            "@{{target=$s.TargetPath;args=$s.Arguments}}|ConvertTo-Json -Compress"
        ).format(path=escaped)
        try:
            proc = subprocess.run(
                ["powershell", "-NoProfile", "-NonInteractive", "-Command", ps_cmd],
                capture_output=True,
                text=True,
                timeout=8,
                check=False,
            )
            if proc.returncode == 0 and proc.stdout.strip():
                parsed = json.loads(proc.stdout.strip())
                if isinstance(parsed, dict):
                    target = str(parsed.get("target") or "").strip()
                    args = str(parsed.get("args") or "").strip()
                    if target:
                        return (target, args)
        except Exception:
            pass

    return (raw, "")


def list_apps_and_workspaces() -> dict[str, list[dict[str, Any]]]:
    """Return both `apps` and `workspaces` from `data/apps.json`."""
    with _LOCK:
        return _load_apps_data()


def list_apps() -> list[dict[str, Any]]:
    """Return registered local application entries."""
    return list_apps_and_workspaces()["apps"]


def _clean_aliases(aliases: list[str] | None) -> list[str]:
    if not aliases:
        return []
    cleaned: list[str] = []
    seen: set[str] = set()
    for item in aliases:
        text = str(item or "").strip()
        if text and text not in seen:
            seen.add(text)
            cleaned.append(text)
    return cleaned


def _add_app_locked(
    data: dict[str, list[dict[str, Any]]],
    name: str,
    path: str,
    aliases: list[str] | None = None,
    args: str = "",
) -> tuple[dict[str, Any], bool]:
    """Insert or deduplicate an app inside already-locked `data`. Returns `(app, mutated)`."""
    raw_path = str(path or "").strip()
    if not raw_path:
        raise ValueError("应用程序路径不能为空")

    resolved_path, lnk_args = resolve_lnk(raw_path)
    final_args = str(args or "").strip() or lnk_args
    clean_name = str(name or "").strip() or Path(resolved_path).stem or "未命名应用"
    cleaned_aliases = _clean_aliases(aliases)
    norm_target = _normalize_app_path(resolved_path)

    for existing in data["apps"]:
        if _normalize_app_path(str(existing.get("path", ""))) == norm_target:
            mutated = False
            if cleaned_aliases:
                merged_aliases = _clean_aliases(list(existing.get("aliases") or []) + cleaned_aliases)
                if merged_aliases != existing.get("aliases"):
                    existing["aliases"] = merged_aliases
                    mutated = True
            if final_args and not existing.get("args"):
                existing["args"] = final_args
                mutated = True
            return existing, mutated

    app_entry = {
        "id": f"app_{uuid.uuid4().hex[:8]}",
        "name": clean_name,
        "aliases": cleaned_aliases,
        "path": resolved_path,
        "args": final_args,
    }
    data["apps"].append(app_entry)
    return app_entry, True


def add_app(
    name: str,
    path: str,
    aliases: list[str] | None = None,
    args: str = "",
) -> dict[str, Any]:
    """Register a local application (auto-resolving `.lnk`) and persist atomically."""
    if not str(name or "").strip():
        raise ValueError("应用名称不能为空")
    with _LOCK:
        data = _load_apps_data()
        entry, mutated = _add_app_locked(data, name=name, path=path, aliases=aliases, args=args)
        if mutated:
            _save_apps_data(data)
        return dict(entry)


def delete_app(app_id: str) -> dict[str, Any]:
    """Delete an app from `apps.json` and strip its ID from all workspaces."""
    target_id = str(app_id or "").strip()
    if not target_id:
        raise ValueError("app_id 不能为空")

    with _LOCK:
        data = _load_apps_data()
        remaining = [item for item in data["apps"] if item.get("id") != target_id]
        if len(remaining) == len(data["apps"]):
            raise FileNotFoundError(f"未找到应用：{target_id}")

        data["apps"] = remaining
        for ws in data["workspaces"]:
            app_ids = ws.get("app_ids")
            if isinstance(app_ids, list):
                ws["app_ids"] = [aid for aid in app_ids if aid != target_id]
        _save_apps_data(data)

    return {"id": target_id, "deleted": True}


def get_running_windows() -> dict[str, Any]:
    """Capture visible running desktop windows via PowerShell on Windows (no pywin32/psutil)."""
    if sys.platform != "win32":
        return {
            "windows": [],
            "platform": sys.platform,
            "supported": False,
            "message": "当前非 Windows 桌面环境，可手动添加常用程序或直接使用示例工作区",
        }

    ps_cmd = (
        "Get-Process | Where-Object {$_.MainWindowTitle -ne \"\" -and $_.Path} | "
        "Select-Object ProcessName, MainWindowTitle, Path | ConvertTo-Json -Compress"
    )
    try:
        proc = subprocess.run(
            ["powershell", "-NoProfile", "-NonInteractive", "-Command", ps_cmd],
            capture_output=True,
            text=True,
            timeout=10,
            check=False,
        )
    except Exception as exc:
        return {
            "windows": [],
            "platform": sys.platform,
            "supported": True,
            "message": f"获取桌面窗口失败：{exc}",
        }

    raw_out = (proc.stdout or "").strip()
    if proc.returncode != 0 or not raw_out:
        return {
            "windows": [],
            "platform": sys.platform,
            "supported": True,
            "message": "",
        }

    try:
        parsed = json.loads(raw_out)
    except json.JSONDecodeError:
        return {
            "windows": [],
            "platform": sys.platform,
            "supported": True,
            "message": "解析桌面窗口输出失败",
        }

    rows = [parsed] if isinstance(parsed, dict) else (parsed if isinstance(parsed, list) else [])
    windows: list[dict[str, str]] = []
    seen_paths: set[str] = set()

    for row in rows:
        if not isinstance(row, dict):
            continue
        proc_name = str(row.get("ProcessName") or "").strip()
        title = str(row.get("MainWindowTitle") or "").strip()
        exe_path = str(row.get("Path") or "").strip()
        if not proc_name or not title or not exe_path:
            continue
        if proc_name.lower() in _IGNORED_PROCESS_NAMES:
            continue
        norm_key = exe_path.lower()
        if norm_key in seen_paths:
            continue
        seen_paths.add(norm_key)
        windows.append({
            "process_name": proc_name,
            "title": title,
            "path": exe_path,
        })

    return {
        "windows": windows,
        "platform": sys.platform,
        "supported": True,
        "message": "",
    }


def list_workspaces() -> list[dict[str, Any]]:
    """Return configured workspace combinations."""
    return list_apps_and_workspaces()["workspaces"]


def create_workspace(
    name: str,
    app_ids: list[str] | None = None,
    file_paths: list[str] | None = None,
    captured_apps: list[dict[str, Any]] | None = None,
) -> dict[str, Any]:
    """Create a scene workspace, auto-registering any `captured_apps` into `apps.json`."""
    ws_name = str(name or "").strip()
    if not ws_name:
        raise ValueError("工作区名称不能为空")

    with _LOCK:
        data = _load_apps_data()
        final_app_ids: list[str] = []
        seen_ids: set[str] = set()

        for aid in app_ids or []:
            aid_s = str(aid or "").strip()
            if aid_s and aid_s not in seen_ids:
                seen_ids.add(aid_s)
                final_app_ids.append(aid_s)

        for cap in captured_apps or []:
            if not isinstance(cap, dict):
                continue
            cap_path = str(cap.get("path") or "").strip()
            if not cap_path:
                continue
            cap_name = str(cap.get("name") or cap.get("process_name") or "").strip() or Path(cap_path).stem
            cap_aliases = cap.get("aliases") if isinstance(cap.get("aliases"), list) else []
            cap_args = str(cap.get("args") or "")
            app_entry, _ = _add_app_locked(
                data,
                name=cap_name,
                path=cap_path,
                aliases=cap_aliases,
                args=cap_args,
            )
            aid_s = str(app_entry["id"])
            if aid_s not in seen_ids:
                seen_ids.add(aid_s)
                final_app_ids.append(aid_s)

        final_files: list[str] = []
        seen_files: set[str] = set()
        for fp in file_paths or []:
            fp_s = str(fp or "").strip()
            if fp_s and fp_s not in seen_files:
                seen_files.add(fp_s)
                final_files.append(fp_s)

        workspace = {
            "id": f"ws_{uuid.uuid4().hex[:8]}",
            "name": ws_name,
            "app_ids": final_app_ids,
            "file_paths": final_files,
        }
        data["workspaces"].append(workspace)
        _save_apps_data(data)
        return dict(workspace)


def delete_workspace(workspace_id: str) -> dict[str, Any]:
    """Delete a workspace by ID from `apps.json`."""
    target_id = str(workspace_id or "").strip()
    if not target_id:
        raise ValueError("workspace_id 不能为空")

    with _LOCK:
        data = _load_apps_data()
        remaining = [ws for ws in data["workspaces"] if ws.get("id") != target_id]
        if len(remaining) == len(data["workspaces"]):
            raise FileNotFoundError(f"未找到工作区：{target_id}")
        data["workspaces"] = remaining
        _save_apps_data(data)

    return {"id": target_id, "deleted": True}


def _spawn_detached(app: dict[str, Any]) -> tuple[bool, str]:
    """Launch a single app non-blocking. Returns `(success, message)`."""
    raw_path = str(app.get("path") or "").strip()
    if not raw_path:
        return (False, "未配置可执行文件路径")

    target_exe, lnk_args = resolve_lnk(raw_path)
    raw_args = str(app.get("args") or "").strip() or lnk_args

    resolved_cmd: str | None = None
    if os.path.exists(target_exe):
        resolved_cmd = target_exe
    elif not os.path.isabs(target_exe) and ("/" not in target_exe and "\\" not in target_exe):
        resolved_cmd = shutil.which(target_exe)

    if not resolved_cmd:
        return (False, f"当前环境未找到可执行文件：{target_exe}")

    try:
        arg_tokens = shlex.split(raw_args, posix=(sys.platform != "win32")) if raw_args else []
    except ValueError:
        arg_tokens = raw_args.split()

    cmd = [resolved_cmd, *arg_tokens]
    try:
        if sys.platform == "win32":
            detached = getattr(subprocess, "DETACHED_PROCESS", 0x00000008)
            new_group = getattr(subprocess, "CREATE_NEW_PROCESS_GROUP", 0x00000200)
            subprocess.Popen(
                cmd,
                creationflags=detached | new_group,
                stdin=subprocess.DEVNULL,
                stdout=subprocess.DEVNULL,
                stderr=subprocess.DEVNULL,
                close_fds=True,
            )
        else:
            subprocess.Popen(
                cmd,
                start_new_session=True,
                stdin=subprocess.DEVNULL,
                stdout=subprocess.DEVNULL,
                stderr=subprocess.DEVNULL,
                close_fds=True,
            )
        return (True, "")
    except OSError as exc:
        if sys.platform == "win32" and hasattr(os, "startfile") and not arg_tokens:
            try:
                os.startfile(resolved_cmd)  # type: ignore[attr-defined]
                return (True, "")
            except OSError as start_exc:
                return (False, str(start_exc))
        return (False, str(exc))


def launch_target(app_id: str | None = None, workspace_id: str | None = None) -> dict[str, Any]:
    """Non-blocking launch of a single app or an entire workspace (apps + file list)."""
    req_app_id = str(app_id or "").strip() or None
    req_ws_id = str(workspace_id or "").strip() or None
    if not req_app_id and not req_ws_id:
        raise ValueError("请提供 app_id 或 workspace_id")

    data = list_apps_and_workspaces()
    apps_by_id = {str(a.get("id")): a for a in data["apps"] if a.get("id")}
    ws_by_id = {str(w.get("id")): w for w in data["workspaces"] if w.get("id")}

    launched: list[dict[str, Any]] = []
    failed: list[dict[str, Any]] = []
    file_paths: list[str] = []
    workspace_name = ""
    target_app_ids: list[str] = []

    if req_ws_id:
        ws = ws_by_id.get(req_ws_id)
        if ws is None:
            raise FileNotFoundError(f"未找到工作区：{req_ws_id}")
        workspace_name = str(ws.get("name") or "")
        file_paths = [str(p) for p in (ws.get("file_paths") or []) if str(p).strip()]
        target_app_ids.extend(str(aid) for aid in (ws.get("app_ids") or []) if str(aid).strip())

    if req_app_id:
        if req_app_id not in apps_by_id:
            raise FileNotFoundError(f"未找到应用：{req_app_id}")
        if req_app_id not in target_app_ids:
            target_app_ids.append(req_app_id)

    for aid in target_app_ids:
        app = apps_by_id.get(aid)
        if app is None:
            failed.append({"id": aid, "name": aid, "path": "", "reason": "应用配置不存在"})
            continue
        ok_flag, reason = _spawn_detached(app)
        info = {
            "id": app.get("id"),
            "name": app.get("name"),
            "path": app.get("path"),
        }
        if ok_flag:
            launched.append(info)
        else:
            failed.append({**info, "reason": reason})

    return {
        "launched": launched,
        "failed": failed,
        "file_paths": file_paths,
        "workspace_name": workspace_name,
    }


def _has_gui_display() -> bool:
    if sys.platform == "win32" or sys.platform == "darwin":
        return True
    return bool(os.environ.get("DISPLAY") or os.environ.get("WAYLAND_DISPLAY"))


def pick_local_path(mode: str = "file") -> dict[str, Any]:
    """Open native desktop file/folder picker via pywebview or tkinter, degrading gracefully if headless."""
    clean_mode = str(mode or "file").strip().lower()
    if clean_mode not in {"file", "folder", "app"}:
        raise ValueError("mode 仅支持 file / folder / app")

    # 1. Try active pywebview window if available
    try:
        import webview  # type: ignore

        windows = getattr(webview, "windows", None) or []
        if windows:
            win = windows[0]
            if clean_mode == "folder":
                dialog_type = getattr(webview, "FOLDER_DIALOG", 20)
                result = win.create_file_dialog(dialog_type)
            elif clean_mode == "app":
                dialog_type = getattr(webview, "OPEN_DIALOG", 10)
                ft = (
                    ("Applications (*.exe;*.lnk)", "All files (*.*)")
                    if sys.platform == "win32"
                    else ("All files (*.*)",)
                )
                result = win.create_file_dialog(dialog_type, file_types=ft)
            else:
                dialog_type = getattr(webview, "OPEN_DIALOG", 10)
                ft = ("Supported Docs (*.md;*.txt;*.pdf;*.xlsx)", "All files (*.*)")
                result = win.create_file_dialog(dialog_type, file_types=ft)

            paths = [str(p) for p in result] if result else []
            if paths:
                return {
                    "path": paths[0],
                    "paths": paths,
                    "cancelled": False,
                    "headless": False,
                    "message": "",
                }
            return {
                "path": "",
                "paths": [],
                "cancelled": True,
                "headless": False,
                "message": "已取消选择",
            }
    except Exception:
        pass

    # 2. Fall back to stdlib tkinter.filedialog when display is present
    if _has_gui_display():
        try:
            import tkinter as tk
            from tkinter import filedialog

            root = tk.Tk()
            root.withdraw()
            try:
                root.attributes("-topmost", True)
            except Exception:
                pass
            try:
                if clean_mode == "folder":
                    picked = filedialog.askdirectory(title="选择本地目录")
                elif clean_mode == "app":
                    filetypes = (
                        [("Applications", "*.exe *.lnk"), ("All files", "*.*")]
                        if sys.platform == "win32"
                        else [("All files", "*.*")]
                    )
                    picked = filedialog.askopenfilename(title="选择本地程序", filetypes=filetypes)
                else:
                    picked = filedialog.askopenfilename(
                        title="选择本地文件",
                        filetypes=[
                            ("Supported Docs", "*.md *.txt *.pdf *.xlsx"),
                            ("All files", "*.*"),
                        ],
                    )
            finally:
                root.destroy()

            picked_s = str(picked or "").strip()
            if picked_s:
                return {
                    "path": picked_s,
                    "paths": [picked_s],
                    "cancelled": False,
                    "headless": False,
                    "message": "",
                }
            return {
                "path": "",
                "paths": [],
                "cancelled": True,
                "headless": False,
                "message": "已取消选择",
            }
        except Exception:
            pass

    # 3. Headless Linux / no GUI fallback
    return {
        "path": "",
        "paths": [],
        "cancelled": True,
        "headless": True,
        "message": "当前环境无桌面文件选择器，请直接输入本地路径或使用上传/快捷导入",
    }
