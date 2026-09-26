@echo off
setlocal
title FLOODLIGHT
cd /d "%~dp0"

rem ---- find Python 3 ----
set PY=
where py >nul 2>nul && set PY=py -3
if not defined PY where python >nul 2>nul && set PY=python
if not defined PY (
  echo Python 3.11+ was not found. Install it from python.org, tick
  echo "Add python.exe to PATH", then run this file again.
  pause
  exit /b 1
)

rem ---- virtual env: created once, reused offline forever ----
if not exist .venv (
  echo Creating the virtual environment ^(first run only^)...
  %PY% -m venv .venv || (echo Could not create .venv & pause & exit /b 1)
)
set PYEXE=.venv\Scripts\python.exe

rem ---- dependencies: skipped when already installed, so this works offline ----
"%PYEXE%" -c "import fastapi, uvicorn" >nul 2>nul
if errorlevel 1 (
  echo Installing dependencies ^(needs internet this one time^)...
  "%PYEXE%" -m pip install -q -r requirements.txt || (
    echo pip install failed - connect to the internet once and re-run.
    pause
    exit /b 1
  )
)

echo.
echo  FLOODLIGHT  -  http://localhost:8737        Ctrl+C stops the server
echo  fonts, engine, replays, tour: fully offline
echo  map tiles / satellite / live rain: need internet, degrade gracefully
echo.
start /min cmd /c "timeout /t 2 >nul && start http://localhost:8737"
"%PYEXE%" run.py
pause
