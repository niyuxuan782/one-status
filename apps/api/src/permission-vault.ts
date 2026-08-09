import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
  randomUUID,
} from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import { dirname } from "node:path";
import type { DatabaseSync as DatabaseSyncType } from "node:sqlite";
import { z } from "zod";

const nodeRequire = createRequire(import.meta.url);
const FLOW_TTL_MS = 10 * 60 * 1_000;

export const oauthProviders = [
  "google",
  "github",
  "slack",
  "microsoft",
  "notion",
  "dropbox",
  "zoom",
  "canva",
  "asana",
  "trello",
  "airtable",
  "linear",
  "figma",
  "box",
] as const;
export type OAuthProvider = (typeof oauthProviders)[number];

const secretlessProviders = new Set<OAuthProvider>(["slack", "trello"]);

export interface OAuthProviderConfig {
  clientId: string;
  clientSecret?: string;
}

export interface OAuthFlow {
  codeVerifier: string;
  provider: OAuthProvider;
  redirectUri: string;
  returnTo: string;
  state: string;
  userId: string;
}

export interface OAuthCredential {
  accessToken: string;
  refreshToken?: string;
  tokenType?: string;
}

export interface OAuthConnection {
  accountId: string;
  credentialOwnership: "managed" | "external";
  createdAt: string;
  expiresAt: string | null;
  id: string;
  label: string;
  provider: OAuthProvider;
  scopes: string[];
  source: "oauth" | "imported";
  status: "connected" | "expired" | "error";
  updatedAt: string;
}

export interface OAuthConnectionWithCredential extends OAuthConnection {
  credential: OAuthCredential;
}

export interface AgentGrant {
  actions: string[];
  agentId: string;
  connectionId: string;
  updatedAt: string;
}

export interface ToolAuditEvent {
  action: string;
  agentId: string;
  connectionId?: string;
  createdAt: string;
  decision: "allow" | "deny";
  durationMs?: number;
  id: string;
  outcome: "success" | "error" | "blocked";
  providerRequestId?: string;
}

export interface PermissionVaultBundle {
  connections: OAuthConnectionWithCredential[];
  format: "one-status.permission-vault-bundle";
  grants: AgentGrant[];
  providers: Array<{
    config: OAuthProviderConfig;
    provider: OAuthProvider;
    updatedAt: string;
  }>;
  updatedAt: string;
  version: 1;
}

interface PermissionVaultOptions {
  key?: Uint8Array;
  keyPath?: string;
  path: string;
}

interface ConnectionRow {
  account_id: string;
  credential_ownership: OAuthConnection["credentialOwnership"];
  created_at: string;
  credentials: string;
  expires_at: string | null;
  id: string;
  label: string;
  provider: OAuthProvider;
  scopes: string;
  source: OAuthConnection["source"];
  status: OAuthConnection["status"];
  updated_at: string;
}

export class PermissionVault {
  readonly #database: DatabaseSyncType;
  readonly #key: Buffer;

