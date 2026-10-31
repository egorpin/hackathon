@echo off
setlocal
pushd "%~dp0"

set "DOCKER_EXE=docker"
where docker >nul 2>nul
if errorlevel 1 (
  if exist "D:\Docker\resources\bin\docker.exe" (
    set "DOCKER_EXE=D:\Docker\resources\bin\docker.exe"
    set "PATH=D:\Docker\resources\bin;%PATH%"
  ) else if exist "C:\Program Files\Docker\Docker\resources\bin\docker.exe" (
    set "DOCKER_EXE=C:\Program Files\Docker\Docker\resources\bin\docker.exe"
    set "PATH=C:\Program Files\Docker\Docker\resources\bin;%PATH%"
  ) else (
    echo Docker CLI not found. Install and start Docker Desktop.
    popd
    exit /b 1
  )
)

"%DOCKER_EXE%" compose up -d --build --remove-orphans --wait
if errorlevel 1 (
  echo.
  echo Launch failed. Make sure Docker Desktop is running and port 8000 is free.
  popd
  exit /b 1
)

"%DOCKER_EXE%" compose ps
echo.
echo Mars Colony is ready: http://localhost:8000
popd
