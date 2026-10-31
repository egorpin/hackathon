#!/usr/bin/env bash
# Run inside WSL; the responder must run in Windows, not WSL's virtual network.
set -euo pipefail
repo_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
: "${WSL_DISTRO_NAME:?Run this launcher inside WSL on the server Windows computer}"
exec powershell.exe -NoProfile -ExecutionPolicy Bypass -File \
  "$(wslpath -w "$repo_dir/windows/start-server.ps1")" \
  -Distro "$WSL_DISTRO_NAME" -ProjectPath "$repo_dir" "$@"
