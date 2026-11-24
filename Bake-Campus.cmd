@echo off
setlocal
set "stratum_exe=%STRATUM_BLENDER%"
if defined stratum_exe if not exist "%stratum_exe%" set "stratum_exe="
if not defined stratum_exe for /f "delims=" %%B in ('where blender.exe 2^>nul') do if not defined stratum_exe set "stratum_exe=%%B"
if not defined stratum_exe for /f "delims=" %%V in ('dir /b /ad /o:-n "%ProgramFiles%\Blender Foundation\Blender *" 2^>nul') do if not defined stratum_exe if exist "%ProgramFiles%\Blender Foundation\%%V\blender.exe" set "stratum_exe=%ProgramFiles%\Blender Foundation\%%V\blender.exe"
if not defined stratum_exe (
  echo Could not find Blender. Set STRATUM_BLENDER to the full path of blender.exe and run again.
  pause
  exit /b 1
)
"%stratum_exe%" --background --factory-startup --python-exit-code 1 --python "%~dp0tools\bake_daylight.py" -- %*
set "stratum_result=%errorlevel%"
if not "%stratum_result%"=="0" echo Bake failed. The previous lighting index is still in place.
if "%stratum_result%"=="0" echo Upload the lighting.json and the lighting folder printed above.
pause
exit /b %stratum_result%