  constructor(options: PermissionVaultOptions) {
    const persistent = options.path !== ":memory:";
    if (persistent) {
      ensurePrivateDirectory(dirname(options.path));
    }
    this.#key = options.key
      ? validateKey(options.key)
      : loadOrCreateKey(requiredKeyPath(options));
    const { DatabaseSync } = nodeRequire(
      "node:sqlite",
    ) as typeof import("node:sqlite");
    this.#database = new DatabaseSync(options.path);
    if (persistent) chmodSync(options.path, 0o600);
    this.#database.exec("PRAGMA foreign_keys = ON");
    this.#database.exec("PRAGMA journal_mode = WAL");
    this.#database.exec(`
      CREATE TABLE IF NOT EXISTS oauth_provider_configs (
        user_id TEXT NOT NULL,
        provider TEXT NOT NULL,
        client_id TEXT NOT NULL,
        client_secret TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        PRIMARY KEY (user_id, provider)
      );

      CREATE TABLE IF NOT EXISTS oauth_flows (
        state_hash TEXT PRIMARY KEY,
        user_id TEXT NOT NULL,
        provider TEXT NOT NULL,
        code_verifier TEXT NOT NULL,
        redirect_uri TEXT NOT NULL,
        return_to TEXT NOT NULL,
        expires_at TEXT NOT NULL,
        created_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS oauth_connections (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL,
        provider TEXT NOT NULL,
        account_id TEXT NOT NULL,
        label TEXT NOT NULL,
        scopes TEXT NOT NULL,
        credentials TEXT NOT NULL,
        source TEXT NOT NULL DEFAULT 'oauth',
        credential_ownership TEXT NOT NULL DEFAULT 'managed',
        expires_at TEXT,
        status TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE (user_id, provider, account_id)
      );

      CREATE TABLE IF NOT EXISTS agent_grants (
        user_id TEXT NOT NULL,
        connection_id TEXT NOT NULL REFERENCES oauth_connections(id) ON DELETE CASCADE,
        agent_id TEXT NOT NULL,
        actions TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        PRIMARY KEY (user_id, connection_id, agent_id)
      );

      CREATE TABLE IF NOT EXISTS tool_audit_events (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL,
        connection_id TEXT,
        agent_id TEXT NOT NULL,
        action TEXT NOT NULL,
        decision TEXT NOT NULL,
        outcome TEXT NOT NULL,
        provider_request_id TEXT,
        duration_ms INTEGER,
        created_at TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS tool_audit_events_user_created
        ON tool_audit_events(user_id, created_at DESC);

      CREATE TABLE IF NOT EXISTS permission_vault_state (
        user_id TEXT PRIMARY KEY,
        updated_at TEXT NOT NULL
      );
    `);
    ensureConnectionMetadataColumns(this.#database);
  }

  close(): void {
    this.#database.close();
  }

  configureProvider(
    userId: string,
    provider: OAuthProvider,
    input: { clientId: string; clientSecret?: string },
  ): void {
    const clientId = requiredSecretValue(input.clientId, "Client ID", 500);
    const current = this.getProviderConfig(userId, provider);
    const clientSecret =
      secretlessProviders.has(provider)
        ? ""
        : input.clientSecret
          ? requiredSecretValue(input.clientSecret, "Client secret", 1_000)
          : current?.clientSecret;
    if (!secretlessProviders.has(provider) && !clientSecret) {
      throw new Error("Client secret is required.");
    }
    const storedClientSecret = clientSecret ?? "";
    const now = new Date().toISOString();
    this.#database
      .prepare(
        `INSERT INTO oauth_provider_configs
           (user_id, provider, client_id, client_secret, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(user_id, provider) DO UPDATE SET
           client_id = excluded.client_id,
           client_secret = excluded.client_secret,
           updated_at = excluded.updated_at`,
      )
      .run(
        userId,
        provider,
        clientId,
        this.#encrypt(
          storedClientSecret,
          `provider:${userId}:${provider}`,
        ),
        now,
        now,
      );
    this.#touch(userId);
  }

  getProviderConfig(
    userId: string,
    provider: OAuthProvider,
  ): OAuthProviderConfig | null {
    const row = this.#database
      .prepare(
        `SELECT client_id, client_secret
           FROM oauth_provider_configs
          WHERE user_id = ? AND provider = ?`,
      )
      .get(userId, provider) as
      | { client_id: string; client_secret: string }
      | undefined;
    if (!row) return null;
    const clientSecret = this.#decrypt(
      row.client_secret,
      `provider:${userId}:${provider}`,
    );
    return {
      clientId: row.client_id,
      ...(clientSecret ? { clientSecret } : {}),
    };
  }

  listConfiguredProviders(userId: string): OAuthProvider[] {
    return (
      this.#database
        .prepare(
          "SELECT provider FROM oauth_provider_configs WHERE user_id = ?",
        )
        .all(userId) as Array<{ provider: OAuthProvider }>
    ).map((row) => row.provider);
  }

  createFlow(input: {
    provider: OAuthProvider;
    redirectUri: string;
    returnTo?: string;
    userId: string;
  }): OAuthFlow & { codeChallenge: string } {
    validateRedirectUri(input.redirectUri);
    const state = randomBytes(32).toString("base64url");
    const codeVerifier = randomBytes(48).toString("base64url");
    const stateHash = hashState(state);
    const now = new Date();
    const nowIso = now.toISOString();
    const returnTo = safeReturnTo(input.returnTo);
    this.#database.exec("BEGIN IMMEDIATE");
    try {
      this.#database
        .prepare(
          `DELETE FROM oauth_flows
            WHERE expires_at <= ?
               OR (user_id = ? AND provider = ?)`,
        )
        .run(nowIso, input.userId, input.provider);
      this.#database
        .prepare(
          `INSERT INTO oauth_flows
             (state_hash, user_id, provider, code_verifier, redirect_uri,
              return_to, expires_at, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          stateHash,
          input.userId,
          input.provider,
          this.#encrypt(
            codeVerifier,
            `flow:${input.userId}:${input.provider}:${stateHash}`,
          ),
          input.redirectUri,
          returnTo,
          new Date(now.getTime() + FLOW_TTL_MS).toISOString(),
          nowIso,
        );
      this.#database.exec("COMMIT");
    } catch (error) {
      this.#database.exec("ROLLBACK");
      throw error;
    }
    return {
      codeChallenge: createHash("sha256")
        .update(codeVerifier)
        .digest("base64url"),
      codeVerifier,
      provider: input.provider,
      redirectUri: input.redirectUri,
      returnTo,
      state,
      userId: input.userId,
    };
  }

  consumeFlow(state: string): OAuthFlow | null {
    const stateHash = hashState(state);
    const row = this.#database
      .prepare("SELECT * FROM oauth_flows WHERE state_hash = ?")
      .get(stateHash) as
      | {
          code_verifier: string;
          expires_at: string;
          provider: OAuthProvider;
          redirect_uri: string;
          return_to: string;
          user_id: string;
        }
      | undefined;
    this.#database
      .prepare("DELETE FROM oauth_flows WHERE state_hash = ?")
      .run(stateHash);
    if (!row || Date.parse(row.expires_at) <= Date.now()) return null;
    return {
      codeVerifier: this.#decrypt(
        row.code_verifier,
        `flow:${row.user_id}:${row.provider}:${stateHash}`,
      ),
      provider: row.provider,
      redirectUri: row.redirect_uri,
      returnTo: row.return_to,
      state,
      userId: row.user_id,
    };
  }

