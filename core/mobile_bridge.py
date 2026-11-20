"""Windows <-> Android LAN bridge, pairing, UDP discovery, and cross-device sync core.

Strictly zero FastAPI/Starlette imports and zero third-party pip dependencies.
All disk writes pass through `config.atomic_write_json` or `core.safe_io`.
"""

from __future__ import annotations

import base64
import binascii
from datetime import datetime
import hashlib
import json
import os
from pathlib import Path
import re
import secrets
import socket
import threading
from typing import Any
from urllib.parse import quote
import uuid

from config import (
    DATA_DIR,
    atomic_write_json,
    ensure_data_dirs,
    get_default_notes_dir,
    get_local_ip,
    load_config,
)
from core import safe_io, scheduler, todo_indexer

MOBILE_PAIR_FILE: Path = DATA_DIR / "mobile_pair.json"
SERVICE_NAME = "SmartLocalNote"
SERVICE_VERSION = "7.5"
DEFAULT_UDP_PORT = 8766
MAX_PAIRED_DEVICES = 30
MAX_UPLOAD_BYTES = 50 * 1024 * 1024  # 50 MB safety cap

_ALLOWED_STICKY_COLORS = {"yellow", "blue", "green", "pink", "purple", "slate"}
_INVALID_NAME_RE = re.compile(r'[\\/:*?"<>|\x00-\x1f]')
_LOCAL_HOSTS = {"127.0.0.1", "::1", "localhost"}

_PAIR_LOCK = threading.RLock()
_DISCOVERY_LOCK = threading.Lock()
_discovery_sock: socket.socket | None = None
_discovery_thread: threading.Thread | None = None
_discovery_running: bool = False
_discovery_udp_port: int = DEFAULT_UDP_PORT
_active_http_port: int | None = None


def _now_iso() -> str:
    return datetime.now().isoformat(timespec="seconds")


def _generate_pin() -> str:
    return f"{secrets.randbelow(1_000_000):06d}"


def _generate_token() -> str:
    return secrets.token_hex(16)  # 32-char hex token


def _get_hostname() -> str:
    try:
        name = socket.gethostname().strip()
        if name:
            return name
    except OSError:
        pass
    return "SmartLocalNote-PC"


def get_active_port(port: int | None = None) -> int:
    """Return the active HTTP server port."""
    if port is not None:
        try:
            p = int(port)
            if 1 <= p <= 65535:
                return p
        except (TypeError, ValueError):
            pass
    env_port = os.environ.get("SMARTLOCALNOTE_ACTIVE_PORT", "").strip()
    if env_port:
        try:
            p = int(env_port)
            if 1 <= p <= 65535:
                return p
        except ValueError:
            pass
    if _active_http_port is not None:
        return _active_http_port
    cfg = load_config()
    try:
        return int(cfg.get("port", 8765) or 8765)
    except (TypeError, ValueError):
        return 8765


def _load_pair_state() -> dict[str, Any]:
    """Load or initialize `data/mobile_pair.json` atomically."""
    ensure_data_dirs()
    with _PAIR_LOCK:
        raw: dict[str, Any] = {}
        needs_save = False
        if MOBILE_PAIR_FILE.exists():
            try:
                loaded = json.loads(MOBILE_PAIR_FILE.read_text(encoding="utf-8"))
                if isinstance(loaded, dict):
                    raw = loaded
                else:
                    needs_save = True
            except (OSError, json.JSONDecodeError):
                needs_save = True
        else:
            needs_save = True

        pin = str(raw.get("pin") or "").strip()
        if len(pin) != 6 or not pin.isdigit():
            pin = _generate_pin()
            needs_save = True

        token = str(raw.get("token") or "").strip()
        if len(token) < 32:
            token = _generate_token()
            needs_save = True

        raw_devices = raw.get("paired_devices")
        devices: list[dict[str, Any]] = []
        if isinstance(raw_devices, list):
            for item in raw_devices:
                if isinstance(item, dict) and item.get("id"):
                    devices.append({
                        "id": str(item.get("id")),
                        "name": str(item.get("name") or "Android 手机"),
                        "paired_at": str(item.get("paired_at") or _now_iso()),
                        "last_seen": str(item.get("last_seen") or item.get("paired_at") or _now_iso()),
                    })
        else:
            needs_save = True

        state = {
            "pin": pin,
            "token": token,
            "paired_devices": devices[:MAX_PAIRED_DEVICES],
        }
        if needs_save:
            atomic_write_json(MOBILE_PAIR_FILE, state)
        return state


