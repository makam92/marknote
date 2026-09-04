#!/bin/sh
# Cross-packages a Windows build from macOS: downloads the matching Electron
# win32-x64 runtime, embeds the app code, zips it. EXPERIMENTAL — untested
# on real Windows until someone runs it. No icon/signing (needs Windows tools).
set -e

PROJECT="$(cd "$(dirname "$0")" && pwd)"
DIST="$PROJECT/dist"
VER=$(node -p "require('$PROJECT/node_modules/electron/package.json').version")
CACHE="$PROJECT/.electron-cache"
ZIP="$CACHE/electron-v$VER-win32-x64.zip"

mkdir -p "$CACHE" "$DIST"
if [ ! -f "$ZIP" ]; then
  echo "Downloading Electron $VER for win32-x64…"
  curl -fSL -o "$ZIP" "https://github.com/electron/electron/releases/download/v$VER/electron-v$VER-win32-x64.zip"
fi

WIN="$DIST/Marknote-win"
rm -rf "$WIN"
mkdir -p "$WIN"
unzip -q "$ZIP" -d "$WIN"
mv "$WIN/electron.exe" "$WIN/Marknote.exe"

APPDIR="$WIN/resources/app"
rm -rf "$WIN/resources/default_app.asar"
mkdir -p "$APPDIR/public"
printf '{ "name": "marknote", "productName": "Marknote", "version": "1.1.1", "main": "main.js" }\n' \
  > "$APPDIR/package.json"
cp "$PROJECT/main.js" "$PROJECT/server.js" "$PROJECT/preload.js" "$PROJECT/AGENTS.md" "$PROJECT/CLAUDE.md" "$APPDIR/"
ditto "$PROJECT/public" "$APPDIR/public"

(cd "$DIST" && rm -f Marknote-win.zip && ditto -c -k Marknote-win Marknote-win.zip)
echo "Built $DIST/Marknote-win.zip ($(du -h "$DIST/Marknote-win.zip" | cut -f1))"
