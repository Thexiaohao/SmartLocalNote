@echo off
chcp 65001 >nul
setlocal
cd /d "%~dp0"

echo ============================================================
echo   SmartLocalNote - 本地 Windows .exe 一键打包工具
echo ============================================================

if not exist ".venv\Scripts\python.exe" (
    echo [1/4] 创建虚拟环境 .venv ...
    python -m venv .venv
)

echo [2/4] 安装精简白名单依赖与 PyInstaller ...
".venv\Scripts\python.exe" -m pip install --upgrade pip
".venv\Scripts\python.exe" -m pip install -r requirements.txt pyinstaller

echo [3/4] 开始编译单文件 SmartLocalNote.exe ...
set "SLN_BUILD_MODE=onefile"
".venv\Scripts\pyinstaller.exe" --clean --noconfirm SmartLocalNote.spec

if errorlevel 1 (
    echo [ERROR] 编译失败，请检查上方日志。
    pause
    exit /b 1
)

echo.
echo [4/4] 编译完成！
echo 可执行文件位置: %cd%\dist\SmartLocalNote.exe
echo 双击即可运行，首次启动会自动在同级目录创建 data\ 并释放 V5 全格式实测流程包。
pause
endlocal
