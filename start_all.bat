@echo off
chcp 65001 >nul 2>&1
title classbuzz - start (background)
cd /d "%~dp0"

:: ---- locate node ----
set "NODE=node"
where node >nul 2>nul || (
  if exist "C:\Program Files\nodejs\node.exe"        set "NODE=C:\Program Files\nodejs\node.exe"
  if exist "C:\Program Files (x86)\nodejs\node.exe"  set "NODE=C:\Program Files (x86)\nodejs\node.exe"
  if exist "%APPDATA%\nvm\nodejs\node.exe"           set "NODE=%APPDATA%\nvm\nodejs\node.exe"
  if exist "%LOCALAPPDATA%\fnm\node-versions\*"       for /d %%d in ("%LOCALAPPDATA%\fnm\node-versions\*") do if exist "%%d\installation\node.exe" set "NODE=%%d\installation\node.exe"
)
where %NODE% >nul 2>nul || (
  echo [ERROR] Node.js not found. Install from https://nodejs.org
  pause
  exit /b 1
)

echo [*] starting classbuzz in background ...
echo [*] natapp tunnel is NOT touched here (it auto-starts with Windows).
echo [*] public address comes from public-url.txt ; add --no-open to skip the browser.
echo.

%NODE% scripts/classbuzz.mjs start %*

echo.
if not defined SHELL pause
