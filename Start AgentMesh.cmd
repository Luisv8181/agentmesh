@echo off
setlocal
title AgentMesh
cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 (
  echo.
  echo  AgentMesh needs Node.js, which isn't installed on this computer yet.
  echo.
  echo  Your browser will open the Node.js download page.
  echo  Download the "LTS" Windows Installer, run it with the default options,
  echo  then double-click "Start AgentMesh" again.
  echo.
  start "" "https://nodejs.org/en/download"
  pause
  exit /b 1
)

node -e "const [a,b]=process.versions.node.split('.').map(Number); process.exit(a>20||(a===20&&b>=3)?0:1)"
if errorlevel 1 (
  echo.
  echo  Your Node.js is too old for AgentMesh. Please install the current "LTS" version
  echo  from the page that just opened, then double-click "Start AgentMesh" again.
  echo.
  start "" "https://nodejs.org/en/download"
  pause
  exit /b 1
)

if not exist node_modules (
  echo.
  echo  First start: setting up AgentMesh. This takes about a minute...
  echo.
  call npm install --no-audit --no-fund
  if errorlevel 1 goto :fail
)

rem Build every start so updates are always picked up. Takes a few seconds.
call npm run build --silent > "%TEMP%\agentmesh-build.log" 2>&1
if errorlevel 1 (
  type "%TEMP%\agentmesh-build.log"
  goto :fail
)

node dist\cli\index.js ui --recent
if errorlevel 1 pause
exit /b 0

:fail
echo.
echo  Something went wrong while setting up AgentMesh.
echo  Take a screenshot of this window and send it to the person who shared AgentMesh with you.
echo.
pause
exit /b 1
