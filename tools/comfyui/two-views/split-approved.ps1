$ErrorActionPreference='Stop'
Add-Type -AssemblyName System.Drawing
$base=(Resolve-Path 'artifacts/model-review/two-views').Path
$review=Get-Content (Join-Path $base 'review.json') -Raw | ConvertFrom-Json
$cuts=@{astronaut=1005;drill=887;oxygen_generator=900;storage=887;dome_base=887;rover=800}
$outDir=Join-Path $base 'split'; New-Item -ItemType Directory -Force -Path $outDir|Out-Null
foreach($entry in $review.images.PSObject.Properties){$name=$entry.Name;$bmp=[System.Drawing.Bitmap]::FromFile((Join-Path $base $entry.Value));$cut=$cuts[$name];$w=$bmp.Width;$h=$bmp.Height
 foreach($side in @('front','side')){if($side -eq 'front'){$sx=0;$sw=$cut}else{$sx=$cut;$sw=$w-$cut};$out=New-Object System.Drawing.Bitmap($sw,$h);$g=[System.Drawing.Graphics]::FromImage($out);$g.DrawImage($bmp,(New-Object System.Drawing.Rectangle(0,0,$sw,$h)),(New-Object System.Drawing.Rectangle($sx,0,$sw,$h)),[System.Drawing.GraphicsUnit]::Pixel);$g.Dispose();$out.Save((Join-Path $outDir "$name-$side.png"),[System.Drawing.Imaging.ImageFormat]::Png);$out.Dispose()}
 Write-Output "$name cut=$cut width=$w";$bmp.Dispose()}
