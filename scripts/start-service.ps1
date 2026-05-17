param(
  [int]$Port = 3000,
  [string]$PublicBaseUrl = "",
  [switch]$SkipScheduleCheck
)

$ErrorActionPreference = "Stop"
$Root = Split-Path -Parent $PSScriptRoot
$DataDir = Join-Path $Root "data"
$LogDir = Join-Path $Root "logs"
$PidPath = Join-Path $DataDir "service.pid"
$SchedulePath = Join-Path $DataDir "schedule.json"
$AdminKeyPath = Join-Path $DataDir "admin-key.txt"
$OutLog = Join-Path $LogDir "service.out.log"
$ErrLog = Join-Path $LogDir "service.err.log"
$EmailLog = Join-Path $LogDir "admin-url-email.txt"

New-Item -ItemType Directory -Force -Path $DataDir, $LogDir | Out-Null

if (-not $SkipScheduleCheck) {
  $today = Get-Date -Format "yyyy-MM-dd"
  $schedule = Get-Content $SchedulePath -Raw | ConvertFrom-Json
  $todayEntry = $schedule | Where-Object { $_.date -eq $today } | Select-Object -First 1
  if (-not $todayEntry -or -not $todayEntry.presentations -or $todayEntry.presentations.Count -eq 0) {
    "[$(Get-Date -Format s)] No scheduled presentations for $today. Service was not started." | Add-Content $EmailLog
    Write-Host "No scheduled presentations for $today. Service was not started."
    exit 0
  }
}

if (Test-Path $PidPath) {
  $existingPid = Get-Content $PidPath -Raw
  $existingPid = $existingPid.Trim()
  if ($existingPid -and (Get-Process -Id ([int]$existingPid) -ErrorAction SilentlyContinue)) {
    Write-Host "Service is already running with PID $existingPid."
    exit 0
  }
}

$env:PORT = [string]$Port
if ($PublicBaseUrl) {
  $env:PUBLIC_BASE_URL = $PublicBaseUrl.TrimEnd("/")
} elseif (-not $env:PUBLIC_BASE_URL) {
  $env:PUBLIC_BASE_URL = "http://localhost:$Port"
} else {
  $env:PUBLIC_BASE_URL = $env:PUBLIC_BASE_URL.TrimEnd("/")
}

$node = Get-Command node -ErrorAction Stop
$process = Start-Process `
  -FilePath $node.Source `
  -ArgumentList "server.js" `
  -WorkingDirectory $Root `
  -WindowStyle Hidden `
  -RedirectStandardOutput $OutLog `
  -RedirectStandardError $ErrLog `
  -PassThru

Set-Content -Path $PidPath -Value $process.Id

for ($i = 0; $i -lt 30; $i++) {
  if (Test-Path $AdminKeyPath) {
    break
  }
  Start-Sleep -Milliseconds 500
}

if ($env:ADMIN_KEY) {
  $adminKey = $env:ADMIN_KEY
} else {
  $adminKey = (Get-Content $AdminKeyPath -Raw).Trim()
}

$encodedAdminKey = [System.Uri]::EscapeDataString($adminKey)
$adminUrl = "$($env:PUBLIC_BASE_URL)/admin?key=$encodedAdminKey"
$message = @"
Presentation evaluation service is running.

Student URL: $($env:PUBLIC_BASE_URL)/
Admin URL: $adminUrl
"@

if ($env:SMTP_HOST -and $env:SMTP_USER -and $env:SMTP_PASS) {
  $smtpPort = if ($env:SMTP_PORT) { [int]$env:SMTP_PORT } else { 587 }
  $smtpFrom = if ($env:SMTP_FROM) { $env:SMTP_FROM } else { $env:SMTP_USER }
  $smtp = [System.Net.Mail.SmtpClient]::new($env:SMTP_HOST, $smtpPort)
  $smtp.EnableSsl = if ($env:SMTP_SSL) { [System.Convert]::ToBoolean($env:SMTP_SSL) } else { $true }
  $smtp.Credentials = [System.Net.NetworkCredential]::new($env:SMTP_USER, $env:SMTP_PASS)
  $mail = [System.Net.Mail.MailMessage]::new($smtpFrom, "myounggulee@konkuk.ac.kr", "Presentation Evaluation Admin URL", $message)
  $smtp.Send($mail)
  "[$(Get-Date -Format s)] Sent admin URL to myounggulee@konkuk.ac.kr: $adminUrl" | Add-Content $EmailLog
} else {
  "[$(Get-Date -Format s)] SMTP is not configured. Admin URL: $adminUrl" | Add-Content $EmailLog
}

Write-Host $message
