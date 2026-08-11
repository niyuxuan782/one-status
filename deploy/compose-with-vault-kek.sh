#!/usr/bin/env bash
set -euo pipefail

ROOT="${ONE_STATUS_DEPLOY_ROOT:-/opt/one-status}"
KEK_FILE="$ROOT/shared/secrets/vault-kek"
vault_kek=""

if [[ -e "$KEK_FILE" ]]; then
  metadata="$(stat -c '%u:%g:%a:%s' "$KEK_FILE")"
  if [[ "$metadata" != "0:0:600:43" ]]; then
    printf 'Vault KEK must be root:root, mode 0600, and exactly 43 bytes.\n' >&2
    exit 70
  fi
  vault_kek="$(< "$KEK_FILE")"
  if [[ ! "$vault_kek" =~ ^[A-Za-z0-9_-]{43}$ ]]; then
    printf 'Vault KEK has an invalid encoding.\n' >&2
    exit 71
  fi
fi

export ONE_STATUS_VAULT_KEK="$vault_kek"
exec docker compose "$@"
