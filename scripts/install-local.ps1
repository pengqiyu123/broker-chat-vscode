$ErrorActionPreference = "Stop"

$projectRoot = Split-Path -Parent $PSScriptRoot
$packageJsonPath = Join-Path $projectRoot "package.json"

if (-not (Test-Path $packageJsonPath)) {
  throw "package.json not found: $packageJsonPath"
}

$package = Get-Content $packageJsonPath -Raw | ConvertFrom-Json
$publisher = [string]$package.publisher
$name = [string]$package.name
$version = [string]$package.version

if ([string]::IsNullOrWhiteSpace($publisher) -or [string]::IsNullOrWhiteSpace($name) -or [string]::IsNullOrWhiteSpace($version)) {
  throw "publisher/name/version is missing in package.json"
}

$extensionRoot = Join-Path $HOME ".vscode\extensions"
$targetDirName = "$publisher.$name-$version"
$targetDir = Join-Path $extensionRoot $targetDirName

Write-Host "Compiling extension..."
Push-Location $projectRoot
try {
  npm run compile | Out-Host
} finally {
  Pop-Location
}

if (-not (Test-Path $extensionRoot)) {
  New-Item -ItemType Directory -Path $extensionRoot | Out-Null
}

if (Test-Path $targetDir) {
  Remove-Item -LiteralPath $targetDir -Recurse -Force
}

New-Item -ItemType Directory -Path $targetDir | Out-Null

$pathsToCopy = @(
  "dist",
  "media",
  "package.json",
  "README.md"
)

foreach ($relativePath in $pathsToCopy) {
  $source = Join-Path $projectRoot $relativePath
  if (-not (Test-Path $source)) {
    continue
  }

  $destination = Join-Path $targetDir $relativePath
  Copy-Item -LiteralPath $source -Destination $destination -Recurse -Force
}

Write-Host ""
Write-Host "Installed to: $targetDir"
Write-Host "Next step: fully close and reopen your normal VS Code window, then run 'Open Broker Chat'."
