#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SSH_HOST="${ONE_STATUS_SSH_HOST:?set ONE_STATUS_SSH_HOST}"
SSH_USER="${ONE_STATUS_SSH_USER:-ubuntu}"
REMOTE_ROOT="${ONE_STATUS_REMOTE_ROOT:-/opt/one-status}"
DOMAIN="${ONE_STATUS_DOMAIN:?set ONE_STATUS_DOMAIN}"
ACME_EMAIL="${ONE_STATUS_ACME_EMAIL:?set ONE_STATUS_ACME_EMAIL}"
SEED_DB="${ONE_STATUS_SEED_DB:-}"
PREBUILT_IMAGES="${ONE_STATUS_PREBUILT_IMAGES:-false}"
PUBLIC_HEALTH_REQUIRED="${ONE_STATUS_PUBLIC_HEALTH_REQUIRED:-true}"
RELEASE_ID="${ONE_STATUS_RELEASE_ID:-$(date -u +%Y%m%dT%H%M%SZ)}"
RELEASE_DIR="$REMOTE_ROOT/releases/$RELEASE_ID"
RELEASE_ENV="$RELEASE_DIR/production.env"
TARGET="$SSH_USER@$SSH_HOST"
CONTROL_PATH="${ONE_STATUS_SSH_CONTROL_PATH:-/tmp/one-status-%C}"
PREVIOUS_RELEASE=""
LOCK_ACQUIRED=false
DEPLOYMENT_STARTED=false
DEPLOYMENT_FINALIZED=false
CURL_RESOLVE_OPTIONS=()
SSH_OPTIONS=(
  -o ControlMaster=auto
  -o ControlPersist=120
  -o "ControlPath=$CONTROL_PATH"
  -o ConnectTimeout=15
  -o ServerAliveInterval=15
)
if [[ -n "${ONE_STATUS_SSH_IDENTITY:-}" ]]; then
  if [[ ! -r "$ONE_STATUS_SSH_IDENTITY" ]]; then
    printf 'SSH identity is not readable: %s\n' "$ONE_STATUS_SSH_IDENTITY" >&2
    exit 1
  fi
  SSH_OPTIONS+=(-o IdentitiesOnly=yes -i "$ONE_STATUS_SSH_IDENTITY")
fi

if [[ ! "$DOMAIN" =~ ^[A-Za-z0-9.-]+$ ]]; then
  printf 'ONE_STATUS_DOMAIN contains unsupported characters.\n' >&2
  exit 1
fi
if [[ ! "$ACME_EMAIL" =~ ^[^[:space:]@]+@[^[:space:]@]+$ ]]; then
  printf 'ONE_STATUS_ACME_EMAIL is invalid.\n' >&2
  exit 1
fi
if [[ ! "$RELEASE_ID" =~ ^[0-9]{8}T[0-9]{6}Z$ ]]; then
  printf 'ONE_STATUS_RELEASE_ID must use YYYYMMDDTHHMMSSZ.\n' >&2
  exit 1
fi
if [[ "$PREBUILT_IMAGES" != true && "$PREBUILT_IMAGES" != false ]]; then
  printf 'ONE_STATUS_PREBUILT_IMAGES must be true or false.\n' >&2
  exit 1
fi
if [[ "$PUBLIC_HEALTH_REQUIRED" != true && "$PUBLIC_HEALTH_REQUIRED" != false ]]; then
  printf 'ONE_STATUS_PUBLIC_HEALTH_REQUIRED must be true or false.\n' >&2
  exit 1
fi
if [[ "$SSH_HOST" =~ ^([0-9]{1,3}\.){3}[0-9]{1,3}$ ]]; then
  CURL_RESOLVE_OPTIONS=(--resolve "$DOMAIN:443:$SSH_HOST")
fi

close_control_master() {
  ssh "${SSH_OPTIONS[@]}" -O exit "$TARGET" >/dev/null 2>&1 || true
}

cleanup() {
  local exit_status=$?
  trap - EXIT
  if [[ "$DEPLOYMENT_STARTED" == true && "$DEPLOYMENT_FINALIZED" != true ]]; then
    printf 'Deployment did not finish; restoring the previous release.\n' >&2
    rollback_release || printf 'Automatic rollback failed; inspect the remote Compose stack.\n' >&2
  fi
  if [[ "$LOCK_ACQUIRED" == true ]]; then
    ssh_run "rm -rf /tmp/one-status-deploy.lock" >/dev/null 2>&1 || true
  fi
  close_control_master
  exit "$exit_status"
}
trap cleanup EXIT

