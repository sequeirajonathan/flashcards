#!/bin/bash
# flashcards-sync.sh — Pull latest from GitHub and redeploy if anything changed.
# Runs as a systemd user timer (see README). Safe to run by hand too.
set -u

cd "$HOME/flashcards" || exit 1

BEFORE=$(git rev-parse HEAD 2>/dev/null) || exit 1

# --ff-only: never merge, never clobber local changes. Fails quietly offline.
if ! git pull --ff-only --quiet 2>/dev/null; then
  exit 0
fi

AFTER=$(git rev-parse HEAD)

if [ "$BEFORE" = "$AFTER" ]; then
  exit 0 # nothing new
fi

echo "flashcards: $BEFORE -> $AFTER, redeploying"
npm install --omit=dev --no-audit --no-fund
systemctl --user restart flashcards