  upsertConnection(input: {
    accountId: string;
    credential: OAuthCredential;
    expiresAt?: string | null;
    label: string;
    provider: OAuthProvider;
    scopes: string[];
    source?: OAuthConnection["source"];
    userId: string;
  }): OAuthConnection {
    const accountId = requiredTextValue(input.accountId, "OAuth account ID", 500);
    const label = requiredTextValue(input.label, "OAuth account label", 500);
    const expiresAt = normalizeExpiration(input.expiresAt);
    const source = input.source ?? "oauth";
    const credentialOwnership = ownershipForSource(source);
    const existing = this.#database
      .prepare(
        `SELECT id, created_at, credentials, source, credential_ownership
           FROM oauth_connections
          WHERE user_id = ? AND provider = ? AND account_id = ?`,
      )
      .get(input.userId, input.provider, accountId) as
      | {
          created_at: string;
          credential_ownership: OAuthConnection["credentialOwnership"];
          credentials: string;
          id: string;
          source: OAuthConnection["source"];
        }
      | undefined;
    const id = existing?.id ?? randomUUID();
    const now = new Date().toISOString();
    const createdAt = existing?.created_at ?? now;
    const previousCredential =
      existing &&
      existing.source === source &&
      existing.credential_ownership === credentialOwnership
      ? parseCredential(
          this.#decrypt(
            existing.credentials,
            `connection:${input.userId}:${id}`,
          ),
        )
      : undefined;
    const credential = mergeCredential(
      previousCredential,
      validateCredential(input.credential),
    );
    this.#database
      .prepare(
        `INSERT INTO oauth_connections
           (id, user_id, provider, account_id, label, scopes, credentials,
            source, credential_ownership, expires_at, status, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'connected', ?, ?)
         ON CONFLICT(user_id, provider, account_id) DO UPDATE SET
           label = excluded.label,
           scopes = excluded.scopes,
           credentials = excluded.credentials,
           source = excluded.source,
           credential_ownership = excluded.credential_ownership,
           expires_at = excluded.expires_at,
           status = 'connected',
           updated_at = excluded.updated_at`,
      )
      .run(
        id,
        input.userId,
        input.provider,
        accountId,
        label,
        JSON.stringify(uniqueStrings(input.scopes)),
        this.#encrypt(
          JSON.stringify(credential),
          `connection:${input.userId}:${id}`,
        ),
        source,
        credentialOwnership,
        expiresAt,
        createdAt,
        now,
      );
    this.#touch(input.userId);
    return this.getConnection(input.userId, id)!;
  }

  listConnections(userId: string): OAuthConnection[] {
    const rows = this.#database
      .prepare(
        `SELECT * FROM oauth_connections
          WHERE user_id = ? ORDER BY provider, label`,
      )
      .all(userId) as unknown as ConnectionRow[];
    return rows.map((row) => toConnection(row));
  }

  getConnection(userId: string, id: string): OAuthConnection | null {
    const row = this.#database
      .prepare(
        "SELECT * FROM oauth_connections WHERE user_id = ? AND id = ?",
      )
      .get(userId, id) as unknown as ConnectionRow | undefined;
    return row ? toConnection(row) : null;
  }

  getConnectionWithCredential(
    userId: string,
    id: string,
  ): OAuthConnectionWithCredential | null {
    const row = this.#database
      .prepare(
        "SELECT * FROM oauth_connections WHERE user_id = ? AND id = ?",
      )
      .get(userId, id) as unknown as ConnectionRow | undefined;
    if (!row) return null;
    return {
      ...toConnection(row),
      credential: parseCredential(
        this.#decrypt(row.credentials, `connection:${userId}:${id}`),
      ),
    };
  }

  updateCredential(
    userId: string,
    id: string,
    credential: OAuthCredential,
    expiresAt: string | null,
    scopes?: string[],
  ): void {
    const current = this.getConnectionWithCredential(userId, id);
    if (!current) throw new Error("OAuth connection was not found.");
    const merged = mergeCredential(
      current.credential,
      validateCredential(credential),
    );
    const nextScopes = scopes ? uniqueStrings(scopes) : current.scopes;
    const normalizedExpiresAt = normalizeExpiration(expiresAt);
    this.#database
      .prepare(
        `UPDATE oauth_connections
            SET credentials = ?, expires_at = ?, scopes = ?, status = 'connected', updated_at = ?
          WHERE user_id = ? AND id = ?`,
      )
      .run(
        this.#encrypt(
          JSON.stringify(merged),
          `connection:${userId}:${id}`,
        ),
        normalizedExpiresAt,
        JSON.stringify(nextScopes),
        new Date().toISOString(),
        userId,
        id,
      );
    this.#touch(userId);
  }

  setConnectionStatus(
    userId: string,
    id: string,
    status: OAuthConnection["status"],
  ): void {
    this.#database
      .prepare(
        `UPDATE oauth_connections SET status = ?, updated_at = ?
          WHERE user_id = ? AND id = ?`,
      )
      .run(status, new Date().toISOString(), userId, id);
    this.#touch(userId);
  }

  deleteConnection(userId: string, id: string): boolean {
    const deleted =
      this.#database
        .prepare(
          "DELETE FROM oauth_connections WHERE user_id = ? AND id = ?",
        )
        .run(userId, id).changes > 0;
    if (deleted) this.#touch(userId);
    return deleted;
  }

  setGrant(
    userId: string,
    connectionId: string,
    agentId: string,
    actions: string[],
  ): AgentGrant {
    const normalizedAgentId = agentId.trim();
    if (!normalizedAgentId || normalizedAgentId.length > 120) {
      throw new Error("Agent ID is invalid.");
    }
    if (!this.getConnection(userId, connectionId)) {
      throw new Error("OAuth connection was not found.");
    }
    const now = new Date().toISOString();
    const normalized = uniqueStrings(actions);
    this.#database
      .prepare(
        `INSERT INTO agent_grants
           (user_id, connection_id, agent_id, actions, updated_at)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(user_id, connection_id, agent_id) DO UPDATE SET
           actions = excluded.actions,
           updated_at = excluded.updated_at`,
      )
      .run(
        userId,
        connectionId,
        normalizedAgentId,
        JSON.stringify(normalized),
        now,
      );
    this.#touch(userId);
    return {
      actions: normalized,
      agentId: normalizedAgentId,
      connectionId,
      updatedAt: now,
    };
  }

  listGrants(userId: string): AgentGrant[] {
    return (
      this.#database
        .prepare(
          `SELECT connection_id, agent_id, actions, updated_at
             FROM agent_grants WHERE user_id = ?`,
        )
        .all(userId) as Array<{
        actions: string;
        agent_id: string;
        connection_id: string;
        updated_at: string;
      }>
    ).map((row) => ({
      actions: JSON.parse(row.actions) as string[],
      agentId: row.agent_id,
      connectionId: row.connection_id,
      updatedAt: row.updated_at,
    }));
  }

  getAllowedActions(
    userId: string,
    connectionId: string,
    agentId: string,
  ): string[] {
    const row = this.#database
      .prepare(
        `SELECT actions FROM agent_grants
          WHERE user_id = ? AND connection_id = ? AND agent_id = ?`,
      )
      .get(userId, connectionId, agentId) as
      | { actions: string }
      | undefined;
    return row ? (JSON.parse(row.actions) as string[]) : [];
  }

  exportBundle(userId: string): PermissionVaultBundle {
    const providerRows = this.#database
      .prepare(
        `SELECT provider, client_id, client_secret, updated_at
           FROM oauth_provider_configs
          WHERE user_id = ? ORDER BY provider`,
      )
      .all(userId) as Array<{
      client_id: string;
      client_secret: string;
      provider: OAuthProvider;
      updated_at: string;
    }>;
    const connectionRows = this.#database
      .prepare(
        `SELECT * FROM oauth_connections
          WHERE user_id = ? ORDER BY provider, label`,
      )
      .all(userId) as unknown as ConnectionRow[];

    return permissionVaultBundleSchema.parse({
      connections: connectionRows.map((row) => ({
        ...toConnection(row, false),
        credential: parseCredential(
          this.#decrypt(row.credentials, `connection:${userId}:${row.id}`),
        ),
      })),
      format: "one-status.permission-vault-bundle",
      grants: this.listGrants(userId),
      providers: providerRows.map((row) => {
        const clientSecret = this.#decrypt(
          row.client_secret,
          `provider:${userId}:${row.provider}`,
        );
        return {
          config: {
            clientId: row.client_id,
            ...(clientSecret ? { clientSecret } : {}),
          },
          provider: row.provider,
          updatedAt: row.updated_at,
        };
      }),
      updatedAt: this.#updatedAt(userId),
      version: 1,
    });
  }

  importBundle(userId: string, bundleValue: PermissionVaultBundle): void {
    const bundle = permissionVaultBundleSchema.parse(
      normalizePermissionVaultBundle(bundleValue),
    );
    if (
      bundle.connections.some(
        (connection) =>
          connection.credentialOwnership !==
          ownershipForSource(connection.source),
      )
    ) {
      throw new Error("Permission Vault connection ownership is invalid.");
    }
    const connectionIds = new Set(
      bundle.connections.map((connection) => connection.id),
    );
    if (bundle.grants.some((grant) => !connectionIds.has(grant.connectionId))) {
      throw new Error("Permission Vault bundle contains an orphan Agent grant.");
    }

    this.#database.exec("BEGIN IMMEDIATE");
    try {
      this.#database
        .prepare("DELETE FROM agent_grants WHERE user_id = ?")
        .run(userId);
      this.#database
        .prepare("DELETE FROM oauth_connections WHERE user_id = ?")
        .run(userId);
      this.#database
        .prepare("DELETE FROM oauth_provider_configs WHERE user_id = ?")
        .run(userId);

      for (const entry of bundle.providers) {
        const clientSecret =
          secretlessProviders.has(entry.provider)
            ? ""
            : requiredSecretValue(
                entry.config.clientSecret ?? "",
                "Client secret",
                1_000,
              );
        this.#database
          .prepare(
            `INSERT INTO oauth_provider_configs
               (user_id, provider, client_id, client_secret, created_at, updated_at)
             VALUES (?, ?, ?, ?, ?, ?)`,
          )
          .run(
            userId,
            entry.provider,
            requiredSecretValue(entry.config.clientId, "Client ID", 500),
            this.#encrypt(
              clientSecret,
              `provider:${userId}:${entry.provider}`,
            ),
            entry.updatedAt,
            entry.updatedAt,
          );
      }

      for (const connection of bundle.connections) {
        this.#database
          .prepare(
            `INSERT INTO oauth_connections
               (id, user_id, provider, account_id, label, scopes, credentials,
                source, credential_ownership, expires_at, status, created_at,
                updated_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          )
          .run(
            connection.id,
            userId,
            connection.provider,
            connection.accountId,
            connection.label,
            JSON.stringify(uniqueStrings(connection.scopes)),
            this.#encrypt(
              JSON.stringify(validateCredential(connection.credential)),
              `connection:${userId}:${connection.id}`,
            ),
            connection.source,
            connection.credentialOwnership,
            normalizeExpiration(connection.expiresAt),
            connection.status,
            connection.createdAt,
            connection.updatedAt,
          );
      }

      for (const grant of bundle.grants) {
        this.#database
          .prepare(
            `INSERT INTO agent_grants
               (user_id, connection_id, agent_id, actions, updated_at)
             VALUES (?, ?, ?, ?, ?)`,
          )
          .run(
            userId,
            grant.connectionId,
            grant.agentId,
            JSON.stringify(uniqueStrings(grant.actions)),
            grant.updatedAt,
          );
      }

      this.#database
        .prepare(
          `INSERT INTO permission_vault_state (user_id, updated_at)
           VALUES (?, ?)
           ON CONFLICT(user_id) DO UPDATE SET updated_at = excluded.updated_at`,
        )
        .run(userId, bundle.updatedAt);
      this.#database.exec("COMMIT");
    } catch (error) {
      this.#database.exec("ROLLBACK");
      throw error;
    }
  }

  recordAudit(input: {
    action: string;
    agentId: string;
    connectionId?: string;
    decision: "allow" | "deny";
    durationMs?: number;
    outcome: "success" | "error" | "blocked";
    providerRequestId?: string;
    userId: string;
  }): void {
    this.#database
      .prepare(
        `INSERT INTO tool_audit_events
           (id, user_id, connection_id, agent_id, action, decision, outcome,
            provider_request_id, duration_ms, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        randomUUID(),
        input.userId,
        input.connectionId ?? null,
        input.agentId,
        input.action,
        input.decision,
        input.outcome,
        input.providerRequestId ?? null,
        input.durationMs ?? null,
        new Date().toISOString(),
      );
  }

  listAuditEvents(userId: string, limit = 100): ToolAuditEvent[] {
    const safeLimit = Number.isSafeInteger(limit)
      ? Math.min(Math.max(limit, 1), 200)
      : 100;
    const rows = this.#database
      .prepare(
        `SELECT id, connection_id, agent_id, action, decision, outcome,
                provider_request_id, duration_ms, created_at
           FROM tool_audit_events
          WHERE user_id = ?
          ORDER BY created_at DESC
          LIMIT ?`,
      )
      .all(userId, safeLimit) as Array<{
      action: string;
      agent_id: string;
      connection_id: string | null;
      created_at: string;
      decision: ToolAuditEvent["decision"];
      duration_ms: number | null;
      id: string;
      outcome: ToolAuditEvent["outcome"];
      provider_request_id: string | null;
    }>;
    return rows.map((row) => ({
      id: row.id,
      action: row.action,
      agentId: row.agent_id,
      ...(row.connection_id ? { connectionId: row.connection_id } : {}),
      decision: row.decision,
      outcome: row.outcome,
      ...(row.provider_request_id
        ? { providerRequestId: row.provider_request_id }
        : {}),
      ...(row.duration_ms === null ? {} : { durationMs: row.duration_ms }),
      createdAt: row.created_at,
    }));
  }

  #updatedAt(userId: string): string {
    const row = this.#database
      .prepare(
        `SELECT MAX(updated_at) AS updated_at
           FROM (
             SELECT updated_at FROM permission_vault_state WHERE user_id = ?
             UNION ALL
             SELECT updated_at FROM oauth_provider_configs WHERE user_id = ?
             UNION ALL
             SELECT updated_at FROM oauth_connections WHERE user_id = ?
             UNION ALL
             SELECT updated_at FROM agent_grants WHERE user_id = ?
           )`,
      )
      .get(userId, userId, userId, userId) as
      | { updated_at: string | null }
      | undefined;
    return row?.updated_at ?? "1970-01-01T00:00:00.000Z";
  }

  #touch(userId: string): void {
    const previous = Date.parse(this.#updatedAt(userId));
    const updatedAt = new Date(
      Math.max(Date.now(), Number.isFinite(previous) ? previous + 1 : 0),
    ).toISOString();
    this.#database
      .prepare(
        `INSERT INTO permission_vault_state (user_id, updated_at)
         VALUES (?, ?)
         ON CONFLICT(user_id) DO UPDATE SET updated_at = excluded.updated_at`,
      )
      .run(userId, updatedAt);
  }

  #encrypt(plaintext: string, aad: string): string {
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", this.#key, iv);
    cipher.setAAD(Buffer.from(aad));
    const ciphertext = Buffer.concat([
      cipher.update(plaintext, "utf8"),
      cipher.final(),
    ]);
    return JSON.stringify({
      version: 1,
      iv: iv.toString("base64url"),
      ciphertext: ciphertext.toString("base64url"),
      authTag: cipher.getAuthTag().toString("base64url"),
    });
  }

  #decrypt(envelopeValue: string, aad: string): string {
    const envelope = JSON.parse(envelopeValue) as {
      authTag: string;
      ciphertext: string;
      iv: string;
      version: number;
    };
    if (envelope.version !== 1) throw new Error("Unsupported secret envelope.");
    const decipher = createDecipheriv(
      "aes-256-gcm",
      this.#key,
      Buffer.from(envelope.iv, "base64url"),
    );
    decipher.setAAD(Buffer.from(aad));
    decipher.setAuthTag(Buffer.from(envelope.authTag, "base64url"));
    return Buffer.concat([
      decipher.update(Buffer.from(envelope.ciphertext, "base64url")),
      decipher.final(),
    ]).toString("utf8");
  }
}

