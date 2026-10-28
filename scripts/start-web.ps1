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
$WorkspaceLocation = Resolve-Path -LiteralPath $Workspace
if ($WorkspaceLocation.Provider.Name -ne 'FileSystem') { throw 'Workspace must be a FileSystem directory. No Agent was started.' }
$Workspace = $WorkspaceLocation.Path
$Entry = Join-Path $Repo 'index.js'
if (-not (Test-Path -LiteralPath $Entry -PathType Leaf)) { throw "Entry file not found: $Entry" }
Write-Host 'Starting 7coder. Use the listening address printed by the Agent after startup succeeds.'
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
