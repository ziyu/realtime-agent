param(
  [Parameter(Mandatory = $true)]
  [string]$Title
)

$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
Add-Type -AssemblyName System.Drawing
Add-Type -AssemblyName System.Windows.Forms

$form = New-Object System.Windows.Forms.Form
$form.Text = $Title
$form.StartPosition = 'Manual'
$form.Location = New-Object System.Drawing.Point(180, 140)
$form.Size = New-Object System.Drawing.Size(560, 360)
$form.KeyPreview = $true

$caption = New-Object System.Windows.Forms.Label
$caption.Text = 'Native desktop driver fixture'
$caption.Location = New-Object System.Drawing.Point(24, 24)
$caption.AutoSize = $true

$editorBox = New-Object System.Windows.Forms.TextBox
$editorBox.AccessibleName = 'InputBox'
$editorBox.Name = 'InputBoxControl'
$editorBox.ShortcutsEnabled = $true
$editorBox.Location = New-Object System.Drawing.Point(24, 64)
$editorBox.Size = New-Object System.Drawing.Size(360, 28)

$apply = New-Object System.Windows.Forms.Button
$apply.Text = 'Apply'
$apply.AccessibleName = 'Apply'
$apply.Location = New-Object System.Drawing.Point(24, 112)
$apply.Size = New-Object System.Drawing.Size(120, 36)

$move = New-Object System.Windows.Forms.Button
$move.Text = 'Move window'
$move.AccessibleName = 'Move window'
$move.Location = New-Object System.Drawing.Point(164, 112)
$move.Size = New-Object System.Drawing.Size(140, 36)

$minimize = New-Object System.Windows.Forms.Button
$minimize.Text = 'Minimize'
$minimize.AccessibleName = 'Minimize'
$minimize.Location = New-Object System.Drawing.Point(324, 112)
$minimize.Size = New-Object System.Drawing.Size(120, 36)

$status = New-Object System.Windows.Forms.TextBox
$status.AccessibleName = 'StatusBox'
$status.ReadOnly = $true
$status.Text = 'Idle'
$status.Location = New-Object System.Drawing.Point(24, 176)
$status.Size = New-Object System.Drawing.Size(360, 28)

$apply.Add_Click({ $status.Text = 'Clicked' })
$move.Add_Click({
  $form.Left += 72
  $form.Top += 48
  $status.Text = 'Moved'
})
$minimize.Add_Click({ $form.WindowState = [System.Windows.Forms.FormWindowState]::Minimized })
$form.Add_KeyDown({
  param($sender, $event)
  if ($event.Control -and $event.KeyCode -eq [System.Windows.Forms.Keys]::L) {
    $status.Text = 'Shortcut received'
    $event.SuppressKeyPress = $true
  }
})
$editorBox.Add_KeyDown({
  param($sender, $event)
  if ($event.Control -and $event.KeyCode -eq [System.Windows.Forms.Keys]::A) {
    $sender.SelectAll()
    $event.SuppressKeyPress = $true
  }
})
$editorBox.Add_KeyUp({
  param($sender, $event)
  if ($event.KeyCode -eq [System.Windows.Forms.Keys]::A -and [System.Windows.Forms.Control]::ModifierKeys -eq [System.Windows.Forms.Keys]::Control) {
    $status.Text = "Select:$($sender.SelectionStart):$($sender.SelectionLength):$($form.ActiveControl.Name)"
  }
})
$form.Add_Shown({
  $form.Activate()
  [Console]::Out.WriteLine((@{ ready = $true; processId = $PID } | ConvertTo-Json -Compress))
  [Console]::Out.Flush()
})

$form.Controls.AddRange(@($caption, $editorBox, $apply, $move, $minimize, $status))
[System.Windows.Forms.Application]::Run($form)
