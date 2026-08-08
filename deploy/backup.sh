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

mkdir -p "$BACKUP_DIR"
chmod 0700 "$BACKUP_DIR"
exec 9>"$BACKUP_DIR/.backup.lock"
flock -n 9 || exit 0

compose=(docker compose --env-file "$ENV_FILE" -f "$COMPOSE_FILE")
restart_api=true
cleanup() {
  if [[ "$restart_api" == true ]]; then
    "${compose[@]}" start api >/dev/null
  fi
}
trap cleanup EXIT

"${compose[@]}" stop api >/dev/null
tar -czf "$ARCHIVE.tmp" -C "$DATA_DIR" \
  one-status.sqlite \
  --wildcards 'one-status.sqlite-*' 2>/dev/null || {
    tar -czf "$ARCHIVE.tmp" -C "$DATA_DIR" one-status.sqlite
  }
chmod 0600 "$ARCHIVE.tmp"
mv "$ARCHIVE.tmp" "$ARCHIVE"
"${compose[@]}" start api >/dev/null
restart_api=false

find "$BACKUP_DIR" -type f -name 'one-status-*.tar.gz' \
  -mtime "+$RETENTION_DAYS" -delete
printf '%s\n' "$ARCHIVE"
