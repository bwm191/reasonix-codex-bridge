param(
  [string]$Addr = "127.0.0.1:8787",
  [Parameter(ValueFromRemainingArguments = $true)]
  [string[]]$RemainingArgs
)

$ErrorActionPreference = "Stop"

for ($i = 0; $i -lt $RemainingArgs.Count; $i++) {
  if ($RemainingArgs[$i] -eq "--addr" -and ($i + 1) -lt $RemainingArgs.Count) {
    $Addr = $RemainingArgs[$i + 1]
    $i++
  }
}

$legacyConfigPath = Join-Path $env:USERPROFILE ".reasonix\config.json"
if (Test-Path $legacyConfigPath) {
  $text = [System.IO.File]::ReadAllText($legacyConfigPath)
  $pattern = [regex]::Escape('"apiKey"') + '\s*:\s*"([^"]*)"'
  $match = [regex]::Match($text, $pattern)
  if ($match.Success -and $match.Groups[1].Value) {
    $env:DEEPSEEK_API_KEY = $match.Groups[1].Value
  }
}

npx --yes reasonix@1.8.0-rc.1 serve --addr $Addr
