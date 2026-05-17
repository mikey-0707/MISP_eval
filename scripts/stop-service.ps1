$ErrorActionPreference = "Stop"
$Root = Split-Path -Parent $PSScriptRoot
$DataDir = Join-Path $Root "data"
$PidPath = Join-Path $DataDir "service.pid"
$LogDir = Join-Path $Root "logs"
$StopLog = Join-Path $LogDir "service-stop.log"

New-Item -ItemType Directory -Force -Path $DataDir, $LogDir | Out-Null

if (-not (Test-Path $PidPath)) {
  "[$(Get-Date -Format s)] No PID file found. Service was already stopped." | Add-Content $StopLog
  Write-Host "No PID file found. Service was already stopped."
  exit 0
}

$pidValue = (Get-Content $PidPath -Raw).Trim()
if (-not $pidValue) {
  Remove-Item -Path $PidPath -Force
  Write-Host "Empty PID file removed."
  exit 0
}

$process = Get-Process -Id ([int]$pidValue) -ErrorAction SilentlyContinue
if ($process) {
  Stop-Process -Id ([int]$pidValue) -Force
  "[$(Get-Date -Format s)] Stopped service PID $pidValue." | Add-Content $StopLog
  Write-Host "Stopped service PID $pidValue."
} else {
  "[$(Get-Date -Format s)] PID $pidValue was not running." | Add-Content $StopLog
  Write-Host "PID $pidValue was not running."
}

Remove-Item -Path $PidPath -Force
