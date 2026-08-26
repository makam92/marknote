#!/bin/sh
# Builds /Applications/Marknote.app — a copy of the Electron runtime whose app dir is a
# thin launcher requiring this project in place, so code changes here apply on next
# launch without rebuilding. Re-run this script only if the Electron version changes.
set -e

PROJECT="$(cd "$(dirname "$0")" && pwd)"
APP="/Applications/Marknote.app"
SRC="$PROJECT/node_modules/electron/dist/Electron.app"

[ -d "$SRC" ] || { echo "Electron runtime missing — run npm install first"; exit 1; }

# Never clobber an app bundle we didn't build.
if [ -d "$APP" ] && [ ! -f "$APP/Contents/Resources/app/launcher.js" ]; then
  echo "$APP exists but was not built by this script — aborting"; exit 1
fi

# Build the icns once from the rendered 1024px PNG.
if [ ! -f "$PROJECT/icon/notes.icns" ]; then
  ICONSET="$PROJECT/icon/notes.iconset"
  rm -rf "$ICONSET" && mkdir -p "$ICONSET"
  for s in 16 32 128 256 512; do
    sips -z $s $s "$PROJECT/icon/notes-icon.svg.png" --out "$ICONSET/icon_${s}x${s}.png" >/dev/null
    d=$((s * 2))
    sips -z $d $d "$PROJECT/icon/notes-icon.svg.png" --out "$ICONSET/icon_${s}x${s}@2x.png" >/dev/null
  done
  iconutil -c icns "$ICONSET" -o "$PROJECT/icon/notes.icns"
  rm -rf "$ICONSET"
fi

rm -rf "$APP"
ditto "$SRC" "$APP"

mkdir -p "$APP/Contents/Resources/app"
printf '{ "name": "marknote", "productName": "Marknote", "main": "launcher.js" }\n' \
  > "$APP/Contents/Resources/app/package.json"
printf "require('%s/main.js');\n" "$PROJECT" > "$APP/Contents/Resources/app/launcher.js"

mv "$APP/Contents/MacOS/Electron" "$APP/Contents/MacOS/Marknote"
PLIST="$APP/Contents/Info.plist"
PB=/usr/libexec/PlistBuddy
$PB -c "Set :CFBundleExecutable Marknote" "$PLIST"
$PB -c "Set :CFBundleName Marknote" "$PLIST"
$PB -c "Set :CFBundleDisplayName Marknote" "$PLIST" 2>/dev/null || \
  $PB -c "Add :CFBundleDisplayName string Marknote" "$PLIST"
$PB -c "Set :CFBundleIdentifier app.marknote.desktop" "$PLIST"
$PB -c "Set :NSMicrophoneUsageDescription Marknote records meeting audio when you press the record button." "$PLIST" 2>/dev/null || \
  $PB -c "Add :NSMicrophoneUsageDescription string Marknote records meeting audio when you press the record button." "$PLIST"
cp "$PROJECT/icon/notes.icns" "$APP/Contents/Resources/electron.icns"

codesign --force --deep --sign - "$APP" 2>/dev/null

echo "Built $APP"
