@echo off
setlocal
pushd "%~dp0" || exit /b 1
set "NODE_EXE=node.exe"
if exist "runtime\node.exe" set "NODE_EXE=%CD%\runtime\node.exe"
set "NEEDS_BUILD=0"
if exist "VERSION.txt" (
  if not exist "dist\index.html" goto incomplete
) else (
  "%NODE_EXE%" scripts/source-build.mjs check >nul 2>nul
  if errorlevel 1 set "NEEDS_BUILD=1"
)
if "%NEEDS_BUILD%"=="1" (
  node.exe -e "process.exit(Number(process.versions.node.split('.')[0]) < 24 ? 1 : 0)" 2>nul
  if errorlevel 1 goto missing_node
  echo Preparing the updated web application. Installing dependencies may need internet access.
  "%NODE_EXE%" scripts/source-build.mjs deps >nul 2>nul
  if errorlevel 1 (
    call npm.cmd ci --ignore-scripts
    if errorlevel 1 goto failed
  )
  call npm.cmd run build
  if errorlevel 1 goto failed
)
"%NODE_EXE%" "server\start-web.mjs"
if errorlevel 1 goto failed
popd
exit /b 0

:missing_node
echo Install Node.js 24 LTS for the source ZIP, or download the portable ZIP from GitHub Releases.
goto failed

:incomplete
echo The portable package is incomplete. Extract the entire ZIP before starting.
goto failed

:failed
echo Unable to start Render Workbench. See the message above.
if not "%RENDER_WORKBENCH_NO_PAUSE%"=="1" pause
popd
exit /b 1
