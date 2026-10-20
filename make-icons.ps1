Add-Type -AssemblyName System.Drawing

function New-Icon {
  param([int]$Size, [string]$Path)

  $scale = 4
  $s = [float]($Size * $scale)
  $bmp = New-Object System.Drawing.Bitmap([int]$s, [int]$s)
  $g = [System.Drawing.Graphics]::FromImage($bmp)
  $g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
  $g.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
  $g.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality
  $g.Clear([System.Drawing.Color]::Transparent)

  # --- Nền: hình vuông bo góc + gradient ---
  $r = $s * 0.23
  $d = $r * 2
  $rect = New-Object System.Drawing.RectangleF(0, 0, $s, $s)
  $bg = New-Object System.Drawing.Drawing2D.GraphicsPath
  $bg.AddArc(0, 0, $d, $d, 180, 90)
  $bg.AddArc($s - $d, 0, $d, $d, 270, 90)
  $bg.AddArc($s - $d, $s - $d, $d, $d, 0, 90)
  $bg.AddArc(0, $s - $d, $d, $d, 90, 90)
  $bg.CloseFigure()

  $brush = New-Object System.Drawing.Drawing2D.LinearGradientBrush(
    $rect,
    [System.Drawing.Color]::FromArgb(255, 66, 133, 244),
    [System.Drawing.Color]::FromArgb(255, 158, 108, 213),
    40.0
  )
  $g.FillPath($brush, $bg)

  # --- Sao 4 cánh ---
  function New-Sparkle {
    param([float]$Cx, [float]$Cy, [float]$R, [float]$Inner)
    $p = New-Object System.Drawing.Drawing2D.GraphicsPath
    $k = $R * $Inner
    [System.Drawing.PointF[]]$pts = @(
      (New-Object System.Drawing.PointF($Cx, ($Cy - $R))),
      (New-Object System.Drawing.PointF(($Cx + $k), ($Cy - $k))),
      (New-Object System.Drawing.PointF(($Cx + $R), $Cy)),
      (New-Object System.Drawing.PointF(($Cx + $k), ($Cy + $k))),
      (New-Object System.Drawing.PointF($Cx, ($Cy + $R))),
      (New-Object System.Drawing.PointF(($Cx - $k), ($Cy + $k))),
      (New-Object System.Drawing.PointF(($Cx - $R), $Cy)),
      (New-Object System.Drawing.PointF(($Cx - $k), ($Cy - $k)))
    )
    $p.AddPolygon($pts)
    return $p
  }

  $white = New-Object System.Drawing.SolidBrush([System.Drawing.Color]::White)
  $soft = New-Object System.Drawing.SolidBrush([System.Drawing.Color]::FromArgb(235, 255, 255, 255))

  $main = New-Sparkle -Cx ($s * 0.46) -Cy ($s * 0.44) -R ($s * 0.30) -Inner $(if ($Size -le 20) { 0.26 } else { 0.16 })
  if ($Size -ge 32) {
    $small = New-Sparkle -Cx ($s * 0.76) -Cy ($s * 0.75) -R ($s * 0.115) -Inner 0.16
    $g.FillPath($soft, $small)
  }
  $g.FillPath($white, $main)

  # --- Xuống thang với nội suy chất lượng cao ---
  $out = New-Object System.Drawing.Bitmap($Size, $Size)
  $g2 = [System.Drawing.Graphics]::FromImage($out)
  $g2.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
  $g2.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality
  $g2.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
  $g2.DrawImage($bmp, (New-Object System.Drawing.Rectangle(0, 0, $Size, $Size)))

  $out.Save($Path, [System.Drawing.Imaging.ImageFormat]::Png)

  $g2.Dispose(); $out.Dispose()
  $g.Dispose(); $bmp.Dispose()
  $brush.Dispose(); $white.Dispose(); $soft.Dispose(); $bg.Dispose(); $main.Dispose()
}

$dir = Join-Path $PSScriptRoot 'icons'
New-Item -ItemType Directory -Force -Path $dir | Out-Null

foreach ($size in 16, 32, 48, 128) {
  New-Icon -Size $size -Path (Join-Path $dir "icon$size.png")
}

Get-ChildItem $dir | Select-Object Name, Length
