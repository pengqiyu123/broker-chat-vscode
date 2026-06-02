$ErrorActionPreference = "Stop"

$projectRoot = Split-Path -Parent $PSScriptRoot
$packageJsonPath = Join-Path $projectRoot "package.json"
$package = Get-Content $packageJsonPath -Raw | ConvertFrom-Json

$name = [string]$package.name
$version = [string]$package.version
$outputDir = Join-Path $projectRoot "artifacts"
$outputFile = Join-Path $outputDir "$name-$version.vsix"
$vscePath = Join-Path $projectRoot "node_modules\.bin\vsce.cmd"

if (-not (Test-Path $outputDir)) {
  New-Item -ItemType Directory -Path $outputDir | Out-Null
}

if (-not (Test-Path $vscePath)) {
  throw "Local vsce not found. Run 'npm install' first."
}

Write-Host "Compiling extension..."
Push-Location $projectRoot
try {
  npm run compile | Out-Host

  $staleDistDirs = @(
    "dist\mcp",
    "dist\server"
  )

  foreach ($relativePath in $staleDistDirs) {
    $stalePath = Join-Path $projectRoot $relativePath
    if (Test-Path $stalePath) {
      Remove-Item -LiteralPath $stalePath -Recurse -Force
    }
  }

  Write-Host "Packaging VSIX..."
  & $vscePath package --allow-missing-repository --out $outputFile | Out-Host
} finally {
  Pop-Location
}

Write-Host ""
Write-Host "VSIX created at: $outputFile"
Write-Host "You can share this file and install it via VS Code -> Extensions -> ... -> Install from VSIX..."
