@echo off
setlocal
pushd "%~dp0" || exit /b 1
set "NODE_EXE=node.exe"
if exist "runtime\node.exe" set "NODE_EXE=%CD%\runtime\node.exe"
if not exist "dist\index.html" (
  node.exe -e "process.exit(Number(process.versions.node.split('.')[0]) < 24 ? 1 : 0)" 2>nul
  if errorlevel 1 goto missing_node
  echo Preparing the web application. The first build needs internet access.
  call npm.cmd ci --ignore-scripts
  if errorlevel 1 goto failed
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

:failed
echo Unable to start Render Workbench. See the message above.
if not "%RENDER_WORKBENCH_NO_PAUSE%"=="1" pause
popd
exit /b 1
