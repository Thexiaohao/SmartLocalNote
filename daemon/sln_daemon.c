/*
 * SmartLocalNote Native Win32 Daemon (Phase 2 + Phase 4 Hardened)
 * Pure C11, CRT-free (-nostdlib /NODEFAULTLIB), single-thread zero-poll loop.
 * Links ONLY against kernel32.dll, user32.dll, shell32.dll, advapi32.dll.
 */

#ifndef WIN32_LEAN_AND_MEAN
#define WIN32_LEAN_AND_MEAN
#endif
#ifndef UNICODE
#define UNICODE
#endif
#ifndef _UNICODE
#define _UNICODE
#endif

#include <windows.h>
#include <shellapi.h>

#define IDI_TRAY               101
#define WM_SLN_TRAY            (WM_APP + 1)
#define HOTKEY_ID_TOGGLE       1

#define IDM_TOGGLE_UI          1001
#define IDM_RELEASE_UI         1002
#define IDM_AUTOSTART          1003
#define IDM_EXIT_ALL           1004

#define TIMER_IDLE_KILL        1
#define TIMER_FORCE_KILL       2
#define TIMER_BOOT_TIMEOUT     3

#define FORCE_KILL_DELAY_MS    3500U
#define BOOT_TIMEOUT_MS        20000U

#define SLN_COPYDATA_READY     0x534C4E01U

#define CMD_SHOW               1U
#define CMD_HIDE               2U
#define CMD_TOGGLE             3U
#define CMD_QUIT               4U
#define CMD_UI_HIDDEN          10U
#define CMD_UI_SHOWN           11U
#define CMD_PING_WAKE          20U

#define QUIT_REASON_IDLE       1U
#define QUIT_REASON_TRAY       2U

typedef enum DaemonState {
    STATE_SILENT = 0,
    STATE_LAUNCHING,
    STATE_UI_VISIBLE,
    STATE_UI_HIDDEN,
    STATE_TERMINATING
} DaemonState;

typedef struct SlnReadyPayload {
    ULONGLONG main_hwnd;
    ULONGLONG msg_hwnd;
    DWORD     ui_pid;
    DWORD     reserved;
} SlnReadyPayload;

static const WCHAR kMutexName[]    = L"Local\\SmartLocalNote.Daemon.SingleInstance.v1";
static const WCHAR kClassName[]    = L"SmartLocalNoteDaemonClass";
static const WCHAR kIpcMsgName[]   = L"SmartLocalNote.IPC.Control.v1";
static const WCHAR kRunSubKey[]    = L"Software\\Microsoft\\Windows\\CurrentVersion\\Run";
static const WCHAR kRunValueName[] = L"SmartLocalNote";
static const WCHAR kTrayTip[]      = L"SmartLocalNote (Alt+Space)";

static HINSTANCE       g_hinst          = NULL;
static HWND            g_hwnd           = NULL;
static HICON           g_tray_icon      = NULL;
static UINT            g_wm_ipc         = 0;
static UINT            g_wm_taskbar     = 0;
static NOTIFYICONDATAW g_nid;
static BOOL            g_tray_added     = FALSE;

static DaemonState     g_state          = STATE_SILENT;
static HANDLE          g_job            = NULL;
static HANDLE          g_ui_process     = NULL;
static DWORD           g_ui_pid         = 0;
static HWND            g_ui_main_hwnd   = NULL;
static HWND            g_ui_msg_hwnd    = NULL;
static BOOL            g_exiting_daemon = FALSE;

static UINT g_idle_timeout_sec = 180;
static UINT g_hotkey_mod       = MOD_ALT;
static UINT g_hotkey_vk        = VK_SPACE;

/* Static path/command buffers keep stack frames tiny and avoid __chkstk calls */
static WCHAR g_exe_path[MAX_PATH];
static WCHAR g_base_dir[MAX_PATH];
static WCHAR g_ini_path[MAX_PATH];
static WCHAR g_probe_exe[MAX_PATH];
static WCHAR g_probe_arg[MAX_PATH];
static WCHAR g_work_dir[MAX_PATH];
static WCHAR g_cmd_buf[1024];
static WCHAR g_reg_buf[MAX_PATH + 8];

