param(
  [Parameter(Mandatory = $true)] [string]$Manifest,
  [switch]$Apply
)
# Explicit per-run ownership only. Compatible with Win7 PowerShell 2.0.
$ErrorActionPreference = 'Stop'
$Manifest = (Resolve-Path -LiteralPath $Manifest).Path
$RunDir = Split-Path -Parent $Manifest
$TempRoot = [IO.Path]::GetFullPath([IO.Path]::GetTempPath()).TrimEnd('\') + '\'
if (-not $RunDir.StartsWith($TempRoot, [StringComparison]::OrdinalIgnoreCase) -or
    (Split-Path -Leaf $RunDir) -notlike '7coder-test-*' -or
    (Split-Path -Leaf $Manifest) -ne 'owned-processes.tsv') { throw 'Not a test-run ownership manifest.' }
$Lines = @(Get-Content -LiteralPath $Manifest -Encoding UTF8)
if ($Lines.Count -eq 0 -or $Lines[0] -ne ("# 7coder-test-run`t" + $RunDir)) { throw 'Invalid test-run header.' }
foreach ($Line in $Lines | Select-Object -Skip 1) {
  $Parts = $Line -split "`t", 2
  if ($Parts.Count -ne 2 -or $Parts[0] -notmatch '^\d+$' -or [int]$Parts[0] -lt 2) { continue }
  $Needle = $Parts[1]
  if ($Needle.IndexOf($RunDir, [StringComparison]::OrdinalIgnoreCase) -lt 0) { throw 'Ownership marker does not belong to this run.' }
  $Target = Get-WmiObject Win32_Process -Filter ("ProcessId=" + $Parts[0])
  if (-not $Target -or -not $Target.CommandLine -or
      $Target.CommandLine.IndexOf($Needle, [StringComparison]::OrdinalIgnoreCase) -lt 0) { continue }
  if ($Apply) {
    Write-Output ("KILL owned PID " + $Target.ProcessId)
    & taskkill.exe /PID $Target.ProcessId /T /F
  } else {
    Write-Output ("DRY-RUN owned PID " + $Target.ProcessId + ' (use -Apply to stop)')
  }
}
