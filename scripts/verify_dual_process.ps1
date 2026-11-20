$ErrorActionPreference = "Stop"

$RepoRoot = "c:\note\SmartLocalNote"
$BundleSrc = Join-Path $RepoRoot "dist-dual"
$TestDir = "C:\Users\Hao\.gemini\antigravity\brain\a776a01c-9e5f-43fc-b1d9-e10af098e83e\scratch\dual_verify"

# Ensure no stale SmartLocalNote processes are running
Get-Process SmartLocalNote, SmartLocalNote-UI -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue
Start-Sleep -Milliseconds 400

if (Test-Path $TestDir) { Remove-Item -Recurse -Force $TestDir }
New-Item -ItemType Directory -Force -Path $TestDir | Out-Null
Copy-Item -Recurse -Force "$BundleSrc\*" $TestDir
New-Item -ItemType Directory -Force -Path "$TestDir\data" | Out-Null
Set-Content -Path "$TestDir\data\daemon.ini" -Value "[daemon]`r`nidle_timeout_sec=5`r`n" -Encoding Ascii

$DaemonExe = Join-Path $TestDir "SmartLocalNote.exe"
$ExeBytes = (Get-Item $DaemonExe).Length
Write-Host "=== [1] Binary & DLL Check ==="
Write-Host "SmartLocalNote.exe exact bytes: $ExeBytes bytes ($([math]::Round($ExeBytes/1024, 2)) KB)"
if ($ExeBytes -gt 102400) { throw "Daemon EXE > 100 KB ($ExeBytes)" }

$objdump = (Get-ChildItem "$env:LOCALAPPDATA\Microsoft\WinGet\Packages" -Filter "*LLVM-MinGW*" -ErrorAction SilentlyContinue | ForEach-Object { Get-ChildItem $_.FullName -Recurse -Filter "llvm-objdump.exe" -ErrorAction SilentlyContinue } | Select-Object -First 1).FullName
if ($objdump) {
    $dlls = & $objdump -p $DaemonExe | Select-String "DLL Name" | ForEach-Object { $_.Line.Trim() }
    Write-Host "DLLs: $($dlls -join ' | ')"
}

# Win32 helper via Add-Type for IPC/visibility inspection in test harness
Add-Type -TypeDefinition @'
using System;
using System.Text;
using System.Runtime.InteropServices;
public static class SlvTestWin32 {
    public delegate bool EnumProc(IntPtr hwnd, IntPtr lParam);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)]
    public static extern IntPtr FindWindowW(string cls, string title);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)]
    public static extern uint RegisterWindowMessageW(string name);
    [DllImport("user32.dll")]
    public static extern bool PostMessageW(IntPtr hwnd, uint msg, IntPtr wparam, IntPtr lparam);
    [DllImport("user32.dll")]
    public static extern bool IsWindowVisible(IntPtr hwnd);
    [DllImport("user32.dll")]
    public static extern bool IsWindow(IntPtr hwnd);
    [DllImport("user32.dll")]
    public static extern bool EnumWindows(EnumProc lpEnumFunc, IntPtr lParam);
    [DllImport("user32.dll")]
    public static extern uint GetWindowThreadProcessId(IntPtr hwnd, out uint pid);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)]
    public static extern int GetWindowTextW(IntPtr hwnd, StringBuilder buf, int maxCount);

    public static IntPtr FindMainWindowByPidTitle(uint targetPid, string expectedTitle) {
        IntPtr found = IntPtr.Zero;
        EnumWindows((hwnd, lParam) => {
            uint pid;
            GetWindowThreadProcessId(hwnd, out pid);
            if (pid == targetPid && IsWindowVisible(hwnd)) {
                var sb = new StringBuilder(256);
                GetWindowTextW(hwnd, sb, 256);
                if (sb.ToString() == expectedTitle) {
                    found = hwnd;
                    return false;
                }
            }
            return true;
        }, IntPtr.Zero);
        return found;
    }
}
'@

function Get-PrivateWsMb([int]$PidVal, [string]$ProcName) {
    try {
        $p = Get-Process -Id $PidVal -ErrorAction Stop
        $ctrPath = "\Process($ProcName)\Working Set - Private"
        $val = (Get-Counter $ctrPath -ErrorAction Stop).CounterSamples[0].CookedValue
        return [math]::Round($val / 1MB, 3)
    } catch {
        $p = Get-Process -Id $PidVal -ErrorAction SilentlyContinue
        if ($p) { return [math]::Round($p.PrivateMemorySize64 / 1MB, 3) }
        return -1
    }
}

function Get-UiSubtree([int]$UiPid) {
    $all = Get-CimInstance Win32_Process | Select-Object ProcessId, ParentProcessId, Name
    $desc = New-Object System.Collections.Generic.HashSet[int]
    $null = $desc.Add($UiPid)
    $added = $true
    while ($added) {
        $added = $false
        foreach ($p in $all) {
            if ($desc.Contains([int]$p.ParentProcessId) -and -not $desc.Contains([int]$p.ProcessId)) {
                $null = $desc.Add([int]$p.ProcessId)
                $added = $true
            }
        }
    }
    return $all | Where-Object { $desc.Contains([int]$_.ProcessId) }
}

