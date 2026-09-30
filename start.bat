@echo off
rem Double-click to start the audiobook server (HTTPS for phones if HTTPS=1 is set in .env).
rem Extra arguments go to server.js, e.g.  start.bat --mock
cd /d "%~dp0"
title Audiobook companion

where node >nul 2>nul
if errorlevel 1 (
  echo.
  echo   Node.js is not installed. Install the current LTS from https://nodejs.org/ and run this again.
  echo.
  pause
  exit /b 1
)

rem server.js needs Node 20.12 or newer. ("call" everywhere: node may be a .cmd shim from nvm/Volta/fnm, which must be called to come back.)
call node -e "const [a,b]=process.versions.node.split('.').map(Number);process.exit(a>20||(a===20&&b>=12)?0:1)"
if errorlevel 1 (
  echo.
  echo   This app needs Node.js 20.12 or newer, but this is:
  call node -v
  echo   Install the current LTS from https://nodejs.org/ and run this again.
  echo.
  pause
  exit /b 1
)

if not exist node_modules (
  echo First run: installing dependencies ^(npm install^) ...
  call npm install
  if errorlevel 1 (
    echo.
    echo   npm install failed - see the messages above.
    echo.
    pause
    exit /b 1
  )
)

call node server.js %*
pause
