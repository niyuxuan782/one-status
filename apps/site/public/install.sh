#!/usr/bin/env bash

set -eu

REPOSITORY="niyuxuan782/one-status"
RELEASE_API_URL="${ONE_STATUS_RELEASE_API_URL:-https://niyuxuan782.github.io/one-status/release.json}"
MODE="desktop"
TEMP_DIRECTORY=""
INSTALL_STAGING=""

say() {
  printf 'One Status: %s\n' "$*"
}

fail() {
  printf 'One Status installer error: %s\n' "$*" >&2
  exit 1
}

usage() {
  cat <<'EOF'
Install the latest One Status release.

Usage:
  curl -fsSL https://niyuxuan782.github.io/one-status/install.sh | bash
  curl -fsSL https://niyuxuan782.github.io/one-status/install.sh | bash -s -- --cli

Options:
  --desktop  Install the desktop application (default)
  --cli      Install the one-status CLI
  -h, --help Show this help
EOF
}

cleanup() {
  if [ -n "$INSTALL_STAGING" ]; then
    rm -rf -- "$INSTALL_STAGING"
  fi
  if [ -n "$TEMP_DIRECTORY" ] && [ -d "$TEMP_DIRECTORY" ]; then
    rm -rf -- "$TEMP_DIRECTORY"
  fi
}

stop_on_signal() {
  trap - EXIT HUP INT TERM
  cleanup
  exit 1
}

trap cleanup EXIT
trap stop_on_signal HUP INT TERM

while [ "$#" -gt 0 ]; do
  case "$1" in
    --desktop)
      MODE="desktop"
      ;;
    --cli)
      MODE="cli"
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      fail "unknown option: $1 (use --help for usage)"
      ;;
  esac
  shift
done

command -v curl >/dev/null 2>&1 || fail "curl is required. Install curl and run this command again."

TEMP_DIRECTORY="$(mktemp -d "${TMPDIR:-/tmp}/one-status.XXXXXX")" || fail "could not create a temporary directory."
RELEASE_JSON="$TEMP_DIRECTORY/release.json"

say "checking the latest One Status release..."
if ! curl --fail --location --silent --show-error \
  --header "Accept: application/vnd.github+json" \
  --header "User-Agent: One-Status-Installer" \
  "$RELEASE_API_URL" \
  --output "$RELEASE_JSON"; then
  fail "could not read the One Status release manifest. Check your network connection and try again."
fi

TAG="$(grep -Eo '"tag_name"[[:space:]]*:[[:space:]]*"[^"]*"' "$RELEASE_JSON" | sed -n 's/^"tag_name"[[:space:]]*:[[:space:]]*"\([^"]*\)"$/\1/p' | head -n 1)"
if ! printf '%s\n' "$TAG" | grep -Eq '^v[0-9]+(\.[0-9]+){2}([.+-][0-9A-Za-z.-]+)?$'; then
  fail "the GitHub latest release response did not contain a valid semantic version tag_name."
fi
VERSION="${TAG#v}"

release_asset_urls() {
  grep -Eo '"browser_download_url"[[:space:]]*:[[:space:]]*"[^"]*"' "$RELEASE_JSON" |
    sed -n 's/^"browser_download_url"[[:space:]]*:[[:space:]]*"\([^"]*\)"$/\1/p'
}

release_filename() {
  url_without_query="${1%%\?*}"
  encoded_name="${url_without_query##*/}"
  printf '%s\n' "$encoded_name" | sed 's/%20/ /g; s/%2[Bb]/+/g'
}

find_exact_asset() {
  wanted_name="$1"
  release_asset_urls | while IFS= read -r asset_url; do
    asset_name="$(release_filename "$asset_url")"
    if [ "$asset_name" = "$wanted_name" ]; then
      printf '%s\n' "$asset_url"
      break
    fi
  done
}

normalized_architecture() {
  case "$(uname -m 2>/dev/null || true)" in
    arm64|aarch64) printf '%s\n' "arm64" ;;
    x86_64|amd64) printf '%s\n' "x64" ;;
    *) fail "unsupported CPU architecture: $(uname -m 2>/dev/null || printf unknown)" ;;
  esac
}

