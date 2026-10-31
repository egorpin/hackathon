# Explicit one-time SERVER setup. Run as administrator; never run on clients.
[CmdletBinding()]
param([ValidateRange(1, 65535)][int]$Port = 8443)
#Requires -RunAsAdministrator
$ErrorActionPreference = 'Stop'
$python = Join-Path $env:LOCALAPPDATA 'MarsColony\mdns\Scripts\python.exe'
if (-not (Test-Path $python)) { throw 'Run start-server.cmd -Prepare as the server user first.' }
$rules = @(
    @{Name='MarsColony-HTTPS'; DisplayName='Mars Colony HTTPS (LAN)'; Protocol='TCP'; LocalPort=$Port},
    @{Name='MarsColony-mDNS'; DisplayName='Mars Colony mDNS (LAN)'; Protocol='UDP'; LocalPort=5353}
)
foreach ($rule in $rules) {
    Get-NetFirewallRule -Name $rule.Name -ErrorAction SilentlyContinue | Remove-NetFirewallRule
    New-NetFirewallRule @rule -Group 'Mars Colony' -Direction Inbound -Action Allow -Profile Any -RemoteAddress LocalSubnet | Out-Null
}
Write-Host 'Server LAN rules installed (including Public profile for phone hotspots). Firewall remains enabled.'
