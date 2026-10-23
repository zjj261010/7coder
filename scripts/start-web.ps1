param(
  [Parameter(Position = 0)]
  [string]$Workspace
)

$ErrorActionPreference = 'Stop'
$Repo = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
$Node = Join-Path $Repo 'runtime\node.exe'
if (-not (Test-Path -LiteralPath $Node -PathType Leaf)) { $Node = $null }

if (-not $Node) {
  $NodeCommand = Get-Command node.exe -ErrorAction SilentlyContinue
  if (-not $NodeCommand) { throw 'Bundled Node.js was not found and node.exe is not on PATH.' }
  $Node = $NodeCommand.Definition
}

if (-not $Workspace -or $Workspace.Trim().Length -eq 0) {
  $Workspace = $Repo
}

if (-not (Test-Path -LiteralPath $Workspace -PathType Container)) { throw "Workspace directory not found: $Workspace" }
$Workspace = (Resolve-Path -LiteralPath $Workspace).Path
$Entry = Join-Path $Repo 'index.js'
if (-not (Test-Path -LiteralPath $Entry -PathType Leaf)) { throw "Entry file not found: $Entry" }
$HttpPort = 7103
$WorkspaceEnv = Join-Path $Workspace '.env'
if (Test-Path -LiteralPath $WorkspaceEnv -PathType Leaf) {
  $PortLine = Get-Content -LiteralPath $WorkspaceEnv | Where-Object { $_ -match '^\s*HTTP_PORT\s*=' } | Select-Object -Last 1
  if ($PortLine -match '^\s*HTTP_PORT\s*=\s*(\d+)') { $HttpPort = $Matches[1] }
}
Write-Host "7coder web UI: http://127.0.0.1:$HttpPort/"
Write-Host "Workspace: $Workspace"
Write-Host "Runtime: $Node"
Write-Host 'Press Ctrl+C to stop the server.'
Push-Location -LiteralPath $Workspace
try {
  & $Node $Entry --server
  exit $LASTEXITCODE
} finally {
  Pop-Location
}