desktop_asset_matches() {
  candidate_name="$1"
  platform="$2"
  architecture="$3"
  require_explicit_architecture="$4"
  lower_name="$(printf '%s' "$candidate_name" | tr '[:upper:]' '[:lower:]')"

  case "$lower_name" in
    *one-status*|*one_status*|*one\ status*) ;;
    *) return 1 ;;
  esac

  case "$platform" in
    mac)
      case "$lower_name" in *.zip) ;; *) return 1 ;; esac
      case "$lower_name" in *mac*|*darwin*|*osx*) ;; *) return 1 ;; esac
      ;;
    linux)
      case "$lower_name" in *.appimage) ;; *) return 1 ;; esac
      ;;
    *) return 1 ;;
  esac

  case "$architecture" in
    arm64)
      case "$lower_name" in *arm64*|*aarch64*) return 0 ;; *) return 1 ;; esac
      ;;
    x64)
      case "$lower_name" in
        *arm64*|*aarch64*) return 1 ;;
        *x64*|*x86_64*|*amd64*) return 0 ;;
      esac
      [ "$require_explicit_architecture" = "no" ]
      ;;
  esac
}

find_desktop_asset() {
  platform="$1"
  architecture="$2"
  for explicit_architecture in yes no; do
    if [ "$architecture" != "x64" ] && [ "$explicit_architecture" = "no" ]; then
      continue
    fi
    found_asset="$(release_asset_urls | while IFS= read -r asset_url; do
      asset_name="$(release_filename "$asset_url")"
      if desktop_asset_matches "$asset_name" "$platform" "$architecture" "$explicit_architecture"; then
        printf '%s\n' "$asset_url"
        break
      fi
    done)"
    if [ -n "$found_asset" ]; then
      printf '%s\n' "$found_asset"
      return 0
    fi
  done
  return 1
}

download_file() {
  source_url="$1"
  destination="$2"
  if ! curl --fail --location --silent --show-error \
    --header "Accept: application/octet-stream" \
    --header "User-Agent: One-Status-Installer" \
    "$source_url" \
    --output "$destination"; then
    fail "download failed: $(release_filename "$source_url")"
  fi
}

sha256_of() {
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$1" | awk '{print $1}'
  elif command -v shasum >/dev/null 2>&1; then
    shasum -a 256 "$1" | awk '{print $1}'
  else
    fail "sha256sum or shasum is required to verify the download."
  fi
}

verify_checksum() {
  downloaded_file="$1"
  release_name="$2"
  checksum_file="$3"
  expected_hash="$(awk -v filename="$release_name" '
    {
      hash = $1
      name = $0
      sub(/^[^[:space:]]+[[:space:]]+[*]?/, "", name)
      if (name == filename) print hash
    }
  ' "$checksum_file")"

  case "$expected_hash" in
    *$'\n'*) fail "SHA256SUMS.txt contains duplicate entries for $release_name." ;;
  esac
  case "$expected_hash" in
    ""|*[!0-9a-fA-F]*) fail "SHA256SUMS.txt has no valid entry for $release_name." ;;
  esac
  if [ "${#expected_hash}" -ne 64 ]; then
    fail "SHA256SUMS.txt has an invalid hash for $release_name."
  fi

  actual_hash="$(sha256_of "$downloaded_file" | tr '[:upper:]' '[:lower:]')"
  expected_hash="$(printf '%s' "$expected_hash" | tr '[:upper:]' '[:lower:]')"
  if [ "$actual_hash" != "$expected_hash" ]; then
    fail "checksum verification failed for $release_name. The downloaded file was not installed."
  fi
  say "verified SHA-256 for $release_name"
}

CHECKSUM_URL="$(find_exact_asset "SHA256SUMS.txt")"
[ -n "$CHECKSUM_URL" ] || fail "release $TAG does not contain SHA256SUMS.txt; installation has been stopped."
CHECKSUM_FILE="$TEMP_DIRECTORY/SHA256SUMS.txt"
download_file "$CHECKSUM_URL" "$CHECKSUM_FILE"

