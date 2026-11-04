# PodCutter installer for Windows (per-user, no admin rights needed).
#   - copies the extension to %APPDATA%\Adobe\CEP\extensions\PodCutter
#   - unblocks the bundled ffmpeg / whisper executables (downloaded zips are "blocked" by Windows)
#   - enables loading unsigned CEP extensions (PlayerDebugMode) for Premiere's CEP runtimes
param([switch]$Uninstall, [switch]$Silent)  # -Silent: used by the in-panel updater

$ErrorActionPreference = "Stop"
$name   = "PodCutter"
$target = Join-Path $env:APPDATA "Adobe\CEP\extensions\$name"
$source = Join-Path $PSScriptRoot $name
# PodCutter was called PodDirector up to 0.17: its old extension folder is removed so the panel isn't listed twice.
$oldTarget = Join-Path $env:APPDATA "Adobe\CEP\extensions\PodDirector"

function Say($msg, $color = "Gray") { Write-Host $msg -ForegroundColor $color }

function Remove-OldPodDirector {
  if (-not (Test-Path $oldTarget)) { return }
  try { Remove-Item $oldTarget -Recurse -Force; Say "Removed the old PodDirector panel ($oldTarget)" Green }
  catch { Say "Couldn't remove the old PodDirector panel at $oldTarget (Premiere may be using it). Delete that folder after closing Premiere." Yellow }
}

if (-not $Silent -and (Get-Process -Name "Adobe Premiere Pro" -ErrorAction SilentlyContinue)) {
  Say "Premiere Pro is running. Please save your work and close it, then press Enter to continue." Yellow
  [void](Read-Host)
}

if ($Uninstall) {
  if (Test-Path $target) { Remove-Item $target -Recurse -Force; Say "Removed $target" Green }
  elseif (-not (Test-Path $oldTarget)) { Say "PodCutter is not installed." }
  Remove-OldPodDirector
  Say "Your presets and transcripts in Documents\PodCutter (and Documents\PodDirector, from before the rename) were left in place."
  exit 0
}

if (-not (Test-Path (Join-Path $source "CSXS\manifest.xml"))) {
  if (Test-Path (Join-Path $PSScriptRoot "..\CSXS\manifest.xml")) {
    Say "This is the PodCutter *source code*, not the installer package." Red
    Say "Download PodCutter-x.y.z-Windows.zip from the Assets list on:" Yellow
    Say "  https://github.com/memoria-productions/podcutter/releases/latest" Yellow
  } else {
    Say "Can't find the PodCutter folder next to this installer ($source)." Red
  }
  exit 1
}

Say "Installing PodCutter to $target ..." Cyan
New-Item -ItemType Directory -Force -Path $target | Out-Null
# Mirror the folder (removes files from older versions).
robocopy $source $target /MIR /NFL /NDL /NJH /NJS /NP | Out-Null
if ($LASTEXITCODE -ge 8) { Say "Copy failed (robocopy code $LASTEXITCODE)." Red; exit 1 }
Remove-OldPodDirector

Get-ChildItem -Path $target -Recurse -File | Unblock-File -ErrorAction SilentlyContinue

foreach ($v in 9..13) {
  $key = "HKCU:\Software\Adobe\CSXS.$v"
  if (-not (Test-Path $key)) { New-Item -Path $key -Force | Out-Null }
  New-ItemProperty -Path $key -Name "PlayerDebugMode" -Value "1" -PropertyType String -Force | Out-Null
}

# Quick self-test of the bundled tools.
$ff = Join-Path $target "vendor\ffmpeg\win32-x64\ffmpeg.exe"
$wh = Join-Path $target "vendor\whisper\win32-x64\whisper-cli.exe"
try { & $ff -hide_banner -version | Select-Object -First 1 | Out-Null; Say "  ffmpeg ........ OK" Green } catch { Say "  ffmpeg ........ could not run ($ff)" Yellow }
if (Test-Path $wh) { Say "  transcriber ... OK" Green } else { Say "  transcriber ... missing" Yellow }

Say ""
Say "Done! Start Premiere Pro, then open:  Window > Extensions > PodCutter" Green
