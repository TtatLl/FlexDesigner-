<#
  Sends media keys to whatever app owns the Windows media session (QQ Music
  registers for these keys, so this controls it without any window focus).

  One shot:  powershell -File media-key.ps1 -Key next
  Server:    powershell -File media-key.ps1 -Server     (accepts one action per stdin line)

  Actions: playpause | play | pause | stop | next | previous | volup | voldown | mute
#>

param(
    [switch]$Server,
    [string]$Key = 'playpause'
)

$ErrorActionPreference = 'Stop'

if (-not ([System.Management.Automation.PSTypeName]'QQMusicNow.Keyboard').Type) {
    Add-Type -Namespace 'QQMusicNow' -Name 'Keyboard' -MemberDefinition @'
[System.Runtime.InteropServices.DllImport("user32.dll", SetLastError = true)]
public static extern void keybd_event(byte bVk, byte bScan, uint dwFlags, System.UIntPtr dwExtraInfo);

public static void Tap(byte vk)
{
    keybd_event(vk, 0, 0, System.UIntPtr.Zero);
    System.Threading.Thread.Sleep(30);
    keybd_event(vk, 0, 2, System.UIntPtr.Zero);
}
'@
}

function Get-VirtualKey([string]$Name) {
    switch ($Name.Trim().ToLowerInvariant()) {
        'playpause' { return 0xB3 }
        'toggle'    { return 0xB3 }
        'play'      { return 0xB3 }
        'pause'     { return 0xB3 }
        'stop'      { return 0xB2 }
        'next'      { return 0xB0 }
        'previous'  { return 0xB1 }
        'prev'      { return 0xB1 }
        'volup'     { return 0xAF }
        'voldown'   { return 0xAE }
        'mute'      { return 0xAD }
        default     { return 0xFF }
    }
}

function Send-MediaKey([string]$Name) {
    $virtualKey = Get-VirtualKey $Name
    if ($virtualKey -eq 0xFF) { return $false }
    [QQMusicNow.Keyboard]::Tap([byte]$virtualKey)
    return $true
}

if ($Server) {
    while ($true) {
        $line = [Console]::In.ReadLine()
        if ($null -eq $line) { break }
        $action = $line.Trim()
        if ($action) { [void](Send-MediaKey $action) }
    }
    exit 0
}

[void](Send-MediaKey $Key)
