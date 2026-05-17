param(
  [int]$Port = 3000,
  [string]$PublicBaseUrl = ""
)

$ErrorActionPreference = "Stop"
$Root = Split-Path -Parent $PSScriptRoot
$StartScript = Join-Path $PSScriptRoot "start-service.ps1"
$StopScript = Join-Path $PSScriptRoot "stop-service.ps1"
$PresentationDates = @("2026-05-18", "2026-06-01", "2026-06-08", "2026-06-15")

foreach ($dateText in $PresentationDates) {
  $date = [datetime]::ParseExact($dateText, "yyyy-MM-dd", $null)
  $weekTag = $date.ToString("yyyyMMdd")
  $startName = "PresentationEvaluationStart-$weekTag"
  $stopName = "PresentationEvaluationStop-$weekTag"

  $startArgs = "-NoProfile -ExecutionPolicy Bypass -File `"$StartScript`" -Port $Port"
  if ($PublicBaseUrl) {
    $startArgs += " -PublicBaseUrl `"$PublicBaseUrl`""
  }

  $startAction = New-ScheduledTaskAction -Execute "powershell.exe" -Argument $startArgs -WorkingDirectory $Root
  $startTrigger = New-ScheduledTaskTrigger -Once -At ($date.Date.AddHours(11).AddMinutes(50))
  Register-ScheduledTask -TaskName $startName -Action $startAction -Trigger $startTrigger -Description "Start the presentation evaluation service 10 minutes before class." -Force | Out-Null

  $stopAction = New-ScheduledTaskAction -Execute "powershell.exe" -Argument "-NoProfile -ExecutionPolicy Bypass -File `"$StopScript`"" -WorkingDirectory $Root
  $stopTrigger = New-ScheduledTaskTrigger -Once -At ($date.Date.AddHours(13).AddMinutes(30))
  Register-ScheduledTask -TaskName $stopName -Action $stopAction -Trigger $stopTrigger -Description "Stop the presentation evaluation service after class." -Force | Out-Null
}

Write-Host "Scheduled presentation evaluation service tasks for: $($PresentationDates -join ', ')"