const oauthCredentialSchema = z
  .object({
    accessToken: z.string().min(1).max(32_000),
    refreshToken: z.string().min(1).max(32_000).optional(),
    tokenType: z.string().min(1).max(120).optional(),
  })
  .strict();

const permissionVaultBundleSchema: z.ZodType<PermissionVaultBundle> = z
  .object({
    connections: z.array(
      z
        .object({
          accountId: z.string().min(1).max(500),
          credentialOwnership: z.enum(["managed", "external"]),
          createdAt: z.iso.datetime({ offset: true }),
          credential: oauthCredentialSchema,
          expiresAt: z.iso.datetime({ offset: true }).nullable(),
          id: z.uuid(),
          label: z.string().min(1).max(500),
          provider: z.enum(oauthProviders),
          scopes: z.array(z.string().min(1).max(20_000)),
          source: z.enum(["oauth", "imported"]),
          status: z.enum(["connected", "expired", "error"]),
          updatedAt: z.iso.datetime({ offset: true }),
        })
        .strict(),
    ),
    format: z.literal("one-status.permission-vault-bundle"),
    grants: z.array(
      z
        .object({
          actions: z.array(z.string().min(1).max(500)),
          agentId: z.string().min(1).max(120),
          connectionId: z.uuid(),
          updatedAt: z.iso.datetime({ offset: true }),
        })
        .strict(),
    ),
    providers: z.array(
      z
        .object({
          config: z
            .object({
              clientId: z.string().min(1).max(500),
              clientSecret: z.string().min(1).max(1_000).optional(),
            })
            .strict(),
          provider: z.enum(oauthProviders),
          updatedAt: z.iso.datetime({ offset: true }),
        })
        .strict(),
    ),
    updatedAt: z.iso.datetime({ offset: true }),
    version: z.literal(1),
  })
  .strict();