ssh_run() {
  ssh "${SSH_OPTIONS[@]}" "$TARGET" "$@"
}

rollback_release() {
  if [[ -n "$PREVIOUS_RELEASE" ]]; then
    local previous_id
    previous_id="$(basename "$PREVIOUS_RELEASE")"
    printf 'Restoring previous release %s\n' "$previous_id" >&2
    ssh_run "set -e; previous_env='$PREVIOUS_RELEASE/production.env'; test -f \"\$previous_env\"; ln -sfn \"\$previous_env\" '$REMOTE_ROOT/shared/.production.env.rollback.$RELEASE_ID'; mv -Tf '$REMOTE_ROOT/shared/.production.env.rollback.$RELEASE_ID' '$REMOTE_ROOT/shared/production.env'; ln -sfn '$PREVIOUS_RELEASE' '$REMOTE_ROOT/.current.rollback.$RELEASE_ID'; mv -Tf '$REMOTE_ROOT/.current.rollback.$RELEASE_ID' '$REMOTE_ROOT/current'; sudo docker compose --env-file \"\$previous_env\" -f '$PREVIOUS_RELEASE/deploy/compose.production.yaml' up -d --no-build --pull never --remove-orphans --wait --wait-timeout 120"
  else
    printf 'Stopping incomplete first deployment.\n' >&2
    ssh_run "set -e; sudo docker compose --env-file '$RELEASE_ENV' -f '$RELEASE_DIR/deploy/compose.production.yaml' down --remove-orphans || true; if [[ -L '$REMOTE_ROOT/current' && \"\$(readlink -f '$REMOTE_ROOT/current')\" == '$RELEASE_DIR' ]]; then unlink '$REMOTE_ROOT/current'; fi; if [[ -L '$REMOTE_ROOT/shared/production.env' && \"\$(readlink -f '$REMOTE_ROOT/shared/production.env')\" == '$RELEASE_ENV' ]]; then unlink '$REMOTE_ROOT/shared/production.env'; fi" || true
  fi
}

if [[ ! "$REMOTE_ROOT" =~ ^/[A-Za-z0-9._/-]+$ ]]; then
  printf 'ONE_STATUS_REMOTE_ROOT contains unsupported characters.\n' >&2
  exit 1
fi

if ! ssh_run "set -e; lock=/tmp/one-status-deploy.lock; now=\$(date +%s); if mkdir \"\$lock\" 2>/dev/null; then printf '%s\n' \"\$now\" > \"\$lock/created_at\"; exit 0; fi; created=\$(cat \"\$lock/created_at\" 2>/dev/null || printf 0); if (( now - created > 7200 )); then rm -rf \"\$lock\"; mkdir \"\$lock\"; printf '%s\n' \"\$now\" > \"\$lock/created_at\"; exit 0; fi; exit 19"; then
  printf 'Another One Status deployment is already running.\n' >&2
  exit 19
fi
LOCK_ACQUIRED=true

ssh_run "set -e; tcp=\$(sudo ss -H -ltn | grep -E ':(80|443)([[:space:]]|$)' || true); udp=\$(sudo ss -H -lun | grep -E ':443([[:space:]]|$)' || true); if [[ -n \"\$tcp\$udp\" ]]; then if [[ -L '$REMOTE_ROOT/current' ]] && command -v docker >/dev/null 2>&1 && sudo docker ps --filter label=com.docker.compose.project=one-status-cloud --format '{{.Names}}' | grep -q .; then exit 0; fi; printf 'Ports 80 or 443 are already in use by an unmanaged service.\n%s\n%s\n' \"\$tcp\" \"\$udp\" >&2; exit 18; fi"

remote_uid="$(ssh_run "id -u '$SSH_USER'")"
remote_gid="$(ssh_run "id -g '$SSH_USER'")"
if [[ "$remote_uid" != 1000 ]]; then
  printf 'The API image requires deployment UID 1000; remote user is %s:%s.\n' "$remote_uid" "$remote_gid" >&2
  exit 20
