# send-continue-to-vscode-claude.ps1
# 1時間後に VS Code をアクティブ化し、Claude Code チャットへ「続行」を送信する

$delaySeconds       = 3600
$vscodeWindowTitle  = "Visual Studio Code"
$message            = "続行"

# あなたの環境で「Claude Codeのチャット入力にフォーカス」するショートカットに合わせて変更
# 例: Ctrl+Alt+I => "^%i"
$focusChatShortcut  = "^%i"

Start-Sleep -Seconds $delaySeconds

$wshell = New-Object -ComObject WScript.Shell
if (-not $wshell.AppActivate($vscodeWindowTitle)) {
    Write-Error "VS Code ウィンドウが見つかりません: $vscodeWindowTitle"
    exit 1
}

Start-Sleep -Milliseconds 500

# Claude Code チャット入力へフォーカス
$wshell.SendKeys($focusChatShortcut)
Start-Sleep -Milliseconds 500

# 日本語は SendKeys 直打ちよりクリップボード貼り付けが安定
Set-Clipboard -Value $message
$wshell.SendKeys("^v")
Start-Sleep -Milliseconds 120
$wshell.SendKeys("{ENTER}")