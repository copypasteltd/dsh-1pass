Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
[System.Windows.Forms.Application]::EnableVisualStyles()
$form = New-Object System.Windows.Forms.Form
$form.Text = 'DSH 凭据库 — 设置主密码（无强度限制）'
$form.Size = New-Object System.Drawing.Size(660, 390)
$form.StartPosition = 'CenterScreen'
$form.TopMost = $true
$form.FormBorderStyle = 'FixedDialog'
$form.MaximizeBox = $false
$form.MinimizeBox = $false
$intro = New-Object System.Windows.Forms.Label
$intro.Location = New-Object System.Drawing.Point(22, 18)
$intro.Size = New-Object System.Drawing.Size(610, 88)
$intro.Text = @('请在此窗口设置主密码；不限制长度或字符组合，允许弱密码。','密码不会进入聊天或项目配置文件。','本步骤保存到当前 Windows 用户的 DSH_VAULT_PASSWORD 环境变量。','注意：用户环境变量不是加密钥匙串，同账号程序可读取；请勿复用其他密码。') -join [Environment]::NewLine
$form.Controls.Add($intro)
$label1 = New-Object System.Windows.Forms.Label
$label1.Text = '主密码'
$label1.Location = New-Object System.Drawing.Point(22, 122)
$label1.AutoSize = $true
$form.Controls.Add($label1)
$first = New-Object System.Windows.Forms.TextBox
$first.Location = New-Object System.Drawing.Point(140, 118)
$first.Size = New-Object System.Drawing.Size(475, 26)
$first.UseSystemPasswordChar = $true
$form.Controls.Add($first)
$label2 = New-Object System.Windows.Forms.Label
$label2.Text = '再次输入'
$label2.Location = New-Object System.Drawing.Point(22, 168)
$label2.AutoSize = $true
$form.Controls.Add($label2)
$second = New-Object System.Windows.Forms.TextBox
$second.Location = New-Object System.Drawing.Point(140, 164)
$second.Size = New-Object System.Drawing.Size(475, 26)
$second.UseSystemPasswordChar = $true
$form.Controls.Add($second)
$notice = New-Object System.Windows.Forms.Label
$notice.Location = New-Object System.Drawing.Point(22, 213)
$notice.Size = New-Object System.Drawing.Size(595, 48)
$notice.Text = '保存后请回到聊天，告诉助手“已设置”，不要发送实际密码。首次启用还需要重启 DSH。'
$form.Controls.Add($notice)
$save = New-Object System.Windows.Forms.Button
$save.Text = '保存到当前用户环境'
$save.Location = New-Object System.Drawing.Point(250, 280)
$save.Size = New-Object System.Drawing.Size(220, 38)
$form.Controls.Add($save)
$cancel = New-Object System.Windows.Forms.Button
$cancel.Text = '取消'
$cancel.Location = New-Object System.Drawing.Point(490, 280)
$cancel.Size = New-Object System.Drawing.Size(125, 38)
$form.Controls.Add($cancel)
$form.AcceptButton = $save
$form.CancelButton = $cancel
$cancel.Add_Click({ $form.Close() })
$save.Add_Click({
  # Only empty input is invalid; strength and character composition never gate saving.
  if ($first.Text.Length -eq 0) {
    [System.Windows.Forms.MessageBox]::Show('请输入主密码，可以使用任意非空密码。', '尚未输入') | Out-Null
    return
  }
  if ($first.Text -cne $second.Text) {
    [System.Windows.Forms.MessageBox]::Show('两次输入不一致。请重新输入。', '输入不一致') | Out-Null
    return
  }
  $key = [Microsoft.Win32.Registry]::CurrentUser.OpenSubKey('Environment')
  $exists = $false
  try { if ($null -ne $key) { $exists = @($key.GetValueNames()) -contains 'DSH_VAULT_PASSWORD' } } finally { if ($null -ne $key) { $key.Dispose() } }
  if ($exists) {
    $confirm = [System.Windows.Forms.MessageBox]::Show('该变量已经存在。更改它不会自动重加密现有保险库，可能导致无法解锁。确认替换？', '已有主密码变量', 'YesNo', 'Warning')
    if ($confirm -ne [System.Windows.Forms.DialogResult]::Yes) { return }
  }
  try {
    [Environment]::SetEnvironmentVariable('DSH_VAULT_PASSWORD', $first.Text, [EnvironmentVariableTarget]::User)
    $first.Clear()
    $second.Clear()
    $save.Enabled = $false
    Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class DshEnvironmentNotify {
  [DllImport("user32.dll", CharSet=CharSet.Unicode, SetLastError=true)]
  public static extern IntPtr SendMessageTimeout(IntPtr hWnd, uint Msg, UIntPtr wParam, string lParam, uint flags, uint timeout, out UIntPtr result);
}
'@
    $result = [UIntPtr]::Zero
    [void][DshEnvironmentNotify]::SendMessageTimeout([IntPtr]0xffff, 0x001a, [UIntPtr]::Zero, 'Environment', 2, 3000, [ref]$result)
    [System.Windows.Forms.MessageBox]::Show('已保存。请妥善保管主密码。回到聊天回复“已设置”，不要发送实际密码。当前 DSH 尚未重启。', '设置完成') | Out-Null
    $form.Close()
  } catch {
    $first.Clear()
    $second.Clear()
    [System.Windows.Forms.MessageBox]::Show('设置未完成。请检查当前用户写入环境变量的权限，再重试。未记录密码。', '设置失败') | Out-Null
    $save.Enabled = $true
  }
})
[void]$form.ShowDialog()
$first.Clear()
$second.Clear()
$form.Dispose()
