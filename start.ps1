# NeuralDesk: first-time setup and start (Windows PowerShell 5.1 or PowerShell 7)
# Run from this folder:  powershell -ExecutionPolicy Bypass -File .\start.ps1
$ErrorActionPreference = 'Stop'
$app = Join-Path $PSScriptRoot 'app'
Set-Location $app

if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
  Write-Host 'Node.js is not installed. Install the LTS version (22.13 or newer) from https://nodejs.org, then run this script again.' -ForegroundColor Yellow
  exit 1
}
$v = (node -p "process.versions.node").Trim()
$p = $v.Split('.')
if ([int]$p[0] -lt 22 -or ([int]$p[0] -eq 22 -and [int]$p[1] -lt 13)) {
  Write-Host "Node.js $v is too old. Install 22.13 or newer (LTS) from https://nodejs.org" -ForegroundColor Yellow
  exit 1
}
Write-Host "Node.js $v OK" -ForegroundColor Green

$envFile = Join-Path $app '.env'
if (-not (Test-Path $envFile)) {
  $key = (node -e "console.log(require('crypto').randomBytes(32).toString('base64'))").Trim()
  $lines = Get-Content (Join-Path $app '.env.example') | ForEach-Object { if ($_ -match '^ENCRYPTION_KEY=') { "ENCRYPTION_KEY=$key" } else { $_ } }
  [System.IO.File]::WriteAllLines($envFile, [string[]]$lines)   # UTF-8 without BOM
  Write-Host 'Created app\.env with a new encryption key. Keep it private and back it up: without it, saved bot tokens cannot be read.' -ForegroundColor Green
} else {
  Write-Host 'app\.env already exists, keeping it.'
}

Write-Host 'Running tests...'
npm test
if ($LASTEXITCODE -ne 0) { Write-Host 'Some tests failed. See the output above.' -ForegroundColor Red; exit 1 }

Write-Host ''
Write-Host 'Starting on http://localhost:3000  (press Ctrl+C to stop)' -ForegroundColor Cyan
Write-Host 'Make yourself admin (in another window):  cd app; npm run make-admin -- you@example.com'
npm start