fi

ssh_run "set -e; missing=(); command -v docker >/dev/null 2>&1 || missing+=(docker.io); sudo docker compose version >/dev/null 2>&1 || missing+=(docker-compose-v2); command -v sqlite3 >/dev/null 2>&1 || missing+=(sqlite3); if (( \${#missing[@]} )); then sudo apt-get update; sudo DEBIAN_FRONTEND=noninteractive apt-get install -y \"\${missing[@]}\"; fi; sudo systemctl enable --now docker; sudo docker compose version >/dev/null"

ssh_run "set -e; sudo install -d -m 0755 '$REMOTE_ROOT' '$REMOTE_ROOT/releases' '$RELEASE_DIR' '$REMOTE_ROOT/shared'; sudo install -d -m 0700 '$REMOTE_ROOT/shared/data' '$REMOTE_ROOT/shared/backups'; sudo install -d -m 0700 -o root -g root '$REMOTE_ROOT/shared/caddy-data' '$REMOTE_ROOT/shared/caddy-config'; sudo chown '$SSH_USER' '$REMOTE_ROOT' '$REMOTE_ROOT/releases' '$RELEASE_DIR' '$REMOTE_ROOT/shared' '$REMOTE_ROOT/shared/data' '$REMOTE_ROOT/shared/backups'"
PREVIOUS_RELEASE="$(ssh_run "if [[ -L '$REMOTE_ROOT/current' ]]; then readlink -f '$REMOTE_ROOT/current'; fi")"

if [[ -n "$PREVIOUS_RELEASE" ]]; then
  ssh_run "set -e; if [[ ! -f '$PREVIOUS_RELEASE/production.env' ]]; then cp '$REMOTE_ROOT/shared/production.env' '$PREVIOUS_RELEASE/production.env'; chmod 0600 '$PREVIOUS_RELEASE/production.env'; fi"
fi

COPYFILE_DISABLE=1 tar -C "$ROOT" \
  --no-xattrs \
  --exclude='._*' \
  --exclude='.env' \
  --exclude='.env.*' \
  --exclude='*/dist' \
  --exclude='*/node_modules' \
  --exclude='*/release' \
  --exclude='*/target' \
  --exclude='*.key' \
  --exclude='*.pem' \
  --exclude='*.sqlite' \
  --exclude='*.sqlite-*' \
  -czf - \
  Dockerfile LICENSE README.md package.json pnpm-lock.yaml \
  pnpm-workspace.yaml tsconfig.json tsconfig.build.json vitest.config.ts \
  apps packages scripts deploy | ssh_run "set -e; tar -xzf - -C '$RELEASE_DIR'"

ssh_run "set -e
cat > '$RELEASE_ENV' <<EOF
ONE_STATUS_DOMAIN=$DOMAIN
ONE_STATUS_ACME_EMAIL=$ACME_EMAIL
ONE_STATUS_IMAGE_TAG=$RELEASE_ID
ONE_STATUS_DATA_DIR=$REMOTE_ROOT/shared/data
ONE_STATUS_CADDY_DATA_DIR=$REMOTE_ROOT/shared/caddy-data
ONE_STATUS_CADDY_CONFIG_DIR=$REMOTE_ROOT/shared/caddy-config
EOF
chmod 0600 '$RELEASE_ENV'"

if [[ -n "$SEED_DB" ]]; then
  if [[ ! -f "$SEED_DB" ]]; then
    printf 'Seed database was not found: %s\n' "$SEED_DB" >&2
    exit 1
  fi
  if ! ssh_run "test -f '$REMOTE_ROOT/shared/data/one-status.sqlite'"; then
    seed_sha="$(shasum -a 256 "$SEED_DB" | awk '{print $1}')"
    remote_seed="$REMOTE_ROOT/shared/data/.seed-$RELEASE_ID.sqlite.tmp"
    scp "${SSH_OPTIONS[@]}" "$SEED_DB" "$TARGET:$remote_seed"
    if ! ssh_run "set -e; actual_sha=\$(sha256sum '$remote_seed' | awk '{print \$1}'); [[ \"\$actual_sha\" == '$seed_sha' ]]; [[ \"\$(sqlite3 '$remote_seed' 'PRAGMA quick_check;')\" == ok ]]; [[ -z \"\$(sqlite3 '$remote_seed' 'PRAGMA foreign_key_check;')\" ]]; table_count=\$(sqlite3 '$remote_seed' \"SELECT count(*) FROM sqlite_master WHERE type='table' AND name IN ('users','devices','sessions','status_vaults','status_mutation_receipts');\"); [[ \"\$table_count\" == 5 ]]; chmod 0600 '$remote_seed'; mv '$remote_seed' '$REMOTE_ROOT/shared/data/one-status.sqlite'"; then
      ssh_run "rm -f '$remote_seed'" || true
      printf 'Seed database verification failed.\n' >&2
      exit 1
    fi
  fi
