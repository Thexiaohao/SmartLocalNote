"""Win32 native IPC, window state snapshot, and aggressive process-tree memory trimmer."""

from __future__ import annotations

import ctypes
from ctypes import wintypes
import gc
import json
import os
import struct
import sys
import threading
import time
from typing import Any

from config import WINDOW_STATE_FILE, atomic_write_json

IPC_MSG_NAME = "SmartLocalNote.IPC.Control.v1"
SLN_COPYDATA_READY = 0x534C4E01

CMD_SHOW = 1
CMD_HIDE = 2
CMD_TOGGLE = 3
CMD_QUIT = 4
CMD_UI_HIDDEN = 10
CMD_UI_SHOWN = 11

WM_COPYDATA = 0x004A
WM_CLOSE = 0x0010
WM_DESTROY = 0x0002

SW_HIDE = 0
SW_RESTORE = 9
SW_SHOW = 5
MONITOR_DEFAULTTONULL = 0
SMTO_ABORTIFHUNG = 0x0002

TH32CS_SNAPPROCESS = 0x00000002
PROCESS_QUERY_LIMITED_INFORMATION = 0x1000
PROCESS_SET_QUOTA = 0x0100

DEFAULT_WIDTH = 1360
DEFAULT_HEIGHT = 840
MIN_WIDTH = 960
MIN_HEIGHT = 640

LRESULT = ctypes.c_ssize_t
WPARAM = ctypes.c_size_t
LPARAM = ctypes.c_ssize_t
ULONG_PTR = ctypes.c_size_t
SIZE_T_MAX = ctypes.c_size_t(-1)


def _is_win32() -> bool:
    return sys.platform == "win32"


class _RECT(ctypes.Structure):
    _fields_ = [
        ("left", ctypes.c_long),
        ("top", ctypes.c_long),
        ("right", ctypes.c_long),
        ("bottom", ctypes.c_long),
    ]


class _COPYDATASTRUCT(ctypes.Structure):
    _fields_ = [
        ("dwData", ULONG_PTR),
        ("cbData", wintypes.DWORD),
        ("lpData", ctypes.c_void_p),
    ]


class _PROCESSENTRY32W(ctypes.Structure):
    _fields_ = [
        ("dwSize", wintypes.DWORD),
        ("cntUsage", wintypes.DWORD),
        ("th32ProcessID", wintypes.DWORD),
        ("th32DefaultHeapID", ULONG_PTR),
        ("th32ModuleID", wintypes.DWORD),
        ("cntThreads", wintypes.DWORD),
        ("th32ParentProcessID", wintypes.DWORD),
        ("pcPriClassBase", ctypes.c_long),
        ("dwFlags", wintypes.DWORD),
        ("szExeFile", wintypes.WCHAR * 260),
    ]


