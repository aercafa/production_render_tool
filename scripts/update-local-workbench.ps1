param(
    [Parameter(Mandatory = $true)][string]$Target,
    [string]$Package = (Join-Path $PSScriptRoot '..\release\web\RenderWorkbench-Web-windows-x64.zip')
)
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.IO.Compression.FileSystem
$workspace = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$appRoot = (Resolve-Path -LiteralPath $Target).Path.TrimEnd('\')
if ((Get-Item -LiteralPath $appRoot).Attributes -band [IO.FileAttributes]::ReparsePoint) { throw 'Target must not be a link.' }
if (!(Test-Path -LiteralPath (Join-Path $appRoot 'Start-Workbench.cmd')) -or !(Test-Path -LiteralPath (Join-Path $appRoot 'runtime\node.exe'))) { throw 'Target is not a portable workbench directory.' }
if (Get-ChildItem -LiteralPath $appRoot -Recurse -Force -Attributes ReparsePoint) { throw 'Target contains filesystem links; update aborted.' }
$packageFile = (Resolve-Path -LiteralPath $Package).Path
$jobRoot = Join-Path $workspace ('local-fixtures\deploy-' + [guid]::NewGuid().ToString())
[IO.Directory]::CreateDirectory($jobRoot) | Out-Null
$archive = [IO.Compression.ZipFile]::OpenRead($packageFile)
try {
    foreach ($entry in $archive.Entries) {
        $resolved = [IO.Path]::GetFullPath((Join-Path $jobRoot $entry.FullName))
        if (!$resolved.StartsWith($jobRoot + '\', [StringComparison]::OrdinalIgnoreCase)) { throw 'Package contains an unsafe path.' }
    }
} finally { $archive.Dispose() }
[IO.Compression.ZipFile]::ExtractToDirectory($packageFile, $jobRoot)
$source = Join-Path $jobRoot 'RenderWorkbench-Web'
$build = Get-Content -LiteralPath (Join-Path $source 'build-info.json') -Raw | ConvertFrom-Json
if ($build.platform -ne 'windows-x64' -or $build.version -notmatch '^\d+\.\d+\.\d+$') { throw 'Invalid Windows package metadata.' }
$entryHash = (Get-FileHash -LiteralPath (Join-Path $source 'dist\index.html') -Algorithm SHA256).Hash.ToLowerInvariant()
if ($entryHash -ne $build.indexSha256) { throw 'Package index does not match its build metadata.' }
$backupRoot = Join-Path $workspace 'release\backups'
[IO.Directory]::CreateDirectory($backupRoot) | Out-Null
$backup = Join-Path $backupRoot ('RenderWorkbench-before-' + $build.version + '-' + (Get-Date -Format 'yyyyMMdd-HHmmss') + '.zip')
$backupArchive = [IO.Compression.ZipFile]::Open($backup, [IO.Compression.ZipArchiveMode]::Create)
try {
    foreach ($file in Get-ChildItem -LiteralPath $appRoot -Recurse -File) {
        $relative = $file.FullName.Substring($appRoot.Length + 1)
        # Running services may exclusively hold their redirected logs. They are not replaced by this update.
        if ($relative.StartsWith('logs\', [StringComparison]::OrdinalIgnoreCase)) { continue }
        [IO.Compression.ZipFileExtensions]::CreateEntryFromFile($backupArchive, $file.FullName, $relative.Replace('\','/'), [IO.Compression.CompressionLevel]::Fastest) | Out-Null
    }
} finally { $backupArchive.Dispose() }
$runtime = Join-Path $appRoot 'runtime\node.exe'
$stopped = @()
foreach ($process in Get-CimInstance Win32_Process -Filter "Name = 'node.exe'") {
    if ($process.ExecutablePath -and $process.ExecutablePath.Equals($runtime, [StringComparison]::OrdinalIgnoreCase) -and $process.CommandLine -match 'server[\\/]start-web\.mjs') {
        $stopped += $process.ProcessId
        Stop-Process -Id $process.ProcessId -Force
    }
}
$count = 0
foreach ($file in Get-ChildItem -LiteralPath $source -Recurse -File) {
    $relative = $file.FullName.Substring($source.Length + 1)
    $destination = [IO.Path]::GetFullPath((Join-Path $appRoot $relative))
    if (!$destination.StartsWith($appRoot + '\', [StringComparison]::OrdinalIgnoreCase)) { throw 'Update destination escaped the selected app directory.' }
    $expected = (Get-FileHash -LiteralPath $file.FullName -Algorithm SHA256).Hash
    $same = (Test-Path -LiteralPath $destination) -and ((Get-FileHash -LiteralPath $destination -Algorithm SHA256).Hash -eq $expected)
    if (!$same) {
        [IO.Directory]::CreateDirectory([IO.Path]::GetDirectoryName($destination)) | Out-Null
        Copy-Item -LiteralPath $file.FullName -Destination $destination -Force
    }
    if ((Get-FileHash -LiteralPath $destination -Algorithm SHA256).Hash -ne $expected) { throw ('Updated file failed verification: ' + $relative) }
    $count++
}
$logRoot = Join-Path $appRoot 'logs'
[IO.Directory]::CreateDirectory($logRoot) | Out-Null
$logSuffix = Get-Date -Format 'yyyyMMdd-HHmmss'
$stdout = Join-Path $logRoot ('startup-' + $logSuffix + '.log')
$stderr = Join-Path $logRoot ('startup-' + $logSuffix + '.error.log')
$oldNoBrowser = $env:RENDER_WORKBENCH_NO_BROWSER
try {
    $env:RENDER_WORKBENCH_NO_BROWSER = '1'
    $started = Start-Process -FilePath $runtime -ArgumentList @('server/start-web.mjs') -WorkingDirectory $appRoot -WindowStyle Hidden -RedirectStandardOutput $stdout -RedirectStandardError $stderr -PassThru
} finally { $env:RENDER_WORKBENCH_NO_BROWSER = $oldNoBrowser }
$url = ''
for ($attempt = 0; $attempt -lt 50; $attempt++) {
    Start-Sleep -Milliseconds 200
    $text = Get-Content -LiteralPath $stdout -Raw -ErrorAction SilentlyContinue
    if ($text -match 'Render Workbench: (http://127\.0\.0\.1:\d+/)') { $url = $Matches[1]; break }
    if ($started.HasExited) { throw ('Updated service failed to start. See ' + $stderr) }
}
if (!$url) { throw ('Updated service startup timed out. See ' + $stdout) }
[pscustomobject]@{ Version=$build.version; Target=$appRoot; Url=$url; VerifiedFiles=$count; Stopped=$stopped; ProcessId=$started.Id; Backup=$backup } | ConvertTo-Json
