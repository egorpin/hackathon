#!/usr/bin/env bash
# Optional WSL entry point; clients without WSL use start-client.cmd.
set -euo pipefail
repo_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
: "${WSL_DISTRO_NAME:?Run this launcher inside WSL, or use start-client.cmd in Windows}"
exec powershell.exe -NoProfile -ExecutionPolicy Bypass -File \
  "$(wslpath -w "$repo_dir/lan/windows/start-client.ps1")" "$@"
