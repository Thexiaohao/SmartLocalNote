# SmartLocalNote Windows Native GUI Setup Wizard (Zero external deps, preserves data\)
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
[System.Windows.Forms.Application]::EnableVisualStyles()

$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$pkgRoot = Split-Path -Parent $scriptDir
if (-not (Test-Path (Join-Path $pkgRoot 'SmartLocalNote.exe'))) {
    $pkgRoot = $scriptDir
}
if (-not (Test-Path (Join-Path $pkgRoot 'SmartLocalNote.exe'))) {
    [System.Windows.Forms.MessageBox]::Show(
        "未在安装包目录找到 SmartLocalNote.exe，请先完整解压压缩包后再运行安装向导。",
        "SmartLocalNote 安装向导",
        [System.Windows.Forms.MessageBoxButtons]::OK,
        [System.Windows.Forms.MessageBoxIcon]::Error
    ) | Out-Null
    exit 1
}

$defaultDir = Join-Path $env:LOCALAPPDATA 'SmartLocalNote'

$form = New-Object System.Windows.Forms.Form
$form.Text = 'SmartLocalNote V7.5 安装向导'
$form.Size = New-Object System.Drawing.Size(500, 390)
$form.StartPosition = 'CenterScreen'
$form.FormBorderStyle = 'FixedDialog'
$form.MaximizeBox = $false
$form.BackColor = [System.Drawing.Color]::FromArgb(248, 249, 252)
$form.Font = New-Object System.Drawing.Font('Microsoft YaHei UI', 9.5)

$titleLbl = New-Object System.Windows.Forms.Label
$titleLbl.Text = 'SmartLocalNote V7.5 桌面与手机直连版'
$titleLbl.Font = New-Object System.Drawing.Font('Microsoft YaHei UI', 13, [System.Drawing.FontStyle]::Bold)
$titleLbl.ForeColor = [System.Drawing.Color]::FromArgb(24, 24, 28)
$titleLbl.Location = New-Object System.Drawing.Point(24, 18)
$titleLbl.AutoSize = $true
$form.Controls.Add($titleLbl)

$subLbl = New-Object System.Windows.Forms.Label
$subLbl.Text = '极致轻量 15 KB 原生守护进程（静默 0.08 MB）· 覆盖升级自动保护 data\ 笔记不丢失'
$subLbl.ForeColor = [System.Drawing.Color]::FromArgb(100, 108, 122)
$subLbl.Location = New-Object System.Drawing.Point(24, 48)
$subLbl.Size = New-Object System.Drawing.Size(445, 22)
$form.Controls.Add($subLbl)

$dirLbl = New-Object System.Windows.Forms.Label
$dirLbl.Text = '安装目录（免管理员权限，推荐默认位置）：'
$dirLbl.Location = New-Object System.Drawing.Point(24, 86)
$dirLbl.AutoSize = $true
$form.Controls.Add($dirLbl)

$dirBox = New-Object System.Windows.Forms.TextBox
$dirBox.Text = $defaultDir
$dirBox.Location = New-Object System.Drawing.Point(24, 110)
$dirBox.Size = New-Object System.Drawing.Size(356, 26)
$form.Controls.Add($dirBox)

$browseBtn = New-Object System.Windows.Forms.Button
$browseBtn.Text = '浏览...'
$browseBtn.Location = New-Object System.Drawing.Point(388, 109)
$browseBtn.Size = New-Object System.Drawing.Size(76, 28)
$browseBtn.Add_Click({
    $fbd = New-Object System.Windows.Forms.FolderBrowserDialog
    $fbd.SelectedPath = $dirBox.Text
    if ($fbd.ShowDialog() -eq [System.Windows.Forms.DialogResult]::OK) {
        $dirBox.Text = $fbd.SelectedPath
    }
})
$form.Controls.Add($browseBtn)

$chkDesktop = New-Object System.Windows.Forms.CheckBox
$chkDesktop.Text = '创建桌面快捷方式（SmartLocalNote）'
$chkDesktop.Checked = $true
$chkDesktop.Location = New-Object System.Drawing.Point(26, 152)
$chkDesktop.AutoSize = $true
$form.Controls.Add($chkDesktop)

$chkStartMenu = New-Object System.Windows.Forms.CheckBox
$chkStartMenu.Text = '创建开始菜单快捷方式与卸载入口'
$chkStartMenu.Checked = $true
$chkStartMenu.Location = New-Object System.Drawing.Point(26, 180)
$chkStartMenu.AutoSize = $true
$form.Controls.Add($chkStartMenu)

