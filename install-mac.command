#!/bin/bash
# Installs the LuckyTwitch Markers CEP panel on macOS: no Creative Cloud app needed.
#   ./install-mac.command              install / update
#   ./install-mac.command --uninstall  remove the panel (the PlayerDebugMode flag stays on)
# Double-click it in Finder, or run it in Terminal:  bash install-mac.command
# Source layout (relative to this script):  cep-panel/ (CSXS, js, jsx, index.html, .debug)  +  src/*.js (shared code, copied into the panel's shared/)
set -e
HERE="$(cd "$(dirname "$0")" && pwd)"
ID="com.luckytwitch.markers"
OLD_ID="com.luckytwitch.ceptest"   # the panel's old id (test builds): removed on install so Premiere does not list two panels
EXT="$HOME/Library/Application Support/Adobe/CEP/extensions"
TARGET="$EXT/$ID"
PANEL="$HERE/cep-panel"
SHARED="$HERE/src"

if [ -d "$EXT/$OLD_ID" ]; then echo "Removing the old test panel $EXT/$OLD_ID"; rm -rf "$EXT/$OLD_ID"; fi
if [ -d "$TARGET" ]; then echo "Removing $TARGET"; rm -rf "$TARGET"; fi
if [ "$1" = "--uninstall" ] || [ "$1" = "-Uninstall" ]; then echo "Uninstalled. Restart Premiere Pro."; exit 0; fi

# Everything that must exist before we copy anything: fail loudly instead of installing half a panel.
for f in "$PANEL/CSXS/manifest.xml" "$PANEL/index.html" "$PANEL/js/runner.js" "$PANEL/js/ui.js" "$PANEL/jsx/host.jsx" \
         "$SHARED/timecode.js" "$SHARED/markers-core.js" "$SHARED/guard.js" "$SHARED/progress.js"; do
  if [ ! -f "$f" ]; then echo "Missing source file: $f" >&2; exit 1; fi
done

# Allow unsigned panels. Set for several CEP versions so it works whichever one your Premiere reads.
for v in 9 10 11 12 13 14; do defaults write "com.adobe.CSXS.$v" PlayerDebugMode 1; done
killall cfprefsd 2>/dev/null || true
echo "Unsigned panels allowed (PlayerDebugMode = 1 for CSXS.9 to CSXS.14)."

mkdir -p "$TARGET/shared"
cp -R "$PANEL/CSXS" "$PANEL/js" "$PANEL/jsx" "$TARGET/"
cp "$PANEL/index.html" "$TARGET/"
if [ "$1" = "--dev" ] && [ -f "$PANEL/.debug" ]; then
  cp "$PANEL/.debug" "$TARGET/.debug"
fi
cp "$SHARED"/*.js "$TARGET/shared/"

# Verify what actually landed.
for rel in CSXS/manifest.xml index.html js/runner.js js/ui.js jsx/host.jsx shared/timecode.js shared/markers-core.js shared/guard.js shared/progress.js; do
  if [ ! -f "$TARGET/$rel" ]; then echo "Install check failed: $rel is not in $TARGET" >&2; exit 1; fi
done
# A broken manifest makes Premiere hide the panel without any error: check it is complete before saying "installed".
if ! tail -c 200 "$TARGET/CSXS/manifest.xml" | grep -q "</ExtensionManifest>"; then echo "Install check failed: CSXS/manifest.xml is cut off. The package is broken." >&2; exit 1; fi
echo "manifest.xml OK."
echo "Installed to $TARGET"

if pgrep -x "Adobe Premiere Pro" >/dev/null 2>&1; then
  echo "Premiere Pro is running: close it and open it again."
else
  echo "Start Premiere Pro and open Window > Extensions > LuckyTwitch Markers."
fi
echo "Debugger (optional): open http://localhost:8099 in Chrome while the panel is open."