if sys.platform == "win32":
    # Private DLL instances with explicit 64-bit prototypes; never mutate global ctypes.windll
    _user32 = ctypes.WinDLL("user32", use_last_error=True)
    _kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)
    try:
        _psapi = ctypes.WinDLL("psapi", use_last_error=True)
    except Exception:
        _psapi = None

    _kernel32.GetModuleHandleW.argtypes = [wintypes.LPCWSTR]
    _kernel32.GetModuleHandleW.restype = wintypes.HMODULE
    _kernel32.GetCurrentThreadId.argtypes = []
    _kernel32.GetCurrentThreadId.restype = wintypes.DWORD
    _kernel32.GetCurrentProcess.argtypes = []
    _kernel32.GetCurrentProcess.restype = wintypes.HANDLE
    _kernel32.SetProcessWorkingSetSize.argtypes = [
        wintypes.HANDLE,
        ctypes.c_size_t,
        ctypes.c_size_t,
    ]
    _kernel32.SetProcessWorkingSetSize.restype = wintypes.BOOL
    _kernel32.CreateToolhelp32Snapshot.argtypes = [wintypes.DWORD, wintypes.DWORD]
    _kernel32.CreateToolhelp32Snapshot.restype = wintypes.HANDLE
    _kernel32.Process32FirstW.argtypes = [wintypes.HANDLE, ctypes.POINTER(_PROCESSENTRY32W)]
    _kernel32.Process32FirstW.restype = wintypes.BOOL
    _kernel32.Process32NextW.argtypes = [wintypes.HANDLE, ctypes.POINTER(_PROCESSENTRY32W)]
    _kernel32.Process32NextW.restype = wintypes.BOOL
    _kernel32.OpenProcess.argtypes = [wintypes.DWORD, wintypes.BOOL, wintypes.DWORD]
    _kernel32.OpenProcess.restype = wintypes.HANDLE
    _kernel32.CloseHandle.argtypes = [wintypes.HANDLE]
    _kernel32.CloseHandle.restype = wintypes.BOOL

    if _psapi is not None and hasattr(_psapi, "EmptyWorkingSet"):
        _psapi.EmptyWorkingSet.argtypes = [wintypes.HANDLE]
        _psapi.EmptyWorkingSet.restype = wintypes.BOOL

    _user32.RegisterWindowMessageW.argtypes = [wintypes.LPCWSTR]
    _user32.RegisterWindowMessageW.restype = wintypes.UINT
    _user32.DefWindowProcW.argtypes = [wintypes.HWND, wintypes.UINT, WPARAM, LPARAM]
    _user32.DefWindowProcW.restype = LRESULT
    _user32.RegisterClassExW.argtypes = [ctypes.c_void_p]
    _user32.RegisterClassExW.restype = wintypes.ATOM
    _user32.CreateWindowExW.argtypes = [
        wintypes.DWORD,
        wintypes.LPCWSTR,
        wintypes.LPCWSTR,
        wintypes.DWORD,
        ctypes.c_int,
        ctypes.c_int,
        ctypes.c_int,
        ctypes.c_int,
        wintypes.HWND,
        wintypes.HMENU,
        wintypes.HINSTANCE,
        ctypes.c_void_p,
    ]
    _user32.CreateWindowExW.restype = wintypes.HWND
    _user32.GetMessageW.argtypes = [
        ctypes.POINTER(wintypes.MSG),
        wintypes.HWND,
        wintypes.UINT,
        wintypes.UINT,
    ]
    _user32.GetMessageW.restype = wintypes.BOOL
    _user32.TranslateMessage.argtypes = [ctypes.POINTER(wintypes.MSG)]
    _user32.TranslateMessage.restype = wintypes.BOOL
    _user32.DispatchMessageW.argtypes = [ctypes.POINTER(wintypes.MSG)]
    _user32.DispatchMessageW.restype = LRESULT
    _user32.PostQuitMessage.argtypes = [ctypes.c_int]
    _user32.PostQuitMessage.restype = None
    _user32.PostMessageW.argtypes = [wintypes.HWND, wintypes.UINT, WPARAM, LPARAM]
    _user32.PostMessageW.restype = wintypes.BOOL
    _user32.SendMessageTimeoutW.argtypes = [
        wintypes.HWND,
        wintypes.UINT,
        WPARAM,
        LPARAM,
        wintypes.UINT,
        wintypes.UINT,
        ctypes.POINTER(ULONG_PTR),
    ]
    _user32.SendMessageTimeoutW.restype = LRESULT
    _user32.GetWindowRect.argtypes = [wintypes.HWND, ctypes.POINTER(_RECT)]
    _user32.GetWindowRect.restype = wintypes.BOOL
    _user32.IsIconic.argtypes = [wintypes.HWND]
    _user32.IsIconic.restype = wintypes.BOOL
    _user32.IsWindowVisible.argtypes = [wintypes.HWND]
    _user32.IsWindowVisible.restype = wintypes.BOOL
    _user32.MonitorFromRect.argtypes = [ctypes.POINTER(_RECT), wintypes.DWORD]
    _user32.MonitorFromRect.restype = wintypes.HMONITOR
    _user32.ShowWindow.argtypes = [wintypes.HWND, ctypes.c_int]
    _user32.ShowWindow.restype = wintypes.BOOL
    _user32.GetForegroundWindow.argtypes = []
    _user32.GetForegroundWindow.restype = wintypes.HWND
    _user32.GetWindowThreadProcessId.argtypes = [
        wintypes.HWND,
        ctypes.POINTER(wintypes.DWORD),
    ]
    _user32.GetWindowThreadProcessId.restype = wintypes.DWORD
    _user32.AttachThreadInput.argtypes = [wintypes.DWORD, wintypes.DWORD, wintypes.BOOL]
    _user32.AttachThreadInput.restype = wintypes.BOOL
    _user32.BringWindowToTop.argtypes = [wintypes.HWND]
    _user32.BringWindowToTop.restype = wintypes.BOOL
    _user32.SetForegroundWindow.argtypes = [wintypes.HWND]
    _user32.SetForegroundWindow.restype = wintypes.BOOL
    _user32.SetFocus.argtypes = [wintypes.HWND]
    _user32.SetFocus.restype = wintypes.HWND
    _user32.EnumWindows.argtypes = [ctypes.c_void_p, LPARAM]
    _user32.EnumWindows.restype = wintypes.BOOL
    _user32.GetWindowTextW.argtypes = [wintypes.HWND, wintypes.LPWSTR, ctypes.c_int]
    _user32.GetWindowTextW.restype = ctypes.c_int

    _get_dpi_for_window = getattr(_user32, "GetDpiForWindow", None)
    if _get_dpi_for_window is not None:
        _get_dpi_for_window.argtypes = [wintypes.HWND]
        _get_dpi_for_window.restype = wintypes.UINT
