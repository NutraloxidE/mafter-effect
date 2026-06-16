param(
    [int]$DelaySeconds = 2100,
    [string]$VsCodeWindowTitle = "Visual Studio Code",
    # Default message is U+7D9A U+884C ("continue" in Japanese).
    [string]$Message = ([string]([char]0x7D9A) + [char]0x884C)
)

Start-Sleep -Seconds $DelaySeconds

$wshell = New-Object -ComObject WScript.Shell
if (-not $wshell.AppActivate($VsCodeWindowTitle)) {
    Write-Error "VS Code window not found: $VsCodeWindowTitle"
    exit 1
}

Start-Sleep -Milliseconds 500

function Invoke-VSCodeCommand {
    param(
        [Parameter(Mandatory = $true)]
        [string]$CommandId
    )

    # Open Command Palette, execute command id directly.
    $wshell.SendKeys("^+p")
    Start-Sleep -Milliseconds 350
    Set-Clipboard -Value ">$CommandId"
    $wshell.SendKeys("^v")
    Start-Sleep -Milliseconds 120
    $wshell.SendKeys("{ENTER}")
    Start-Sleep -Milliseconds 500
}

# Open Claude Code tab and then focus prompt input.
Invoke-VSCodeCommand -CommandId "claude-vscode.editor.open"
Invoke-VSCodeCommand -CommandId "claude-vscode.focus"
Start-Sleep -Milliseconds 300
$wshell.SendKeys("{ESC}")
Start-Sleep -Milliseconds 120

# Paste is more reliable than direct SendKeys for non-ASCII text.
Set-Clipboard -Value ($Message.Normalize([Text.NormalizationForm]::FormC))
$wshell.SendKeys("^v")
Start-Sleep -Milliseconds 120
$wshell.SendKeys("{ENTER}")