/* --------------------------------------------------------------------------
 * CRT-free minimal primitives
 * -------------------------------------------------------------------------- */
#ifdef _MSC_VER
#pragma function(memset, memcpy)
#endif

void *memset(void *dst, int val, size_t len) {
    unsigned char *p = (unsigned char *)dst;
    unsigned char c = (unsigned char)val;
    while (len--) {
        *p++ = c;
    }
    return dst;
}

void *memcpy(void *dst, const void *src, size_t len) {
    unsigned char *d = (unsigned char *)dst;
    const unsigned char *s = (const unsigned char *)src;
    while (len--) {
        *d++ = *s++;
    }
    return dst;
}

static size_t wstr_len(const WCHAR *s) {
    size_t n = 0;
    while (s && s[n]) n++;
    return n;
}

static void wstr_copy(WCHAR *dst, size_t cap, const WCHAR *src) {
    size_t i = 0;
    if (!dst || cap == 0) return;
    if (src) {
        while (src[i] && i + 1 < cap) {
            dst[i] = src[i];
            i++;
        }
    }
    dst[i] = L'\0';
}

static void wstr_cat(WCHAR *dst, size_t cap, const WCHAR *src) {
    size_t n = wstr_len(dst);
    size_t i = 0;
    if (!dst || n >= cap || !src) return;
    while (src[i] && n + i + 1 < cap) {
        dst[n + i] = src[i];
        i++;
    }
    dst[n + i] = L'\0';
}

static void uint_to_dec_w(UINT val, WCHAR *out, size_t cap) {
    WCHAR tmp[16];
    int n = 0;
    size_t o = 0;
    if (!out || cap < 2) return;
    if (val == 0) {
        out[0] = L'0';
        out[1] = L'\0';
        return;
    }
    while (val > 0 && n < 15) {
        tmp[n++] = (WCHAR)(L'0' + (val % 10));
        val /= 10;
    }
    while (n > 0 && o + 1 < cap) {
        out[o++] = tmp[--n];
    }
    out[o] = L'\0';
}

static void uint64_to_hex_w(ULONGLONG val, WCHAR *out, size_t cap) {
    static const WCHAR kHex[] = L"0123456789ABCDEF";
    WCHAR tmp[18];
    int n = 0;
    size_t o = 0;
    if (!out || cap < 4) return;
    out[o++] = L'0';
    out[o++] = L'x';
    if (val == 0) {
        out[o++] = L'0';
        out[o] = L'\0';
        return;
    }
    while (val > 0 && n < 16) {
        tmp[n++] = kHex[val & 0xFU];
        val >>= 4;
    }
    while (n > 0 && o + 1 < cap) {
        out[o++] = tmp[--n];
    }
    out[o] = L'\0';
}

static BOOL file_exists_w(const WCHAR *path) {
    DWORD attr = GetFileAttributesW(path);
    return (attr != INVALID_FILE_ATTRIBUTES) && !(attr & FILE_ATTRIBUTE_DIRECTORY);
}

static void trim_working_set(void) {
    SetProcessWorkingSetSize(GetCurrentProcess(), (SIZE_T)-1, (SIZE_T)-1);
}

static void kill_all_timers(HWND hwnd) {
    if (!hwnd) return;
    KillTimer(hwnd, TIMER_IDLE_KILL);
    KillTimer(hwnd, TIMER_FORCE_KILL);
    KillTimer(hwnd, TIMER_BOOT_TIMEOUT);
}

