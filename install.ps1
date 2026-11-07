# Installs the LuckyTwitch Markers CEP panel for Windows: no Creative Cloud app needed. (macOS: install-mac.command.)
#   install.bat              install / update
#   install.bat -Uninstall   remove the panel (the registry flag stays on)
# Source layout (relative to this script):  cep-panel\ (CSXS, js, jsx, index.html, .debug)  +  src\*.js (shared code, copied into the panel's shared\)
param([switch]$Uninstall, [switch]$Dev)
$ErrorActionPreference = "Stop"

$id = "com.luckytwitch.markers"
$oldId = "com.luckytwitch.ceptest"   # the panel's old id (test builds): removed on install so Premiere does not list two panels
$target = Join-Path $env:APPDATA "Adobe\CEP\extensions\$id"
$oldTarget = Join-Path $env:APPDATA "Adobe\CEP\extensions\$oldId"
$panel = Join-Path $PSScriptRoot "cep-panel"
$shared = Join-Path $PSScriptRoot "src"

if (Test-Path $oldTarget) {
    Write-Host "Removing the old test panel $oldTarget"
    Remove-Item $oldTarget -Recurse -Force
}
if (Test-Path $target) {
    Write-Host "Removing $target"
    Remove-Item $target -Recurse -Force
}
if ($Uninstall) {
    Write-Host "Uninstalled. Restart Premiere Pro."
    exit 0
}

# Everything that must exist before we copy anything: fail loudly instead of installing half a panel.
$need = @(
    (Join-Path $panel "CSXS\manifest.xml"), (Join-Path $panel "index.html"),
    (Join-Path $panel "js\runner.js"), (Join-Path $panel "js\ui.js"), (Join-Path $panel "jsx\host.jsx"), (Join-Path $shared "timecode.js"), (Join-Path $shared "markers-core.js"), (Join-Path $shared "guard.js"), (Join-Path $shared "progress.js")
)
foreach ($f in $need) { if (-not (Test-Path $f)) { throw "Missing source file: $f" } }

# Allow unsigned panels. Set for several CEP versions so it works whichever one your Premiere reads.
foreach ($v in 9..14) {
    $key = "HKCU:\Software\Adobe\CSXS.$v"
    if (-not (Test-Path $key)) { New-Item -Path $key -Force | Out-Null }
    Set-ItemProperty -Path $key -Name "PlayerDebugMode" -Value "1" -Type String
}
Write-Host "Unsigned panels allowed (PlayerDebugMode = 1 for CSXS.9 to CSXS.14)."

New-Item -ItemType Directory -Path $target -Force | Out-Null
Copy-Item (Join-Path $panel "CSXS") $target -Recurse
Copy-Item (Join-Path $panel "js") $target -Recurse
Copy-Item (Join-Path $panel "jsx") $target -Recurse
Copy-Item (Join-Path $panel "index.html") $target
if ($Dev -and (Test-Path (Join-Path $panel ".debug"))) {
    Copy-Item (Join-Path $panel ".debug") $target -Force
}

# Shared code from src\ goes to shared\: the panel page loads markers-core.js from there, and loads timecode.js into ExtendScript from there.
New-Item -ItemType Directory -Path (Join-Path $target "shared") -Force | Out-Null
foreach ($f in Get-ChildItem (Join-Path $shared "*.js")) {
    Copy-Item $f.FullName (Join-Path $target "shared") -Force
}

# Verify what actually landed.
foreach ($rel in @("CSXS\manifest.xml", "index.html", "js\runner.js", "js\ui.js", "jsx\host.jsx", "shared\timecode.js", "shared\markers-core.js", "shared\guard.js", "shared\progress.js")) {
    if (-not (Test-Path (Join-Path $target $rel))) { throw "Install check failed: $rel is not in $target" }
}
# A broken manifest makes Premiere hide the panel without any error: check it is complete before saying "installed".
$mf = Get-Content (Join-Path $target "CSXS\manifest.xml") -Raw
if ($mf.Length -lt 500 -or -not $mf.TrimEnd().EndsWith("</ExtensionManifest>")) { throw "Install check failed: CSXS\manifest.xml is empty or cut off ($($mf.Length) characters). The package is broken." }
Write-Host "manifest.xml OK ($($mf.Length) characters)."
Write-Host "Installed to $target"
Get-ChildItem $target -Recurse -File | ForEach-Object { Write-Host ("  " + $_.FullName.Substring($target.Length + 1)) }

if (Get-Process -Name "Adobe Premiere Pro" -ErrorAction SilentlyContinue) {
    Write-Host "Premiere Pro is running: close it and open it again." -ForegroundColor Yellow
} else {
    Write-Host "Start Premiere Pro and open Window > Extensions > LuckyTwitch Markers."
}
Write-Host "Debugger (optional): open http://localhost:8099 in Chrome while the panel is open."
