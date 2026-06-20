<#
.SYNOPSIS
  Bake a test texture into the Vermeil companion cape at a chosen resolution,
  to verify the in-game mod renders each resolution correctly.

.DESCRIPTION
  Reads a source image (default: ~/Downloads/test.gif), builds the mod's cape
  format — a vertical strip of square 64*Res frames with the art in the top 2:1
  region — and writes it to %LOCALAPPDATA%\Vermeil\companion\cape.png plus a
  cape.json. The running game live-reloads it within ~1s (no relaunch needed),
  as long as you've set+enabled a custom cape once in the launcher and launched
  the 26.2 instance (so the mod is installed and -Dvermeil.dataDir is wired).

  Res is the resolution multiplier of the 64x32 atlas — the same set the cape
  modal offers: 1, 2, 4, 8, 16, 32  (frame size = 64*Res; 8 -> 512px, 32 -> 2048px).

.EXAMPLE
  # from the repo root
  ./scripts/test-cape.ps1 -Res 1
  ./scripts/test-cape.ps1 -Res 8
  ./scripts/test-cape.ps1 -Res 32 -FrameMs 50
  ./scripts/test-cape.ps1 -Res 16 -Source "$env:USERPROFILE\Downloads\my.png"
#>
param(
  [ValidateSet(1, 2, 4, 8, 16, 32)]
  [int]$Res = 8,
  [string]$Source = "$env:USERPROFILE\Downloads\test.gif",
  [int]$FrameMs = 100,
  [int]$MaxFrames = 64
)

$ErrorActionPreference = "Stop"
Add-Type -AssemblyName System.Drawing

if (-not (Test-Path $Source)) { throw "Source image not found: $Source" }

$companion = Join-Path $env:LOCALAPPDATA "Vermeil\companion"
New-Item -ItemType Directory -Force -Path $companion | Out-Null
$outPng = Join-Path $companion "cape.png"
$outJson = Join-Path $companion "cape.json"

$frame = 64 * $Res          # square frame edge in px
$capeH = 32 * $Res          # cape art occupies the top 2:1 region of each frame

$img = [System.Drawing.Image]::FromFile($Source)
try {
  # Enumerate animation frames (1 for a static image).
  $fd = New-Object System.Drawing.Imaging.FrameDimension $img.FrameDimensionsList[0]
  $srcFrames = [Math]::Max(1, $img.GetFrameCount($fd))

  # Bound frame count to the mod's per-resolution memory budget (64 MB of
  # decoded RGBA), and to -MaxFrames, so a long gif at high res stays sane.
  $perFrameBytes = [int64]$frame * $capeH * 4
  $budget = [Math]::Max(1, [int][Math]::Floor((64 * 1024 * 1024) / $perFrameBytes))
  $frames = [Math]::Min([Math]::Min($srcFrames, $MaxFrames), $budget)

  $strip = New-Object System.Drawing.Bitmap($frame, ($frame * $frames))
  $g = [System.Drawing.Graphics]::FromImage($strip)
  $g.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
  $g.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality

  for ($i = 0; $i -lt $frames; $i++) {
    [void]$img.SelectActiveFrame($fd, $i)
    # Draw the frame stretched to fill the top 2:1 region of slot i.
    $dest = New-Object System.Drawing.Rectangle(0, ($i * $frame), $frame, $capeH)
    $g.DrawImage($img, $dest)
  }
  $g.Dispose()

  $strip.Save($outPng, [System.Drawing.Imaging.ImageFormat]::Png)
  $strip.Dispose()
}
finally {
  $img.Dispose()
}

$ft = if ($frames -gt 1) { $FrameMs } else { 100 }
"{`n  `"enabled`": true,`n  `"frameTimeMs`": $ft`n}" | Set-Content -Path $outJson -Encoding UTF8

$h = $frame * $frames
Write-Host "Wrote $outPng  ($frame x $h, ${frames} frame(s) @ ${ft}ms, res x$Res)" -ForegroundColor Green
Write-Host "In-game cape live-reloads within ~1s. Re-run with a different -Res to compare."
