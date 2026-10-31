[CmdletBinding()]
param(
    [string]$Distro,
    [string]$ProjectPath,
    [string]$Interface,
    [ValidateRange(1, 65535)][int]$Port = 8443,
    [switch]$Prepare,
    [string]$WheelDirectory,
    [switch]$NoBrowser
)
$ErrorActionPreference = 'Stop'
$repo = Split-Path $PSScriptRoot -Parent
# Running the script via Explorer's WSL UNC path needs no machine-specific config.
if ($repo -match '^\\\\wsl(?:\.localhost|\$)\\([^\\]+)(\\.*)$') {
    if (-not $Distro) { $Distro = $Matches[1] }
    if (-not $ProjectPath) { $ProjectPath = $Matches[2].Replace('\', '/') }
}
if (-not $Distro -or -not $ProjectPath) {
    throw 'Specify -Distro Ubuntu -ProjectPath /home/USER/projects/hackathon, or run from the WSL UNC folder.'
}
$runtime = Join-Path $env:LOCALAPPDATA 'MarsColony\mdns'
$python = Join-Path $runtime 'Scripts\python.exe'
function Invoke-ProjectWsl([string[]]$Arguments) {
    & wsl.exe --distribution $Distro --cd $ProjectPath --exec @Arguments
    if ($LASTEXITCODE -ne 0) { throw "WSL command failed: $($Arguments[0])" }
}
if ($Prepare) {
    # Preparation may download packages/images. Ordinary startup never does.
    if (-not (Test-Path $python)) {
        & py.exe -3 -m venv $runtime
        if ($LASTEXITCODE -ne 0) { throw 'Install Windows Python 3.10+ before preparation.' }
    }
    $pipArgs = @('-m', 'pip', 'install', '-r', (Join-Path $repo 'tools\requirements-mdns.txt'))
    if ($WheelDirectory) { $pipArgs += @('--no-index', '--find-links', $WheelDirectory) }
    & $python @pipArgs
    if ($LASTEXITCODE -ne 0) { throw 'Cannot prepare the Windows mDNS environment.' }
    Copy-Item (Join-Path $repo 'tools\mars-mdns.py') (Join-Path $runtime 'mars-mdns.py') -Force
    Invoke-ProjectWsl -Arguments @('python3', 'tools/generate-lan-cert.py', '--hostname', 'mars.local')
    Invoke-ProjectWsl -Arguments @('docker', 'compose', '-f', 'compose.https.yaml', 'build')
    $bundle = Join-Path $env:LOCALAPPDATA 'MarsColony\client'
    New-Item -ItemType Directory -Force (Join-Path $bundle 'windows') | Out-Null
    Copy-Item (Join-Path $repo 'start-client.cmd') $bundle -Force
    Copy-Item (Join-Path $repo 'windows\start-client.ps1') (Join-Path $bundle 'windows') -Force
    Copy-Item (Join-Path $repo 'certs\ca.crt') $bundle -Force
    Write-Host "Prepared client bundle: $bundle"
    Write-Host 'Copy this folder to clients; run start-client.cmd -TrustCertificate -InstallOnly once on every computer, including this server.'
    Write-Host 'Configure server firewall using windows\setup-server-firewall.ps1 as administrator.'
    Write-Host 'Preparation complete. Run start-server.cmd without -Prepare for the offline demo.'
    exit 0
}
if (-not (Test-Path $python) -or -not (Test-Path (Join-Path $runtime 'mars-mdns.py'))) {
    throw 'Prepare on the SERVER first: start-server.cmd -Prepare'
}
Invoke-ProjectWsl -Arguments @('test', '-f', 'certs/server.crt')
Invoke-ProjectWsl -Arguments @('openssl', 'verify', '-CAfile', 'certs/ca.crt', '-verify_hostname', 'mars.local', 'certs/server.crt')
Invoke-ProjectWsl -Arguments @('env', "MARS_HTTPS_PORT=$Port", 'docker', 'compose', '-f', 'compose.https.yaml',
    'up', '-d', '--no-build', '--pull', 'never', '--force-recreate', '--remove-orphans', '--wait')
$mdnsArgs = @((Join-Path $runtime 'mars-mdns.py'), '--port', "$Port")
if ($Interface) { $mdnsArgs += @('--interface', $Interface) }
if (-not $NoBrowser) { $mdnsArgs += '--open-browser' }
Write-Host "Game URL for EVERY computer: https://mars.local:$Port"
Write-Host 'Keep this window open. Ctrl+C stops mDNS; Docker containers keep running.'
& $python @mdnsArgs
if ($LASTEXITCODE -ne 0) { throw 'mDNS failed. Check adapter selection, UDP 5353 and duplicate servers.' }
