@echo off
setlocal
pushd "%~dp0"

if not exist "certs\server.crt" goto missing_cert
if not exist "certs\server.key" goto missing_cert

set "DOCKER_EXE=docker"
where docker >nul 2>nul
if errorlevel 1 (
  if exist "D:\Docker\resources\bin\docker.exe" (
    set "DOCKER_EXE=D:\Docker\resources\bin\docker.exe"
  ) else if exist "C:\Program Files\Docker\Docker\resources\bin\docker.exe" (
    set "DOCKER_EXE=C:\Program Files\Docker\Docker\resources\bin\docker.exe"
  ) else (
    echo Docker CLI not found. Install and start Docker Desktop.
    popd
    exit /b 1
  )
)

"%DOCKER_EXE%" compose -f compose.https.yaml up -d --no-build --pull never --remove-orphans --wait
if errorlevel 1 (
  echo Launch failed. Prepare images and certificates first; see docs\https-lan.md.
  popd
  exit /b 1
)
"%DOCKER_EXE%" compose -f compose.https.yaml ps
if not defined MARS_HTTPS_PORT set "MARS_HTTPS_PORT=8443"
echo Open https://SERVER-LAN-IP:%MARS_HTTPS_PORT% and trust certs\ca.crt on each client.
echo If .env overrides the port, use MARS_HTTPS_PORT from that file.
popd
exit /b 0

:missing_cert
echo Prepare certificates first: py tools\generate-lan-cert.py SERVER-LAN-IP
echo See docs\https-lan.md. No internet is needed to issue certificates.
popd
exit /b 1
