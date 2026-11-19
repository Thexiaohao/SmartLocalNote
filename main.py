"""SmartLocalNote application entrypoint (FastAPI + optional pywebview desktop shell).

Supports both source execution (`python main.py`) and PyInstaller frozen `.exe` execution
with `--noconsole` safety, automatic demo seeding, port fallback, and WebView2 native windowing.
"""

from __future__ import annotations

import argparse
from contextlib import asynccontextmanager
import importlib
import mimetypes
import os
import platform
import socket
import sys
import threading
import time
import traceback
from typing import Any
import webbrowser

# Force standard web MIME types BEFORE FastAPI StaticFiles initializes
# (Prevents Windows Registry HKCR\.js -> text/plain from blocking <script type="module"> in WebView2!)
mimetypes.init()
mimetypes.add_type("application/javascript", ".js")
mimetypes.add_type("application/javascript", ".mjs")
mimetypes.add_type("text/css", ".css")
mimetypes.add_type("image/svg+xml", ".svg")
mimetypes.add_type("application/manifest+json", ".webmanifest")

# Guard stdout/stderr in PyInstaller --noconsole/--windowed mode BEFORE importing uvicorn
if sys.stdout is None:
    sys.stdout = open(os.devnull, "w", encoding="utf-8")
if sys.stderr is None:
    sys.stderr = open(os.devnull, "w", encoding="utf-8")

from fastapi import Body, FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, HTMLResponse, JSONResponse
from fastapi.staticfiles import StaticFiles
import uvicorn

from api import ok, register_exception_handlers
from config import (
    DATA_DIR,
    IS_FROZEN,
    RESOURCE_DIR,
    ensure_data_dirs,
    get_default_notes_dir,
    get_local_ip,
    load_config,
    update_config,
)

# Explicit router imports so PyInstaller static analysis always bundles all API & core modules
from api import ai_api, excel_api, files_api, system_api, tools_api  # noqa: F401
from core import scheduler as _core_scheduler  # noqa: F401

STATIC_DIR = RESOURCE_DIR / "static"
ICON_FILE = RESOURCE_DIR / "assets" / "icon.ico"
_NO_CACHE_HEADERS = {
    "Cache-Control": "no-store, no-cache, must-revalidate, max-age=0",
    "Pragma": "no-cache",
}
_ROUTER_MODULES = (
    "api.system_api",
    "api.files_api",
    "api.excel_api",
    "api.tools_api",
    "api.ai_api",
)


def _try_scheduler_hook(fn_name: str) -> None:
    try:
        scheduler_mod = importlib.import_module("core.scheduler")
    except ImportError:
        return
    hook = getattr(scheduler_mod, fn_name, None)
    if callable(hook):
        try:
            hook()
        except Exception:
            pass


@asynccontextmanager
async def lifespan(_app: FastAPI):
    ensure_data_dirs()
    get_default_notes_dir()
    _try_scheduler_hook("start_scheduler")
    try:
        yield
    finally:
        _try_scheduler_hook("stop_scheduler")


app = FastAPI(title="SmartLocalNote", lifespan=lifespan)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.middleware("http")
async def _enforce_static_mime_types(request: Request, call_next):
    """Guarantee correct Content-Type for ES6 JS modules & CSS regardless of Windows registry."""
    response = await call_next(request)
    path = request.url.path.lower()
    if path.endswith((".js", ".mjs")):
        response.headers["content-type"] = "application/javascript; charset=utf-8"
        response.headers["cache-control"] = "no-store"
    elif path.endswith(".css"):
        response.headers["content-type"] = "text/css; charset=utf-8"
    elif path.endswith(".svg"):
        response.headers["content-type"] = "image/svg+xml"
    return response


register_exception_handlers(app)


def _mount_available_routers() -> set[str]:
    mounted: set[str] = set()
    for mod_name in _ROUTER_MODULES:
        try:
            mod = importlib.import_module(mod_name)
        except ImportError:
            continue
        router = getattr(mod, "router", None)
        if router is not None:
            app.include_router(router)
            mounted.add(mod_name)
    return mounted


_mounted_routers = _mount_available_routers()

if "api.system_api" not in _mounted_routers:

    @app.get("/api/system/info")
    async def _fallback_system_info() -> dict:
        cfg = load_config()
        ai_cfg = cfg.get("ai") if isinstance(cfg.get("ai"), dict) else {}
        return ok({
            "ip": get_local_ip(),
            "port": cfg.get("port", 8765),
            "platform": platform.system(),
            "ai_configured": bool(str(ai_cfg.get("api_key", "")).strip()),
        })

    @app.get("/api/system/config")
    async def _fallback_get_config() -> dict:
        return ok(load_config())

    @app.put("/api/system/config")
    async def _fallback_update_config(payload: dict[str, Any] = Body(...)) -> dict:
        return ok(update_config(payload), message="配置已更新")


if STATIC_DIR.exists():
    app.mount("/static", StaticFiles(directory=str(STATIC_DIR)), name="static")


@app.get("/")
async def serve_index():
    index_file = STATIC_DIR / "index.html"
    if index_file.exists():
        return FileResponse(index_file, headers=_NO_CACHE_HEADERS)
    return HTMLResponse(
        "<!doctype html><html><head><meta charset='utf-8'><title>SmartLocalNote</title></head>"
        "<body><h2>SmartLocalNote API Ready</h2><p>static/index.html not found.</p></body></html>",
        headers=_NO_CACHE_HEADERS,
    )


