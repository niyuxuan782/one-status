# One Status Cloud Deployment

This stack serves the encrypted Sync API, OAuth Authorization Server, outbound
Desktop Relay, and Remote MCP behind Caddy. `os.furesta.top` owns `/v1/*`,
`/oauth/*`, and `/v1/relay`; `mcp.os.furesta.top` owns `/mcp` and OAuth protected
resource discovery. Other website paths redirect to GitHub Pages.
Images, JavaScript, CSS, installation scripts, and release downloads are served
by GitHub. The cloud API does not receive the Status Key, local paths, or raw
Agent sessions. Cloud Vault stores one ciphertext and one KMS-wrapped DEK per
credential. Vault Runtime can decrypt one authorized credential in memory for
the lifetime of a request; request bodies and results are excluded from logs.
Remote credential writes require a one-time approval bound to the Agent
session, operation, exact request digest, and a ten-minute expiry. Credential
mutations and audit records commit in one PostgreSQL transaction.
Caddy runs inside the Tencent Cloud Lighthouse instance; this deployment has no
Cloudflare proxy, tunnel, DNS, or certificate dependency.

## Prerequisites

- Ubuntu 24.04 with Docker Engine and the Compose plugin
- TCP ports 80 and 443 open
- SSH key access for the deployment user
- Deployment user UID `1000` for the non-root API container
- Two hostnames resolving to the server
- A Tencent Cloud KMS symmetric key and a least-privilege CAM identity allowed
  to call `GenerateDataKey` and `Decrypt` for that key
- Two independently generated OPAQUE server setups stored in a secret manager

The production hostnames are `os.furesta.top` and `mcp.os.furesta.top`, both
managed in Tencent Cloud DNS and pointing to the Lighthouse instance public
address.

Generate the account and Wallet OPAQUE setups once. Keep both values for the
lifetime of their registration records, store them separately, and include
them in the disaster-recovery secret set. Replacing the account setup
invalidates account password records; replacing the Vault setup invalidates
Wallet password records.

```bash
install -d -m 0700 "$HOME/.config/one-status/deploy"
npx --yes @serenity-kit/opaque@1.1.0 create-server-setup \
  > "$HOME/.config/one-status/deploy/account-opaque.setup"
npx --yes @serenity-kit/opaque@1.1.0 create-server-setup \
  > "$HOME/.config/one-status/deploy/vault-opaque.setup"
chmod 0600 "$HOME/.config/one-status/deploy/"*.setup
```

## Deploy

```bash
export ONE_STATUS_SSH_HOST=124.220.104.225
export ONE_STATUS_SSH_USER=ubuntu
export ONE_STATUS_DOMAIN=os.furesta.top
export ONE_STATUS_MCP_DOMAIN=mcp.os.furesta.top
export ONE_STATUS_ACME_EMAIL=you@example.com
export ONE_STATUS_OPAQUE_SERVER_SETUP="$(tr -d '\r\n' < "$HOME/.config/one-status/deploy/account-opaque.setup")"
export ONE_STATUS_VAULT_OPAQUE_SERVER_SETUP="$(tr -d '\r\n' < "$HOME/.config/one-status/deploy/vault-opaque.setup")"
export ONE_STATUS_POSTGRES_PASSWORD="$(openssl rand -base64 48 | tr -dc 'A-Za-z0-9_-')"
export ONE_STATUS_VAULT_SERVICE_TOKEN="$(openssl rand -base64 48 | tr -dc 'A-Za-z0-9_-')"
export ONE_STATUS_VAULT_KMS_KEY_ID=your-kms-key-id
export ONE_STATUS_VAULT_KMS_REGION=ap-guangzhou
export TENCENTCLOUD_SECRET_ID=your-least-privilege-secret-id
export TENCENTCLOUD_SECRET_KEY=your-least-privilege-secret-key
# Optional when the CAM credential is temporary:
export TENCENTCLOUD_SESSION_TOKEN=your-session-token
export ONE_STATUS_SEED_DB=/path/to/one-status.sqlite
export ONE_STATUS_SSH_IDENTITY="$HOME/.config/one-status/deploy/lhins-8owupwdq-ed25519"
./scripts/deploy-production.sh
```

`ONE_STATUS_SEED_DB` is imported only when the remote database does not exist.
It is uploaded under a temporary name, checked by SHA-256, SQLite
`quick_check`, foreign-key validation and required-table validation, then moved
to the final path atomically. Later deployments preserve
`/opt/one-status/shared/data` and `/opt/one-status/shared/postgres-data`.

