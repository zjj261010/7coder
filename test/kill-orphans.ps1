$targets = Get-CimInstance Win32_Process -Filter "Name='node.exe'" |
  Where-Object { $_.CommandLine -match 'mock-server\.js|chaos-mock\.js|cur-script-|7coder\\index\.js --server|7coder\\index\.js\" --server' }
foreach ($p in $targets) {
  $cl = $p.CommandLine
  if ($cl.Length -gt 140) { $cl = $cl.Substring(0, 140) }
  Write-Output ("KILL " + $p.ProcessId + " " + $cl)
  Stop-Process -Id $p.ProcessId -Force -ErrorAction SilentlyContinue
}
if (-not $targets) { Write-Output "no orphans" }
