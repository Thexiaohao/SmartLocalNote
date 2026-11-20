# Build SmartLocalNote Windows Portable + One-Click Installer Distribution ZIP
$ErrorActionPreference = 'Stop'
$v7Dir = 'c:\note\SmartLocalNote_V7'
$repoDir = 'c:\note\SmartLocalNote'
$outRoot = 'c:\note\SmartLocalNote_Release'
$stageDir = Join-Path $outRoot 'SmartLocalNote_V7.5_Windows_x64'
$zipPath = Join-Path $outRoot 'SmartLocalNote_V7.5_Windows_x64_绿色便携与安装整合包.zip'

if (-not (Test-Path (Join-Path $v7Dir 'SmartLocalNote.exe'))) {
    throw "Missing $v7Dir\SmartLocalNote.exe"
}
if (-not (Test-Path (Join-Path $v7Dir 'app-ui\SmartLocalNote-UI.exe'))) {
    throw "Missing $v7Dir\app-ui\SmartLocalNote-UI.exe"
}

if (Test-Path $stageDir) { Remove-Item $stageDir -Recurse -Force }
New-Item -ItemType Directory -Path $stageDir -Force | Out-Null
New-Item -ItemType Directory -Path (Join-Path $stageDir 'installer') -Force | Out-Null

Copy-Item (Join-Path $v7Dir 'SmartLocalNote.exe') (Join-Path $stageDir 'SmartLocalNote.exe') -Force
Copy-Item (Join-Path $v7Dir 'app-ui') (Join-Path $stageDir 'app-ui') -Recurse -Force
Copy-Item (Join-Path $repoDir '使用教程.md') (Join-Path $stageDir '使用教程.md') -Force
Copy-Item (Join-Path $repoDir 'installer\安装_SmartLocalNote.bat') (Join-Path $stageDir '安装_SmartLocalNote.bat') -Force
Copy-Item (Join-Path $repoDir 'installer\卸载_SmartLocalNote.bat') (Join-Path $stageDir '卸载_SmartLocalNote.bat') -Force
Copy-Item (Join-Path $repoDir 'installer\SetupWizard.ps1') (Join-Path $stageDir 'installer\SetupWizard.ps1') -Force
Copy-Item (Join-Path $repoDir 'installer\UninstallWizard.ps1') (Join-Path $stageDir 'installer\UninstallWizard.ps1') -Force

# Write clean README inside release folder
@"
SmartLocalNote V7.5 Windows x64 便携与安装整合包
=================================================

【两种使用方式任选其一】

方式一 · 绿色免安装（解压即用）
  直接双击 SmartLocalNote.exe 即可运行。
  所有笔记数据保存在同目录 data\ 文件夹内，拷走即带走全部资料。

方式二 · 一键图形化安装到本机（推荐）
  双击「安装_SmartLocalNote.bat」打开安装向导：
  - 免管理员权限，默认安装至 %LOCALAPPDATA%\SmartLocalNote
  - 自动创建桌面快捷方式、开始菜单入口，可选开机自启
  - 自动应用 NTFS LZX 轻量化压缩（占盘仅 ~21 MB）
  - 覆盖升级时 100% 保护原 data\ 笔记目录不丢失
  - 支持从「Windows 设置 → 应用」或双击「卸载_SmartLocalNote.bat」干净卸载

常用快捷键：Alt + Space 全局秒唤 | Ctrl + K 全局搜索 | Alt + N 召唤闪念卡
详细教程请参阅同目录「使用教程.md」。
"@ | Set-Content -Path (Join-Path $stageDir '使用前必读_README.txt') -Encoding UTF8

if (Test-Path $zipPath) { Remove-Item $zipPath -Force }
Compress-Archive -Path "$stageDir\*" -DestinationPath $zipPath -CompressionLevel Optimal
$sizeMb = [Math]::Round((Get-Item $zipPath).Length / 1MB, 2)
Write-Host "RELEASE_ZIP_READY: $zipPath ($sizeMb MB)"
