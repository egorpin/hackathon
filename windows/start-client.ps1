[CmdletBinding()]
param(
    [ValidateRange(1, 65535)][int]$Port = 8443,
    [switch]$TrustCertificate,
    [switch]$InstallOnly,
    [string]$CaPath,
    [switch]$NoBrowser
)
$ErrorActionPreference = 'Stop'
$repo = Split-Path $PSScriptRoot -Parent
if ($InstallOnly -and -not $TrustCertificate) { throw '-InstallOnly requires -TrustCertificate.' }
if (-not $CaPath) {
    $CaPath = Join-Path $repo 'ca.crt'
    if (-not (Test-Path $CaPath)) { $CaPath = Join-Path $repo 'certs\ca.crt' }
}
if ($TrustCertificate) {
    $cert = New-Object System.Security.Cryptography.X509Certificates.X509Certificate2((Resolve-Path $CaPath).Path)
    $basic = $cert.Extensions | Where-Object { $_.Oid.Value -eq '2.5.29.19' }
    if (-not $basic -or -not $basic.CertificateAuthority -or $cert.Subject -ne $cert.Issuer) {
        throw 'The supplied file is not a self-issued CA certificate.'
    }
    $sha = [System.Security.Cryptography.SHA256]::Create()
    try { $fingerprint = ([BitConverter]::ToString($sha.ComputeHash($cert.RawData))).Replace('-', ':') }
    finally { $sha.Dispose() }
    Write-Host "CA SHA256: $fingerprint"
    Import-Certificate -FilePath (Resolve-Path $CaPath).Path -CertStoreLocation Cert:\CurrentUser\Root | Out-Null
    Write-Host 'CA installed for the current Windows user. Restart an already-open browser if necessary.'
}
if ($InstallOnly) { exit 0 }
$url = "https://mars.local:$Port"
try {
    $addresses = [System.Net.Dns]::GetHostAddresses('mars.local')
    Write-Host "mars.local resolves to: $($addresses.IPAddressToString -join ', ')"
    # Local request only, with normal chain + hostname verification and no proxy.
    $request = [System.Net.HttpWebRequest]::Create("$url/api/health")
    $request.Proxy = $null
    $request.Timeout = 10000
    $response = $request.GetResponse()
    try {
        $reader = New-Object System.IO.StreamReader($response.GetResponseStream())
        try { $health = $reader.ReadToEnd() | ConvertFrom-Json }
        finally { $reader.Dispose() }
        if ($health.status -ne 'ok') { throw 'Unexpected API health response.' }
    } finally { $response.Close() }
} catch {
    Write-Host 'Check: same hotspot, server mDNS window open, firewall TCP 8443/UDP 5353, CA trusted.'
    Write-Host 'For initial CA setup run: start-client.cmd -TrustCertificate'
    Write-Host 'Hotspot client isolation or blocked multicast can prevent connection.'
    throw "Cannot connect to $url : $($_.Exception.Message)"
}
Write-Host "Ready: $url"
if (-not $NoBrowser) { Start-Process $url }
