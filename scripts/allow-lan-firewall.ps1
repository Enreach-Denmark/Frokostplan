$ErrorActionPreference = 'Stop'
$isAdministrator = ([Security.Principal.WindowsPrincipal] [Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
if (-not $isAdministrator) { throw 'Run this script from an elevated PowerShell window (Run as administrator), or ask IT to run it.' }
$ruleName = 'Lunchly HTTPS 3000 (Local Subnet)'
$allowedRemoteAddresses = @('LocalSubnet', '192.168.45.0/24')
$nodePath = (Get-Command node.exe).Source

$blockedNodeRules = Get-NetFirewallRule -DisplayName 'Node.js JavaScript Runtime' -ErrorAction SilentlyContinue | Where-Object {
  $filter = $_ | Get-NetFirewallApplicationFilter
  $_.Direction -eq 'Inbound' -and $_.Action -eq 'Block' -and $filter.Program -ieq $nodePath
}
foreach ($rule in $blockedNodeRules) {
  Disable-NetFirewallRule -InputObject $rule
}

if (-not (Get-NetFirewallRule -DisplayName $ruleName -ErrorAction SilentlyContinue)) {
  New-NetFirewallRule -DisplayName $ruleName -Direction Inbound -Action Allow `
    -Program $nodePath -Protocol TCP -LocalPort 3000 `
    -RemoteAddress $allowedRemoteAddresses -Profile Domain,Private,Public | Out-Null
} else {
  Get-NetFirewallRule -DisplayName $ruleName | Get-NetFirewallAddressFilter |
    Set-NetFirewallAddressFilter -RemoteAddress $allowedRemoteAddresses | Out-Null
}

$active = Get-NetFirewallRule -DisplayName $ruleName -PolicyStore ActiveStore -ErrorAction SilentlyContinue
if (-not $active -or $active.Enabled -ne 'True') {
  throw 'The rule is not active. This computer may be managed by a company firewall policy; ask IT to allow TCP 3000 from the local subnet and 192.168.45.0/24.'
}

$activeAddresses = @($active | Get-NetFirewallAddressFilter | Select-Object -ExpandProperty RemoteAddress)
if ('LocalSubnet' -notin $activeAddresses -or '192.168.45.0/24' -notin $activeAddresses) {
  throw 'The active firewall rule does not allow both the local subnet and 192.168.45.0/24. Check company firewall policy.'
}

Write-Host 'Firewall allows Lunchly HTTPS on TCP 3000 from the local subnet and 192.168.45.0/24.'
