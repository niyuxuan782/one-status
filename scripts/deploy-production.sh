#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SSH_HOST="${ONE_STATUS_SSH_HOST:?set ONE_STATUS_SSH_HOST}"
SSH_USER="${ONE_STATUS_SSH_USER:-ubuntu}"
REMOTE_ROOT="${ONE_STATUS_REMOTE_ROOT:-/opt/one-status}"
DOMAIN="${ONE_STATUS_DOMAIN:?set ONE_STATUS_DOMAIN}"
MCP_DOMAIN="${ONE_STATUS_MCP_DOMAIN:?set ONE_STATUS_MCP_DOMAIN}"
ACME_EMAIL="${ONE_STATUS_ACME_EMAIL:?set ONE_STATUS_ACME_EMAIL}"
OPAQUE_SERVER_SETUP="${ONE_STATUS_OPAQUE_SERVER_SETUP:?set ONE_STATUS_OPAQUE_SERVER_SETUP}"
VAULT_OPAQUE_SERVER_SETUP="${ONE_STATUS_VAULT_OPAQUE_SERVER_SETUP:?set ONE_STATUS_VAULT_OPAQUE_SERVER_SETUP}"
POSTGRES_PASSWORD="${ONE_STATUS_POSTGRES_PASSWORD:?set ONE_STATUS_POSTGRES_PASSWORD}"
VAULT_SERVICE_TOKEN="${ONE_STATUS_VAULT_SERVICE_TOKEN:?set ONE_STATUS_VAULT_SERVICE_TOKEN}"
VAULT_KMS_PROVIDER="${ONE_STATUS_VAULT_KMS_PROVIDER:-self-hosted}"
VAULT_KEK="${ONE_STATUS_VAULT_KEK:-}"
VAULT_KEK_FILE="${ONE_STATUS_VAULT_KEK_FILE:-}"
VAULT_KEK_ID="${ONE_STATUS_VAULT_KEK_ID:-one-status-production-v1}"
VAULT_KMS_KEY_ID="${ONE_STATUS_VAULT_KMS_KEY_ID:-}"
VAULT_KMS_REGION="${ONE_STATUS_VAULT_KMS_REGION:-}"
TENCENT_SECRET_ID="${TENCENTCLOUD_SECRET_ID:-}"
TENCENT_SECRET_KEY="${TENCENTCLOUD_SECRET_KEY:-}"
TENCENT_SESSION_TOKEN="${TENCENTCLOUD_SESSION_TOKEN:-}"
SEED_DB="${ONE_STATUS_SEED_DB:-}"
PREBUILT_IMAGES="${ONE_STATUS_PREBUILT_IMAGES:-false}"
PUBLIC_HEALTH_REQUIRED="${ONE_STATUS_PUBLIC_HEALTH_REQUIRED:-true}"
RELEASE_ID="${ONE_STATUS_RELEASE_ID:-$(date -u +%Y%m%dT%H%M%SZ)}"
RELEASE_DIR="$REMOTE_ROOT/releases/$RELEASE_ID"
RELEASE_ENV="$RELEASE_DIR/production.env"
REMOTE_KEK_FILE="$REMOTE_ROOT/shared/secrets/vault-kek"
REMOTE_BOOTSTRAP_FILE="$REMOTE_ROOT/shared/secrets/bootstrap-identity.env"
REMOTE_COMPOSE_RUNNER="/usr/local/sbin/one-status-compose"
TARGET="$SSH_USER@$SSH_HOST"
CONTROL_PATH="${ONE_STATUS_SSH_CONTROL_PATH:-/tmp/one-status-%C}"
PREVIOUS_RELEASE=""
LOCK_ACQUIRED=false
DEPLOYMENT_STARTED=false
DEPLOYMENT_FINALIZED=false
CURL_RESOLVE_OPTIONS=()
MCP_CURL_RESOLVE_OPTIONS=()
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
if [[ ! "$MCP_DOMAIN" =~ ^[A-Za-z0-9.-]+$ ]]; then
  printf 'ONE_STATUS_MCP_DOMAIN contains unsupported characters.\n' >&2
  exit 1