static void init_paths_and_config(void) {
    DWORD len = GetModuleFileNameW(NULL, g_exe_path, MAX_PATH);
    if (len == 0 || len >= MAX_PATH) {
        g_exe_path[0] = L'\0';
        g_base_dir[0] = L'\0';
        g_ini_path[0] = L'\0';
        return;
    }

    wstr_copy(g_base_dir, MAX_PATH, g_exe_path);
    for (DWORD i = len; i > 0; i--) {
        if (g_base_dir[i - 1] == L'\\' || g_base_dir[i - 1] == L'/') {
            g_base_dir[i - 1] = L'\0';
            break;
        }
    }

    wstr_copy(g_ini_path, MAX_PATH, g_base_dir);
    wstr_cat(g_ini_path, MAX_PATH, L"\\data\\daemon.ini");

    if (file_exists_w(g_ini_path)) {
        g_idle_timeout_sec = GetPrivateProfileIntW(L"daemon", L"idle_timeout_sec", 180, g_ini_path);
        g_hotkey_mod       = GetPrivateProfileIntW(L"daemon", L"hotkey_mod", MOD_ALT, g_ini_path);
        g_hotkey_vk        = GetPrivateProfileIntW(L"daemon", L"hotkey_vk", VK_SPACE, g_ini_path);
        if (g_hotkey_vk == 0) g_hotkey_vk = VK_SPACE;
    }
}

/* --------------------------------------------------------------------------
 * Startup Registry (HKCU, zero admin rights)
 * -------------------------------------------------------------------------- */
static BOOL is_autostart_enabled(void) {
    HKEY hkey = NULL;
    DWORD type = 0;
    DWORD cb = 0;
    LONG rc;
    if (RegOpenKeyExW(HKEY_CURRENT_USER, kRunSubKey, 0, KEY_READ, &hkey) != ERROR_SUCCESS) {
        return FALSE;
    }
    rc = RegQueryValueExW(hkey, kRunValueName, NULL, &type, NULL, &cb);
    RegCloseKey(hkey);
    return (rc == ERROR_SUCCESS && (type == REG_SZ || type == REG_EXPAND_SZ) && cb > sizeof(WCHAR));
}

static void toggle_autostart(void) {
    HKEY hkey = NULL;
    BOOL enabled = is_autostart_enabled();
    if (RegCreateKeyExW(HKEY_CURRENT_USER, kRunSubKey, 0, NULL, 0, KEY_WRITE, NULL, &hkey, NULL) != ERROR_SUCCESS) {
        return;
    }
    if (enabled) {
        RegDeleteValueW(hkey, kRunValueName);
    } else if (g_exe_path[0]) {
        DWORD cb;
        wstr_copy(g_reg_buf, MAX_PATH + 8, L"\"");
        wstr_cat(g_reg_buf, MAX_PATH + 8, g_exe_path);
        wstr_cat(g_reg_buf, MAX_PATH + 8, L"\"");
        cb = (DWORD)((wstr_len(g_reg_buf) + 1) * sizeof(WCHAR));
        RegSetValueExW(hkey, kRunValueName, 0, REG_SZ, (const BYTE *)g_reg_buf, cb);
    }
    RegCloseKey(hkey);
}

/* --------------------------------------------------------------------------
 * Job Object & UI Process Lifecycle
 * -------------------------------------------------------------------------- */
static void cleanup_ui_job(void) {
    kill_all_timers(g_hwnd);
    if (g_job) {
        TerminateJobObject(g_job, 0);
        CloseHandle(g_job);
        g_job = NULL;
    }
    if (g_ui_process) {
        CloseHandle(g_ui_process);
        g_ui_process = NULL;
    }
    g_ui_pid = 0;
    g_ui_main_hwnd = NULL;
    g_ui_msg_hwnd = NULL;
    g_state = STATE_SILENT;

    trim_working_set();

    if (g_exiting_daemon && g_hwnd) {
        DestroyWindow(g_hwnd);
    }
}

