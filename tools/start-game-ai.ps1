# Keep this process running while playing. The model stays on the Tesla server.
$ErrorActionPreference = 'Stop'
ssh -N -o BatchMode=yes -o ExitOnForwardFailure=yes -o ServerAliveInterval=30 -L 127.0.0.1:11435:127.0.0.1:11434 tesla-server