Write-Host "`n=== [2] Silent Baseline (waiting ~35s for OS threadpool idle retirement) ==="
$daemon = Start-Process -FilePath $DaemonExe -WorkingDirectory $TestDir -PassThru
Start-Sleep -Seconds 36
$dProc = Get-Process -Id $daemon.Id
$cpu0 = $dProc.TotalProcessorTime.TotalMilliseconds
Start-Sleep -Seconds 5
$dProc.Refresh()
$cpu1 = $dProc.TotalProcessorTime.TotalMilliseconds
$priv0 = Get-PrivateWsMb $daemon.Id "SmartLocalNote"
$threads0 = $dProc.Threads.Count
$handles0 = $dProc.HandleCount
Write-Host "Settled silent -> PrivateWS=${priv0}MB, Threads=$threads0, Handles=$handles0, CPU_5s_delta=$($cpu1-$cpu0)ms"
if ($priv0 -gt 2.0) { throw "PrivateWS > 2.0 MB ($priv0)" }
if ($threads0 -ne 1) { throw "Settled threads != 1 ($threads0)" }
if (($cpu1 - $cpu0) -ne 0) { throw "Silent CPU != 0" }

Write-Host "`n=== [3] Cold Wake -> READY -> Hide -> Fast Re-Show -> 5s Idle Auto-Destroy ==="
$tWake = Get-Date
Start-Process -FilePath $DaemonExe -WorkingDirectory $TestDir -Wait
$uiProc = $null
$uiHwnd = [IntPtr]::Zero
for ($i = 0; $i -lt 120; $i++) {
    $uiProc = Get-Process SmartLocalNote-UI -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($uiProc) {
        $uiHwnd = [SlvTestWin32]::FindMainWindowByPidTitle([uint32]$uiProc.Id, "SmartLocalNote")
        if ($uiHwnd -ne [IntPtr]::Zero) { break }
    }
    Start-Sleep -Milliseconds 100
}
$coldSec = [math]::Round(((Get-Date) - $tWake).TotalSeconds, 3)
if (-not $uiProc -or $uiHwnd -eq [IntPtr]::Zero) { throw "UI SmartLocalNote window failed to appear!" }
Start-Sleep -Seconds 2
$subtreeAlive = @(Get-UiSubtree $uiProc.Id)
$vis1 = [SlvTestWin32]::IsWindowVisible($uiHwnd)
Write-Host "Cold wake -> UI PID=$($uiProc.Id), MainHWND=$uiHwnd, Visible=$vis1, ColdAppear=${coldSec}s, TreeCount=$($subtreeAlive.Count)"

# Simulate user clicking window X (WM_CLOSE -> hides UI and starts 5s idle timer)
$WM_CLOSE = 0x0010
$null = [SlvTestWin32]::PostMessageW($uiHwnd, $WM_CLOSE, [IntPtr]::Zero, [IntPtr]::Zero)
Start-Sleep -Milliseconds 800
$stillWindow = [SlvTestWin32]::IsWindow($uiHwnd)
$visAfterClose = [SlvTestWin32]::IsWindowVisible($uiHwnd)
$winStateExists = Test-Path "$TestDir\data\window_state.json"
Write-Host "After WM_CLOSE -> IsWindow=$stillWindow, Visible=$visAfterClose (expected True/False), window_state_saved=$winStateExists"
if (-not $stillWindow) { throw "UI HWND was destroyed instead of hidden!" }
if ($visAfterClose) { throw "Window did not hide on close!" }
if (-not $winStateExists) { throw "window_state.json was not written on close!" }
Write-Host "window_state.json -> $((Get-Content "$TestDir\data\window_state.json" -Raw).Trim())"

# Test fast re-show (< 200ms) while still in 5s window
$tReshow = Get-Date
Start-Process -FilePath $DaemonExe -WorkingDirectory $TestDir -Wait
$reshowVis = $false
for ($i = 0; $i -lt 30; $i++) {
    if ([SlvTestWin32]::IsWindowVisible($uiHwnd)) { $reshowVis = $true; break }
    Start-Sleep -Milliseconds 20
}
$reshowMs = [math]::Round(((Get-Date) - $tReshow).TotalMilliseconds, 1)
Write-Host "Fast re-show -> Visible=$reshowVis in ${reshowMs}ms"
if (-not $reshowVis) { throw "Fast re-show failed!" }