function normalizePermissionVaultBundle(value: unknown): unknown {
  if (!value || typeof value !== "object") return value;
  const bundle = value as Record<string, unknown>;
  if (!Array.isArray(bundle.connections)) return value;
  return {
    ...bundle,
    connections: bundle.connections.map((connection) => {
      if (!connection || typeof connection !== "object") return connection;
      const record = connection as Record<string, unknown>;
      const source = record.source ?? "oauth";
      return {
        ...record,
        credentialOwnership:
          record.credentialOwnership ??
          (source === "imported" ? "external" : "managed"),
        source,
      };
    }),
  };
}

function toConnection(
  row: ConnectionRow,
  deriveExpiration = true,
): OAuthConnection {
  const expired =
    deriveExpiration &&
    row.status === "connected" &&
    row.expires_at !== null &&
    Date.parse(row.expires_at) <= Date.now();
  return {
    accountId: row.account_id,
    credentialOwnership: row.credential_ownership,
    createdAt: row.created_at,
    expiresAt: row.expires_at,
    id: row.id,
    label: row.label,
    provider: row.provider,
    scopes: JSON.parse(row.scopes) as string[],
    source: row.source,
    status: expired ? "expired" : row.status,
    updatedAt: row.updated_at,
  };
}

function ownershipForSource(
  source: OAuthConnection["source"],
): OAuthConnection["credentialOwnership"] {
  return source === "imported" ? "external" : "managed";
}

