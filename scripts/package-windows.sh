#!/usr/bin/env bash
# Build the Windows installer zip: dist/PodCutter-<version>-Windows.zip
# Bundles the panel, engine, Windows ffmpeg + whisper.cpp, and the English Whisper model.
# Run scripts/fetch-vendor.sh first if vendor/ is empty.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
VERSION="$(node -e "console.log(require('$ROOT/engine/director.js').VERSION)")"
OUT="$ROOT/dist/PodCutter-$VERSION-Windows"
EXT="$OUT/PodCutter"

for f in vendor/ffmpeg/win32-x64/ffmpeg.exe vendor/whisper/win32-x64/whisper-cli.exe vendor/whisper/models/vad/ggml-silero-v5.1.2.bin; do
  [ -f "$ROOT/$f" ] || { echo "Missing $f - run scripts/fetch-vendor.sh"; exit 1; }
done
ls "$ROOT"/vendor/whisper/models/ggml-*.bin >/dev/null 2>&1 || { echo "No Whisper model in vendor/whisper/models"; exit 1; }

rm -rf "$OUT" && mkdir -p "$EXT"
cp -R "$ROOT/CSXS" "$ROOT/client" "$ROOT/engine" "$ROOT/host" "$EXT/"
mkdir -p "$EXT/vendor/ffmpeg" "$EXT/vendor/whisper"
cp -R "$ROOT/vendor/ffmpeg/win32-x64" "$EXT/vendor/ffmpeg/"
cp -R "$ROOT/vendor/whisper/win32-x64" "$ROOT/vendor/whisper/models" "$EXT/vendor/whisper/"
cp "$ROOT/LICENSE" "$ROOT/THIRD_PARTY_NOTICES.md" "$EXT/"
cp "$ROOT/install/install.ps1" "$ROOT/install/Install PodCutter.bat" "$ROOT/install/Uninstall PodCutter.bat" "$OUT/"
cp "$ROOT/docs/USER_GUIDE.md" "$OUT/PodCutter User Guide.md"

(cd "$ROOT/dist" && rm -f "PodCutter-$VERSION-Windows.zip" && zip -qr -9 "PodCutter-$VERSION-Windows.zip" "PodCutter-$VERSION-Windows")
echo "Built $ROOT/dist/PodCutter-$VERSION-Windows.zip ($(du -h "$ROOT/dist/PodCutter-$VERSION-Windows.zip" | cut -f1))"
