@echo off
chcp 65001 >nul
cd /d "%~dp0"
title 海报工作台 V2

where py >nul 2>nul
if %errorlevel%==0 (
  py -3 --version >nul 2>nul
  if not errorlevel 1 (
    echo 正在启动海报工作台 V2，关闭此窗口即停止服务。
    py -3 server.py --open
    goto end
  )
)

where python >nul 2>nul
if %errorlevel%==0 (
  python --version >nul 2>nul
  if not errorlevel 1 (
    echo 正在启动海报工作台 V2，关闭此窗口即停止服务。
    python server.py --open
    goto end
  )
)

where python3 >nul 2>nul
if %errorlevel%==0 (
  echo 正在启动海报工作台 V2，关闭此窗口即停止服务。
  python3 server.py --open
  goto end
)

echo 未找到 Python，请先安装 Python 3.10 或更高版本：https://www.python.org/downloads/
echo 安装时请勾选 "Add python.exe to PATH"。

:end
pause
