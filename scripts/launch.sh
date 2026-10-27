#!/bin/zsh
# Quick launcher for the Harness Editor.
# Rebuilds (typecheck + bundle) only when sources changed since the last build,
# then starts Electron on the built output. Double-click entry point is
# "Harness Editor.app" (a thin wrapper that execs this script), so launch logic
# stays in git. Logs: /tmp/harness-editor-launch.log
set -u
export PATH="/opt/homebrew/bin:$PATH"

REPO="${0:A:h:h}"   # this script lives in <repo>/scripts/
LOG=/tmp/harness-editor-launch.log
cd "$REPO" || exit 1

BUILT=out/main/index.js
needs_build=0
if [ ! -f "$BUILT" ]; then
  needs_build=1
elif [ -n "$(find src package.json electron.vite.config.ts -newer "$BUILT" -print -quit 2>/dev/null)" ]; then
  needs_build=1
fi

if [ "$needs_build" -eq 1 ]; then
  osascript -e 'display notification "Sources changed — rebuilding (10–30 s)…" with title "Harness Editor"' >/dev/null 2>&1
  if ! npm run build >"$LOG" 2>&1; then
    osascript -e 'display alert "Harness Editor build failed" message "See /tmp/harness-editor-launch.log — launch from a terminal to debug."' >/dev/null 2>&1
    exit 1
  fi
fi

exec npx electron . >>"$LOG" 2>&1