def _save_pair_state(state: dict[str, Any]) -> None:
    ensure_data_dirs()
    atomic_write_json(MOBILE_PAIR_FILE, state)


def get_pairing_info(port: int | None = None) -> dict[str, Any]:
    """Return LAN IP, hostname, port, 6-digit PIN, token, pairing URI, and paired devices."""
    resolved_port = get_active_port(port)
    ip = get_local_ip()
    hostname = _get_hostname()
    state = _load_pair_state()
    pin = state["pin"]
    encoded_name = quote(hostname, safe="-_.")
    uri = f"sln://pair?host={ip}&port={resolved_port}&pin={pin}&name={encoded_name}"

    with _DISCOVERY_LOCK:
        discovery_active = _discovery_running
        udp_port = _discovery_udp_port

    return {
        "ip": ip,
        "host": ip,
        "hostname": hostname,
        "port": resolved_port,
        "url": f"http://{ip}:{resolved_port}",
        "pin": pin,
        "token": state["token"],
        "uri": uri,
        "paired_devices": list(state["paired_devices"]),
        "discovery_active": discovery_active,
        "udp_port": udp_port,
    }


def rotate_pin(port: int | None = None) -> dict[str, Any]:
    """Rotate the 6-digit pairing PIN while keeping already-paired device tokens valid."""
    with _PAIR_LOCK:
        state = _load_pair_state()
        old_pin = state["pin"]
        new_pin = _generate_pin()
        while new_pin == old_pin:
            new_pin = _generate_pin()
        state["pin"] = new_pin
        _save_pair_state(state)
    return get_pairing_info(port)


def verify_pair_pin(
    pin: str,
    device_name: str = "Android 手机",
    port: int | None = None,
) -> dict[str, Any]:
    """Verify a 6-digit PIN; on success record device and return auth token + host metadata."""
    clean_pin = re.sub(r"\s+", "", str(pin or ""))
    clean_name = str(device_name or "").strip()[:60] or "Android 手机"

    with _PAIR_LOCK:
        state = _load_pair_state()
        expected_pin = str(state.get("pin") or "")
        if not clean_pin or not secrets.compare_digest(clean_pin, expected_pin):
            return {"ok": False, "error": "配对码不正确"}

        now = _now_iso()
        devices = list(state.get("paired_devices") or [])
        existing = next((d for d in devices if d.get("name") == clean_name), None)
        if existing is not None:
            existing["last_seen"] = now
            device_rec = dict(existing)
        else:
            device_rec = {
                "id": f"dev_{uuid.uuid4().hex[:8]}",
                "name": clean_name,
                "paired_at": now,
                "last_seen": now,
            }
            devices.insert(0, device_rec)

        state["paired_devices"] = devices[:MAX_PAIRED_DEVICES]
        _save_pair_state(state)

        resolved_port = get_active_port(port)
        ip = get_local_ip()
        hostname = _get_hostname()
        return {
            "ok": True,
            "token": state["token"],
            "host": ip,
            "ip": ip,
            "port": resolved_port,
            "hostname": hostname,
            "device": device_rec,
        }


def is_local_host(client_host: str | None) -> bool:
    """Return True when the request originates from loopback (`127.0.0.1` / `localhost` / `::1`)."""
    host = str(client_host or "").strip().lower()
    return host in _LOCAL_HOSTS


def verify_token(token: str, client_host: str = "") -> bool:
    """Validate mobile bearer token; always allows local loopback requests."""
    if is_local_host(client_host):
        return True
    clean = str(token or "").strip()
    if not clean:
        return False
    state = _load_pair_state()
    expected = str(state.get("token") or "")
    if not expected:
        return False
    return secrets.compare_digest(clean, expected)


