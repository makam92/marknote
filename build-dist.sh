#!/bin/sh
# Builds dist/Marknote.app with the app code EMBEDDED (self-contained) and
# zips it for distribution — no git, npm or GitHub needed on the target Mac.
# Data lives in ~/Documents/Marknote on end-user machines (see server.js).
set -e

PROJECT="$(cd "$(dirname "$0")" && pwd)"
DIST="$PROJECT/dist"
APP="$DIST/Marknote.app"
SRC="$PROJECT/node_modules/electron/dist/Electron.app"

[ -d "$SRC" ] || { echo "Electron runtime missing — run npm install first"; exit 1; }
[ -f "$PROJECT/icon/notes.icns" ] || { echo "icon/notes.icns missing — run build-app.sh once first"; exit 1; }

rm -rf "$DIST"
mkdir -p "$DIST"
ditto "$SRC" "$APP"

APPDIR="$APP/Contents/Resources/app"
mkdir -p "$APPDIR/public"
printf '{ "name": "marknote", "productName": "Marknote", "version": "1.1.1", "main": "main.js" }\n' \
  > "$APPDIR/package.json"
cp "$PROJECT/main.js" "$PROJECT/server.js" "$PROJECT/preload.js" "$PROJECT/AGENTS.md" "$PROJECT/CLAUDE.md" "$APPDIR/"
ditto "$PROJECT/public" "$APPDIR/public"

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

ditto -c -k --keepParent "$APP" "$DIST/Marknote-mac.zip"
echo "Built $APP"
echo "Zip:  $DIST/Marknote-mac.zip ($(du -h "$DIST/Marknote-mac.zip" | cut -f1))"
