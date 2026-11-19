@echo off
chcp 65001 >nul
setlocal
cd /d "%~dp0"

echo ========================================================
echo   SmartLocalNote - Local-First 苹果风双端工作台启动器
echo ========================================================

if exist ".venv\Scripts\python.exe" (
    set "PY_CMD=.venv\Scripts\python.exe"
) else (
    set "PY_CMD=python"
)

echo [INFO] 使用 Python: %PY_CMD%
"%PY_CMD%" main.py %*
if errorlevel 1 (
    echo.
    echo [WARN] 启动退出（错误码 %errorlevel%）。如需纯浏览器模式请运行：start.bat --web-only
    pause
)
endlocal
