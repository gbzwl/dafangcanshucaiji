@echo off
chcp 65001 >nul
cd /d "%~dp0"
set ELECTRON_RUN_AS_NODE=
echo 正在启动大放设备参数采集工具...
call pnpm start
