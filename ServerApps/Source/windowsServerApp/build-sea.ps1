$ErrorActionPreference = 'Stop'
$trayHost = Join-Path (Split-Path -Parent $MyInvocation.MyCommand.Path) 'trayhost'
& (Join-Path $trayHost 'build-sea.ps1')
