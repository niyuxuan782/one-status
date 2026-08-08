#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TAP_DIR="${ONE_STATUS_LOCAL_TAP_DIR:-$HOME/.cache/one-status/homebrew-local}"
VERSION="$(node -p "require('$ROOT/package.json').version")"
SERVICE_WAS_STARTED=false
SERVICE_PLIST="$HOME/Library/LaunchAgents/homebrew.mxcl.one-status.plist"

if [[ -f "$SERVICE_PLIST" ]] || \
  brew services list 2>/dev/null | awk '$1 == "one-status" && $2 == "started" { found = 1 } END { exit !found }'; then
  SERVICE_WAS_STARTED=true
fi

cd "$ROOT"
pnpm release:prepare

mkdir -p "$TAP_DIR/Formula" "$TAP_DIR/dist"
cp "$ROOT/dist/one-status-$VERSION.tgz" "$TAP_DIR/dist/one-status-$VERSION.tgz"
node "$ROOT/scripts/make-local-formula.mjs" \
  "$ROOT/Formula/one-status.rb" \
  "$TAP_DIR/Formula/one-status.rb" \
  "$TAP_DIR/dist/one-status-$VERSION.tgz"

if [[ ! -d "$TAP_DIR/.git" ]]; then
  git init "$TAP_DIR"
  git -C "$TAP_DIR" config user.name "One Status Local Tap"
  git -C "$TAP_DIR" config user.email "local-tap@one-status.invalid"
fi

git -C "$TAP_DIR" add Formula/one-status.rb "dist/one-status-$VERSION.tgz"
if ! git -C "$TAP_DIR" diff --cached --quiet; then
  git -C "$TAP_DIR" commit -m "one-status $VERSION"
fi

if [[ "$SERVICE_WAS_STARTED" == true ]]; then
  brew services stop one-status/local/one-status
fi
if brew list --formula one-status >/dev/null 2>&1; then
  brew uninstall one-status/local/one-status
fi
if brew tap | grep -qx "one-status/local"; then
  brew untap one-status/local
fi
brew tap one-status/local "$TAP_DIR"
brew install one-status/local/one-status

one-status version
# Homebrew cleanup may remove the original file:// source artifact. Restore the
# verified tap copy so the repository keeps its npm release deliverable.
cp "$TAP_DIR/dist/one-status-$VERSION.tgz" \
  "$ROOT/dist/one-status-$VERSION.tgz"
if [[ "$SERVICE_WAS_STARTED" == true ]]; then
  brew services start one-status/local/one-status
  for attempt in {1..30}; do
    if curl --noproxy '*' --connect-timeout 1 --max-time 2 -fsS \
      http://127.0.0.1:8787/health >/dev/null 2>&1; then
      printf 'One Status service is healthy at http://127.0.0.1:8787\n'
      exit 0
    fi
    sleep 1
  done
  printf 'One Status service did not become healthy after reinstall.\n' >&2
  exit 1
fi