else:
    _user32 = None
    _kernel32 = None
    _psapi = None
    _get_dpi_for_window = None


def _trim_single_handle(hproc: Any) -> None:
    if not hproc or _kernel32 is None:
        return
    try:
        if _psapi is not None and hasattr(_psapi, "EmptyWorkingSet"):
            _psapi.EmptyWorkingSet(hproc)
    except Exception:
        pass
    try:
        _kernel32.SetProcessWorkingSetSize(hproc, SIZE_T_MAX, SIZE_T_MAX)
    except Exception:
        pass


def trim_process_tree_memory(include_children: bool = True) -> None:
    """Reclaim cold physical pages from UI process and all child WebView2 processes."""
    try:
        gc.collect()
    except Exception:
        pass
    if not _is_win32() or _kernel32 is None:
        return

    if include_children:
        try:
            snap = _kernel32.CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0)
            invalid_handle = wintypes.HANDLE(-1).value
            if snap and snap != invalid_handle:
                try:
                    parent_map: dict[int, list[int]] = {}
                    pe = _PROCESSENTRY32W()
                    pe.dwSize = ctypes.sizeof(_PROCESSENTRY32W)
                    ok = _kernel32.Process32FirstW(snap, ctypes.byref(pe))
                    while ok:
                        parent_map.setdefault(int(pe.th32ParentProcessID), []).append(int(pe.th32ProcessID))
                        ok = _kernel32.Process32NextW(snap, ctypes.byref(pe))

                    root_pid = os.getpid()
                    queue = list(parent_map.get(root_pid, []))
                    visited: set[int] = set()
                    access = PROCESS_QUERY_LIMITED_INFORMATION | PROCESS_SET_QUOTA
                    while queue:
                        child_pid = queue.pop(0)
                        if child_pid in visited or child_pid <= 0:
                            continue
                        visited.add(child_pid)
                        queue.extend(parent_map.get(child_pid, []))
                        hchild = _kernel32.OpenProcess(access, False, child_pid)
                        if hchild:
                            try:
                                _trim_single_handle(hchild)
                            finally:
                                _kernel32.CloseHandle(hchild)
                finally:
                    _kernel32.CloseHandle(snap)
        except Exception:
            pass

    try:
        _trim_single_handle(_kernel32.GetCurrentProcess())
    except Exception:
        pass