function ensureConnectionMetadataColumns(database: DatabaseSyncType): void {
  const columns = new Set(
    (
      database.prepare("PRAGMA table_info(oauth_connections)").all() as Array<{
        name: string;
      }>
    ).map((column) => column.name),
  );
  if (!columns.has("source")) {
    database.exec(
      "ALTER TABLE oauth_connections ADD COLUMN source TEXT NOT NULL DEFAULT 'oauth'",
    );
  }
  if (!columns.has("credential_ownership")) {
    database.exec(
      "ALTER TABLE oauth_connections ADD COLUMN credential_ownership TEXT NOT NULL DEFAULT 'managed'",
    );
  }
}

function hashState(state: string): string {
  return createHash("sha256").update(state).digest("base64url");
}

function safeReturnTo(value?: string): string {
  if (!value?.startsWith("/")) return "/integrations";
  try {
    const base = new URL("https://one-status.invalid");
    const candidate = new URL(value, base);
    return candidate.origin === base.origin
      ? `${candidate.pathname}${candidate.search}${candidate.hash}`
      : "/integrations";
  } catch {
    return "/integrations";
  }
}

function uniqueStrings(values: string[]): string[] {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))];
}

function validateCredential(value: OAuthCredential): OAuthCredential {
  const accessToken = requiredSecretValue(
    value.accessToken,
    "OAuth access token",
    32_000,
  );
  const refreshToken = value.refreshToken
    ? requiredSecretValue(value.refreshToken, "OAuth refresh token", 32_000)
    : undefined;
  const tokenType = value.tokenType?.trim();
  if (tokenType && tokenType.length > 120) {
    throw new Error("OAuth token type is invalid.");
  }
  return {
    accessToken,
    ...(refreshToken ? { refreshToken } : {}),
    ...(tokenType ? { tokenType } : {}),
  };
}

