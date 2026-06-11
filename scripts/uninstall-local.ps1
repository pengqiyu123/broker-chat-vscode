$ErrorActionPreference = "Stop"

$projectRoot = Split-Path -Parent $PSScriptRoot
$packageJsonPath = Join-Path $projectRoot "package.json"

if (-not (Test-Path $packageJsonPath)) {
  throw "package.json not found: $packageJsonPath"
}

$package = Get-Content $packageJsonPath -Raw -Encoding UTF8 | ConvertFrom-Json
$publisher = [string]$package.publisher
$name = [string]$package.name
$version = [string]$package.version
$extensionRoot = Join-Path $HOME ".vscode\extensions"
$targetDir = Join-Path $extensionRoot "$publisher.$name-$version"

if (Test-Path $targetDir) {
  Remove-Item -LiteralPath $targetDir -Recurse -Force
  Write-Host "Removed: $targetDir"
} else {
  Write-Host "Nothing to remove: $targetDir"
}

Write-Host "Next step: fully close and reopen VS Code."
