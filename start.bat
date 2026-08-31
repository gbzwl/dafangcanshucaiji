@echo off
chcp 65001 >nul
echo ========================================
echo   大放设备参数采集程序 v3.0
echo ========================================
echo.
echo 正在启动服务...
echo 浏览器访问: http://localhost:9091
echo.
echo 按 Ctrl+C 停止服务
echo.
node server.js
pause