function parseCredential(value: string): OAuthCredential {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new Error("Stored OAuth credential is invalid.");
  }
  if (!parsed || typeof parsed !== "object" || !("accessToken" in parsed)) {
    throw new Error("Stored OAuth credential is invalid.");
  }
  const record = parsed as Record<string, unknown>;
  if (
    typeof record.accessToken !== "string" ||
    (record.refreshToken !== undefined &&
      typeof record.refreshToken !== "string") ||
    (record.tokenType !== undefined && typeof record.tokenType !== "string")
  ) {
    throw new Error("Stored OAuth credential is invalid.");
  }
  return validateCredential({
    accessToken: record.accessToken,
    ...(typeof record.refreshToken === "string"
      ? { refreshToken: record.refreshToken }
      : {}),
    ...(typeof record.tokenType === "string"
      ? { tokenType: record.tokenType }
      : {}),
  });
}

function mergeCredential(
  previous: OAuthCredential | undefined,
  next: OAuthCredential,
): OAuthCredential {
  return {
    accessToken: next.accessToken,
    ...(next.refreshToken || previous?.refreshToken
      ? { refreshToken: next.refreshToken ?? previous?.refreshToken }
      : {}),
    ...(next.tokenType || previous?.tokenType
      ? { tokenType: next.tokenType ?? previous?.tokenType }
      : {}),
  };
}

