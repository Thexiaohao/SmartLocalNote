param(
    [string]$OutPath = "",
    [ValidateSet("auto", "clang", "msvc")]
    [string]$Toolchain = "auto"
)

$ErrorActionPreference = "Stop"
$DaemonDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$RepoRoot = Split-Path -Parent $DaemonDir

if (-not $OutPath) {
    $OutPath = Join-Path $RepoRoot "SmartLocalNote-Daemon.exe"
}
$OutDir = Split-Path -Parent $OutPath
if ($OutDir -and -not (Test-Path $OutDir)) {
    New-Item -ItemType Directory -Force -Path $OutDir | Out-Null
}

function Find-LlvmMingw {
    $candidates = @()
    $cmd = Get-Command clang.exe -ErrorAction SilentlyContinue
    if ($cmd) { $candidates += (Split-Path -Parent $cmd.Source) }
    $pkgRoots = @(
        (Join-Path $env:LOCALAPPDATA "Microsoft\WinGet\Packages"),
        "C:\Program Files",
        "C:\llvm-mingw"
    )
    foreach ($root in $pkgRoots) {
        if (Test-Path $root) {
            Get-ChildItem -Path $root -Directory -Filter "*llvm-mingw*" -ErrorAction SilentlyContinue | ForEach-Object {
                $bin = Join-Path $_.FullName "bin"
                if (Test-Path (Join-Path $bin "clang.exe")) { $candidates += $bin }
                Get-ChildItem -Path $_.FullName -Directory -ErrorAction SilentlyContinue | ForEach-Object {
                    $subBin = Join-Path $_.FullName "bin"
                    if (Test-Path (Join-Path $subBin "clang.exe")) { $candidates += $subBin }
                }
            }
        }
    }
    return $candidates | Select-Object -First 1
}

function Find-Msvc {
    $cl = Get-Command cl.exe -ErrorAction SilentlyContinue
    if ($cl) { return "PATH" }
    $vsRoots = @(
        "C:\Program Files\Microsoft Visual Studio",
        "C:\Program Files (x86)\Microsoft Visual Studio"
    )
    foreach ($r in $vsRoots) {
        if (Test-Path $r) {
            $found = Get-ChildItem -Path $r -Recurse -Filter "cl.exe" -ErrorAction SilentlyContinue |
                Where-Object { $_.FullName -match "Hostx64\\x64\\cl\.exe$" } |
                Select-Object -First 1
            if ($found) { return $found.FullName }
        }
    }
    return $null
}

$chosen = $Toolchain
$llvmBin = $null
$msvcCl = $null

if ($chosen -eq "auto") {
    $msvcCl = Find-Msvc
    $llvmBin = Find-LlvmMingw
    if ($llvmBin) { $chosen = "clang" }
    elseif ($msvcCl) { $chosen = "msvc" }
    else { throw "No C11 Windows toolchain found (LLVM-MinGW or MSVC)." }
} elseif ($chosen -eq "clang") {
    $llvmBin = Find-LlvmMingw
    if (-not $llvmBin) { throw "LLVM-MinGW clang.exe not found." }
} elseif ($chosen -eq "msvc") {
    $msvcCl = Find-Msvc
    if (-not $msvcCl) { throw "MSVC cl.exe not found." }
}

Push-Location $DaemonDir
try {
    if ($chosen -eq "clang") {
        $clang = Join-Path $llvmBin "clang.exe"
        $windres = Join-Path $llvmBin "x86_64-w64-mingw32-windres.exe"
        if (-not (Test-Path $windres)) { $windres = Join-Path $llvmBin "windres.exe" }
        $objdump = Join-Path $llvmBin "llvm-objdump.exe"

        $resObj = Join-Path $DaemonDir "daemon.res"
        & $windres "daemon.rc" "-O" "coff" "-o" $resObj
        if ($LASTEXITCODE -ne 0) { throw "windres failed ($LASTEXITCODE)" }

        & $clang `
            -target x86_64-w64-mingw32 -std=c11 -Os `
            -fno-exceptions -fno-asynchronous-unwind-tables -fno-ident `
            -fno-builtin -mno-stack-arg-probe `
            -ffunction-sections -fdata-sections `
            -Wall -Wextra `
            -DUNICODE -D_UNICODE -DWIN32_LEAN_AND_MEAN `
            -nostdlib -mwindows `
            "-Wl,--entry=WinMainCRTStartup" `
            "-Wl,--gc-sections" `
            "-Wl,--strip-all" `
            "-Wl,--file-alignment=512" `
            "sln_daemon.c" $resObj `
            -o $OutPath `
            -lkernel32 -luser32 -lshell32 -ladvapi32
        if ($LASTEXITCODE -ne 0) { throw "clang link failed ($LASTEXITCODE)" }
        Remove-Item -Force $resObj -ErrorAction SilentlyContinue

        $info = Get-Item $OutPath
        Write-Host "Built ($chosen): $($info.FullName) -> $($info.Length) bytes"
        if (Test-Path $objdump) {
            Write-Host "--- DLL Imports ---"
            & $objdump -p $OutPath | Select-String "DLL Name" | ForEach-Object { Write-Host $_.Line.Trim() }
        }
    } else {
        $resObj = Join-Path $DaemonDir "daemon.res"
        $objFile = Join-Path $DaemonDir "sln_daemon.obj"
        & rc.exe /nologo /fo $resObj "daemon.rc"
        if ($LASTEXITCODE -ne 0) { throw "rc.exe failed ($LASTEXITCODE)" }

        & cl.exe /nologo /c /O1 /Os /GL /GS- /EHs-c- /GR- /Gy /Gw /Oi- /W4 `
            /DUNICODE /D_UNICODE /DWIN32_LEAN_AND_MEAN /Fo$objFile "sln_daemon.c"
        if ($LASTEXITCODE -ne 0) { throw "cl.exe failed ($LASTEXITCODE)" }

        & link.exe /nologo /SUBSYSTEM:WINDOWS /ENTRY:WinMainCRTStartup /NODEFAULTLIB `
            /LTCG /OPT:REF /OPT:ICF /MERGE:.rdata=.text /ALIGN:512 /MANIFEST:NO `
            /OUT:$OutPath $objFile $resObj kernel32.lib user32.lib shell32.lib advapi32.lib
        if ($LASTEXITCODE -ne 0) { throw "link.exe failed ($LASTEXITCODE)" }

        Remove-Item -Force $resObj, $objFile -ErrorAction SilentlyContinue
        $info = Get-Item $OutPath
        Write-Host "Built ($chosen): $($info.FullName) -> $($info.Length) bytes"
    }
} finally {
    Pop-Location
}
