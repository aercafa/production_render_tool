$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
Add-Type -AssemblyName System.Windows.Forms
$dialog = New-Object System.Windows.Forms.OpenFileDialog
$dialog.Title = 'Import model - OBJ / 3DM and materials'
$dialog.Filter = 'Models and resources|*.obj;*.3dm;*.mtl;*.png;*.jpg;*.jpeg;*.webp;*.gif|All files|*.*'
$dialog.Multiselect = $true
$dialog.CheckFileExists = $true
$owner = New-Object System.Windows.Forms.Form
$owner.TopMost = $true
$owner.ShowInTaskbar = $false
$owner.Opacity = 0
try {
    # Consume the hidden startup ShowWindow on our transparent owner, not the file dialog.
    $owner.Show()
    $owner.Hide()
    if ($dialog.ShowDialog($owner) -eq [System.Windows.Forms.DialogResult]::OK) {
        [Console]::WriteLine((ConvertTo-Json -InputObject @($dialog.FileNames) -Compress))
    } else {
        [Console]::WriteLine('[]')
    }
} finally {
    $dialog.Dispose()
    $owner.Dispose()
}
