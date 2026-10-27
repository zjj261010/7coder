# Development only. Target machines run the checked-in helper without csc.
$ErrorActionPreference = 'Stop'
$scriptDirectory = Split-Path -Parent $MyInvocation.MyCommand.Path
$projectRoot = [IO.Path]::GetFullPath((Join-Path $scriptDirectory '..'))
$compiler = Join-Path $env:SystemRoot 'Microsoft.NET\Framework\v3.5\csc.exe'
if (-not (Test-Path -LiteralPath $compiler)) { throw 'Build requires the .NET 3.5 compiler (CLR 2.0 target).' }
$nativeRoot = Join-Path $projectRoot 'native'
$systemAssembly = Join-Path $env:SystemRoot 'Microsoft.NET\Framework\v2.0.50727\System.dll'
& $compiler /nologo /noconfig "/reference:$systemAssembly" /target:exe /platform:anycpu /optimize+ "/win32manifest:$nativeRoot\process-owner.manifest" "/out:$nativeRoot\process-owner.exe" "$nativeRoot\process-owner.cs"
if ($LASTEXITCODE -ne 0) { throw 'process-owner compilation failed' }
$sha = [Security.Cryptography.SHA256]::Create()
try {
    $digest = [BitConverter]::ToString($sha.ComputeHash([IO.File]::ReadAllBytes((Join-Path $nativeRoot 'process-owner.exe')))).Replace('-', '').ToLowerInvariant()
    $sourceDigest = [BitConverter]::ToString($sha.ComputeHash([IO.File]::ReadAllBytes((Join-Path $nativeRoot 'process-owner.cs')))).Replace('-', '').ToLowerInvariant()
    $configDigest = [BitConverter]::ToString($sha.ComputeHash([IO.File]::ReadAllBytes((Join-Path $nativeRoot 'process-owner.exe.config')))).Replace('-', '').ToLowerInvariant()
    $manifestDigest = [BitConverter]::ToString($sha.ComputeHash([IO.File]::ReadAllBytes((Join-Path $nativeRoot 'process-owner.manifest')))).Replace('-', '').ToLowerInvariant()
} finally { $sha.Dispose() }
$manifest = '{"protocol":1,"file":"process-owner.exe","target":"Windows 7 SP1; CLR 2.0 or CLR 4","sha256":"' + $digest + '","sourceSha256":"' + $sourceDigest + '","configSha256":"' + $configDigest + '","manifestSha256":"' + $manifestDigest + '"}'
[IO.File]::WriteAllText((Join-Path $nativeRoot 'process-owner.json'), $manifest + "`n", (New-Object Text.UTF8Encoding($false)))
Write-Output ('Built CLR 2.0 process owner: ' + $digest)