_AUTO_TRIM_STARTED = False
_AUTO_TRIM_LOCK = threading.Lock()


def start_auto_memory_trim(interval_sec: float = 10.0) -> None:
    """Start a background daemon thread that periodically trims cold pages from UI + WebView2."""
    global _AUTO_TRIM_STARTED
    if not _is_win32():
        return
    with _AUTO_TRIM_LOCK:
        if _AUTO_TRIM_STARTED:
            return
        _AUTO_TRIM_STARTED = True

    def _loop() -> None:
        for delay in (1.0, 2.5, 5.0):
            time.sleep(delay)
            trim_process_tree_memory(include_children=True)
        while True:
            time.sleep(max(5.0, float(interval_sec)))
            trim_process_tree_memory(include_children=True)

    threading.Thread(target=_loop, name="sln-mem-trimmer", daemon=True).start()


def _get_dpi_scale(hwnd: int) -> float:
    if not _is_win32() or not hwnd or _get_dpi_for_window is None:
        return 1.0
    try:
        dpi = int(_get_dpi_for_window(wintypes.HWND(hwnd)) or 96)
        return max(1.0, dpi / 96.0)
    except Exception:
        return 1.0


def _clamp_window_rect(data: dict[str, Any]) -> dict[str, Any]:
    width = int(data.get("width") or DEFAULT_WIDTH)
    height = int(data.get("height") or DEFAULT_HEIGHT)
    width = max(MIN_WIDTH, min(3840, width))
    height = max(MIN_HEIGHT, min(2160, height))
    result: dict[str, Any] = {"width": width, "height": height}

    x = data.get("x")
    y = data.get("y")
    if isinstance(x, int) and isinstance(y, int) and x > -10000 and y > -10000:
        if _is_win32() and _user32 is not None:
            try:
                px = data.get("phys_x")
                py = data.get("phys_y")
                pw = data.get("phys_w")
                if not (isinstance(px, int) and isinstance(py, int)):
                    px, py, pw = x, y, width
                elif not isinstance(pw, int):
                    pw = width
                rc = _RECT(px + 20, py + 20, px + min(max(120, pw), 400), py + 80)
                if _user32.MonitorFromRect(ctypes.byref(rc), MONITOR_DEFAULTTONULL):
                    result["x"] = x
                    result["y"] = y
            except Exception:
                pass
        else:
            result["x"] = x
            result["y"] = y
    return result


def load_window_state() -> dict[str, Any]:
    """Load persisted window geometry validated against currently attached displays."""
    try:
        if WINDOW_STATE_FILE.exists():
            raw = json.loads(WINDOW_STATE_FILE.read_text(encoding="utf-8"))
            if isinstance(raw, dict):
                return _clamp_window_rect(raw)
    except (OSError, json.JSONDecodeError, ValueError, TypeError):
        pass
    return {"width": DEFAULT_WIDTH, "height": DEFAULT_HEIGHT}