static BOOL resolve_ui_command(void) {
    WCHAR hwnd_hex[24];
    WCHAR idle_dec[16];
    BOOL has_script = FALSE;

    g_probe_exe[0] = L'\0';
    g_probe_arg[0] = L'\0';
    wstr_copy(g_work_dir, MAX_PATH, g_base_dir);

    /* 1. Standard dual-process onedir layout: <dir>\app-ui\SmartLocalNote-UI.exe */
    wstr_copy(g_probe_exe, MAX_PATH, g_base_dir);
    wstr_cat(g_probe_exe, MAX_PATH, L"\\app-ui\\SmartLocalNote-UI.exe");
    if (file_exists_w(g_probe_exe)) {
        wstr_copy(g_work_dir, MAX_PATH, g_base_dir);
        wstr_cat(g_work_dir, MAX_PATH, L"\\app-ui");
    } else {
        /* 2. Side-by-side UI executable: <dir>\SmartLocalNote-UI.exe */
        wstr_copy(g_probe_exe, MAX_PATH, g_base_dir);
        wstr_cat(g_probe_exe, MAX_PATH, L"\\SmartLocalNote-UI.exe");
        if (!file_exists_w(g_probe_exe)) {
            /* 3. Source dev fallback: <dir>\.venv\Scripts\pythonw.exe <dir>\main.py */
            wstr_copy(g_probe_arg, MAX_PATH, g_base_dir);
            wstr_cat(g_probe_arg, MAX_PATH, L"\\main.py");
            if (!file_exists_w(g_probe_arg)) {
                return FALSE;
            }
            wstr_copy(g_probe_exe, MAX_PATH, g_base_dir);
            wstr_cat(g_probe_exe, MAX_PATH, L"\\.venv\\Scripts\\pythonw.exe");
            if (!file_exists_w(g_probe_exe)) {
                wstr_copy(g_probe_exe, MAX_PATH, g_base_dir);
                wstr_cat(g_probe_exe, MAX_PATH, L"\\.venv\\Scripts\\python.exe");
            }
            if (!file_exists_w(g_probe_exe)) {
                return FALSE;
            }
            has_script = TRUE;
        }
    }

    uint64_to_hex_w((ULONGLONG)(ULONG_PTR)g_hwnd, hwnd_hex, 24);
    uint_to_dec_w(g_idle_timeout_sec, idle_dec, 16);

    wstr_copy(g_cmd_buf, 1024, L"\"");
    wstr_cat(g_cmd_buf, 1024, g_probe_exe);
    wstr_cat(g_cmd_buf, 1024, L"\"");
    if (has_script) {
        wstr_cat(g_cmd_buf, 1024, L" \"");
        wstr_cat(g_cmd_buf, 1024, g_probe_arg);
        wstr_cat(g_cmd_buf, 1024, L"\"");
    }
    wstr_cat(g_cmd_buf, 1024, L" --daemon-hwnd ");
    wstr_cat(g_cmd_buf, 1024, hwnd_hex);
    wstr_cat(g_cmd_buf, 1024, L" --idle-timeout ");
    wstr_cat(g_cmd_buf, 1024, idle_dec);
    return TRUE;
}

