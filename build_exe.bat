@echo off
chcp 65001 >nul
setlocal
cd /d "%~dp0"

echo ============================================================
echo   SmartLocalNote - 双进程极致轻量守护版 本地一键打包工具
echo ============================================================

if not exist ".venv\Scripts\python.exe" (
    echo [1/4] 创建虚拟环境 .venv ...
    python -m venv .venv
)

echo [2/4] 安装精简白名单依赖与 PyInstaller ...
".venv\Scripts\python.exe" -m pip install --upgrade pip
".venv\Scripts\python.exe" -m pip install -r requirements.txt pyinstaller

echo [3/4] 编译极致轻量原生 C11 守护进程 SmartLocalNote.exe ...
if exist "dist-dual" rmdir /s /q "dist-dual"
mkdir "dist-dual"
powershell -ExecutionPolicy Bypass -File "daemon\build_daemon.ps1" -OutPath "%cd%\dist-dual\SmartLocalNote.exe"
if errorlevel 1 (
    echo [ERROR] 原生守护进程编译失败，请确认本机已安装 LLVM-MinGW 或 MSVC。
    pause
    exit /b 1
)

echo [4/4] 编译按需拉起 UI 子程序 (app-ui\SmartLocalNote-UI.exe) ...
set "SLN_BUILD_MODE=onedir"
set "SLN_EXE_NAME=SmartLocalNote-UI"
".venv\Scripts\pyinstaller.exe" --clean --noconfirm --distpath dist-ui-tmp --workpath build-ui-tmp SmartLocalNote.spec
if errorlevel 1 (
    echo [ERROR] UI 子程序编译失败，请检查上方日志。
    pause
    exit /b 1
)

move "dist-ui-tmp\SmartLocalNote-UI" "dist-dual\app-ui" >nul
rmdir /s /q "dist-ui-tmp" 2>nul
rmdir /s /q "build-ui-tmp" 2>nul

echo.
echo ============================================================
echo   双进程版本打包完成！
echo   主入口(守护进程): %cd%\dist-dual\SmartLocalNote.exe
echo   按需UI子目录    : %cd%\dist-dual\app-ui\SmartLocalNote-UI.exe
echo   双击 SmartLocalNote.exe 驻留托盘（Alt+Space 秒唤起，关闭隐藏3分钟自动释放）
echo ============================================================
pause
endlocal