def get_ping_info() -> dict[str, Any]:
    """Return lightweight service identity and workspace todo summary for Android ping."""
    try:
        todos_stats = todo_indexer.scan_all_todos().get("stats", {"total": 0, "done": 0, "open": 0})
    except Exception:
        todos_stats = {"total": 0, "done": 0, "open": 0}
    return {
        "ok": True,
        "service": SERVICE_NAME,
        "version": SERVICE_VERSION,
        "hostname": _get_hostname(),
        "ip": get_local_ip(),
        "port": get_active_port(),
        "todos_stats": todos_stats,
    }


def _udp_discovery_loop(sock: socket.socket, http_port: int) -> None:
    """Pure blocking UDP recvfrom loop (0% idle CPU, exits immediately when socket closes)."""
    hostname = _get_hostname()
    while True:
        try:
            data, addr = sock.recvfrom(1024)
        except OSError:
            break
        if not data:
            continue
        try:
            if data.lstrip().startswith(b"SLN_DISCOVER"):
                reply = json.dumps(
                    {
                        "service": SERVICE_NAME,
                        "version": SERVICE_VERSION,
                        "name": hostname,
                        "ip": get_local_ip(),
                        "port": http_port,
                    },
                    ensure_ascii=False,
                ).encode("utf-8")
                sock.sendto(reply, addr)
        except OSError:
            continue


def start_lan_discovery(http_port: int, udp_port: int = DEFAULT_UDP_PORT) -> bool:
    """Start blocking UDP LAN discovery responder on `0.0.0.0:8766` (silently degrades if busy)."""
    global _discovery_sock, _discovery_thread, _discovery_running, _discovery_udp_port, _active_http_port

    with _DISCOVERY_LOCK:
        _active_http_port = int(http_port)
        if _discovery_running and _discovery_sock is not None:
            return True

        sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        try:
            sock.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
            sock.bind(("0.0.0.0", int(udp_port)))
        except OSError:
            try:
                sock.close()
            except OSError:
                pass
            _discovery_running = False
            return False

        _discovery_sock = sock
        _discovery_udp_port = int(udp_port)
        _discovery_running = True
        thread = threading.Thread(
            target=_udp_discovery_loop,
            args=(sock, int(http_port)),
            name="sln-lan-discovery",
            daemon=True,
        )
        _discovery_thread = thread
        thread.start()
        return True


def stop_lan_discovery() -> None:
    """Close UDP discovery socket so the blocking listener thread exits cleanly."""
    global _discovery_sock, _discovery_thread, _discovery_running

    with _DISCOVERY_LOCK:
        _discovery_running = False
        sock = _discovery_sock
        _discovery_sock = None
        _discovery_thread = None

    if sock is not None:
        try:
            sock.close()
        except OSError:
            pass


def _publish_mobile_event(event_name: str, payload: dict[str, Any]) -> dict[str, Any]:
    """Broadcast a mobile SSE event both as named event and default message envelope."""
    enriched = {
        **payload,
        "event_id": f"mevt_{uuid.uuid4().hex[:10]}",
        "timestamp": _now_iso(),
    }
    scheduler.publish_event(event_name, enriched)
    # Also fan out via standard 'message' SSE event so clients using default EventSource.onmessage receive it
    scheduler.publish_event("message", {"_event": event_name, **enriched})
    return enriched


def receive_quick_sticky(
    text: str,
    color: str = "yellow",
    device_name: str = "Android",
) -> dict[str, Any]:
    """Broadcast an instant floating sticky note from mobile to desktop via SSE."""
    clean_text = str(text or "").strip()
    if not clean_text:
        raise ValueError("闪念内容不能为空")

    clean_color = str(color or "yellow").strip().lower()
    if clean_color not in _ALLOWED_STICKY_COLORS:
        clean_color = "yellow"
    clean_device = str(device_name or "Android").strip()[:60] or "Android"
    sticky_id = f"msticky_{uuid.uuid4().hex[:8]}"

    payload = {
        "id": sticky_id,
        "text": clean_text,
        "color": clean_color,
        "device_name": clean_device,
    }
    _publish_mobile_event("mobile:sticky", payload)
    return {"ok": True, **payload}