static BOOL launch_ui_process(void) {
    JOBOBJECT_EXTENDED_LIMIT_INFORMATION jeli;
    STARTUPINFOW si;
    PROCESS_INFORMATION pi;

    if (g_ui_process != NULL || g_state != STATE_SILENT) {
        return FALSE;
    }
    if (!resolve_ui_command()) {
        return FALSE;
    }

    g_job = CreateJobObjectW(NULL, NULL);
    if (!g_job) {
        return FALSE;
    }

    memset(&jeli, 0, sizeof(jeli));
    jeli.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
    if (!SetInformationJobObject(g_job, JobObjectExtendedLimitInformation, &jeli, sizeof(jeli))) {
        CloseHandle(g_job);
        g_job = NULL;
        return FALSE;
    }

    /* Export parent dir so app-ui\SmartLocalNote-UI.exe shares top-level data\ */
    SetEnvironmentVariableW(L"SMARTLOCALNOTE_BASE_DIR", g_base_dir);

    memset(&si, 0, sizeof(si));
    si.cb = sizeof(si);
    memset(&pi, 0, sizeof(pi));

    if (!CreateProcessW(
            g_probe_exe,
            g_cmd_buf,
            NULL,
            NULL,
            FALSE,
            CREATE_SUSPENDED,
            NULL,
            g_work_dir,
            &si,
            &pi)) {
        CloseHandle(g_job);
        g_job = NULL;
        return FALSE;
    }

    if (!AssignProcessToJobObject(g_job, pi.hProcess)) {
        TerminateProcess(pi.hProcess, 1);
        CloseHandle(pi.hThread);
        CloseHandle(pi.hProcess);
        CloseHandle(g_job);
        g_job = NULL;
        return FALSE;
    }

    ResumeThread(pi.hThread);
    CloseHandle(pi.hThread);

    g_ui_process = pi.hProcess;
    g_ui_pid = pi.dwProcessId;
    g_ui_main_hwnd = NULL;
    g_ui_msg_hwnd = NULL;
    g_state = STATE_LAUNCHING;
    AllowSetForegroundWindow(g_ui_pid);
    SetTimer(g_hwnd, TIMER_BOOT_TIMEOUT, BOOT_TIMEOUT_MS, NULL);
    return TRUE;
}

static void request_ui_quit(UINT reason) {
    if (g_ui_process == NULL) {
        if (g_exiting_daemon && g_hwnd) {
            DestroyWindow(g_hwnd);
        }
        return;
    }

    kill_all_timers(g_hwnd);
    g_state = STATE_TERMINATING;

    if (g_ui_msg_hwnd && IsWindow(g_ui_msg_hwnd)) {
        PostMessageW(g_ui_msg_hwnd, g_wm_ipc, CMD_QUIT, (LPARAM)reason);
    } else if (g_ui_main_hwnd && IsWindow(g_ui_main_hwnd)) {
        PostMessageW(g_ui_main_hwnd, WM_CLOSE, 0, 0);
    }
    SetTimer(g_hwnd, TIMER_FORCE_KILL, FORCE_KILL_DELAY_MS, NULL);
}

static void trigger_wake_or_toggle(BOOL force_show) {
    if (g_state == STATE_SILENT) {
        launch_ui_process();
        return;
    }
    if (g_state == STATE_LAUNCHING || g_state == STATE_TERMINATING) {
        if (g_ui_pid) AllowSetForegroundWindow(g_ui_pid);
        return;
    }

    KillTimer(g_hwnd, TIMER_IDLE_KILL);
    if (g_ui_pid) {
        AllowSetForegroundWindow(g_ui_pid);
    }

    if (g_ui_msg_hwnd && IsWindow(g_ui_msg_hwnd)) {
        UINT cmd = (force_show || g_state == STATE_UI_HIDDEN) ? CMD_SHOW : CMD_TOGGLE;
        PostMessageW(g_ui_msg_hwnd, g_wm_ipc, cmd, 0);
    } else if (g_ui_main_hwnd && IsWindow(g_ui_main_hwnd)) {
        ShowWindow(g_ui_main_hwnd, SW_RESTORE);
        SetForegroundWindow(g_ui_main_hwnd);
        g_state = STATE_UI_VISIBLE;
    }
}

/* --------------------------------------------------------------------------
 * Tray Icon Management
 * -------------------------------------------------------------------------- */
