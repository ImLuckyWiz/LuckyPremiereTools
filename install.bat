@echo off
rem Double-click to install the whole LuckyTwitch CEP panel (panel + shared src code). Pass -Uninstall to remove it.
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0install.ps1" %*
echo.
pause
