#!/usr/bin/env bash
set -euo pipefail

ROOT="${ONE_STATUS_DEPLOY_ROOT:-/opt/one-status}"
ENV_FILE="${ONE_STATUS_PRODUCTION_ENV:-$ROOT/shared/production.env}"
COMPOSE_FILE="$ROOT/current/deploy/compose.production.yaml"
DATA_DIR="${ONE_STATUS_DATA_DIR:-$ROOT/shared/data}"
BACKUP_DIR="${ONE_STATUS_BACKUP_DIR:-$ROOT/shared/backups}"
RETENTION_DAYS="${ONE_STATUS_BACKUP_RETENTION_DAYS:-14}"
TIMESTAMP="$(date -u +%Y%m%dT%H%M%SZ)"
ARCHIVE="$BACKUP_DIR/one-status-$TIMESTAMP.tar.gz"
STAGE="$BACKUP_DIR/.backup-$TIMESTAMP"

mkdir -p "$BACKUP_DIR"
chmod 0700 "$BACKUP_DIR"
exec 9>"$BACKUP_DIR/.backup.lock"
flock -n 9 || exit 0

COMPOSE_RUNNER="${ONE_STATUS_COMPOSE_RUNNER:-/usr/local/sbin/one-status-compose}"
compose=("$COMPOSE_RUNNER" --env-file "$ENV_FILE" -f "$COMPOSE_FILE")
restart_api=true
cleanup() {
  rm -rf "$STAGE"
  if [[ "$restart_api" == true ]]; then
    "${compose[@]}" start api >/dev/null
  fi
}
trap cleanup EXIT

"${compose[@]}" stop api >/dev/null
mkdir -m 0700 "$STAGE"
sqlite3 "$DATA_DIR/one-status.sqlite" ".backup '$STAGE/one-status.sqlite'"
"${compose[@]}" exec -T postgres \
  pg_dump -U one_status -d one_status_vault --format=custom \
  > "$STAGE/cloud-vault.dump"
chmod 0600 "$STAGE/one-status.sqlite" "$STAGE/cloud-vault.dump"
tar -czf "$ARCHIVE.tmp" -C "$STAGE" one-status.sqlite cloud-vault.dump
chmod 0600 "$ARCHIVE.tmp"
mv "$ARCHIVE.tmp" "$ARCHIVE"
"${compose[@]}" start api >/dev/null
restart_api=false

find "$BACKUP_DIR" -type f -name 'one-status-*.tar.gz' \
  -mtime "+$RETENTION_DAYS" -delete
printf '%s\n' "$ARCHIVE"