def save_window_state(window: Any = None, main_hwnd: int = 0) -> None:
    """Persist lightweight window geometry snapshot atomically in both logical & physical px."""
    geom: dict[str, Any] = {}
    if _is_win32() and _user32 is not None and main_hwnd:
        try:
            hwnd_val = wintypes.HWND(main_hwnd)
            if _user32.IsWindowVisible(hwnd_val) and not _user32.IsIconic(hwnd_val):
                rc = _RECT()
                if _user32.GetWindowRect(hwnd_val, ctypes.byref(rc)):
                    phys_w = int(rc.right - rc.left)
                    phys_h = int(rc.bottom - rc.top)
                    scale = _get_dpi_scale(main_hwnd)
                    width = int(round(phys_w / scale))
                    height = int(round(phys_h / scale))
                    x = int(round(rc.left / scale))
                    y = int(round(rc.top / scale))
                    if width >= MIN_WIDTH and height >= MIN_HEIGHT and x > -10000 and y > -10000:
                        geom = {
                            "x": x,
                            "y": y,
                            "width": width,
                            "height": height,
                            "phys_x": int(rc.left),
                            "phys_y": int(rc.top),
                            "phys_w": phys_w,
                            "phys_h": phys_h,
                        }
        except Exception:
            geom = {}

    if not geom and window is not None:
        try:
            x = getattr(window, "x", None)
            y = getattr(window, "y", None)
            w = getattr(window, "width", DEFAULT_WIDTH)
            h = getattr(window, "height", DEFAULT_HEIGHT)
            if isinstance(w, (int, float)) and isinstance(h, (int, float)) and w >= MIN_WIDTH and h >= MIN_HEIGHT:
                geom = {"width": int(w), "height": int(h)}
                if isinstance(x, (int, float)) and isinstance(y, (int, float)) and x > -10000 and y > -10000:
                    geom["x"] = int(x)
                    geom["y"] = int(y)
        except Exception:
            pass

    if not geom:
        return
    try:
        atomic_write_json(WINDOW_STATE_FILE, geom)
    except OSError:
        pass


def _resolve_hwnd_for_window(window: Any) -> int:
    if not _is_win32() or _user32 is None:
        return 0
    try:
        native = getattr(window, "native", None)
        handle = getattr(native, "Handle", None)
        if handle is not None and hasattr(handle, "ToInt64"):
            val = int(handle.ToInt64())
            if val:
                return val
    except Exception:
        pass

    pid = os.getpid()
    found: list[int] = []
    enum_cb_t = ctypes.WINFUNCTYPE(wintypes.BOOL, wintypes.HWND, LPARAM)

    def _cb(hwnd: int, _lp: int) -> bool:
        proc_id = wintypes.DWORD(0)
        _user32.GetWindowThreadProcessId(hwnd, ctypes.byref(proc_id))
        if proc_id.value == pid:
            buf = ctypes.create_unicode_buffer(128)
            _user32.GetWindowTextW(hwnd, buf, 128)
            if buf.value == "SmartLocalNote":
                found.append(int(hwnd))
                return False
        return True

    cb = enum_cb_t(_cb)
    _user32.EnumWindows(ctypes.cast(cb, ctypes.c_void_p), 0)
    return found[0] if found else 0


def _force_foreground(hwnd: int) -> None:
    if not _is_win32() or _user32 is None or _kernel32 is None or not hwnd:
        return
    try:
        target = wintypes.HWND(hwnd)
        if _user32.IsIconic(target):
            _user32.ShowWindow(target, SW_RESTORE)
        else:
            _user32.ShowWindow(target, SW_SHOW)

        fg = _user32.GetForegroundWindow()
        fg_tid = _user32.GetWindowThreadProcessId(fg, None) if fg else 0
        cur_tid = _kernel32.GetCurrentThreadId()
        attached = False
        if fg_tid and fg_tid != cur_tid:
            attached = bool(_user32.AttachThreadInput(cur_tid, fg_tid, True))
        try:
            _user32.BringWindowToTop(target)
            _user32.SetForegroundWindow(target)
            _user32.SetFocus(target)
        finally:
            if attached:
                _user32.AttachThreadInput(cur_tid, fg_tid, False)
    except Exception:
        pass


