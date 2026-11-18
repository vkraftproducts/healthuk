@echo off
rem Starts the Healthcare Hub demo stack (Docker) and opens it at http://localhost:8080.
rem Rebuilds the images so the latest code is used; the setup step applies migrations and seeds.
cd /d "%~dp0"
where docker >nul 2>nul || (echo Docker is not installed or not on PATH. Start Docker Desktop and try again. & pause & exit /b 1)
docker info >nul 2>nul || (echo Docker Desktop is not running. Start it, wait until it says Running, then run this again. & pause & exit /b 1)
echo Building and starting the stack. The first build can take several minutes...
docker compose -p hublocal -f .compose-local.yml -f .compose-local.override.yml --env-file .stack.env up -d --build
if errorlevel 1 (echo. & echo Start failed - see the messages above. & pause & exit /b 1)
echo.
docker compose -p hublocal -f .compose-local.yml -f .compose-local.override.yml --env-file .stack.env ps
echo.
echo Started. Opening http://localhost:8080 ...
start "" http://localhost:8080
pause