if [ "$MODE" = "cli" ]; then
  command -v node >/dev/null 2>&1 || fail "CLI installation requires Node.js 22 or newer. Install Node.js and run with --cli again."
  NODE_VERSION="$(node --version 2>/dev/null || true)"
  NODE_MAJOR="$(printf '%s' "$NODE_VERSION" | sed -n 's/^v\([0-9][0-9]*\).*/\1/p')"
  if [ -z "$NODE_MAJOR" ] || [ "$NODE_MAJOR" -lt 22 ]; then
    fail "CLI installation requires Node.js 22 or newer; found ${NODE_VERSION:-an unreadable version}."
  fi

  ASSET_NAME="one-status-${VERSION}.tgz"
  ASSET_URL="$(find_exact_asset "$ASSET_NAME")"
  [ -n "$ASSET_URL" ] || fail "release $TAG does not contain $ASSET_NAME."
  ARCHIVE="$TEMP_DIRECTORY/$ASSET_NAME"
  download_file "$ASSET_URL" "$ARCHIVE"
  verify_checksum "$ARCHIVE" "$ASSET_NAME" "$CHECKSUM_FILE"

  command -v tar >/dev/null 2>&1 || fail "tar is required to install the CLI."
  if ! tar -tzf "$ARCHIVE" | grep -qx 'package/dist/one-status.js'; then
    fail "$ASSET_NAME does not contain package/dist/one-status.js."
  fi

  OPERATING_SYSTEM="$(uname -s 2>/dev/null || true)"
  ARCHITECTURE="$(normalized_architecture)"
  case "$OPERATING_SYSTEM" in
    Darwin) SIDECAR_PLATFORM="mac" ;;
    Linux) SIDECAR_PLATFORM="linux" ;;
    *) fail "CLI installation supports macOS and Linux here. On Windows, use install.ps1 -Cli." ;;
  esac
  SIDECAR_ASSET_NAME="one-status-device-sidecar-${VERSION}-${SIDECAR_PLATFORM}-${ARCHITECTURE}.tar.gz"
  SIDECAR_ASSET_URL="$(find_exact_asset "$SIDECAR_ASSET_NAME")"
  [ -n "$SIDECAR_ASSET_URL" ] || fail "release $TAG does not contain $SIDECAR_ASSET_NAME for this device."
  SIDECAR_ARCHIVE="$TEMP_DIRECTORY/$SIDECAR_ASSET_NAME"
  download_file "$SIDECAR_ASSET_URL" "$SIDECAR_ARCHIVE"
  verify_checksum "$SIDECAR_ARCHIVE" "$SIDECAR_ASSET_NAME" "$CHECKSUM_FILE"
  if ! tar -tzf "$SIDECAR_ARCHIVE" | sed 's#^\./##' | grep -qx 'one-status-device-sidecar'; then
    fail "$SIDECAR_ASSET_NAME does not contain one-status-device-sidecar."
  fi
  if ! tar -tzf "$SIDECAR_ARCHIVE" | sed 's#^\./##' | grep -qx 'THIRD_PARTY_NOTICES.device-sidecar.md'; then
    fail "$SIDECAR_ASSET_NAME does not contain its third-party notice."
  fi
  if ! tar -tzf "$SIDECAR_ARCHIVE" | sed 's#^\./##' | grep -qx 'licenses/cc-switch/LICENSE'; then
    fail "$SIDECAR_ASSET_NAME does not contain the CC Switch license."
  fi

  INSTALL_DIRECTORY="${ONE_STATUS_INSTALL_DIR:-$HOME/.local/bin}"
  mkdir -p "$INSTALL_DIRECTORY"
  INSTALL_STAGING="$INSTALL_DIRECTORY/.one-status-install.tmp.$$"
  rm -rf -- "$INSTALL_STAGING"
  mkdir -m 0700 "$INSTALL_STAGING"
  if ! tar -xOzf "$ARCHIVE" package/dist/one-status.js > "$INSTALL_STAGING/one-status"; then
    fail "could not extract the CLI executable from $ASSET_NAME."
  fi
  if ! tar -xOzf "$SIDECAR_ARCHIVE" one-status-device-sidecar > "$INSTALL_STAGING/one-status-device-sidecar"; then
    fail "could not extract the Device Sidecar from $SIDECAR_ASSET_NAME."
  fi
  chmod 0755 "$INSTALL_STAGING/one-status" "$INSTALL_STAGING/one-status-device-sidecar"
  mv -f -- "$INSTALL_STAGING/one-status-device-sidecar" "$INSTALL_DIRECTORY/one-status-device-sidecar"
  mv -f -- "$INSTALL_STAGING/one-status" "$INSTALL_DIRECTORY/one-status"
  rm -rf -- "$INSTALL_STAGING"
  INSTALL_STAGING=""
  SHARE_DIRECTORY="${ONE_STATUS_SHARE_DIR:-$(dirname "$INSTALL_DIRECTORY")/share/one-status}"
  mkdir -p "$SHARE_DIRECTORY/licenses/cc-switch"
  tar -xOzf "$SIDECAR_ARCHIVE" THIRD_PARTY_NOTICES.device-sidecar.md > \
    "$SHARE_DIRECTORY/THIRD_PARTY_NOTICES.device-sidecar.md"
  tar -xOzf "$SIDECAR_ARCHIVE" licenses/cc-switch/LICENSE > \
    "$SHARE_DIRECTORY/licenses/cc-switch/LICENSE"
  chmod 0644 \
    "$SHARE_DIRECTORY/THIRD_PARTY_NOTICES.device-sidecar.md" \
    "$SHARE_DIRECTORY/licenses/cc-switch/LICENSE"
  say "installed CLI $TAG and Device Sidecar at $INSTALL_DIRECTORY"
  case ":$PATH:" in
    *":$INSTALL_DIRECTORY:"*) ;;
    *) say "add $INSTALL_DIRECTORY to PATH before running one-status." ;;
  esac
  exit 0