def receive_mobile_clipboard(
    text: str,
    device_name: str = "Android",
) -> dict[str, Any]:
    """Push mobile clipboard text into desktop clipboard history stack & Dynamic Island via SSE."""
    clean_text = str(text or "").strip()
    if not clean_text:
        raise ValueError("剪贴板内容不能为空")

    clean_device = str(device_name or "Android").strip()[:60] or "Android"
    payload = {
        "text": clean_text,
        "source": clean_device,
        "device_name": clean_device,
    }
    _publish_mobile_event("mobile:clipboard", payload)
    return {"ok": True, **payload}


def _sanitize_filename(raw_name: str) -> str:
    base = Path(str(raw_name or "").replace("\\", "/")).name
    cleaned = _INVALID_NAME_RE.sub("_", base).strip().strip(".")
    if not cleaned or cleaned in (".", ".."):
        return f"upload_{datetime.now().strftime('%Y%m%d_%H%M%S')}.bin"
    return cleaned[:180]


def _sanitize_rel_dir(raw_dir: str) -> Path:
    normalized = str(raw_dir or "手机直传").replace("\\", "/").strip()
    parts: list[str] = []
    for seg in normalized.split("/"):
        s = _INVALID_NAME_RE.sub("_", seg).strip()
        if not s or s in (".", "..") or ":" in s:
            continue
        parts.append(s[:64])
    if not parts:
        parts = ["手机直传"]
    return Path(*parts)


def _unique_dest_path(dest_dir: Path, filename: str) -> Path:
    candidate = dest_dir / filename
    if not candidate.exists():
        return candidate
    stem = candidate.stem
    suffix = candidate.suffix
    counter = 2
    while True:
        alt = dest_dir / f"{stem}_{counter}{suffix}"
        if not alt.exists():
            return alt
        counter += 1


def receive_mobile_upload(
    filename: str,
    content_bytes: bytes,
    target_dir: str = "手机直传",
    add_to_shelf: bool = True,
    note_append: bool = False,
) -> dict[str, Any]:
    """Atomically store a file uploaded from mobile inside `<default_notes_dir>/<target_dir>/`."""
    if not isinstance(content_bytes, (bytes, bytearray)):
        raise ValueError("上传内容必须为二进制数据")
    raw_bytes = bytes(content_bytes)
    if len(raw_bytes) > MAX_UPLOAD_BYTES:
        raise ValueError("上传文件超过 50MB 限制")

    notes_root = get_default_notes_dir().resolve()
    rel_sub = _sanitize_rel_dir(target_dir)
    dest_dir = (notes_root / rel_sub).resolve()

    # Enforce containment inside notes_root and safe_io whitelist
    try:
        dest_dir.relative_to(notes_root)
    except ValueError as exc:
        raise PermissionError("非法上传目标目录") from exc

    safe_io.resolve_safe_path(str(dest_dir))
    dest_dir.mkdir(parents=True, exist_ok=True)

    safe_name = _sanitize_filename(filename)
    dest_path = _unique_dest_path(dest_dir, safe_name)
    safe_io.atomic_write_bytes(dest_path, raw_bytes, snapshot=False)

    rel_dir = dest_path.parent.relative_to(notes_root).as_posix()
    result = {
        "ok": True,
        "path": str(dest_path),
        "name": dest_path.name,
        "rel_dir": rel_dir,
        "size": len(raw_bytes),
        "add_to_shelf": bool(add_to_shelf),
        "note_append": bool(note_append),
    }
    _publish_mobile_event("mobile:upload", result)
    return result


def receive_mobile_upload_base64(
    filename: str,
    content_base64: str,
    target_dir: str = "手机直传",
    add_to_shelf: bool = True,
    note_append: bool = False,
) -> dict[str, Any]:
    """Decode base64 JSON upload payload (zero python-multipart dependency) and store atomically."""
    raw_b64 = str(content_base64 or "").strip()
    if not raw_b64:
        raise ValueError("上传文件内容不能为空")
    if "," in raw_b64 and raw_b64.startswith("data:"):
        raw_b64 = raw_b64.split(",", 1)[1].strip()
    try:
        data = base64.b64decode(raw_b64, validate=False)
    except (binascii.Error, ValueError) as exc:
        raise ValueError("无效的 Base64 文件内容") from exc
    return receive_mobile_upload(
        filename=filename,
        content_bytes=data,
        target_dir=target_dir,
        add_to_shelf=add_to_shelf,
        note_append=note_append,
    )


