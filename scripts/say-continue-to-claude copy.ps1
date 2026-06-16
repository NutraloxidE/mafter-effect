param(
    [int]$DelaySeconds = 2100,
    [string]$VsCodeWindowTitle = "Visual Studio Code",
    # Default message encoded with Unicode code points for reliable input.
    [string]$Message = ([string]([char]0x4F7F)) + ([string]([char]0x7528)) + ([string]([char]0x5236)) + ([string]([char]0x9650)) + ([string]([char]0x3067)) + ([string]([char]0x6700)) + ([string]([char]0x5F8C)) + ([string]([char]0x307E)) + ([string]([char]0x3067)) + ([string]([char]0x5B9F)) + ([string]([char]0x884C)) + ([string]([char]0x3055)) + ([string]([char]0x308C)) + ([string]([char]0x306A)) + ([string]([char]0x304B)) + ([string]([char]0x3063)) + ([string]([char]0x305F)) + ([string]([char]0x3001)) + ([string]([char]0x30B3)) + ([string]([char]0x30F3)) + ([string]([char]0x30C6)) + ([string]([char]0x30AD)) + ([string]([char]0x30B9)) + ([string]([char]0x30C8)) + ([string]([char]0x3092)) + ([string]([char]0x53B3)) + ([string]([char]0x5BC6)) + ([string]([char]0x306B)) + ([string]([char]0x30C1)) + ([string]([char]0x30A7)) + ([string]([char]0x30C3)) + ([string]([char]0x30AF)) + ([string]([char]0x3057)) + ([string]([char]0x3066)) + ([string]([char]0x7D9A)) + ([string]([char]0x884C)) + ([string]([char]0x3057)) + ([string]([char]0x3066)) + ([string]([char]0x307B)) + ([string]([char]0x3057)) + ([string]([char]0x3044))
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