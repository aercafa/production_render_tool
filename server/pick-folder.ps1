$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
Add-Type -AssemblyName System.Windows.Forms
$dialog = New-Object System.Windows.Forms.FolderBrowserDialog
$dialog.Description = 'Select a folder for Model Workbench'
$dialog.ShowNewFolderButton = $true
if ($env:RENDER_FOLDER_START -and (Test-Path -LiteralPath $env:RENDER_FOLDER_START -PathType Container)) {
    $dialog.SelectedPath = $env:RENDER_FOLDER_START
}
$owner = New-Object System.Windows.Forms.Form
$owner.TopMost = $true
$owner.ShowInTaskbar = $false
try {
    if ($dialog.ShowDialog($owner) -eq [System.Windows.Forms.DialogResult]::OK) {
        [Console]::WriteLine($dialog.SelectedPath)
    }
} finally {
    $dialog.Dispose()
    $owner.Dispose()
}