fi

OPERATING_SYSTEM="$(uname -s 2>/dev/null || true)"
ARCHITECTURE="$(normalized_architecture)"
case "$OPERATING_SYSTEM" in
  Darwin) PLATFORM="mac" ;;
  Linux) PLATFORM="linux" ;;
  *) fail "desktop installation supports macOS and Linux here. On Windows, use https://niyuxuan782.github.io/one-status/install.ps1." ;;
esac

ASSET_URL="$(find_desktop_asset "$PLATFORM" "$ARCHITECTURE" || true)"
[ -n "$ASSET_URL" ] || fail "release $TAG has no $PLATFORM $ARCHITECTURE desktop package. See https://github.com/$REPOSITORY/releases/tag/$TAG for available files."
ASSET_NAME="$(release_filename "$ASSET_URL")"
if [ "$PLATFORM" = "mac" ]; then
  INSTALL_DIRECTORY="${ONE_STATUS_INSTALL_DIR:-$HOME/Applications}"
  APP_DESTINATION="$INSTALL_DIRECTORY/One Status.app"
else
  INSTALL_DIRECTORY="${ONE_STATUS_INSTALL_DIR:-$HOME/.local/bin}"
  APP_DESTINATION="$INSTALL_DIRECTORY/one-status-app"
fi
say "release: $TAG"
say "asset: $ASSET_NAME"
say "destination: $APP_DESTINATION"
ARCHIVE="$TEMP_DIRECTORY/$ASSET_NAME"
download_file "$ASSET_URL" "$ARCHIVE"
verify_checksum "$ARCHIVE" "$ASSET_NAME" "$CHECKSUM_FILE"

