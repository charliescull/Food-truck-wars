# Restart the live bot as a detached, minimized process (survives closing terminals).
#   powershell -File restart.ps1
$dir = $PSScriptRoot
if (Test-Path "$dir\bot.pid") {
  $old = Get-Content "$dir\bot.pid"
  try { Stop-Process -Id $old -Force -ErrorAction Stop; "stopped $old" } catch { "no running bot" }
}
$p = Start-Process -FilePath "node" -ArgumentList "bot.js","--camp","thompson","--shadow" -WorkingDirectory $dir -WindowStyle Minimized `
  -RedirectStandardOutput "$dir\live-out.log" -RedirectStandardError "$dir\live-err.log" -PassThru
$p.Id | Out-File -Encoding ascii "$dir\bot.pid"
"started bot, pid $($p.Id); log: $dir\live-out.log"