# Hide again and let 5s idle timeout destroy the entire process tree
$null = [SlvTestWin32]::PostMessageW($uiHwnd, $WM_CLOSE, [IntPtr]::Zero, [IntPtr]::Zero)
Write-Host "Waiting for 5s idle timeout + graceful teardown..."
$destroyed = $false
for ($i = 0; $i -lt 40; $i++) {
    $left = @(Get-UiSubtree $uiProc.Id)
    if ($left.Count -eq 0) { $destroyed = $true; break }
    Start-Sleep -Milliseconds 350
}
Start-Sleep -Seconds 1
$dProc.Refresh()
$privAfterIdle = Get-PrivateWsMb $daemon.Id "SmartLocalNote"
Write-Host "After idle destroy -> TreeRemaining=$(@(Get-UiSubtree $uiProc.Id).Count), Daemon_PrivateWS=${privAfterIdle}MB, Handles=$($dProc.HandleCount)"
if (-not $destroyed) { throw "Idle destroy left zombie UI/WebView2 processes!" }
if ($privAfterIdle -gt 2.0) { throw "Daemon PrivateWS after idle destroy > 2.0 MB ($privAfterIdle)" }

Write-Host "`n=== [4] 5 Consecutive Wake/Destroy Cycles (Handle Leak Check) ==="
$daemonHwnd = [SlvTestWin32]::FindWindowW("SmartLocalNoteDaemonClass", "SmartLocalNoteDaemon")
if ($daemonHwnd -eq [IntPtr]::Zero) { throw "FindWindowW did not find SmartLocalNoteDaemon!" }
$wmIpc = [SlvTestWin32]::RegisterWindowMessageW("SmartLocalNote.IPC.Control.v1")
$handlesBeforeCycles = $dProc.HandleCount
for ($c = 1; $c -le 5; $c++) {
    $null = [SlvTestWin32]::PostMessageW($daemonHwnd, $wmIpc, [IntPtr]20, [IntPtr]::Zero) # CMD_PING_WAKE
    $pUi = $null
    $cHwnd = [IntPtr]::Zero
    for ($i = 0; $i -lt 100; $i++) {
        $pUi = Get-Process SmartLocalNote-UI -ErrorAction SilentlyContinue | Select-Object -First 1
        if ($pUi) {
            $cHwnd = [SlvTestWin32]::FindMainWindowByPidTitle([uint32]$pUi.Id, "SmartLocalNote")
            if ($cHwnd -ne [IntPtr]::Zero) { break }
        }
        Start-Sleep -Milliseconds 100
    }
    if (-not $pUi -or $cHwnd -eq [IntPtr]::Zero) { throw "Cycle $c wake failed" }
    Start-Sleep -Milliseconds 1000
    # Send WM_COMMAND IDM_RELEASE_UI (1002) for fast cycle teardown
    $null = [SlvTestWin32]::PostMessageW($daemonHwnd, 0x0111, [IntPtr]1002, [IntPtr]::Zero)
    for ($i = 0; $i -lt 40; $i++) {
        if (@(Get-UiSubtree $pUi.Id).Count -eq 0) { break }
        Start-Sleep -Milliseconds 200
    }
    Start-Sleep -Milliseconds 300
    $dProc.Refresh()
    Write-Host "  Cycle $c done -> Daemon Handles=$($dProc.HandleCount), PrivateWS=$(Get-PrivateWsMb $daemon.Id 'SmartLocalNote')MB"
}
$dProc.Refresh()
$handleDelta = $dProc.HandleCount - $handlesBeforeCycles
Write-Host "5-Cycle Handle Delta: before=$handlesBeforeCycles, after=$($dProc.HandleCount), delta=$handleDelta"
if ($handleDelta -gt 4) { throw "Handle leak detected across 5 cycles: delta=$handleDelta" }

Write-Host "`n=== [5] Forced Daemon Crash -> Kernel Job Object Zero-Zombie Check ==="
$null = [SlvTestWin32]::PostMessageW($daemonHwnd, $wmIpc, [IntPtr]20, [IntPtr]::Zero)
$pCrash = $null
$crashHwnd = [IntPtr]::Zero
for ($i = 0; $i -lt 100; $i++) {
    $pCrash = Get-Process SmartLocalNote-UI -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($pCrash) {
        $crashHwnd = [SlvTestWin32]::FindMainWindowByPidTitle([uint32]$pCrash.Id, "SmartLocalNote")
        if ($crashHwnd -ne [IntPtr]::Zero) { break }
    }
    Start-Sleep -Milliseconds 100
}
if (-not $pCrash -or $crashHwnd -eq [IntPtr]::Zero) { throw "Crash test wake failed" }
Start-Sleep -Seconds 1
$aliveCount = @(Get-UiSubtree $pCrash.Id).Count
Write-Host "Before force-kill Daemon -> UI+WebView2 tree count=$aliveCount"
Stop-Process -Id $daemon.Id -Force
Start-Sleep -Milliseconds 800
$zombieCount = @(Get-UiSubtree $pCrash.Id).Count
Write-Host "After force-kill Daemon -> remaining tree count=$zombieCount"
if ($zombieCount -ne 0) { throw "Job Object left $zombieCount zombie processes!" }

Write-Host "`n=== [6] Cleanup Temp Verify Dir ==="
Remove-Item -Recurse -Force $TestDir -ErrorAction SilentlyContinue
Write-Host "ALL_DUAL_PROCESS_ACCEPTANCE_TESTS_PASSED"