fi
if [[ ! "$ACME_EMAIL" =~ ^[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+$ ]]; then
  printf 'ONE_STATUS_ACME_EMAIL is invalid.\n' >&2
  exit 1
fi
if [[ ! "$OPAQUE_SERVER_SETUP" =~ ^[A-Za-z0-9_-]{171}$ ]]; then
  printf 'ONE_STATUS_OPAQUE_SERVER_SETUP must be a 171-character Base64URL setup.\n' >&2
  exit 1
fi
if [[ ! "$VAULT_OPAQUE_SERVER_SETUP" =~ ^[A-Za-z0-9_-]{171}$ ]]; then
  printf 'ONE_STATUS_VAULT_OPAQUE_SERVER_SETUP must be a 171-character Base64URL setup.\n' >&2
  exit 1
fi
if [[ "$OPAQUE_SERVER_SETUP" == "$VAULT_OPAQUE_SERVER_SETUP" ]]; then
  printf 'Account and Vault OPAQUE server setups must be generated independently.\n' >&2
  exit 1
fi
if [[ ! "$POSTGRES_PASSWORD" =~ ^[A-Za-z0-9_-]{32,256}$ ]]; then
  printf 'ONE_STATUS_POSTGRES_PASSWORD must be 32-256 URL-safe characters.\n' >&2
  exit 1
fi
if [[ ! "$VAULT_SERVICE_TOKEN" =~ ^[A-Za-z0-9_-]{32,512}$ ]]; then
  printf 'ONE_STATUS_VAULT_SERVICE_TOKEN must be 32-512 URL-safe characters.\n' >&2
  exit 1
fi
if [[ "$VAULT_KMS_PROVIDER" != self-hosted && "$VAULT_KMS_PROVIDER" != tencent-kms ]]; then
  printf 'ONE_STATUS_VAULT_KMS_PROVIDER must be self-hosted or tencent-kms.\n' >&2
  exit 1
fi
if [[ "$VAULT_KMS_PROVIDER" == self-hosted ]]; then
  if [[ ! "$VAULT_KEK_ID" =~ ^[A-Za-z0-9._:-]{1,256}$ ]]; then
    printf 'ONE_STATUS_VAULT_KEK_ID is invalid.\n' >&2
    exit 1
  fi
  if [[ -n "$VAULT_KEK" && -n "$VAULT_KEK_FILE" ]]; then
    printf 'ONE_STATUS_VAULT_KEK and ONE_STATUS_VAULT_KEK_FILE cannot both be set.\n' >&2
    exit 1
  fi
  if [[ -n "$VAULT_KEK_FILE" ]]; then
    if [[ "$VAULT_KEK_FILE" != /* || -L "$VAULT_KEK_FILE" || ! -f "$VAULT_KEK_FILE" || ! -r "$VAULT_KEK_FILE" ]]; then
      printf 'ONE_STATUS_VAULT_KEK_FILE must be an absolute, readable regular file without symlinks.\n' >&2
      exit 1
    fi
    if [[ "$(uname -s)" == Darwin ]]; then
      kek_file_metadata="$(stat -f '%u:%Lp:%z' "$VAULT_KEK_FILE")"
    else
      kek_file_metadata="$(stat -c '%u:%a:%s' "$VAULT_KEK_FILE")"
    fi
    if [[ "$kek_file_metadata" != "$(id -u):600:43" ]]; then
      printf 'ONE_STATUS_VAULT_KEK_FILE must be owned by the current user, mode 0600, and exactly 43 bytes.\n' >&2
      exit 1
    fi
    VAULT_KEK="$(< "$VAULT_KEK_FILE")"
  fi
  if [[ -n "$VAULT_KEK" && ! "$VAULT_KEK" =~ ^[A-Za-z0-9_-]{43}$ ]]; then
    printf 'ONE_STATUS_VAULT_KEK must be an unpadded Base64URL 256-bit key.\n' >&2
    exit 1
  fi
else
  if [[ ! "$VAULT_KMS_KEY_ID" =~ ^[A-Za-z0-9._:-]{1,256}$ ]]; then
    printf 'ONE_STATUS_VAULT_KMS_KEY_ID is invalid.\n' >&2
    exit 1
  fi
  if [[ ! "$VAULT_KMS_REGION" =~ ^[A-Za-z0-9-]{1,64}$ ]]; then
    printf 'ONE_STATUS_VAULT_KMS_REGION is invalid.\n' >&2
    exit 1
  fi
  if [[ ! "$TENCENT_SECRET_ID" =~ ^[A-Za-z0-9_-]{8,256}$ || ! "$TENCENT_SECRET_KEY" =~ ^[A-Za-z0-9_-]{8,256}$ ]]; then
    printf 'Tencent Cloud KMS credentials contain unsupported characters.\n' >&2
    exit 1
  fi
  if [[ -n "$TENCENT_SESSION_TOKEN" && ! "$TENCENT_SESSION_TOKEN" =~ ^[A-Za-z0-9._~+/=-]{8,4096}$ ]]; then
    printf 'Tencent Cloud KMS session token contains unsupported characters.\n' >&2
    exit 1
  fi
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
  MCP_CURL_RESOLVE_OPTIONS=(--resolve "$MCP_DOMAIN:443:$SSH_HOST")
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
    ssh_run "set -e; previous_env='$PREVIOUS_RELEASE/production.env'; test -f \"\$previous_env\"; ln -sfn \"\$previous_env\" '$REMOTE_ROOT/shared/.production.env.rollback.$RELEASE_ID'; mv -Tf '$REMOTE_ROOT/shared/.production.env.rollback.$RELEASE_ID' '$REMOTE_ROOT/shared/production.env'; ln -sfn '$PREVIOUS_RELEASE' '$REMOTE_ROOT/.current.rollback.$RELEASE_ID'; mv -Tf '$REMOTE_ROOT/.current.rollback.$RELEASE_ID' '$REMOTE_ROOT/current'; sudo env ONE_STATUS_DEPLOY_ROOT='$REMOTE_ROOT' '$REMOTE_COMPOSE_RUNNER' --env-file \"\$previous_env\" -f '$PREVIOUS_RELEASE/deploy/compose.production.yaml' up -d --no-build --pull never --remove-orphans --wait --wait-timeout 120"
  else
    printf 'Stopping incomplete first deployment.\n' >&2
    ssh_run "set -e; sudo env ONE_STATUS_DEPLOY_ROOT='$REMOTE_ROOT' '$REMOTE_COMPOSE_RUNNER' --env-file '$RELEASE_ENV' -f '$RELEASE_DIR/deploy/compose.production.yaml' down --remove-orphans || true; if [[ -L '$REMOTE_ROOT/current' && \"\$(readlink -f '$REMOTE_ROOT/current')\" == '$RELEASE_DIR' ]]; then unlink '$REMOTE_ROOT/current'; fi; if [[ -L '$REMOTE_ROOT/shared/production.env' && \"\$(readlink -f '$REMOTE_ROOT/shared/production.env')\" == '$RELEASE_ENV' ]]; then unlink '$REMOTE_ROOT/shared/production.env'; fi" || true
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

ssh_run "set -e; sudo install -d -m 0755 '$REMOTE_ROOT' '$REMOTE_ROOT/releases' '$RELEASE_DIR' '$REMOTE_ROOT/shared'; sudo install -d -m 0700 '$REMOTE_ROOT/shared/data' '$REMOTE_ROOT/shared/backups'; sudo install -d -m 0700 -o root -g root '$REMOTE_ROOT/shared/caddy-data' '$REMOTE_ROOT/shared/caddy-config' '$REMOTE_ROOT/shared/postgres-data' '$REMOTE_ROOT/shared/secrets'; sudo chown '$SSH_USER' '$REMOTE_ROOT' '$REMOTE_ROOT/releases' '$RELEASE_DIR' '$REMOTE_ROOT/shared' '$REMOTE_ROOT/shared/data' '$REMOTE_ROOT/shared/backups'; sudo chown 999:999 '$REMOTE_ROOT/shared/postgres-data'"
PREVIOUS_RELEASE="$(ssh_run "if [[ -L '$REMOTE_ROOT/current' ]]; then readlink -f '$REMOTE_ROOT/current'; fi")"

if [[ -n "$PREVIOUS_RELEASE" ]]; then
  ssh_run "set -e; if [[ ! -f '$PREVIOUS_RELEASE/production.env' ]]; then cp '$REMOTE_ROOT/shared/production.env' '$PREVIOUS_RELEASE/production.env'; chmod 0600 '$PREVIOUS_RELEASE/production.env'; fi"
  previous_kms_provider="$(ssh_run "sed -n 's/^ONE_STATUS_VAULT_KMS_PROVIDER=//p' '$PREVIOUS_RELEASE/production.env' | tail -n 1")"
  previous_kek_id="$(ssh_run "sed -n 's/^ONE_STATUS_VAULT_KEK_ID=//p' '$PREVIOUS_RELEASE/production.env' | tail -n 1")"
  if [[ -n "$previous_kms_provider" && "$previous_kms_provider" != "$VAULT_KMS_PROVIDER" ]]; then
    printf 'Vault KMS provider changes require a Wrapped DEK migration before deployment.\n' >&2
    exit 33
  fi
  if [[ "$VAULT_KMS_PROVIDER" == self-hosted && -n "$previous_kek_id" && "$previous_kek_id" != "$VAULT_KEK_ID" ]]; then
    printf 'Vault KEK ID changes require a Wrapped DEK migration before deployment.\n' >&2
    exit 34
  fi
fi

{
  printf 'ONE_STATUS_OPAQUE_SERVER_SETUP=%s\n' "$OPAQUE_SERVER_SETUP"
  printf 'ONE_STATUS_VAULT_OPAQUE_SERVER_SETUP=%s\n' "$VAULT_OPAQUE_SERVER_SETUP"
  printf 'ONE_STATUS_POSTGRES_PASSWORD=%s\n' "$POSTGRES_PASSWORD"
  printf 'ONE_STATUS_VAULT_KMS_PROVIDER=%s\n' "$VAULT_KMS_PROVIDER"
  printf 'ONE_STATUS_VAULT_KEK_ID=%s\n' "$VAULT_KEK_ID"
  printf 'ONE_STATUS_VAULT_KMS_KEY_ID=%s\n' "$VAULT_KMS_KEY_ID"
} | ssh "${SSH_OPTIONS[@]}" "$TARGET" "set -e; temporary='$REMOTE_ROOT/shared/secrets/.bootstrap-identity.$RELEASE_ID'; sudo sh -c 'umask 077; cat > \"\$1\"' _ \"\$temporary\"; if sudo test -f '$REMOTE_BOOTSTRAP_FILE'; then if ! sudo cmp -s \"\$temporary\" '$REMOTE_BOOTSTRAP_FILE'; then sudo rm -f \"\$temporary\"; printf 'The deployment bootstrap identity differs from the active server identity. An explicit migration is required.\\n' >&2; exit 35; fi; sudo rm -f \"\$temporary\"; else if sudo test -f '$REMOTE_ROOT/shared/postgres-data/PG_VERSION'; then sudo rm -f \"\$temporary\"; printf 'PostgreSQL is initialized without a saved deployment identity. Refusing implicit provider or password migration.\\n' >&2; exit 36; fi; sudo mv \"\$temporary\" '$REMOTE_BOOTSTRAP_FILE'; fi; sudo chown root:root '$REMOTE_BOOTSTRAP_FILE'; sudo chmod 0600 '$REMOTE_BOOTSTRAP_FILE'"

if [[ "$VAULT_KMS_PROVIDER" == self-hosted ]]; then
  if [[ -n "$VAULT_KEK" ]]; then
    if ! printf '%s' "$VAULT_KEK" | ssh "${SSH_OPTIONS[@]}" "$TARGET" "set -e; temporary='$REMOTE_ROOT/shared/secrets/.vault-kek.$RELEASE_ID'; sudo sh -c 'umask 077; cat > \"\$1\"' _ \"\$temporary\"; if sudo test -f '$REMOTE_KEK_FILE'; then if ! sudo cmp -s \"\$temporary\" '$REMOTE_KEK_FILE'; then sudo rm -f \"\$temporary\"; printf 'The supplied Vault KEK differs from the active server KEK. A rewrap migration is required before rotation.\\n' >&2; exit 32; fi; sudo rm -f \"\$temporary\"; else if sudo test -f '$REMOTE_ROOT/shared/postgres-data/PG_VERSION'; then sudo rm -f \"\$temporary\"; printf 'PostgreSQL is initialized but the Vault KEK is missing. Restore the original KEK before deployment.\\n' >&2; exit 37; fi; sudo mv \"\$temporary\" '$REMOTE_KEK_FILE'; fi; sudo chown root:root '$REMOTE_KEK_FILE'; sudo chmod 0600 '$REMOTE_KEK_FILE'"; then
      exit 1
    fi
  else
    ssh_run "set -e; if ! sudo test -f '$REMOTE_KEK_FILE'; then if sudo test -f '$REMOTE_ROOT/shared/postgres-data/PG_VERSION'; then printf 'PostgreSQL is initialized but the Vault KEK is missing. Restore the original KEK before deployment.\\n' >&2; exit 37; fi; temporary='$REMOTE_ROOT/shared/secrets/.vault-kek.$RELEASE_ID'; head -c 32 /dev/urandom | base64 | tr '+/' '-_' | tr -d '=\\n' | sudo tee \"\$temporary\" >/dev/null; sudo chown root:root \"\$temporary\"; sudo chmod 0600 \"\$temporary\"; sudo mv \"\$temporary\" '$REMOTE_KEK_FILE'; fi"
  fi
  ssh_run "set -e; metadata=\$(sudo stat -c '%u:%g:%a' '$REMOTE_KEK_FILE'); [[ \"\$metadata\" == '0:0:600' ]]; value=\$(sudo cat '$REMOTE_KEK_FILE'); [[ \"\$value\" =~ ^[A-Za-z0-9_-]{43}\$ ]]"
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

{
  printf 'ONE_STATUS_DOMAIN=%s\n' "$DOMAIN"
  printf 'ONE_STATUS_MCP_DOMAIN=%s\n' "$MCP_DOMAIN"
  printf 'ONE_STATUS_ACME_EMAIL=%s\n' "$ACME_EMAIL"
  printf 'ONE_STATUS_IMAGE_TAG=%s\n' "$RELEASE_ID"
  printf 'ONE_STATUS_OPAQUE_SERVER_SETUP=%s\n' "$OPAQUE_SERVER_SETUP"
  printf 'ONE_STATUS_VAULT_OPAQUE_SERVER_SETUP=%s\n' "$VAULT_OPAQUE_SERVER_SETUP"
  printf 'ONE_STATUS_DATA_DIR=%s/shared/data\n' "$REMOTE_ROOT"
  printf 'ONE_STATUS_CADDY_DATA_DIR=%s/shared/caddy-data\n' "$REMOTE_ROOT"
  printf 'ONE_STATUS_CADDY_CONFIG_DIR=%s/shared/caddy-config\n' "$REMOTE_ROOT"
  printf 'ONE_STATUS_POSTGRES_DATA_DIR=%s/shared/postgres-data\n' "$REMOTE_ROOT"
  printf 'ONE_STATUS_POSTGRES_PASSWORD=%s\n' "$POSTGRES_PASSWORD"
  printf 'ONE_STATUS_VAULT_SERVICE_TOKEN=%s\n' "$VAULT_SERVICE_TOKEN"
  printf 'ONE_STATUS_VAULT_KMS_PROVIDER=%s\n' "$VAULT_KMS_PROVIDER"
  printf 'ONE_STATUS_VAULT_KEK_ID=%s\n' "$VAULT_KEK_ID"
  printf 'ONE_STATUS_VAULT_KMS_KEY_ID=%s\n' "$VAULT_KMS_KEY_ID"
  printf 'ONE_STATUS_VAULT_KMS_REGION=%s\n' "$VAULT_KMS_REGION"
  printf 'TENCENTCLOUD_SECRET_ID=%s\n' "$TENCENT_SECRET_ID"
  printf 'TENCENTCLOUD_SECRET_KEY=%s\n' "$TENCENT_SECRET_KEY"
  printf 'TENCENTCLOUD_SESSION_TOKEN=%s\n' "$TENCENT_SESSION_TOKEN"
} | ssh "${SSH_OPTIONS[@]}" "$TARGET" "set -e; temporary='$RELEASE_ENV.tmp'; umask 077; cat > \"\$temporary\"; mv \"\$temporary\" '$RELEASE_ENV'"

ssh_run "sudo install -o root -g root -m 0755 '$RELEASE_DIR/deploy/compose-with-vault-kek.sh' '$REMOTE_COMPOSE_RUNNER'"

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
  ssh_run "set -e; sudo docker image inspect 'one-status:$RELEASE_ID' 'caddy:2.10.2-alpine' 'postgres:17.6-bookworm' >/dev/null"
  compose_build_flags="--no-build --pull never"
else
  compose_build_flags="--build"
fi

DEPLOYMENT_STARTED=true
if ! ssh_run "sudo env ONE_STATUS_DEPLOY_ROOT='$REMOTE_ROOT' '$REMOTE_COMPOSE_RUNNER' --env-file '$RELEASE_ENV' -f '$RELEASE_DIR/deploy/compose.production.yaml' up -d $compose_build_flags --remove-orphans --wait --wait-timeout 120"; then
  exit 1
fi

remote_healthy=false
for attempt in {1..60}; do
  health_response="$(ssh_run "curl --noproxy '*' --resolve '$DOMAIN:443:127.0.0.1' --connect-timeout 5 --max-time 10 -fsS 'https://$DOMAIN/health'" 2>/dev/null || true)"
  mcp_health_response="$(ssh_run "curl --noproxy '*' --resolve '$MCP_DOMAIN:443:127.0.0.1' --connect-timeout 5 --max-time 10 -fsS 'https://$MCP_DOMAIN/health'" 2>/dev/null || true)"
  if [[ "$health_response" == *\"release\":\"$RELEASE_ID\"* && "$health_response" == *\"remoteMcp\":\"ready\"* && "$health_response" == *\"cloudVault\":\"configured\"* && "$mcp_health_response" == *\"release\":\"$RELEASE_ID\"* ]]; then
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
  mcp_health_response="$(curl --noproxy '*' "${MCP_CURL_RESOLVE_OPTIONS[@]}" --connect-timeout 5 --max-time 10 -fsS "https://$MCP_DOMAIN/health" 2>/dev/null || true)"
  if [[ "$health_response" == *\"release\":\"$RELEASE_ID\"* && "$health_response" == *\"remoteMcp\":\"ready\"* && "$health_response" == *\"cloudVault\":\"configured\"* && "$mcp_health_response" == *\"release\":\"$RELEASE_ID\"* ]]; then
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

oauth_metadata="$(curl --noproxy '*' "${CURL_RESOLVE_OPTIONS[@]}" --connect-timeout 5 --max-time 10 -fsS "https://$DOMAIN/.well-known/oauth-authorization-server" 2>/dev/null || true)"
resource_metadata="$(curl --noproxy '*' "${MCP_CURL_RESOLVE_OPTIONS[@]}" --connect-timeout 5 --max-time 10 -fsS "https://$MCP_DOMAIN/.well-known/oauth-protected-resource/mcp" 2>/dev/null || true)"
mcp_status="$(curl --noproxy '*' "${MCP_CURL_RESOLVE_OPTIONS[@]}" --connect-timeout 5 --max-time 10 -sS -o /dev/null -w '%{http_code}' "https://$MCP_DOMAIN/mcp" 2>/dev/null || true)"
if [[ "$oauth_metadata" != *\"authorization_endpoint\":\"https://$DOMAIN/oauth/authorize\"* || "$resource_metadata" != *\"resource\":\"https://$MCP_DOMAIN/mcp\"* || "$mcp_status" != 401 ]]; then
  printf 'Remote MCP OAuth discovery verification failed.\n' >&2
  exit 1
fi

ssh_run "set -e; ln -sfn '$RELEASE_ENV' '$REMOTE_ROOT/shared/.production.env.$RELEASE_ID'; mv -Tf '$REMOTE_ROOT/shared/.production.env.$RELEASE_ID' '$REMOTE_ROOT/shared/production.env'; ln -sfn '$RELEASE_DIR' '$REMOTE_ROOT/.current.$RELEASE_ID'; mv -Tf '$REMOTE_ROOT/.current.$RELEASE_ID' '$REMOTE_ROOT/current'; sudo install -m 0755 '$RELEASE_DIR/deploy/backup.sh' /usr/local/sbin/one-status-backup; printf 'ONE_STATUS_DEPLOY_ROOT=%s\n' '$REMOTE_ROOT' | sudo tee /etc/default/one-status-backup >/dev/null; sudo chmod 0600 /etc/default/one-status-backup; printf '17 3 * * * root . /etc/default/one-status-backup && /usr/local/sbin/one-status-backup >>/var/log/one-status-backup.log 2>&1\n' | sudo tee /etc/cron.d/one-status-backup >/dev/null; sudo chmod 0644 /etc/cron.d/one-status-backup"
DEPLOYMENT_FINALIZED=true
printf 'One Status Cloud is healthy: https://%s and https://%s/mcp\n' "$DOMAIN" "$MCP_DOMAIN"