if [ "$PLATFORM" = "mac" ]; then
  command -v unzip >/dev/null 2>&1 || fail "unzip is required to install the macOS application."
  EXTRACT_DIRECTORY="$TEMP_DIRECTORY/app"
  mkdir -p "$EXTRACT_DIRECTORY"
  if ! unzip -q "$ARCHIVE" -d "$EXTRACT_DIRECTORY"; then
    fail "could not extract $ASSET_NAME."
  fi
  APP_SOURCE="$(find "$EXTRACT_DIRECTORY" -type d \( -name 'One Status.app' -o -name 'one-status.app' \) -prune | head -n 1)"
  [ -n "$APP_SOURCE" ] || fail "$ASSET_NAME does not contain a supported One Status app bundle."
  BUNDLE_IDENTIFIER="$(/usr/libexec/PlistBuddy -c 'Print :CFBundleIdentifier' "$APP_SOURCE/Contents/Info.plist" 2>/dev/null || true)"
  [ "$BUNDLE_IDENTIFIER" = "top.furesta.onestatus" ] || fail "$ASSET_NAME contains an unexpected app bundle identifier."

  INSTALL_STAGING="$INSTALL_DIRECTORY/.One Status.app.tmp.$$"
  mkdir -p "$INSTALL_DIRECTORY"
  rm -rf -- "$INSTALL_STAGING"
  cp -R "$APP_SOURCE" "$INSTALL_STAGING"

  command -v codesign >/dev/null 2>&1 || fail "codesign is required to verify the macOS application."
  command -v xattr >/dev/null 2>&1 || fail "xattr is required to preserve macOS Gatekeeper enforcement."
  PRESERVE_QUARANTINE="no"
  if codesign -dv --verbose=4 "$INSTALL_STAGING" 2>&1 | grep -Eq '^Authority=Developer ID Application:'; then
    if ! codesign --verify --deep --strict "$INSTALL_STAGING"; then
      fail "the Apple Developer ID signature is invalid; installation has been stopped."
    fi
    SIGNATURE_DESCRIPTION="Apple Developer ID signature verified"
    if command -v spctl >/dev/null 2>&1 &&
      command -v xcrun >/dev/null 2>&1 &&
      spctl --assess --type execute "$INSTALL_STAGING" >/dev/null 2>&1 &&
      xcrun stapler validate "$INSTALL_STAGING" >/dev/null 2>&1; then
      PRESERVE_QUARANTINE="yes"
      LAUNCH_DESCRIPTION="Gatekeeper and notarization checks passed; quarantine preserved"
    else
      LAUNCH_DESCRIPTION="notarization checks did not pass; quarantine was not added"
    fi
  else
    if ! xattr -cr "$INSTALL_STAGING"; then
      fail "could not remove unsupported Finder metadata from the macOS preview build."
    fi
    if ! codesign --force --deep --sign - "$INSTALL_STAGING"; then
      fail "could not apply a local ad-hoc signature to the macOS preview build."
    fi
    if ! codesign --verify --deep --strict "$INSTALL_STAGING"; then
      fail "the local ad-hoc signature could not be verified; installation has been stopped."
    fi
    SIGNATURE_DESCRIPTION="local ad-hoc signature applied (preview build; not notarized)"
    LAUNCH_DESCRIPTION="SHA-256 and Bundle ID verified; quarantine was not added to the preview build"
  fi

  if [ "$PRESERVE_QUARANTINE" = "yes" ]; then
    QUARANTINE_TIMESTAMP="$(printf '%x' "$(date +%s)")"
    if ! xattr -w com.apple.quarantine "0081;$QUARANTINE_TIMESTAMP;One Status Installer;" "$INSTALL_STAGING"; then
      fail "could not apply the macOS quarantine attribute; installation has been stopped."
    fi
  fi
  rm -rf -- "$APP_DESTINATION"
  mv "$INSTALL_STAGING" "$APP_DESTINATION"
  INSTALL_STAGING=""
  say "installed desktop $TAG at $APP_DESTINATION"
  say "signature: $SIGNATURE_DESCRIPTION"
  say "launch trust: $LAUNCH_DESCRIPTION"
else
  mkdir -p "$INSTALL_DIRECTORY"
  INSTALL_STAGING="$INSTALL_DIRECTORY/.one-status-app.tmp.$$"
  cp "$ARCHIVE" "$INSTALL_STAGING"
  chmod 0755 "$INSTALL_STAGING"
  mv -f -- "$INSTALL_STAGING" "$APP_DESTINATION"
  INSTALL_STAGING=""
  say "installed desktop $TAG at $APP_DESTINATION"
  case ":$PATH:" in
    *":$INSTALL_DIRECTORY:"*) ;;
    *) say "add $INSTALL_DIRECTORY to PATH before running one-status-app." ;;
  esac
  say "run one-status-app to open the GUI."
fi