The deploy script starts a new release with a release-local environment file
before switching the `current` and `shared/production.env` symlinks. It checks
HTTPS from the server loopback and from the deployment machine. If startup or
either health check fails, it restores the previous release and its environment.
Signals and other interrupted exits trigger the same rollback. On a first
deployment failure it removes the incomplete Compose stack. A remote deployment
lock prevents concurrent releases.

Tencent Cloud Lighthouse must allow inbound `TCP 80`, `TCP 443`, and `UDP 443`.
`TCP 80` is used for ACME validation and redirects, `TCP 443` serves HTTPS, and
`UDP 443` enables HTTP/3. DNS A records must resolve before deployment.
All containers use Docker's rotating local log driver with a 10 MB file limit
and five retained files, preventing access logs from filling the instance disk.
Vault startup performs one `GenerateDataKey` and `Decrypt` round trip before its
health endpoint reports `kms: ready`. PostgreSQL runs directly as UID/GID 999;
the deploy script prepares the persistent data directory with that ownership.

For a host that cannot reach Docker Hub, preload `linux/amd64` images named
`one-status:<release-id>` and `caddy:2.10.2-alpine`, then run with:

```bash
export ONE_STATUS_RELEASE_ID=20260809T000000Z
export ONE_STATUS_PREBUILT_IMAGES=true
./scripts/deploy-production.sh
```

When the Tencent Cloud firewall change is still pending, a release can be
staged after its container, certificate, loopback HTTPS, and release ID checks
pass:

```bash
export ONE_STATUS_PUBLIC_HEALTH_REQUIRED=false
./scripts/deploy-production.sh
```

This flag defaults to `true`. Staged mode does not make the service publicly
usable. After opening TCP 443, verify the promoted release directly:

```bash
curl -fsS "https://$ONE_STATUS_DOMAIN/health"
curl -fsS "https://$ONE_STATUS_DOMAIN/.well-known/oauth-authorization-server"
curl -fsS "https://$ONE_STATUS_MCP_DOMAIN/.well-known/oauth-protected-resource/mcp"
curl -sS -o /dev/null -w '%{http_code}\n' "https://$ONE_STATUS_MCP_DOMAIN/mcp"
curl -fsSI "https://$ONE_STATUS_DOMAIN/" | grep -i '^location:'
```

After the copied database is healthy, switch a local installation only after it
can authenticate and decrypt the remote envelope:

```bash
one-status use-server --url "https://$ONE_STATUS_DOMAIN"
one-status doctor
```

## Backup

Install a root cron entry after the first deployment:

```cron
17 3 * * * /usr/local/sbin/one-status-backup >/var/log/one-status-backup.log 2>&1
```

The backup script briefly stops the API, creates a consistent SQLite backup and
a PostgreSQL custom-format dump, archives both with mode `0600`, restarts the
API, and removes archives older than 14 days. Copy backups to a second machine
or object store.

Retained PostgreSQL dumps contain historical ciphertext and wrapped DEKs. They
remain decryptable while the referenced Tencent KMS key is available, so backup
retention and KMS key lifecycle must be managed together.
The backup archive does not contain either OPAQUE server setup. Restore both
original values from the secret manager before starting API or Vault services.

## Restore

```bash
cd /opt/one-status
docker compose --env-file shared/production.env \
  -f current/deploy/compose.production.yaml stop api
mkdir -p /tmp/one-status-restore
tar -xzf shared/backups/one-status-YYYYMMDDTHHMMSSZ.tar.gz \
  -C /tmp/one-status-restore
cp /tmp/one-status-restore/one-status.sqlite shared/data/one-status.sqlite
docker compose --env-file shared/production.env \
  -f current/deploy/compose.production.yaml exec -T postgres \
  pg_restore -U one_status -d one_status_vault --clean --if-exists \
  < /tmp/one-status-restore/cloud-vault.dump
docker compose --env-file shared/production.env \
  -f current/deploy/compose.production.yaml start api
```

## Trust Boundary

The cloud API stores account metadata, device presence, OPAQUE registration
records, unmigrated legacy password hashes, session token hashes, Remote MCP
OAuth token hashes, mutation receipts, encrypted Status envelopes, credential
ciphertext, and KMS-wrapped DEKs. The two OPAQUE server setups remain protected
deployment secrets. Status Keys, project files, local absolute paths, and Agent
configuration remain on user devices.
Vault Runtime holds KMS permission and can temporarily decrypt only a selected
credential after OAuth scope, Agent Grant, credential policy, purpose, project,
expiry, and revocation checks pass. The API and Vault do not persist Remote MCP
request or result bodies. For Status and device-local service calls, the online
Desktop returns only the requested projection or approved tool result over WSS.
