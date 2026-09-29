param(
  [Parameter(Mandatory = $true)]
  [string]$IpAddress
)
$ErrorActionPreference = 'Stop'

$parsed = $null
if (-not [System.Net.IPAddress]::TryParse($IpAddress, [ref]$parsed) -or $parsed.AddressFamily -ne [System.Net.Sockets.AddressFamily]::InterNetwork) {
  throw 'Provide the computer IPv4 address, for example 192.168.1.49.'
}

$tlsDir = Join-Path $env:LOCALAPPDATA 'Lunchly\tls'
$pfxPath = Join-Path $tlsDir 'server.pfx'
$passwordPath = Join-Path $tlsDir 'passphrase.txt'
$publicPath = Join-Path (Split-Path -Parent $PSScriptRoot) 'data\lunchly-lan.cer'
if ((Test-Path -LiteralPath $pfxPath) -or (Test-Path -LiteralPath $passwordPath)) {
  throw "A certificate already exists in $tlsDir. Keep the existing certificate or back it up before generating a replacement."
}

New-Item -ItemType Directory -Path $tlsDir -Force | Out-Null
New-Item -ItemType Directory -Path (Split-Path -Parent $publicPath) -Force | Out-Null
$cert = New-SelfSignedCertificate -Type SSLServerAuthentication `
  -Subject "CN=$IpAddress" `
  -TextExtension @("2.5.29.17={text}IPAddress=$IpAddress&IPAddress=127.0.0.1&DNS=localhost") `
  -KeyAlgorithm RSA -KeyLength 3072 -KeyExportPolicy Exportable `
  -CertStoreLocation 'Cert:\CurrentUser\My' -NotAfter (Get-Date).AddYears(2)

$bytes = New-Object byte[] 32
$generator = [System.Security.Cryptography.RandomNumberGenerator]::Create()
$generator.GetBytes($bytes)
$generator.Dispose()
$passphrase = [Convert]::ToBase64String($bytes)
$securePassphrase = ConvertTo-SecureString $passphrase -AsPlainText -Force
Export-PfxCertificate -Cert $cert -FilePath $pfxPath -Password $securePassphrase | Out-Null
Export-Certificate -Cert $cert -FilePath $publicPath | Out-Null
[System.IO.File]::WriteAllText($passwordPath, $passphrase, [System.Text.Encoding]::ASCII)

Write-Host "HTTPS certificate ready for https://$($IpAddress):3000"
Write-Host "Public certificate to install on client PCs: $publicPath"
Write-Host "Private key stays in: $tlsDir"
