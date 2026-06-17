$ErrorActionPreference = 'Stop'

$trayHost = Split-Path -Parent $MyInvocation.MyCommand.Path
$projectRoot = Split-Path -Parent $trayHost
$dist = Join-Path $projectRoot 'dist'
$payload = Join-Path $trayHost 'payload'

$runningOnWindows = $env:OS -eq 'Windows_NT'
if (-not $runningOnWindows) {
  try {
    $runningOnWindows = [System.Runtime.InteropServices.RuntimeInformation]::IsOSPlatform([System.Runtime.InteropServices.OSPlatform]::Windows)
  } catch {
    $runningOnWindows = $false
  }
}

if (-not $runningOnWindows) {
  throw 'This build is intended for Windows because it produces a WinForms tray executable.'
}

$dotnet = Get-Command dotnet -ErrorAction Stop
$node = Get-Command node -ErrorAction Stop

$existingTray = Get-Process -Name 'LibraryJSServer' -ErrorAction SilentlyContinue
if ($existingTray) {
  Write-Host 'Stopping running LibraryJSServer.exe so the new build can replace it...'
  $existingTray | Stop-Process -Force -ErrorAction SilentlyContinue
  Start-Sleep -Seconds 2
}

Remove-Item $dist -Recurse -Force -ErrorAction SilentlyContinue
Remove-Item $payload -Recurse -Force -ErrorAction SilentlyContinue
New-Item -ItemType Directory -Path $dist, $payload -Force | Out-Null

Copy-Item -LiteralPath (Join-Path $projectRoot 'server.mjs') -Destination (Join-Path $payload 'server.mjs') -Force
Copy-Item -LiteralPath (Join-Path $projectRoot 'libraryjs.html') -Destination (Join-Path $payload 'libraryjs.html') -Force
Copy-Item -LiteralPath (Join-Path $projectRoot 'site') -Destination (Join-Path $payload 'site') -Recurse -Force

$nodeSource = $node.Source
if (-not $nodeSource) {
  throw 'Could not locate node.exe from Get-Command node.'
}
Copy-Item -LiteralPath $nodeSource -Destination (Join-Path $payload 'node.exe') -Force

Write-Host 'Publishing single-file tray executable...'
& $dotnet.Source publish (Join-Path $trayHost 'LibraryJSServerTray.csproj') `
  -c Release `
  -r win-x64 `
  --self-contained true `
  -p:PublishSingleFile=true `
  -p:EnableCompressionInSingleFile=true `
  -p:IncludeNativeLibrariesForSelfExtract=true `
  -p:DebugType=None `
  -p:DebugSymbols=false `
  -o $dist

if ($LASTEXITCODE -ne 0) {
  throw "dotnet publish failed with exit code $LASTEXITCODE"
}

$publishedExe = Get-ChildItem -Path $dist -Filter '*.exe' | Select-Object -First 1
if (-not $publishedExe) {
  throw "No executable was produced in $dist"
}

$finalExe = Join-Path $dist 'LibraryJSServer.exe'
if ($publishedExe.FullName -ne $finalExe) {
  Remove-Item $finalExe -Force -ErrorAction SilentlyContinue
  Move-Item -LiteralPath $publishedExe.FullName -Destination $finalExe
}

Get-ChildItem -Path $dist -File | Where-Object { $_.Name -ne 'LibraryJSServer.exe' } | Remove-Item -Force -ErrorAction SilentlyContinue

Write-Host "Done: $finalExe"
