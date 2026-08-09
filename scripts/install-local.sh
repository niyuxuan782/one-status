#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PREFIX="${ONE_STATUS_INSTALL_PREFIX:-$HOME/.local}"

cd "$ROOT"
pnpm build
cargo build --manifest-path apps/device-sidecar/Cargo.toml --locked --release
mkdir -p "$PREFIX/bin"
install -m 0755 dist/one-status.js "$PREFIX/bin/one-status"
install -m 0755 \
  apps/device-sidecar/target/release/one-status-device-sidecar \
  "$PREFIX/bin/one-status-device-sidecar"
mkdir -p "$PREFIX/share/one-status/licenses/cc-switch"
install -m 0644 apps/device-sidecar/THIRD_PARTY_NOTICES.md \
  "$PREFIX/share/one-status/THIRD_PARTY_NOTICES.device-sidecar.md"
install -m 0644 apps/device-sidecar/third_party/cc-switch/LICENSE \
  "$PREFIX/share/one-status/licenses/cc-switch/LICENSE"

printf 'Installed One Status and Device Sidecar to %s\n' "$PREFIX/bin"
printf 'Run: %s version\n' "$PREFIX/bin/one-status"
