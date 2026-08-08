# One Status Cloud Deployment

This stack runs the ciphertext-only Sync API behind Caddy. It does not receive
the Status Key, local paths, raw Agent sessions, or a decryptable Permission
Vault. The synchronized Permission Vault bundle remains nested ciphertext.
Caddy runs inside the Tencent Cloud Lighthouse instance; this deployment has no
Cloudflare proxy, tunnel, DNS, or certificate dependency.

## Prerequisites

- Ubuntu 24.04 with Docker Engine and the Compose plugin
- TCP ports 80 and 443 open
- SSH key access for the deployment user
- Deployment user UID `1000` for the non-root API container
- A hostname resolving to the server

The production hostname is `os.furesta.top`, managed in Tencent Cloud DNS and
pointing to the Lighthouse instance public address.

## Deploy

```bash
export ONE_STATUS_SSH_HOST=124.220.104.225
export ONE_STATUS_SSH_USER=ubuntu
export ONE_STATUS_DOMAIN=os.furesta.top
export ONE_STATUS_ACME_EMAIL=you@example.com
export ONE_STATUS_SEED_DB=/path/to/one-status.sqlite
export ONE_STATUS_SSH_IDENTITY="$HOME/.config/one-status/deploy/lhins-8owupwdq-ed25519"
./scripts/deploy-production.sh
```

`ONE_STATUS_SEED_DB` is imported only when the remote database does not exist.
It is uploaded under a temporary name, checked by SHA-256, SQLite
`quick_check`, foreign-key validation and required-table validation, then moved
to the final path atomically. Later deployments preserve
`/opt/one-status/shared/data`.

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
Both containers use Docker's rotating local log driver with a 10 MB file limit
and five retained files, preventing access logs from filling the instance disk.

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

The backup script briefly stops the API, archives the SQLite database and WAL
files with mode `0600`, restarts the API, and removes archives older than 14
days. Copy backups to a second machine or object store.

## Restore

```bash
cd /opt/one-status
docker compose --env-file shared/production.env \
  -f current/deploy/compose.production.yaml stop api
tar -xzf shared/backups/one-status-YYYYMMDDTHHMMSSZ.tar.gz \
  -C shared/data
docker compose --env-file shared/production.env \
  -f current/deploy/compose.production.yaml start api
```

## Trust Boundary

The cloud API stores account metadata, device presence, password hashes, session
token hashes, mutation receipts, and encrypted Status envelopes. OAuth Token
plaintext, Status Keys, project files, local absolute paths, and Agent
configuration remain on user devices in this deployment profile.