$chkAutoStart = New-Object System.Windows.Forms.CheckBox
$chkAutoStart.Text = '开机自动启动原生守护进程（Alt+Space 随时秒唤，静默 0.08 MB）'
$chkAutoStart.Checked = $false
$chkAutoStart.Location = New-Object System.Drawing.Point(26, 208)
$chkAutoStart.AutoSize = $true
$form.Controls.Add($chkAutoStart)

$chkLaunch = New-Object System.Windows.Forms.CheckBox
$chkLaunch.Text = '安装完成后立即启动 SmartLocalNote'
$chkLaunch.Checked = $true
$chkLaunch.Location = New-Object System.Drawing.Point(26, 236)
$chkLaunch.AutoSize = $true
$form.Controls.Add($chkLaunch)

$statusLbl = New-Object System.Windows.Forms.Label
$statusLbl.Text = '准备就绪。点击「一键安装」开始部署。'
$statusLbl.ForeColor = [System.Drawing.Color]::FromArgb(75, 85, 99)
$statusLbl.Location = New-Object System.Drawing.Point(24, 272)
$statusLbl.Size = New-Object System.Drawing.Size(445, 22)
$form.Controls.Add($statusLbl)

$installBtn = New-Object System.Windows.Forms.Button
$installBtn.Text = '一键安装'
$installBtn.BackColor = [System.Drawing.Color]::FromArgb(0, 122, 255)
$installBtn.ForeColor = [System.Drawing.Color]::White
$installBtn.FlatStyle = 'Flat'
$installBtn.Location = New-Object System.Drawing.Point(280, 304)
$installBtn.Size = New-Object System.Drawing.Size(102, 34)
$form.Controls.Add($installBtn)

$cancelBtn = New-Object System.Windows.Forms.Button
$cancelBtn.Text = '取消'
$cancelBtn.Location = New-Object System.Drawing.Point(390, 304)
$cancelBtn.Size = New-Object System.Drawing.Size(74, 34)
$cancelBtn.Add_Click({ $form.Close() })
$form.Controls.Add($cancelBtn)

