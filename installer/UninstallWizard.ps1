# SmartLocalNote Windows Native GUI Uninstaller (Defaults to preserving user data\)
Add-Type -AssemblyName System.Windows.Forms
[System.Windows.Forms.Application]::EnableVisualStyles()

$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$appRoot = Split-Path -Parent $scriptDir

$res = [System.Windows.Forms.MessageBox]::Show(
    "确定要卸载 SmartLocalNote 吗？`n`n点击「是」将卸载程序但【保留】你的 data\ 笔记数据；`n点击「否」可取消卸载。",
    '卸载 SmartLocalNote',
    [System.Windows.Forms.MessageBoxButtons]::YesNo,
    [System.Windows.Forms.MessageBoxIcon]::Question
)
if ($res -ne [System.Windows.Forms.DialogResult]::Yes) { exit 0 }

$delData = [System.Windows.Forms.MessageBox]::Show(
    "是否同时删除本地笔记数据文件夹（data\）？`n`n强烈建议选择「否」以保留你的所有 Markdown 笔记与附件！",
    '是否删除个人笔记数据？',
    [System.Windows.Forms.MessageBoxButtons]::YesNo,
    [System.Windows.Forms.MessageBoxIcon]::Warning
)

Get-Process -Name 'SmartLocalNote','SmartLocalNote-UI' -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue
Start-Sleep -Milliseconds 400

# Remove shortcuts & registry entries
$deskLink = Join-Path ([Environment]::GetFolderPath('Desktop')) 'SmartLocalNote.lnk'
if (Test-Path $deskLink) { Remove-Item $deskLink -Force -ErrorAction SilentlyContinue }
$smDir = Join-Path ([Environment]::GetFolderPath('Programs')) 'SmartLocalNote'
if (Test-Path $smDir) { Remove-Item $smDir -Recurse -Force -ErrorAction SilentlyContinue }
Remove-ItemProperty -Path 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Run' -Name 'SmartLocalNote' -ErrorAction SilentlyContinue
Remove-Item -Path 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\SmartLocalNote' -Recurse -Force -ErrorAction SilentlyContinue

# Remove program binaries
foreach ($rel in @('SmartLocalNote.exe', 'app-ui', '使用教程.md')) {
    $p = Join-Path $appRoot $rel
    if (Test-Path $p) { Remove-Item $p -Recurse -Force -ErrorAction SilentlyContinue }
}
if ($delData -eq [System.Windows.Forms.DialogResult]::Yes) {
    $dataP = Join-Path $appRoot 'data'
    if (Test-Path $dataP) { Remove-Item $dataP -Recurse -Force -ErrorAction SilentlyContinue }
}

$msg = if ($delData -eq [System.Windows.Forms.DialogResult]::Yes) {
    "SmartLocalNote 及所有本地数据已彻底卸载。"
} else {
    "SmartLocalNote 程序已卸载完成。`n你的个人笔记数据仍安全保留在：`n$(Join-Path $appRoot 'data')"
}
[System.Windows.Forms.MessageBox]::Show($msg, '卸载完成', [System.Windows.Forms.MessageBoxButtons]::OK, [System.Windows.Forms.MessageBoxIcon]::Information) | Out-Null
