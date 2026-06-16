param(
  [string]$ClaudeCommand = "claude",
  [int]$DelaySeconds = 3,
  [string]$TriggerPattern = "500",
  [string]$ContinueText = "続けて"
)

$ErrorActionPreference = "Stop"

$startInfo = New-Object System.Diagnostics.ProcessStartInfo
$startInfo.FileName = $ClaudeCommand
$startInfo.UseShellExecute = $false
$startInfo.RedirectStandardInput = $true
$startInfo.RedirectStandardOutput = $true
$startInfo.RedirectStandardError = $true
$startInfo.CreateNoWindow = $true

$process = New-Object System.Diagnostics.Process
$process.StartInfo = $startInfo

$script:lastSentAt = [datetime]::MinValue
$script:isSending = $false

$outputHandler = {
  param($sender, $eventArgs)

  if ([string]::IsNullOrWhiteSpace($eventArgs.Data)) {
    return
  }

  Write-Host $eventArgs.Data

  if ($eventArgs.Data -notmatch $TriggerPattern) {
    return
  }

  $now = [datetime]::UtcNow
  if ($script:isSending) {
    return
  }

  $elapsed = $now - $script:lastSentAt
  if ($script:lastSentAt -ne [datetime]::MinValue -and $elapsed.TotalSeconds -lt $DelaySeconds) {
    return
  }

  $script:isSending = $true
  try {
    Start-Sleep -Seconds $DelaySeconds
    $sender.StandardInput.WriteLine($ContinueText)
    $sender.StandardInput.Flush()
    $script:lastSentAt = [datetime]::UtcNow
  }
  finally {
    $script:isSending = $false
  }
}

$errorHandler = {
  param($sender, $eventArgs)

  if ([string]::IsNullOrWhiteSpace($eventArgs.Data)) {
    return
  }

  Write-Host $eventArgs.Data
}

if (-not $process.Start()) {
  throw "Failed to start: $ClaudeCommand"
}

$process.add_OutputDataReceived($outputHandler)
$process.add_ErrorDataReceived($errorHandler)

$process.BeginOutputReadLine()
$process.BeginErrorReadLine()

$process.WaitForExit()