static void add_tray_icon(HWND hwnd) {
    memset(&g_nid, 0, sizeof(g_nid));
    g_nid.cbSize = sizeof(NOTIFYICONDATAW);
    g_nid.hWnd = hwnd;
    g_nid.uID = 1;
    g_nid.uFlags = NIF_MESSAGE | NIF_ICON | NIF_TIP;
    g_nid.uCallbackMessage = WM_SLN_TRAY;
    if (!g_tray_icon) {
        g_tray_icon = (HICON)LoadImageW(g_hinst, MAKEINTRESOURCEW(IDI_TRAY), IMAGE_ICON,
                                        GetSystemMetrics(SM_CXSMICON),
                                        GetSystemMetrics(SM_CYSMICON), 0);
    }
    g_nid.hIcon = g_tray_icon ? g_tray_icon : LoadIconW(NULL, IDI_APPLICATION);
    wstr_copy(g_nid.szTip, sizeof(g_nid.szTip) / sizeof(WCHAR), kTrayTip);

    g_tray_added = Shell_NotifyIconW(NIM_ADD, &g_nid);
    if (g_tray_added) {
        g_nid.uVersion = NOTIFYICON_VERSION_4;
        Shell_NotifyIconW(NIM_SETVERSION, &g_nid);
    }
}

static void remove_tray_icon(void) {
    if (g_tray_added) {
        Shell_NotifyIconW(NIM_DELETE, &g_nid);
        g_tray_added = FALSE;
    }
}

static void show_tray_menu(HWND hwnd) {
    HMENU menu = CreatePopupMenu();
    POINT pt;
    UINT rel_flags;
    if (!menu) return;

    rel_flags = MF_STRING | (g_ui_process != NULL ? 0 : MF_GRAYED);
    AppendMenuW(menu, MF_STRING, IDM_TOGGLE_UI, L"\x663E\x793A / \x9690\x85CF\x4E3B\x754C\x9762 (Alt+Space)");
    AppendMenuW(menu, rel_flags, IDM_RELEASE_UI, L"\x91CA\x653E\x4E3B\x754C\x9762\x5185\x5B58");
    AppendMenuW(menu, MF_SEPARATOR, 0, NULL);
    AppendMenuW(menu, MF_STRING | (is_autostart_enabled() ? MF_CHECKED : 0),
                IDM_AUTOSTART, L"\x5F00\x673A\x81EA\x52A8\x542F\x52A8");
    AppendMenuW(menu, MF_SEPARATOR, 0, NULL);
    AppendMenuW(menu, MF_STRING, IDM_EXIT_ALL, L"\x5B8C\x5168\x9000\x51FA");

    GetCursorPos(&pt);
    SetForegroundWindow(hwnd);
    TrackPopupMenu(menu, TPM_RIGHTBUTTON | TPM_BOTTOMALIGN | TPM_LEFTALIGN, pt.x, pt.y, 0, hwnd, NULL);
    PostMessageW(hwnd, WM_NULL, 0, 0);
    DestroyMenu(menu);
}

/* --------------------------------------------------------------------------
 * Host Window Procedure
 * -------------------------------------------------------------------------- */