fi

if [[ "$PREBUILT_IMAGES" == true ]]; then
  ssh_run "set -e; sudo docker image inspect 'one-status:$RELEASE_ID' 'caddy:2.10.2-alpine' >/dev/null"
  compose_build_flags="--no-build --pull never"
else
  compose_build_flags="--build"
fi

DEPLOYMENT_STARTED=true
if ! ssh_run "sudo docker compose --env-file '$RELEASE_ENV' -f '$RELEASE_DIR/deploy/compose.production.yaml' up -d $compose_build_flags --remove-orphans --wait --wait-timeout 120"; then
  exit 1
fi

remote_healthy=false
for attempt in {1..60}; do
  health_response="$(ssh_run "curl --noproxy '*' --resolve '$DOMAIN:443:127.0.0.1' --connect-timeout 5 --max-time 10 -fsS 'https://$DOMAIN/health'" 2>/dev/null || true)"
  if [[ "$health_response" == *\"release\":\"$RELEASE_ID\"* ]]; then
    remote_healthy=true
    break
  fi
  sleep 2
done

if [[ "$remote_healthy" != true ]]; then
  printf 'Remote HTTPS health check failed.\n' >&2
  exit 1
fi

healthy=false
public_attempts=60
if [[ "$PUBLIC_HEALTH_REQUIRED" == false ]]; then
  public_attempts=3
fi
for ((attempt = 1; attempt <= public_attempts; attempt += 1)); do
  health_response="$(curl --noproxy '*' "${CURL_RESOLVE_OPTIONS[@]}" --connect-timeout 5 --max-time 10 -fsS "https://$DOMAIN/health" 2>/dev/null || true)"
  if [[ "$health_response" == *\"release\":\"$RELEASE_ID\"* ]]; then
    healthy=true
    break
  fi
  sleep 2
done

if [[ "$healthy" != true ]]; then
  if [[ "$PUBLIC_HEALTH_REQUIRED" == true ]]; then
    printf 'Public HTTPS health check failed. Confirm the Tencent Cloud firewall allows inbound TCP 443.\n' >&2
    exit 1
  fi
  printf 'Public HTTPS is not reachable; promoting the release because ONE_STATUS_PUBLIC_HEALTH_REQUIRED=false.\n' >&2
fi

ssh_run "set -e; ln -sfn '$RELEASE_ENV' '$REMOTE_ROOT/shared/.production.env.$RELEASE_ID'; mv -Tf '$REMOTE_ROOT/shared/.production.env.$RELEASE_ID' '$REMOTE_ROOT/shared/production.env'; ln -sfn '$RELEASE_DIR' '$REMOTE_ROOT/.current.$RELEASE_ID'; mv -Tf '$REMOTE_ROOT/.current.$RELEASE_ID' '$REMOTE_ROOT/current'; sudo install -m 0755 '$RELEASE_DIR/deploy/backup.sh' /usr/local/sbin/one-status-backup; printf 'ONE_STATUS_DEPLOY_ROOT=%s\n' '$REMOTE_ROOT' | sudo tee /etc/default/one-status-backup >/dev/null; sudo chmod 0600 /etc/default/one-status-backup; printf '17 3 * * * root . /etc/default/one-status-backup && /usr/local/sbin/one-status-backup >>/var/log/one-status-backup.log 2>&1\n' | sudo tee /etc/cron.d/one-status-backup >/dev/null; sudo chmod 0644 /etc/cron.d/one-status-backup"
DEPLOYMENT_FINALIZED=true
printf 'One Status Cloud is healthy: https://%s\n' "$DOMAIN"
