#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PREFIX="${ONE_STATUS_INSTALL_PREFIX:-$HOME/.local}"

cd "$ROOT"
pnpm build
mkdir -p "$PREFIX/bin"
install -m 0755 dist/one-status.js "$PREFIX/bin/one-status"

printf 'Installed One Status to %s\n' "$PREFIX/bin/one-status"
printf 'Run: %s version\n' "$PREFIX/bin/one-status"