class DaemonBridge:
    """Native Win32 message-only window bridge connecting UI process to C Daemon."""

    def __init__(self, daemon_hwnd: int, idle_timeout_sec: int = 30) -> None:
        self.daemon_hwnd = int(daemon_hwnd or 0)
        self.idle_timeout_sec = max(0, int(idle_timeout_sec))
        self.window: Any = None
        self.main_hwnd: int = 0
        self.msg_hwnd: int = 0
        self.wm_ipc: int = 0
        self.hidden: bool = False
        self.quitting: bool = False
        self._ready_sent: bool = False
        self._ready_event = threading.Event()
        self._lock = threading.Lock()
        self._wndproc_ref: Any = None
        self._thread: threading.Thread | None = None

    def attach_window(self, window: Any) -> None:
        self.window = window

    def start(self) -> None:
        if not _is_win32() or not self.daemon_hwnd:
            return
        self._thread = threading.Thread(target=self._msg_loop, name="sln-ipc-bridge", daemon=True)
        self._thread.start()
        self._ready_event.wait(timeout=3.0)

    def _msg_loop(self) -> None:
        if _user32 is None or _kernel32 is None:
            self._ready_event.set()
            return

        self.wm_ipc = int(_user32.RegisterWindowMessageW(IPC_MSG_NAME))
        hinst = _kernel32.GetModuleHandleW(None)

        WNDPROC = ctypes.WINFUNCTYPE(LRESULT, wintypes.HWND, wintypes.UINT, WPARAM, LPARAM)

        def _wndproc(hwnd: int, msg: int, wparam: int, lparam: int) -> int:
            if msg == self.wm_ipc and self.wm_ipc:
                cmd = int(wparam)
                if cmd == CMD_SHOW:
                    self.show_window()
                    return 0
                if cmd == CMD_HIDE:
                    self.hide_window()
                    return 0
                if cmd == CMD_TOGGLE:
                    if self.hidden:
                        self.show_window()
                    else:
                        self.hide_window()
                    return 0
                if cmd == CMD_QUIT:
                    self.quit_window()
                    return 0
            if msg == WM_DESTROY:
                _user32.PostQuitMessage(0)
                return 0
            return int(_user32.DefWindowProcW(hwnd, msg, wparam, lparam))

        self._wndproc_ref = WNDPROC(_wndproc)

        class WNDCLASSEXW(ctypes.Structure):
            _fields_ = [
                ("cbSize", wintypes.UINT),
                ("style", wintypes.UINT),
                ("lpfnWndProc", WNDPROC),
                ("cbClsExtra", ctypes.c_int),
                ("cbWndExtra", ctypes.c_int),
                ("hInstance", wintypes.HINSTANCE),
                ("hIcon", wintypes.HICON),
                ("hCursor", wintypes.HANDLE),
                ("hbrBackground", wintypes.HBRUSH),
                ("lpszMenuName", wintypes.LPCWSTR),
                ("lpszClassName", wintypes.LPCWSTR),
                ("hIconSm", wintypes.HICON),
            ]

        cls_name = f"SmartLocalNoteUiIpc_{os.getpid()}"
        wc = WNDCLASSEXW()
        wc.cbSize = ctypes.sizeof(WNDCLASSEXW)
        wc.lpfnWndProc = self._wndproc_ref
        wc.hInstance = hinst
        wc.lpszClassName = cls_name
        _user32.RegisterClassExW(ctypes.byref(wc))

        HWND_MESSAGE = wintypes.HWND(-3)
        hwnd = _user32.CreateWindowExW(0, cls_name, "", 0, 0, 0, 0, 0, HWND_MESSAGE, None, hinst, None)
        self.msg_hwnd = int(hwnd) if hwnd else 0
        self._ready_event.set()

        msg = wintypes.MSG()
        while _user32.GetMessageW(ctypes.byref(msg), None, 0, 0) > 0:
            _user32.TranslateMessage(ctypes.byref(msg))
            _user32.DispatchMessageW(ctypes.byref(msg))

    def notify_ready(self, window: Any) -> None:
        self.window = window
        start_auto_memory_trim()
        if not _is_win32() or _user32 is None or not self.daemon_hwnd:
            return
        self._ready_event.wait(timeout=2.0)
        if not self.main_hwnd:
            self.main_hwnd = _resolve_hwnd_for_window(window)

        with self._lock:
            if self._ready_sent:
                return
            ready_to_mark = bool(self.main_hwnd and self.msg_hwnd)

        payload = struct.pack("<QQII", self.main_hwnd, self.msg_hwnd, os.getpid(), 0)
        buf = ctypes.create_string_buffer(payload)
        cds = _COPYDATASTRUCT(SLN_COPYDATA_READY, len(payload), ctypes.cast(buf, ctypes.c_void_p))
        result_out = ULONG_PTR(0)
        sent = _user32.SendMessageTimeoutW(
            wintypes.HWND(self.daemon_hwnd),
            WM_COPYDATA,
            WPARAM(self.msg_hwnd),
            LPARAM(ctypes.addressof(cds)),
            SMTO_ABORTIFHUNG,
            2000,
            ctypes.byref(result_out),
        )
        if sent and ready_to_mark:
            with self._lock:
                self._ready_sent = True

    def _post_daemon(self, cmd: int) -> None:
        if _is_win32() and _user32 is not None and self.daemon_hwnd and self.wm_ipc:
            _user32.PostMessageW(wintypes.HWND(self.daemon_hwnd), self.wm_ipc, cmd, 0)

    def show_window(self) -> None:
        with self._lock:
            self.hidden = False
        win = self.window
        if not self.main_hwnd and win is not None:
            self.main_hwnd = _resolve_hwnd_for_window(win)
        if win is not None:
            if _is_win32() and _user32 is not None and self.main_hwnd:
                try:
                    if _user32.IsIconic(wintypes.HWND(self.main_hwnd)):
                        win.restore()
                except Exception:
                    pass
            try:
                win.show()
            except Exception:
                pass
        if not self.main_hwnd and win is not None:
            self.main_hwnd = _resolve_hwnd_for_window(win)
        _force_foreground(self.main_hwnd)
        self._post_daemon(CMD_UI_SHOWN)

    def _finish_hide(self) -> None:
        win = self.window
        if win is not None:
            try:
                win.hide()
            except Exception:
                if self.main_hwnd and _is_win32() and _user32 is not None:
                    _user32.ShowWindow(wintypes.HWND(self.main_hwnd), SW_HIDE)
        elif self.main_hwnd and _is_win32() and _user32 is not None:
            _user32.ShowWindow(wintypes.HWND(self.main_hwnd), SW_HIDE)
        self._post_daemon(CMD_UI_HIDDEN)
        trim_process_tree_memory(include_children=True)

    def hide_window(self) -> None:
        with self._lock:
            self.hidden = True
        win = self.window
        if not self.main_hwnd and win is not None:
            self.main_hwnd = _resolve_hwnd_for_window(win)
        save_window_state(win, self.main_hwnd)
        self._finish_hide()

    def quit_window(self) -> None:
        with self._lock:
            self.quitting = True
            was_hidden = self.hidden
        win = self.window
        if not was_hidden:
            if not self.main_hwnd and win is not None:
                self.main_hwnd = _resolve_hwnd_for_window(win)
            save_window_state(win, self.main_hwnd)
        if win is not None:
            try:
                win.destroy()
                return
            except Exception:
                pass
        if self.main_hwnd and _is_win32() and _user32 is not None:
            _user32.PostMessageW(wintypes.HWND(self.main_hwnd), WM_CLOSE, 0, 0)

    def on_closing(self) -> bool:
        """PyWebView `events.closing` callback; returning False cancels close and hides instead."""
        with self._lock:
            should_hide = bool(self.daemon_hwnd) and not self.quitting and self.idle_timeout_sec > 0
            if should_hide:
                self.hidden = True
        try:
            if not self.main_hwnd and self.window is not None:
                self.main_hwnd = _resolve_hwnd_for_window(self.window)
            save_window_state(self.window, self.main_hwnd)
        except Exception:
            pass
        if should_hide:
            threading.Thread(target=self._finish_hide, name="sln-hide-defer", daemon=True).start()
            return False
        return True

    def close(self) -> None:
        if _is_win32() and _user32 is not None and self.msg_hwnd:
            try:
                _user32.PostMessageW(wintypes.HWND(self.msg_hwnd), WM_CLOSE, 0, 0)
            except Exception:
                pass