@app.get("/manifest.json")
async def serve_manifest():
    manifest_file = STATIC_DIR / "manifest.json"
    if manifest_file.exists():
        return FileResponse(manifest_file, media_type="application/manifest+json", headers=_NO_CACHE_HEADERS)
    return JSONResponse({
        "name": "SmartLocalNote",
        "short_name": "LocalNote",
        "start_url": "/",
        "display": "standalone",
        "theme_color": "#F5F5F7",
        "background_color": "#F5F5F7",
        "icons": [],
    })


def _pick_available_port(preferred_port: int, span: int = 20) -> int:
    """Return preferred_port if free on localhost, else scan next `span` ports."""
    for candidate in range(preferred_port, preferred_port + span + 1):
        with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as sock:
            sock.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
            try:
                sock.bind(("127.0.0.1", candidate))
                return candidate
            except OSError:
                continue
    return preferred_port


def _wait_for_port(port: int, timeout: float = 12.0) -> bool:
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        try:
            with socket.create_connection(("127.0.0.1", port), timeout=0.25):
                return True
        except OSError:
            time.sleep(0.05)
    return False


def _is_headless_linux() -> bool:
    return (
        sys.platform.startswith("linux")
        and not os.environ.get("DISPLAY")
        and not os.environ.get("WAYLAND_DISPLAY")
    )


def _configure_windows_shell() -> None:
    """Set Windows AppUserModelID so taskbar icon & native notifications group cleanly."""
    if sys.platform != "win32":
        return
    try:
        import ctypes
        ctypes.windll.shell32.SetCurrentProcessExplicitAppUserModelID("SmartLocalNote.Desktop.1")
    except Exception:
        pass


def _show_fatal_error(exc: BaseException) -> None:
    """Log crash details to data/last_error.log and display native Windows dialog if frozen."""
    tb = traceback.format_exc()
    try:
        DATA_DIR.mkdir(parents=True, exist_ok=True)
        (DATA_DIR / "last_error.log").write_text(tb, encoding="utf-8")
    except OSError:
        pass
    if sys.platform == "win32" and IS_FROZEN:
        try:
            import ctypes
            msg = f"SmartLocalNote 启动遇到问题：\n{exc}\n\n详细日志已保存至 data/last_error.log"
            ctypes.windll.user32.MessageBoxW(0, msg, "SmartLocalNote 启动提示", 0x10)
        except Exception:
            pass
    else:
        print(tb, file=sys.stderr)


def _print_banner(port: int, lan_ip: str, web_only: bool) -> None:
    mode = "Web-Only Mode" if web_only else "Desktop + Web Mode"
    print("=" * 56)
    print(f"  SmartLocalNote ({mode})")
    print(f"  Local URL : http://127.0.0.1:{port}")
    print(f"  Mobile LAN: http://{lan_ip}:{port}")
    print("=" * 56, flush=True)


def _run_uvicorn(host: str, port: int, *, quiet: bool = False) -> None:
    """Start uvicorn safely even when running inside a console-less Windows .exe."""
    use_null_log = IS_FROZEN or quiet or not getattr(sys.stderr, "isatty", lambda: False)()
    kwargs: dict[str, Any] = {
        "host": host,
        "port": port,
        "log_level": "warning" if quiet else "info",
    }
    if use_null_log:
        kwargs["log_config"] = None
    uvicorn.run(app, **kwargs)


def main() -> None:
    _configure_windows_shell()
    ensure_data_dirs()
    cfg = load_config()
    default_port = int(cfg.get("port", 8765) or 8765)

    parser = argparse.ArgumentParser(description="SmartLocalNote local-first workbench")
    parser.add_argument("--web-only", action="store_true", help="Run HTTP server only without desktop window")
    parser.add_argument("--host", default="0.0.0.0", help="Bind host (default: 0.0.0.0)")
    parser.add_argument("--port", type=int, default=default_port, help=f"Bind port (default: {default_port})")
    args = parser.parse_args()

    port = _pick_available_port(args.port)
    if port != cfg.get("port"):
        os.environ["SMARTLOCALNOTE_ACTIVE_PORT"] = str(port)

    webview = None
    if not args.web_only and not _is_headless_linux():
        try:
            webview = importlib.import_module("webview")
        except ImportError:
            webview = None

    use_web_only = args.web_only or webview is None
    _print_banner(port, get_local_ip(), use_web_only)

    if use_web_only:
        _run_uvicorn(args.host, port, quiet=False)
        return

    server_thread = threading.Thread(
        target=_run_uvicorn,
        args=(args.host, port),
        kwargs={"quiet": True},
        daemon=True,
    )
    server_thread.start()
    _wait_for_port(port)

    url = f"http://127.0.0.1:{port}"
    try:
        webview.create_window(
            "SmartLocalNote",
            url,
            width=1360,
            height=840,
            min_size=(960, 640),
        )
        if sys.platform == "win32":
            try:
                webview.start(gui="edgechromium")
            except Exception:
                webview.start()
        else:
            webview.start()
    except Exception:
        # Ultimate fallback: open system default browser so user is never stuck
        webbrowser.open(url)
        while server_thread.is_alive():
            time.sleep(1.0)


if __name__ == "__main__":
    try:
        main()
    except KeyboardInterrupt:
        pass
    except BaseException as exc:
        _show_fatal_error(exc)
        raise
