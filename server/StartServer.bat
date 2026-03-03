@echo off

:: 1. Look directly for the bun.exe file on the hard drive
IF NOT EXIST "%USERPROFILE%\.bun\bin\bun.exe" (
    echo Bun is not found! Installing Bun now...
    powershell -c "irm bun.sh/install.ps1 | iex"
) ELSE (
    echo Bun is already installed! Skipping download...
)

:: Set a direct path to Bun so we don't have to rely on Windows recognizing the command yet
set BUN="%USERPROFILE%\.bun\bin\bun.exe"

:: 2. Install dependencies 
echo Installing/Verifying dependencies...
%BUN% install

:: 3. Run the app
echo Starting the project...
%BUN% run index.ts

pause