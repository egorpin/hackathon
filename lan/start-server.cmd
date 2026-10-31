@echo off
setlocal
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0windows\start-server.ps1" %*
set "MARS_EXIT=%ERRORLEVEL%"
if not "%MARS_EXIT%"=="0" pause
exit /b %MARS_EXIT%
