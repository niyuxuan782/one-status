#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TAP_DIR="${ONE_STATUS_LOCAL_TAP_DIR:-$HOME/.cache/one-status/homebrew-local}"
VERSION="$(node -p "require('$ROOT/package.json').version")"
SERVICE_WAS_STARTED=false
SERVICE_PLIST="$HOME/Library/LaunchAgents/homebrew.mxcl.one-status.plist"
INSTALLED_FORMULA="$(
  brew list --formula --full-name 2>/dev/null |
    awk '$0 == "one-status" || $0 ~ /\/one-status$/ { print; exit }'
)"

if [[ -f "$SERVICE_PLIST" ]] || \
  brew services list 2>/dev/null | awk '$1 == "one-status" && $2 == "started" { found = 1 } END { exit !found }'; then
  SERVICE_WAS_STARTED=true
fi

cd "$ROOT"
pnpm release:prepare
cargo build --manifest-path apps/device-sidecar/Cargo.toml --locked --release

mkdir -p "$TAP_DIR/Formula" "$TAP_DIR/dist"
rm -f "$TAP_DIR/dist"/one-status-device-sidecar-*.tar.gz
cp "$ROOT/dist/one-status-$VERSION.tgz" "$TAP_DIR/dist/one-status-$VERSION.tgz"
case "$(uname -s)" in
  Darwin) SIDECAR_PLATFORM="mac" ;;
  Linux) SIDECAR_PLATFORM="linux" ;;
  *) printf 'Unsupported Homebrew host: %s\n' "$(uname -s)" >&2; exit 1 ;;
esac
case "$(uname -m)" in
  arm64|aarch64) SIDECAR_ARCH="arm64" ;;
  x86_64|amd64) SIDECAR_ARCH="x64" ;;
  *) printf 'Unsupported Homebrew architecture: %s\n' "$(uname -m)" >&2; exit 1 ;;
esac
if [[ "$SIDECAR_PLATFORM" == "linux" && "$SIDECAR_ARCH" != "x64" ]]; then
  printf 'Linux Homebrew Device Sidecar currently supports x64.\n' >&2
  exit 1
fi

node "$ROOT/scripts/package-device-sidecar.mjs" \
  --platform "$SIDECAR_PLATFORM" \
  --arch "$SIDECAR_ARCH" \
  --binary "$ROOT/apps/device-sidecar/target/release/one-status-device-sidecar" \
  --output "$TAP_DIR/dist"
CURRENT_SIDECAR="one-status-device-sidecar-$VERSION-$SIDECAR_PLATFORM-$SIDECAR_ARCH.tar.gz"
for target in mac-arm64 mac-x64 linux-x64; do
  candidate="one-status-device-sidecar-$VERSION-$target.tar.gz"
  if [[ ! -f "$TAP_DIR/dist/$candidate" ]]; then
    cp "$TAP_DIR/dist/$CURRENT_SIDECAR" "$TAP_DIR/dist/$candidate"
  fi
done
LOCAL_RELEASE_URL="$(node -e 'const { pathToFileURL } = require("node:url"); console.log(pathToFileURL(process.argv[1]).href)' "$TAP_DIR/dist")"
node "$ROOT/scripts/generate-homebrew-formula.mjs" \
  "$TAP_DIR/dist" \
  "$TAP_DIR/Formula/one-status.rb" \
  "$LOCAL_RELEASE_URL"
for target in mac-arm64 mac-x64 linux-x64; do
  candidate="one-status-device-sidecar-$VERSION-$target.tar.gz"
  if [[ "$candidate" != "$CURRENT_SIDECAR" ]]; then
    rm -f "$TAP_DIR/dist/$candidate"
  fi
done

if [[ ! -d "$TAP_DIR/.git" ]]; then
  git init "$TAP_DIR"
  git -C "$TAP_DIR" config user.name "One Status Local Tap"
  git -C "$TAP_DIR" config user.email "local-tap@one-status.invalid"
fi

git -C "$TAP_DIR" add Formula/one-status.rb \
  "dist/one-status-$VERSION.tgz" \
  "dist/$CURRENT_SIDECAR"
if ! git -C "$TAP_DIR" diff --cached --quiet; then
  git -C "$TAP_DIR" commit -m "one-status $VERSION"
fi

if [[ "$SERVICE_WAS_STARTED" == true ]]; then
  if [[ -n "$INSTALLED_FORMULA" ]]; then
    brew services stop "$INSTALLED_FORMULA"
  elif [[ -f "$SERVICE_PLIST" ]]; then
    launchctl bootout "gui/$(id -u)" "$SERVICE_PLIST" >/dev/null 2>&1 || true
  fi
fi
if [[ -n "$INSTALLED_FORMULA" ]]; then
  brew uninstall --formula "$INSTALLED_FORMULA"
fi
if brew tap | grep -qx "one-status/local"; then
  brew untap one-status/local
fi
brew tap one-status/local "$TAP_DIR"
brew install one-status/local/one-status
brew link --overwrite one-status/local/one-status

INSTALLED_PREFIX="$(brew --prefix one-status/local/one-status)"
INSTALLED_VERSION="$("$INSTALLED_PREFIX/bin/one-status" version)"
if [[ "$INSTALLED_VERSION" != "$VERSION" ]]; then
  printf 'Installed One Status version mismatch: expected %s, got %s.\n' \
    "$VERSION" "$INSTALLED_VERSION" >&2
  exit 1
fi
printf 'Installed One Status %s at %s\n' "$INSTALLED_VERSION" "$INSTALLED_PREFIX"
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