static LRESULT CALLBACK DaemonWndProc(HWND hwnd, UINT msg, WPARAM wParam, LPARAM lParam) {
    if (msg == g_wm_taskbar && g_wm_taskbar != 0) {
        add_tray_icon(hwnd);
        return 0;
    }

    if (msg == g_wm_ipc && g_wm_ipc != 0) {
        switch ((UINT)wParam) {
        case CMD_PING_WAKE:
            trigger_wake_or_toggle(TRUE);
            return 0;
        case CMD_UI_HIDDEN:
            if (g_ui_process != NULL && g_state != STATE_TERMINATING) {
                if (g_idle_timeout_sec == 0) {
                    request_ui_quit(QUIT_REASON_IDLE);
                } else {
                    g_state = STATE_UI_HIDDEN;
                    SetTimer(hwnd, TIMER_IDLE_KILL, g_idle_timeout_sec * 1000U, NULL);
                }
            }
            return 0;
        case CMD_UI_SHOWN:
            if (g_ui_process != NULL && g_state != STATE_TERMINATING) {
                KillTimer(hwnd, TIMER_IDLE_KILL);
                g_state = STATE_UI_VISIBLE;
            }
            return 0;
        default:
            return 0;
        }
    }

    switch (msg) {
    case WM_COPYDATA: {
        const COPYDATASTRUCT *cds = (const COPYDATASTRUCT *)lParam;
        if (cds && cds->dwData == SLN_COPYDATA_READY && cds->cbData == sizeof(SlnReadyPayload) && cds->lpData) {
            const SlnReadyPayload *p = (const SlnReadyPayload *)cds->lpData;
            g_ui_main_hwnd = (HWND)(ULONG_PTR)p->main_hwnd;
            g_ui_msg_hwnd = (HWND)(ULONG_PTR)p->msg_hwnd;
            if (p->ui_pid != 0) {
                g_ui_pid = p->ui_pid;
            }
            KillTimer(hwnd, TIMER_BOOT_TIMEOUT);
            if (g_state != STATE_TERMINATING) {
                g_state = STATE_UI_VISIBLE;
                if (g_ui_pid) AllowSetForegroundWindow(g_ui_pid);
            }
            return TRUE;
        }
        return FALSE;
    }

    case WM_HOTKEY:
        if (wParam == HOTKEY_ID_TOGGLE) {
            trigger_wake_or_toggle(FALSE);
            return 0;
        }
        break;

    case WM_TIMER:
        if (wParam == TIMER_IDLE_KILL) {
            KillTimer(hwnd, TIMER_IDLE_KILL);
            if (g_state == STATE_UI_HIDDEN) {
                request_ui_quit(QUIT_REASON_IDLE);
            }
        } else if (wParam == TIMER_BOOT_TIMEOUT) {
            KillTimer(hwnd, TIMER_BOOT_TIMEOUT);
            if (g_state == STATE_LAUNCHING) {
                cleanup_ui_job();
            }
        } else if (wParam == TIMER_FORCE_KILL) {
            KillTimer(hwnd, TIMER_FORCE_KILL);
            cleanup_ui_job();
        }
        return 0;

    case WM_SLN_TRAY: {
        UINT ev = LOWORD(lParam);
        if (ev == WM_RBUTTONUP || ev == WM_CONTEXTMENU) {
            show_tray_menu(hwnd);
        } else if (ev == WM_LBUTTONUP || ev == WM_LBUTTONDBLCLK) {
            trigger_wake_or_toggle(FALSE);
        }
        return 0;
    }

    case WM_COMMAND:
        switch (LOWORD(wParam)) {
        case IDM_TOGGLE_UI:
            trigger_wake_or_toggle(FALSE);
            break;
        case IDM_RELEASE_UI:
            request_ui_quit(QUIT_REASON_TRAY);
            break;
        case IDM_AUTOSTART:
            toggle_autostart();
            break;
        case IDM_EXIT_ALL:
            g_exiting_daemon = TRUE;
            if (g_ui_process != NULL) {
                request_ui_quit(QUIT_REASON_TRAY);
            } else {
                DestroyWindow(hwnd);
            }
            break;
        default:
            break;
        }
        return 0;

    case WM_QUERYENDSESSION:
        return TRUE;

    case WM_ENDSESSION:
        if (wParam) {
            g_exiting_daemon = TRUE;
            if (g_job) {
                if (g_ui_msg_hwnd && IsWindow(g_ui_msg_hwnd)) {
                    SendMessageTimeoutW(g_ui_msg_hwnd, g_wm_ipc, CMD_QUIT, QUIT_REASON_TRAY,
                                        SMTO_ABORTIFHUNG, 1500, NULL);
                }
                TerminateJobObject(g_job, 0);
                CloseHandle(g_job);
                g_job = NULL;
            }
            if (g_ui_process) {
                CloseHandle(g_ui_process);
                g_ui_process = NULL;
            }
            remove_tray_icon();
            UnregisterHotKey(hwnd, HOTKEY_ID_TOGGLE);
        }
        return 0;

    case WM_DESTROY:
        kill_all_timers(hwnd);
        if (g_job) {
            TerminateJobObject(g_job, 0);
            CloseHandle(g_job);
            g_job = NULL;
        }
        if (g_ui_process) {
            CloseHandle(g_ui_process);
            g_ui_process = NULL;
        }
        UnregisterHotKey(hwnd, HOTKEY_ID_TOGGLE);
        remove_tray_icon();
        if (g_tray_icon) {
            DestroyIcon(g_tray_icon);
            g_tray_icon = NULL;
        }
        PostQuitMessage(0);
        return 0;
    }

    return DefWindowProcW(hwnd, msg, wParam, lParam);
}