function requiredSecretValue(
  value: string,
  label: string,
  maxLength: number,
): string {
  const normalized = value.trim();
  if (!normalized || normalized.length > maxLength) {
    throw new Error(`${label} is invalid.`);
  }
  return normalized;
}

function requiredTextValue(
  value: string,
  label: string,
  maxLength: number,
): string {
  const normalized = value.trim();
  if (!normalized || normalized.length > maxLength) {
    throw new Error(`${label} is invalid.`);
  }
  return normalized;
}

function normalizeExpiration(value: string | null | undefined): string | null {
  if (value === null || value === undefined) return null;
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) {
    throw new Error("OAuth credential expiration is invalid.");
  }
  return new Date(timestamp).toISOString();
}

function validateRedirectUri(value: string): void {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error("OAuth redirect URI is invalid.");
  }
  const loopback = url.hostname === "127.0.0.1" || url.hostname === "[::1]";
  if (url.protocol !== "https:" && !(url.protocol === "http:" && loopback)) {
    throw new Error("OAuth redirect URI must use HTTPS or a loopback address.");
  }
  if (url.username || url.password || url.hash) {
    throw new Error("OAuth redirect URI is invalid.");
  }
}

function validateKey(value: Uint8Array): Buffer {
  if (value.byteLength !== 32) {
    throw new Error("Permission Vault key must contain 32 bytes.");
  }
  return Buffer.from(value);
}

function requiredKeyPath(options: PermissionVaultOptions): string {
  if (!options.keyPath) {
    throw new Error("Permission Vault keyPath is required for persistent use.");
  }
  return options.keyPath;
}

function loadOrCreateKey(path: string): Buffer {
  ensurePrivateDirectory(dirname(path));
  if (existsSync(path)) {
    const key = Buffer.from(readFileSync(path, "utf8").trim(), "base64url");
    return validateKey(key);
  }
  const key = randomBytes(32);
  writeFileSync(path, `${key.toString("base64url")}\n`, {
    encoding: "utf8",
    flag: "wx",
    mode: 0o600,
  });
  chmodSync(path, 0o600);
  return key;
}

function ensurePrivateDirectory(path: string): void {
  const created = mkdirSync(path, { recursive: true, mode: 0o700 });
  if (created) chmodSync(path, 0o700);
}
