@echo off
setlocal
set "stratum_optimizer=%~dp0tools\campus-overview"
where node.exe >nul 2>nul
if errorlevel 1 goto :node_missing
node -e "const [major,minor]=process.versions.node.split('.').map(Number); process.exit(major>20 || major===20 && minor>=19 ? 0 : 1)"
if errorlevel 1 goto :node_missing
if not exist "%stratum_optimizer%\node_modules\sharp\package.json" (
  call npm --prefix "%stratum_optimizer%" ci --no-audit --no-fund
  if errorlevel 1 goto :failed
)
node "%stratum_optimizer%\build.mjs" %*
if errorlevel 1 goto :failed
echo Include the printed revision's overview files when publishing the campus.
if /i not "%~1"=="--after-bake" pause
exit /b 0

:node_missing
echo Install Node.js 22 LTS or newer to rebuild a landscape. The supplied campus is already optimized.
:failed
if /i not "%~1"=="--after-bake" pause
exit /b 1
