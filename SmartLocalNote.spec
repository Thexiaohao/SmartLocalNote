# -*- mode: python ; coding: utf-8 -*-
"""PyInstaller spec for SmartLocalNote Windows x64 executable.

Supports two modes via environment variable `SLN_BUILD_MODE`:
- `onefile` (default): Single standalone `dist/SmartLocalNote.exe`
- `onedir`: Ultra-fast cold-start portable folder `dist/SmartLocalNote/SmartLocalNote.exe`
"""

import os
import sys
from PyInstaller.utils.hooks import collect_all, collect_submodules

BUILD_MODE = os.environ.get("SLN_BUILD_MODE", "onefile").strip().lower()
EXE_NAME = os.environ.get("SLN_EXE_NAME", "SmartLocalNote").strip() or "SmartLocalNote"
ICON_PATH = os.path.join("assets", "icon.ico")

datas = [
    ("static", "static"),
    ("assets", "assets"),
]
binaries = []
hiddenimports = [
    # Local app routers & core modules
    "config",
    "api",
    "api.system_api",
    "api.files_api",
    "api.excel_api",
    "api.tools_api",
    "api.ai_api",
    "api.search_api",
    "core",
    "core.safe_io",
    "core.doc_engine",
    "core.excel_engine",
    "core.app_launcher",
    "core.tree_store",
    "core.ai_service",
    "core.search_engine",
    "core.scheduler",
    "core.daemon_bridge",
    "core.trash_manager",
    "core.todo_indexer",
    # Uvicorn / FastAPI / Starlette dynamic imports
    "uvicorn.logging",
    "uvicorn.loops",
    "uvicorn.loops.auto",
    "uvicorn.loops.asyncio",
    "uvicorn.protocols",
    "uvicorn.protocols.http",
    "uvicorn.protocols.http.auto",
    "uvicorn.protocols.http.h11_impl",
    "uvicorn.protocols.http.httptools_impl",
    "uvicorn.protocols.websockets",
    "uvicorn.protocols.websockets.auto",
    "uvicorn.lifespan",
    "uvicorn.lifespan.on",
    "uvicorn.lifespan.off",
    "anyio._backends._asyncio",
    # APScheduler dynamic triggers/executors/stores
    "apscheduler.schedulers.background",
    "apscheduler.triggers.date",
    "apscheduler.triggers.interval",
    "apscheduler.executors.pool",
    "apscheduler.jobstores.memory",
    # Stdlib modules used dynamically / in frozen bundle
    "zipfile",
    "tarfile",
    "csv",
    "xml.etree.ElementTree",
    "webbrowser",
    # Document engines
    "openpyxl",
    "openpyxl.cell._writer",
]

# Collect pywebview & Windows .NET/WebView2 runtime assemblies
for _pkg in ("webview", "clr_loader", "pythonnet"):
    try:
        _d, _b, _h = collect_all(_pkg)
        datas += _d
        binaries += _b
        hiddenimports += _h
    except Exception:
        pass

# Collect Windows native notification helper on Windows
if sys.platform == "win32":
    try:
        wn_datas, wn_bins, wn_hidden = collect_all("winotify")
        datas += wn_datas
        binaries += wn_bins
        hiddenimports += wn_hidden
    except Exception:
        hiddenimports.append("winotify")

hiddenimports += collect_submodules("apscheduler.triggers")
hiddenimports = sorted(set(hiddenimports))

excludes = [
    "matplotlib",
    "scipy",
    "numpy",
    "pandas",
    "onnxruntime",
    "pytest",
    "IPython",
    "jupyter",
    "pymupdf",
    "fitz",
    "tkinter",
    "_tkinter",
]

a = Analysis(
    ["main.py"],
    pathex=["."],
    binaries=binaries,
    datas=datas,
    hiddenimports=hiddenimports,
    hookspath=[],
    hooksconfig={},
    runtime_hooks=[],
    excludes=excludes,
    noarchive=False,
)

_STRIP_TOKENS = (
    "mupdf",
    "pymupdf",
    "tcl86",
    "tk86",
    "_tkinter",
    "_tcl_data",
    "_tk_data",
)

a.binaries = [
    b for b in a.binaries
    if not any(tok in b[0].lower() or tok in b[1].lower() for tok in _STRIP_TOKENS)
]
a.datas = [
    d for d in a.datas
    if not any(tok in d[0].lower() or tok in d[1].lower() for tok in _STRIP_TOKENS)
]

pyz = PYZ(a.pure)

if BUILD_MODE == "onedir":
    exe = EXE(
        pyz,
        a.scripts,
        [],
        exclude_binaries=True,
        name=EXE_NAME,
        debug=False,
        bootloader_ignore_signals=False,
        strip=False,
        upx=False,
        console=False,
        disable_windowed_traceback=False,
        icon=ICON_PATH if os.path.exists(ICON_PATH) else None,
    )
    coll = COLLECT(
        exe,
        a.binaries,
        a.datas,
        strip=False,
        upx=False,
        name=EXE_NAME,
    )
else:
    exe = EXE(
        pyz,
        a.scripts,
        a.binaries,
        a.datas,
        [],
        name=EXE_NAME,
        debug=False,
        bootloader_ignore_signals=False,
        strip=False,
        upx=False,
        runtime_tmpdir=None,
        console=False,
        disable_windowed_traceback=False,
        icon=ICON_PATH if os.path.exists(ICON_PATH) else None,
    )
