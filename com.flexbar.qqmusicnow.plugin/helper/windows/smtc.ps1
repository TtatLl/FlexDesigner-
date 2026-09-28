<#
  Streams the Windows "now playing" state (System Media Transport Controls) as
  JSON lines, one sample per line.

  Usage:  powershell -NoProfile -ExecutionPolicy Bypass -File smtc.ps1 -IntervalMs 800
          powershell -NoProfile -ExecutionPolicy Bypass -File smtc.ps1 -Once

  Emits:
    {"type":"sample","ts":1690000000000,"sessions":[{"appId":"QQMusic.exe","title":"...","artist":"...","albumTitle":"...","status":"Playing","positionSec":12.3,"durationSec":240.0}]}
    {"type":"error","ts":...,"message":"..."}
#>

param(
    [int]$IntervalMs = 800,
    [switch]$Once
)

$ErrorActionPreference = 'Stop'

try {
    [Console]::OutputEncoding = [System.Text.Encoding]::UTF8
    $OutputEncoding = [System.Text.Encoding]::UTF8
} catch {
    # Older hosts may not allow changing the console encoding.
}

function Emit([hashtable]$Payload) {
    [Console]::Out.WriteLine(($Payload | ConvertTo-Json -Compress -Depth 5))
    [Console]::Out.Flush()
}

function Get-Array($Value) {
    if ($null -eq $Value) { return @() }
    if ($Value -is [System.Array]) { return $Value }
    return @($Value)
}

try {
    Add-Type -AssemblyName System.Runtime.WindowsRuntime
} catch {
    Emit @{ type = 'error'; ts = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds(); message = "System.Runtime.WindowsRuntime unavailable: $($_.Exception.Message)" }
    exit 1
}

