@echo off
setlocal EnableExtensions EnableDelayedExpansion

cd /d "%~dp0"
echo [StartProsody] Working dir: %CD%

set "VENV_DIR=%LOCALAPPDATA%\P8_Project\p8venv"
set "PYTHON_CMD="

REM 1) Try py -3 ONLY if it can actually run and create venv
where py >nul 2>nul
if %errorlevel%==0 (
  py -3 -c "import sys; print(sys.executable)" >nul 2>nul
  if !errorlevel! == 0 (
    set "PYTHON_CMD=py -3"
  )
)

REM 2) Try python on PATH, but ignore WindowsApps stub
if "%PYTHON_CMD%"=="" (
  for /f "delims=" %%P in ('where python 2^>nul') do (
    echo %%P | findstr /i "WindowsApps" >nul
    if !errorlevel! neq 0 (
      "%%P" -c "import sys; print(sys.executable)" >nul 2>nul
      if !errorlevel! == 0 (
        set "PYTHON_CMD=%%P"
        goto :found_python
      )
    )
  )
)

REM 3) Fallback: your portable python if present (helps your machine)
if "%PYTHON_CMD%"=="" (
  if exist "M:\python\python.exe" (
    "M:\python\python.exe" -c "import sys; print(sys.executable)" >nul 2>nul
    if !errorlevel! == 0 (
      set "PYTHON_CMD=M:\python\python.exe"
    )
  )
)

:found_python
if "%PYTHON_CMD%"=="" (
  echo [ERROR] No working Python found.
  echo         Install Python 3.11+ from python.org and re-run this script.
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
"%VENV_DIR%\Scripts\python.exe" -m pip install --upgrade pip wheel
"%VENV_DIR%\Scripts\python.exe" -m pip install --upgrade pip wheel
"%VENV_DIR%\Scripts\python.exe" -m pip install setuptools==68.2.2
REM ---- Create pkg_resources shim if not importable ----
"%VENV_DIR%\Scripts\python.exe" -c "import pkg_resources" >nul 2>nul
if errorlevel 1 (
  echo [INFO] pkg_resources not importable, installing shim...
  "%VENV_DIR%\Scripts\python.exe" -c "import pathlib; p=pathlib.Path(r'%VENV_DIR%\Lib\site-packages\pkg_resources'); p.mkdir(exist_ok=True); (p/'__init__.py').write_text('class _D:\n    def __init__(self,v): self.version=v\ndef get_distribution(n):\n    import importlib.metadata as m\n    try: return _D(m.version(n))\n    except: return _D(\"0.0.0\")\ndef require(*a): pass\nWorkingSet=type(\"WorkingSet\",(),{\"__iter__\":lambda s:iter([])})()\n')"
  echo [OK] pkg_resources shim installed.
)
if errorlevel 1 (
  echo [ERROR] pip upgrade failed.
  pause
  exit /b 1
)

echo [INFO] Installing requirements.txt...
"%VENV_DIR%\Scripts\python.exe" -m pip install -r requirement.txt
if errorlevel 1 (
  echo [ERROR] pip install -r requirement.txt failed.
  pause
  exit /b 1
)





echo [OK] Starting prosody server (ws://localhost:8765)
"%VENV_DIR%\Scripts\python.exe" prosody_server.py

echo [INFO] prosody_server.py exited.
pause