/* --------------------------------------------------------------------------
 * CRT-free Entry Point & Single-Thread Zero-Poll Event Loop
 * -------------------------------------------------------------------------- */
void WINAPI WinMainCRTStartup(void) {
    HANDLE hMutex = NULL;
    WNDCLASSEXW wc;
    MSG msg;
    UINT exit_code = 0;

    g_hinst = GetModuleHandleW(NULL);
    g_wm_ipc = RegisterWindowMessageW(kIpcMsgName);
    g_wm_taskbar = RegisterWindowMessageW(L"TaskbarCreated");

    hMutex = CreateMutexW(NULL, TRUE, kMutexName);
    if (hMutex && GetLastError() == ERROR_ALREADY_EXISTS) {
        HWND existing = FindWindowW(kClassName, NULL);
        if (existing && g_wm_ipc) {
            DWORD existing_pid = 0;
            GetWindowThreadProcessId(existing, &existing_pid);
            if (existing_pid) AllowSetForegroundWindow(existing_pid);
            PostMessageW(existing, g_wm_ipc, CMD_PING_WAKE, 0);
        }
        CloseHandle(hMutex);
        ExitProcess(0);
    }

    init_paths_and_config();

    memset(&wc, 0, sizeof(wc));
    wc.cbSize = sizeof(WNDCLASSEXW);
    wc.lpfnWndProc = DaemonWndProc;
    wc.hInstance = g_hinst;
    wc.lpszClassName = kClassName;
    if (!RegisterClassExW(&wc)) {
        if (hMutex) CloseHandle(hMutex);
        ExitProcess(1);
    }

    g_hwnd = CreateWindowExW(
        WS_EX_TOOLWINDOW,
        kClassName,
        L"SmartLocalNoteDaemon",
        WS_POPUP,
        0, 0, 0, 0,
        NULL,
        NULL,
        g_hinst,
        NULL
    );
    if (!g_hwnd) {
        if (hMutex) CloseHandle(hMutex);
        ExitProcess(1);
    }

    add_tray_icon(g_hwnd);
    RegisterHotKey(g_hwnd, HOTKEY_ID_TOGGLE, g_hotkey_mod | MOD_NOREPEAT, g_hotkey_vk);
    trim_working_set();

    for (;;) {
        if (g_ui_process == NULL) {
            BOOL gm = GetMessageW(&msg, NULL, 0, 0);
            if (gm <= 0) {
                exit_code = (UINT)msg.wParam;
                break;
            }
            TranslateMessage(&msg);
            DispatchMessageW(&msg);
        } else {
            DWORD wait_res = MsgWaitForMultipleObjectsEx(
                1, &g_ui_process, INFINITE, QS_ALLINPUT, MWMO_INPUTAVAILABLE
            );
            if (wait_res == WAIT_OBJECT_0) {
                cleanup_ui_job();
                continue;
            }
            if (wait_res == WAIT_FAILED) {
                cleanup_ui_job();
                continue;
            }
            {
                BOOL quitting = FALSE;
                while (PeekMessageW(&msg, NULL, 0, 0, PM_REMOVE)) {
                    if (msg.message == WM_QUIT) {
                        exit_code = (UINT)msg.wParam;
                        quitting = TRUE;
                        break;
                    }
                    TranslateMessage(&msg);
                    DispatchMessageW(&msg);
                }
                if (quitting) break;
            }
        }
    }

    if (hMutex) CloseHandle(hMutex);
    ExitProcess(exit_code);
}
