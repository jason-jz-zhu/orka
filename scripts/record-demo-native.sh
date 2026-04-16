#!/bin/bash
# Record Orka demo using macOS native screen recording.
# Prerequisites: Orka must be running (npm run tauri dev)
#
# Usage: ./scripts/record-demo-native.sh
#
# Output: demo-output/orka-demo-native.mov

set -e

OUT="demo-output"
mkdir -p "$OUT"

echo "🎬 Orka Native Demo Recording"
echo ""
echo "This will:"
echo "  1. Find the Orka window"
echo "  2. Start screen recording"
echo "  3. Automate UI clicks via AppleScript"
echo "  4. Stop recording after ~40s"
echo ""
echo "⚠️  Keep your hands off the mouse/keyboard during recording!"
echo ""
read -p "Press Enter to start (make sure Orka is open)..."

# Get Orka window ID
WINDOW_ID=$(osascript -e '
tell application "System Events"
  set orkaPID to (unix id of processes whose name contains "Orka")
  if (count of orkaPID) = 0 then
    error "Orka is not running"
  end if
end tell
return first item of orkaPID
' 2>/dev/null || echo "")

if [ -z "$WINDOW_ID" ]; then
  echo "❌ Orka window not found. Make sure 'npm run tauri dev' is running."
  exit 1
fi

echo "✅ Found Orka (PID: $WINDOW_ID)"

# Bring Orka to front
osascript -e '
tell application "System Events"
  set frontmost of (first process whose unix id is '$WINDOW_ID') to true
end tell
'
sleep 1

# Start screen recording of the entire screen
RECORDING="$OUT/orka-demo-native.mov"
echo "🔴 Recording started..."
screencapture -v "$RECORDING" &
RECORD_PID=$!
sleep 2

# --- Automated UI actions via AppleScript ---

# Scene 1: We're on Studio tab (should already be there)
echo "  📍 Scene 1: Studio overview (2s)"
sleep 2

# Scene 2: Click + Agent button
echo "  📍 Scene 2: Click + Agent"
osascript -e '
tell application "System Events"
  tell process "Orka"
    -- Click the + Agent button area (approximate position)
    click at {620, 22}
  end tell
end tell
' 2>/dev/null || true
sleep 2

# Scene 3: Click + Agent again
echo "  📍 Scene 3: Click + Agent again"
osascript -e '
tell application "System Events"
  tell process "Orka"
    click at {620, 22}
  end tell
end tell
' 2>/dev/null || true
sleep 2

# Scene 4: Click + Output
echo "  📍 Scene 4: Click + Output"
osascript -e '
tell application "System Events"
  tell process "Orka"
    click at {780, 22}
  end tell
end tell
' 2>/dev/null || true
sleep 2

# Scene 5: Pause on canvas
echo "  📍 Scene 5: Canvas with nodes (3s)"
sleep 3

# Scene 6: Click Runs tab
echo "  📍 Scene 6: Runs tab"
osascript -e '
tell application "System Events"
  tell process "Orka"
    click at {430, 22}
  end tell
end tell
' 2>/dev/null || true
sleep 3

# Scene 7: Click Live tab
echo "  📍 Scene 7: Live tab"
osascript -e '
tell application "System Events"
  tell process "Orka"
    click at {310, 22}
  end tell
end tell
' 2>/dev/null || true
sleep 3

# Scene 8: Back to Studio
echo "  📍 Scene 8: Back to Studio"
osascript -e '
tell application "System Events"
  tell process "Orka"
    click at {370, 22}
  end tell
end tell
' 2>/dev/null || true
sleep 3

# Stop recording
echo "🔴 Stopping recording..."
kill $RECORD_PID 2>/dev/null || true
sleep 2

echo ""
echo "✅ Recording saved: $RECORDING"
echo ""
echo "Post-production tips:"
echo "  1. Open in iMovie or CapCut"
echo "  2. Crop to just the Orka window"
echo "  3. Add text overlays per docs/DEMO-SCRIPT.md"
echo "  4. Speed up waiting sections 2-4x"
echo "  5. Export as MP4, 1080p"