$installBtn.Add_Click({
    $targetDir = $dirBox.Text.Trim()
    if (-not $targetDir) {
        [System.Windows.Forms.MessageBox]::Show('请选择有效的安装目录。', '提示') | Out-Null
        return
    }
    $installBtn.Enabled = $false
    $cancelBtn.Enabled = $false
    $statusLbl.Text = '正在停止旧版本进程...'
    $form.Refresh()

    try {
        Get-Process -Name 'SmartLocalNote','SmartLocalNote-UI' -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue
        Start-Sleep -Milliseconds 400

        New-Item -ItemType Directory -Path $targetDir -Force | Out-Null
        $statusLbl.Text = '正在复制程序核心文件（自动保留已有 data\ 笔记数据）...'
        $form.Refresh()

        # Copy daemon exe, docs, installer scripts
        Copy-Item (Join-Path $pkgRoot 'SmartLocalNote.exe') (Join-Path $targetDir 'SmartLocalNote.exe') -Force
        if (Test-Path (Join-Path $pkgRoot '使用教程.md')) {
            Copy-Item (Join-Path $pkgRoot '使用教程.md') (Join-Path $targetDir '使用教程.md') -Force
        }
        if (Test-Path (Join-Path $pkgRoot '卸载_SmartLocalNote.bat')) {
            Copy-Item (Join-Path $pkgRoot '卸载_SmartLocalNote.bat') (Join-Path $targetDir '卸载_SmartLocalNote.bat') -Force
        }
        $dstInstaller = Join-Path $targetDir 'installer'
        New-Item -ItemType Directory -Path $dstInstaller -Force | Out-Null
        if (Test-Path (Join-Path $scriptDir 'UninstallWizard.ps1')) {
            Copy-Item (Join-Path $scriptDir 'UninstallWizard.ps1') (Join-Path $dstInstaller 'UninstallWizard.ps1') -Force
        }

        # Replace app-ui cleanly
        $dstUi = Join-Path $targetDir 'app-ui'
        if (Test-Path $dstUi) { Remove-Item $dstUi -Recurse -Force }
        Copy-Item (Join-Path $pkgRoot 'app-ui') $dstUi -Recurse -Force

        # Apply NTFS LZX compression on app-ui for ~21 MB footprint
        $statusLbl.Text = '正在执行 NTFS LZX 轻量化压缩（节省约 50% 磁盘空间）...'
        $form.Refresh()
        & compact.exe /c /s:"$dstUi" /exe:lzx /q | Out-Null

        # Create shortcuts via WScript.Shell
        $wsh = New-Object -ComObject WScript.Shell
        $exePath = Join-Path $targetDir 'SmartLocalNote.exe'
        $iconPath = Join-Path $targetDir 'SmartLocalNote.exe,0'

        if ($chkDesktop.Checked) {
            $deskLink = Join-Path ([Environment]::GetFolderPath('Desktop')) 'SmartLocalNote.lnk'
            $sc = $wsh.CreateShortcut($deskLink)
            $sc.TargetPath = $exePath
            $sc.WorkingDirectory = $targetDir
            $sc.IconLocation = $iconPath
            $sc.Description = 'SmartLocalNote 极致轻量本地知识工作台'
            $sc.Save()
        }

        if ($chkStartMenu.Checked) {
            $smDir = Join-Path ([Environment]::GetFolderPath('Programs')) 'SmartLocalNote'
            New-Item -ItemType Directory -Path $smDir -Force | Out-Null
            $sc1 = $wsh.CreateShortcut((Join-Path $smDir 'SmartLocalNote.lnk'))
            $sc1.TargetPath = $exePath
            $sc1.WorkingDirectory = $targetDir
            $sc1.IconLocation = $iconPath
            $sc1.Save()

            $uninstBat = Join-Path $targetDir '卸载_SmartLocalNote.bat'
            if (Test-Path $uninstBat) {
                $sc2 = $wsh.CreateShortcut((Join-Path $smDir '卸载 SmartLocalNote.lnk'))
                $sc2.TargetPath = $uninstBat
                $sc2.WorkingDirectory = $targetDir
                $sc2.Save()
            }
        }

        # Optional Auto-Start
        $runKey = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Run'
        if ($chkAutoStart.Checked) {
            Set-ItemProperty -Path $runKey -Name 'SmartLocalNote' -Value "`"$exePath`""
        }

        # Register in Windows Settings -> Apps & Features (HKCU, no admin needed)
        $uninstKey = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\SmartLocalNote'
        New-Item -Path $uninstKey -Force | Out-Null
        Set-ItemProperty -Path $uninstKey -Name 'DisplayName' -Value 'SmartLocalNote'
        Set-ItemProperty -Path $uninstKey -Name 'DisplayVersion' -Value '7.5.0'
        Set-ItemProperty -Path $uninstKey -Name 'Publisher' -Value 'SmartLocalNote Local-First'
        Set-ItemProperty -Path $uninstKey -Name 'InstallLocation' -Value $targetDir
        Set-ItemProperty -Path $uninstKey -Name 'DisplayIcon' -Value $exePath
        Set-ItemProperty -Path $uninstKey -Name 'UninstallString' -Value "`"$(Join-Path $targetDir '卸载_SmartLocalNote.bat')`""
        Set-ItemProperty -Path $uninstKey -Name 'NoModify' -Value 1 -Type DWord
        Set-ItemProperty -Path $uninstKey -Name 'NoRepair' -Value 1 -Type DWord

        $statusLbl.Text = '安装完成！'
        $form.Refresh()

        if ($chkLaunch.Checked) {
            Start-Process -FilePath $exePath -WorkingDirectory $targetDir
        }

        [System.Windows.Forms.MessageBox]::Show(
            "SmartLocalNote V7.5 已成功安装至：`n$targetDir`n`n快捷键 Alt + Space 可随时全局秒唤！",
            '安装成功',
            [System.Windows.Forms.MessageBoxButtons]::OK,
            [System.Windows.Forms.MessageBoxIcon]::Information
        ) | Out-Null
        $form.Close()
    } catch {
        [System.Windows.Forms.MessageBox]::Show(
            "安装过程中遇到问题：`n$($_.Exception.Message)",
            '安装失败',
            [System.Windows.Forms.MessageBoxButtons]::OK,
            [System.Windows.Forms.MessageBoxIcon]::Error
        ) | Out-Null
        $installBtn.Enabled = $true
        $cancelBtn.Enabled = $true
    }
})

[void]$form.ShowDialog()
