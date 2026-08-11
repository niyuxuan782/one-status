#!/usr/bin/env bash
set -euo pipefail

ROOT="${ONE_STATUS_DEPLOY_ROOT:-/opt/one-status}"
KEK_FILE="$ROOT/shared/secrets/vault-kek"
MOUNT_DIRECTORY="$ROOT/shared/secrets/runtime"
MOUNT_FILE="$MOUNT_DIRECTORY/vault-kek"

install -d -o root -g root -m 0700 "$MOUNT_DIRECTORY"

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
else
  vault_kek=""
fi

temporary="$MOUNT_DIRECTORY/.vault-kek.$$"
printf '%s' "$vault_kek" > "$temporary"
chown 1000:1000 "$temporary"
chmod 0400 "$temporary"
mv -f "$temporary" "$MOUNT_FILE"
if [[ "$(stat -c '%u:%g:%a:%s' "$MOUNT_FILE")" != "1000:1000:400:${#vault_kek}" ]]; then
  printf 'Vault container Secret has invalid ownership or permissions.\n' >&2
  exit 72
fi

unset vault_kek
export ONE_STATUS_VAULT_KEK_MOUNT_FILE="$MOUNT_FILE"
exec docker compose "$@"