def get_sync_manifest() -> list[dict[str, Any]]:
    """Scan all `.md` files under default notes directory and return sync manifest entries."""
    notes_root = get_default_notes_dir().resolve()
    manifest: list[dict[str, Any]] = []
    if not notes_root.exists():
        return manifest

    for dirpath, dirnames, filenames in os.walk(notes_root):
        dirnames[:] = sorted(d for d in dirnames if not d.startswith("."))
        cur = Path(dirpath)
        for fname in sorted(filenames):
            if fname.startswith(".") or not fname.lower().endswith(".md"):
                continue
            fpath = cur / fname
            try:
                st = fpath.stat()
                digest = hashlib.sha256(fpath.read_bytes()).hexdigest()
                rel_path = fpath.resolve().relative_to(notes_root).as_posix()
            except (OSError, ValueError):
                continue
            manifest.append({
                "rel_path": rel_path,
                "path": str(fpath.resolve()),
                "name": fpath.name,
                "mtime": round(st.st_mtime, 3),
                "size": st.st_size,
                "sha256": digest,
            })

    manifest.sort(key=lambda item: item["rel_path"].lower())
    return manifest


def _resolve_notes_rel(rel_path: str) -> Path:
    """Resolve a relative path safely inside default notes directory."""
    clean = str(rel_path or "").strip().replace("\\", "/").lstrip("/")
    if not clean or ".." in Path(clean).parts:
        raise ValueError("非法的相对路径")
    notes_root = get_default_notes_dir().resolve()
    target = (notes_root / clean).resolve()
    if notes_root not in target.parents and target != notes_root:
        raise PermissionError("路径越界")
    return target


def sync_pull_file(rel_path: str) -> dict[str, Any]:
    """Return base64-encoded content and metadata for a single note under default notes dir."""
    target = _resolve_notes_rel(rel_path)
    if not target.exists() or not target.is_file():
        raise FileNotFoundError(f"文件不存在：{rel_path}")
    raw = target.read_bytes()
    st = target.stat()
    return {
        "rel_path": target.relative_to(get_default_notes_dir().resolve()).as_posix(),
        "name": target.name,
        "mtime": round(st.st_mtime, 3),
        "size": len(raw),
        "sha256": hashlib.sha256(raw).hexdigest(),
        "content_base64": base64.b64encode(raw).decode("ascii"),
    }


def sync_push_file(rel_path: str, content_base64: str, mtime: float = 0.0) -> dict[str, Any]:
    """Write a synced file from Android atomically, creating a conflict copy if Windows is newer."""
    target = _resolve_notes_rel(rel_path)
    raw_b64 = str(content_base64 or "").strip()
    try:
        data = base64.b64decode(raw_b64, validate=False)
    except (binascii.Error, ValueError) as exc:
        raise ValueError("无效的 Base64 内容") from exc

    target.parent.mkdir(parents=True, exist_ok=True)
    incoming_sha = hashlib.sha256(data).hexdigest()
    conflict = False
    final_target = target

    if target.exists() and target.is_file():
        existing_raw = target.read_bytes()
        existing_sha = hashlib.sha256(existing_raw).hexdigest()
        if existing_sha == incoming_sha:
            return {"ok": True, "rel_path": rel_path, "skipped": True, "conflict": False}
        local_mtime = target.stat().st_mtime
        if mtime > 0 and local_mtime > mtime + 5.0:
            conflict = True
            ts = datetime.now().strftime("%Y%m%d_%H%M%S")
            final_target = target.with_name(f"{target.stem}_Android冲突副本_{ts}{target.suffix}")

    safe_io.atomic_write_bytes(final_target, data, snapshot=False)
    if mtime > 0 and not conflict:
        try:
            os.utime(final_target, (mtime, mtime))
        except OSError:
            pass
    rel_out = final_target.resolve().relative_to(get_default_notes_dir().resolve()).as_posix()
    _publish_mobile_event("mobile:upload", {"path": str(final_target), "name": final_target.name, "rel_dir": "", "add_to_shelf": False})
    return {"ok": True, "rel_path": rel_out, "conflict": conflict, "sha256": incoming_sha}