$asTaskMethod = ([System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object {
    $_.Name -eq 'AsTask' -and
    $_.GetParameters().Count -eq 1 -and
    $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation`1'
})[0]

function Await($WinRtOperation, $ResultType) {
    $task = $asTaskMethod.MakeGenericMethod($ResultType).Invoke($null, @($WinRtOperation))
    $task.Wait(4000) | Out-Null
    return $task.Result
}

$managerType = [Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager, Windows.Media.Control, ContentType = WindowsRuntime]
$propsType = [Windows.Media.Control.GlobalSystemMediaTransportControlsSessionMediaProperties, Windows.Media.Control, ContentType = WindowsRuntime]
$null = [Windows.Storage.Streams.DataReader, Windows.Storage.Streams, ContentType = WindowsRuntime]
$null = [Windows.Storage.Streams.IRandomAccessStreamWithContentType, Windows.Storage.Streams, ContentType = WindowsRuntime]

# The media session carries the album art itself, so the plugin can show a cover
# on the very first frame instead of waiting for a metadata lookup + download.
# Sent when the track changes, plus a periodic re-send so a plugin that was
# restarted mid-song still picks it up.
$script:LastArtworkKey = ''
$script:ArtworkHeartbeat = 0

function Close-Stream($Stream) {
    # WinRT objects surfaced through the PowerShell 5.1 projection do not always
    # expose Dispose(); IClosable's Close() is the reliable one. Never let a
    # failure here throw away data we already read.
    try { $Stream.Dispose() } catch { try { $Stream.Close() } catch { } }
}

function Get-ThumbnailInfo($MediaProps, [int]$MaxBytes = 2097152) {
    try {
        $reference = $MediaProps.Thumbnail
        if ($null -eq $reference) { return @{ data = $null; info = 'no-thumbnail-reference' } }

        $stream = Await ($reference.OpenReadAsync()) ([Windows.Storage.Streams.IRandomAccessStreamWithContentType])
        if ($null -eq $stream) { return @{ data = $null; info = 'stream-null' } }

        # The stream arrives as System.__ComObject through the PowerShell 5.1
        # projection: it cannot be cast to the WinRT interfaces and its Size
        # reads as 0, so neither AsStreamForRead nor LoadAsync(Size) works.
        # DataReader.LoadAsync(count) does not need the size: read in chunks
        # until it reports nothing left.
        $bytes = $null
        $how = ''
        $tried = @()
        $chunkSize = 65536

        try {
            $reader = New-Object -TypeName Windows.Storage.Streams.DataReader -ArgumentList $stream
            $chunks = New-Object 'System.Collections.Generic.List[byte]'
            $total = 0
            while ($true) {
                $loaded = [int](Await ($reader.LoadAsync([uint32]$chunkSize)) ([uint32]))
                if ($loaded -le 0) { break }
                $buffer = New-Object byte[] $loaded
                $reader.ReadBytes($buffer)
                $chunks.AddRange($buffer)
                $total += $loaded
                if ($total -gt $MaxBytes) { break }
            }
            Close-Stream $reader
            if ($total -gt 0) {
                $bytes = $chunks.ToArray()
                $how = "chunked:$total"
            } else {
                $tried += 'chunked:empty'
            }
        } catch {
            $inner = $_.Exception
            while ($inner.InnerException) { $inner = $inner.InnerException }
            $tried += "chunked:$($inner.Message)"
        }

        if ($null -eq $bytes) {
            try { $tried += "streamType:$($stream.GetType().FullName)" } catch { }
        }

        Close-Stream $stream

        if ($null -eq $bytes -or $bytes.Length -le 0) {
            return @{ data = $null; info = 'failed:' + ($tried -join '|') }
        }
        if ($bytes.Length -gt $MaxBytes) { return @{ data = $null; info = "too-large:$($bytes.Length)" } }
        $base64 = [Convert]::ToBase64String($bytes)
        return @{ data = $base64; info = "ok:$how" }
    } catch {
        $inner = $_.Exception
        while ($inner.InnerException) { $inner = $inner.InnerException }
        return @{ data = $null; info = "error:$($inner.GetType().Name):$($inner.Message)" }
    }
}

$manager = $null
$iterations = 0

while ($true) {
    $timestamp = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()

    try {
        if ($null -eq $manager -or ($iterations % 60) -eq 0) {
            $manager = Await ($managerType::RequestAsync()) $managerType
        }

        $sessions = @()
        if ($null -ne $manager) {
            foreach ($session in $manager.GetSessions()) {
                $mediaProps = Await ($session.TryGetMediaPropertiesAsync()) $propsType
                $timeline = $session.GetTimelineProperties()
                $playback = $session.GetPlaybackInfo()

                $artworkKey = "$($mediaProps.Title)|$($mediaProps.Artist)"
                $artwork = $null
                $artworkInfo = ''
                if ($artworkKey -ne $script:LastArtworkKey) {
                    $script:LastArtworkKey = $artworkKey
                    $script:ArtworkHeartbeat = 0
                    $thumb = Get-ThumbnailInfo $mediaProps
                    $artwork = $thumb.data
                    $artworkInfo = $thumb.info
                    $script:LastArtwork = $artwork
                    $script:LastArtworkInfo = $artworkInfo
                } else {
                    $script:ArtworkHeartbeat++
                    if ($script:ArtworkHeartbeat -ge 15 -and $script:LastArtwork) {
                        $script:ArtworkHeartbeat = 0
                        $artwork = $script:LastArtwork
                    }
                    $artworkInfo = $script:LastArtworkInfo
                }

                $sessions += [ordered]@{
                    appId       = [string]$session.SourceAppUserModelId
                    title       = [string]$mediaProps.Title
                    artist      = [string]$mediaProps.Artist
                    albumTitle  = [string]$mediaProps.AlbumTitle
                    albumArtist = [string]$mediaProps.AlbumArtist
                    status      = [string]$playback.PlaybackStatus
                    positionSec = [math]::Round($timeline.Position.TotalSeconds, 3)
                    durationSec = [math]::Round($timeline.EndTime.TotalSeconds, 3)
                    artworkInfo = $artworkInfo
                    artworkData = $artwork
                }
            }
        }

        Emit @{ type = 'sample'; ts = $timestamp; sessions = (Get-Array $sessions) }
    } catch {
        $manager = $null
        # Unwrap AggregateException so the caller sees the real WinRT reason
        # (e.g. "the specified service is not installed" on headless systems).
        $inner = $_.Exception
        while ($inner.InnerException) { $inner = $inner.InnerException }
        Emit @{ type = 'error'; ts = $timestamp; message = $inner.Message }
    }

    if ($Once) { break }
    $iterations++
    Start-Sleep -Milliseconds $IntervalMs
}
