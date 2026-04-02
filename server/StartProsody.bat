@echo off
setlocal EnableExtensions

REM Always run from this script's folder
cd /d "%~dp0"
echo [StartProsody] Working dir: %CD%

REM Venv in LocalAppData (avoids execute restrictions on repo drive / OneDrive)
set "VENV_DIR=%LOCALAPPDATA%\P8_Project\p8venv"
set "PYTHON_CMD="

REM 1) Prefer py launcher if available
where py >nul 2>nul
if %errorlevel%==0 (
  py -3 -c "import sys; print(sys.executable)" >nul 2>nul
  if %errorlevel%==0 set "PYTHON_CMD=py -3"
)

REM 2) Else use python on PATH, but ignore WindowsApps stub
if "%PYTHON_CMD%"=="" (
  for /f "delims=" %%P in ('where python 2^>nul') do (
    echo %%P | findstr /i "WindowsApps" >nul
    if errorlevel 1 (
      "%%P" -c "import sys; print(sys.executable)" >nul 2>nul
      if not errorlevel 1 (
        set "PYTHON_CMD=%%P"
        goto :found_python
      )
    )
  )
)

:found_python
if "%PYTHON_CMD%"=="" (
  echo [ERROR] No working Python found.
  echo Install Python 3.11+ from python.org and check "Add Python to PATH".
  pause
  exit /b 1
)

echo [INFO] Using Python: %PYTHON_CMD%

REM Create venv if missing
if not exist "%VENV_DIR%\Scripts\python.exe" (
  echo [INFO] Creating venv at "%VENV_DIR%"
  %PYTHON_CMD% -m venv "%VENV_DIR%"
  if errorlevel 1 (
    echo [ERROR] Failed to create venv.
    pause
    exit /b 1
  )
)

echo [INFO] Upgrading pip/setuptools/wheel...
"%VENV_DIR%\Scripts\python.exe" -m pip install --upgrade pip setuptools wheel
if errorlevel 1 (
  echo [ERROR] pip upgrade failed.
  pause
  exit /b 1
)

echo [INFO] Installing requirement.txt...
"%VENV_DIR%\Scripts\python.exe" -m pip install -r requirement.txt
if errorlevel 1 (
  echo [ERROR] pip install -r requirement.txt failed.
  pause
  exit /b 1
)

echo [OK] Starting prosody server + monitor...

start "Prosody Server" "%VENV_DIR%\Scripts\python.exe" prosody_server.py
timeout /t 1 >nul

start "Prosody Monitor" "%VENV_DIR%\Scripts\python.exe" prosody_monitor.py

echo [OK] Started. Keep these windows open while running Unity.
pause