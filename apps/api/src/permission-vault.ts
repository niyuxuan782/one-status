import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
  randomUUID,
  timingSafeEqual,
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
import type { OpaquePasswordRecord } from "@one-status/pake/authority";

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

export const privateCredentialKinds = [
  "account",
  "ssh",
  "cloud_console",
  "github",
  "database",
  "api",
  "license",
  "card_key",
  "model",
  "oauth",
  "email",
  "vpn",
  "certificate",
  "signing",
  "container_registry",
  "package_registry",
  "domain",
  "remote_desktop",
  "webhook",
  "generic",
] as const;
export type PrivateCredentialKind = (typeof privateCredentialKinds)[number];

export interface PrivateCredentialSource {
  agentId?: string;
  deviceId?: string;
  projectId?: string;
  type: "user" | "agent" | "scan" | "import";
}

export interface PrivateCredentialAccessPolicy {
  allowAgentRead: boolean;
  allowedAgentIds: string[];
  allowedProjectIds: string[];
  deniedAgentIds: string[];
  deniedProjectIds: string[];
  requireApproval: boolean;
}

export interface PrivateCredential {
  accessPolicy: PrivateCredentialAccessPolicy;
  createdAt: string;
  expiresAt: string | null;
  fields: Record<string, string>;
  id: string;
  kind: PrivateCredentialKind;
  label: string;
  purposes: string[];
  secrets: Record<string, string>;
  source: PrivateCredentialSource;
  tags: string[];
  updatedAt: string;
}

export interface MaskedPrivateCredential
  extends Omit<PrivateCredential, "secrets"> {
  secrets: Record<string, "********">;
}

export interface PrivateCredentialTombstone {
  credentialId: string;
  deletedAt: string;
}

export interface CredentialAccessAuditEvent {
  agentId: string;
  createdAt: string;
  credentialId: string;
  decision: "allow" | "deny";
  id: string;
  projectId?: string;
  purpose: string;
  reason:
    | "allowed"
    | "credential_not_found"
    | "credential_expired"
    | "purpose_mismatch"
    | "agent_denied"
    | "agent_not_allowed"
    | "project_denied"
    | "project_not_allowed"
    | "approval_required";
}

export interface UpsertPrivateCredentialInput {
  accessPolicy?: Partial<PrivateCredentialAccessPolicy>;
  expiresAt?: string | null;
  fields?: Record<string, string>;
  id?: string;
  kind: PrivateCredentialKind;
  label: string;
  purposes: string[];
  secrets?: Record<string, string>;
  source?: Partial<PrivateCredentialSource> &
    Pick<PrivateCredentialSource, "type">;
  tags?: string[];
  userId: string;
}

export interface PatchPrivateCredentialInput {
  accessPolicy?: Partial<PrivateCredentialAccessPolicy>;
  credentialId: string;
  expiresAt?: string | null;
  fields?: Record<string, string>;
  kind?: PrivateCredentialKind;
  label?: string;
  purposes?: string[];
  secrets?: Record<string, string>;
  source?: Partial<PrivateCredentialSource>;
  tags?: string[];
  userId: string;
}

export interface PermissionVaultBundle {
  connections: OAuthConnectionWithCredential[];
  format: "one-status.permission-vault-bundle";
  grants: AgentGrant[];
  modelCredentials: Array<{
    apiKey: string;
    createdAt: string;
    sourceId: string;
    updatedAt: string;
  }>;
  modelCredentialIgnores?: Array<{
    sourceId: string;
    updatedAt: string;
  }>;
  privateCredentialTombstones?: PrivateCredentialTombstone[];
  privateCredentials?: PrivateCredential[];
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

interface PrivateCredentialRow {
  created_at: string;
  id: string;
  payload: string;
  updated_at: string;
  user_id: string;
}

interface ModelCredentialRow {
  api_key: string;
  created_at: string;
  source_id: string;
  updated_at: string;
  user_id: string;
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

      CREATE TABLE IF NOT EXISTS model_credentials (
        user_id TEXT NOT NULL,
        source_id TEXT NOT NULL,
        api_key TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        PRIMARY KEY (user_id, source_id)
      );

      CREATE TABLE IF NOT EXISTS wallet_pake_records (
        user_id TEXT PRIMARY KEY,
        registration_record TEXT NOT NULL,
        profile TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS model_credential_ignores (
        user_id TEXT NOT NULL,
        source_id TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        PRIMARY KEY (user_id, source_id)
      );

      CREATE TABLE IF NOT EXISTS private_credentials (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL,
        payload TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS private_credentials_user_updated
        ON private_credentials(user_id, updated_at DESC);

      CREATE TABLE IF NOT EXISTS private_credential_tombstones (
        user_id TEXT NOT NULL,
        credential_id TEXT NOT NULL,
        deleted_at TEXT NOT NULL,
        PRIMARY KEY (user_id, credential_id)
      );

      CREATE TABLE IF NOT EXISTS credential_access_audit_events (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL,
        credential_id TEXT NOT NULL,
        agent_id TEXT NOT NULL,
        project_id TEXT,
        purpose TEXT NOT NULL,
        decision TEXT NOT NULL,
        reason TEXT NOT NULL,
        created_at TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS credential_access_audit_user_created
        ON credential_access_audit_events(user_id, created_at DESC);
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

  setModelCredential(
    userId: string,
    sourceIdValue: string,
    apiKeyValue: string,
  ): boolean {
    const sourceId = requiredControlId(sourceIdValue, "Model source ID");
    const apiKey = requiredSecretValue(apiKeyValue, "Model API key", 32_000);
    const clearedIgnore = this.#database
      .prepare(
        "DELETE FROM model_credential_ignores WHERE user_id = ? AND source_id = ?",
      )
      .run(userId, sourceId);
    const current = this.getModelCredential(userId, sourceId);
    if (current && safeSecretEqual(current, apiKey)) {
      if (Number(clearedIgnore.changes) > 0) this.#touch(userId);
      return Number(clearedIgnore.changes) > 0;
    }
    const existing = this.#database
      .prepare(
        "SELECT created_at FROM model_credentials WHERE user_id = ? AND source_id = ?",
      )
      .get(userId, sourceId) as { created_at: string } | undefined;
    const now = new Date().toISOString();
    this.#database
      .prepare(
        `INSERT INTO model_credentials
           (user_id, source_id, api_key, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(user_id, source_id) DO UPDATE SET
           api_key = excluded.api_key,
           updated_at = excluded.updated_at`,
      )
      .run(
        userId,
        sourceId,
        this.#encrypt(apiKey, `model-source:${userId}:${sourceId}`),
        existing?.created_at ?? now,
        now,
      );
    this.#touch(userId);
    return true;
  }

  setDiscoveredModelCredential(
    userId: string,
    sourceIdValue: string,
    apiKeyValue: string,
  ): boolean {
    if (this.isModelCredentialIgnored(userId, sourceIdValue)) return false;
    return this.setModelCredential(userId, sourceIdValue, apiKeyValue);
  }

  isModelCredentialIgnored(userId: string, sourceIdValue: string): boolean {
    const sourceId = requiredControlId(sourceIdValue, "Model source ID");
    return Boolean(
      this.#database
        .prepare(
          "SELECT 1 AS ignored FROM model_credential_ignores WHERE user_id = ? AND source_id = ?",
        )
        .get(userId, sourceId),
    );
  }

  ignoreModelCredential(userId: string, sourceIdValue: string): boolean {
    const sourceId = requiredControlId(sourceIdValue, "Model source ID");
    const existing = this.isModelCredentialIgnored(userId, sourceId);
    const credential = this.deleteModelCredential(userId, sourceId);
    if (existing) return credential;
    const now = new Date().toISOString();
    this.#database
      .prepare(
        "INSERT INTO model_credential_ignores (user_id, source_id, updated_at) VALUES (?, ?, ?)",
      )
      .run(userId, sourceId, now);
    this.#touch(userId);
    return true;
  }

  getModelCredential(userId: string, sourceIdValue: string): string | undefined {
    const sourceId = requiredControlId(sourceIdValue, "Model source ID");
    const row = this.#database
      .prepare(
        "SELECT api_key FROM model_credentials WHERE user_id = ? AND source_id = ?",
      )
      .get(userId, sourceId) as { api_key: string } | undefined;
    return row
      ? this.#decrypt(row.api_key, `model-source:${userId}:${sourceId}`)
      : undefined;
  }

  hasModelCredential(userId: string, sourceId: string): boolean {
    return this.getModelCredential(userId, sourceId) !== undefined;
  }

  deleteModelCredential(userId: string, sourceIdValue: string): boolean {
    const sourceId = requiredControlId(sourceIdValue, "Model source ID");
    const result = this.#database
      .prepare(
        "DELETE FROM model_credentials WHERE user_id = ? AND source_id = ?",
      )
      .run(userId, sourceId);
    if (Number(result.changes) > 0) this.#touch(userId);
    return Number(result.changes) > 0;
  }

  listModelCredentialStatus(userId: string): Array<{
    sourceId: string;
    updatedAt: string;
  }> {
    return (
      this.#database
        .prepare(
          `SELECT source_id, updated_at FROM model_credentials
            WHERE user_id = ? ORDER BY source_id`,
        )
        .all(userId) as Array<{ source_id: string; updated_at: string }>
    ).map((row) => ({ sourceId: row.source_id, updatedAt: row.updated_at }));
  }

  upsertPrivateCredential(
    inputValue: UpsertPrivateCredentialInput,
  ): MaskedPrivateCredential {
    const input = normalizePrivateCredentialInput(inputValue);
    const id = input.id ?? randomUUID();
    const existingOwner = this.#database
      .prepare("SELECT user_id FROM private_credentials WHERE id = ?")
      .get(id) as { user_id: string } | undefined;
    if (existingOwner && existingOwner.user_id !== input.userId) {
      throw new Error("Credential ID belongs to another account.");
    }
    const current = this.#getPrivateCredential(input.userId, id);
    const modelSourceId = this.#modelSourceIdForPrivateCredentialId(
      input.userId,
      id,
    );
    if (modelSourceId) {
      if (input.kind !== "model") {
        throw new Error("Model wallet credentials must retain the model kind.");
      }
      const secretKeys = Object.keys(input.secrets);
      if (secretKeys.some((key) => key !== "apiKey")) {
        throw new Error("Model wallet credentials only support the apiKey secret.");
      }
      if (input.secrets.apiKey) {
        this.setModelCredential(input.userId, modelSourceId, input.secrets.apiKey);
      }
      return maskPrivateCredential(
        this.#getPrivateCredential(input.userId, id)!,
      );
    }
    const now = nextCredentialTimestamp(current?.updatedAt);
    const credential = privateCredentialSchema.parse({
      accessPolicy: input.accessPolicy,
      createdAt: current?.createdAt ?? now,
      expiresAt: input.expiresAt,
      fields: input.fields,
      id,
      kind: input.kind,
      label: input.label,
      purposes: input.purposes,
      secrets: normalizeCredentialMap(
        { ...current?.secrets, ...input.secrets },
        false,
      ),
      source: input.source,
      tags: input.tags,
      updatedAt: now,
    });
    const tombstone = this.#database
      .prepare(
        `SELECT deleted_at FROM private_credential_tombstones
          WHERE user_id = ? AND credential_id = ?`,
      )
      .get(input.userId, id) as { deleted_at: string } | undefined;
    if (
      current &&
      samePrivateCredentialContent(current, credential) &&
      !tombstone
    ) {
      return maskPrivateCredential(current);
    }

    const updatedAt = nextCredentialTimestamp(
      current?.updatedAt,
      tombstone?.deleted_at,
    );
    const stored = { ...credential, updatedAt };
    this.#database.exec("BEGIN IMMEDIATE");
    try {
      this.#database
        .prepare(
          `INSERT INTO private_credentials
             (id, user_id, payload, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?)
           ON CONFLICT(id) DO UPDATE SET
             payload = excluded.payload,
             created_at = excluded.created_at,
             updated_at = excluded.updated_at
           WHERE private_credentials.user_id = excluded.user_id`,
        )
        .run(
          id,
          input.userId,
          this.#encrypt(
            JSON.stringify(stored),
            `private-credential:${input.userId}:${id}`,
          ),
          stored.createdAt,
          stored.updatedAt,
        );
      this.#database
        .prepare(
          `DELETE FROM private_credential_tombstones
            WHERE user_id = ? AND credential_id = ?`,
        )
        .run(input.userId, id);
      this.#touch(input.userId);
      this.#database.exec("COMMIT");
    } catch (error) {
      this.#database.exec("ROLLBACK");
      throw error;
    }
    return maskPrivateCredential(stored);
  }

  patchPrivateCredential(
    inputValue: PatchPrivateCredentialInput,
  ): MaskedPrivateCredential | null {
    const input = patchPrivateCredentialInputSchema.parse(inputValue);
    const credentialId = requiredUuid(input.credentialId, "Credential ID");
    const current = this.#getPrivateCredential(input.userId, credentialId);
    if (!current) return null;
    return this.upsertPrivateCredential({
      accessPolicy: {
        ...current.accessPolicy,
        ...input.accessPolicy,
      },
      expiresAt:
        input.expiresAt === undefined ? current.expiresAt : input.expiresAt,
      fields: { ...current.fields, ...input.fields },
      id: credentialId,
      kind: input.kind ?? current.kind,
      label: input.label ?? current.label,
      purposes: input.purposes ?? current.purposes,
      secrets: input.secrets,
      source: {
        ...current.source,
        ...input.source,
        type: input.source?.type ?? current.source.type,
      },
      tags: input.tags ?? current.tags,
      userId: input.userId,
    });
  }

  listPrivateCredentials(
    userId: string,
    filter: {
      kinds?: PrivateCredentialKind[];
      purposes?: string[];
      tags?: string[];
    } = {},
  ): MaskedPrivateCredential[] {
    const normalizedFilter = normalizeCredentialFilter(filter);
    return this.#listPrivateCredentials(userId)
      .filter((credential) =>
        credentialMatchesFilter(credential, normalizedFilter),
      )
      .map(maskPrivateCredential);
  }

  getWalletPakeRecord(userId: string): OpaquePasswordRecord | null {
    const row = this.#database
      .prepare(
        `SELECT registration_record, profile, created_at, updated_at
           FROM wallet_pake_records WHERE user_id = ?`,
      )
      .get(userId) as
      | {
          created_at: string;
          profile: string;
          registration_record: string;
          updated_at: string;
        }
      | undefined;
    return row
      ? {
          createdAt: row.created_at,
          profile: JSON.parse(row.profile) as OpaquePasswordRecord["profile"],
          registrationRecord: row.registration_record,
          updatedAt: row.updated_at,
          userId,
        }
      : null;
  }

  upsertWalletPakeRecord(record: OpaquePasswordRecord): void {
    this.#database
      .prepare(
        `INSERT INTO wallet_pake_records
           (user_id, registration_record, profile, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(user_id) DO UPDATE SET
           registration_record = excluded.registration_record,
           profile = excluded.profile,
           updated_at = excluded.updated_at`,
      )
      .run(
        record.userId,
        record.registrationRecord,
        JSON.stringify(record.profile),
        record.createdAt,
        record.updatedAt,
      );
  }

  findPrivateCredentialsForAgent(input: {
    agentId: string;
    kinds?: PrivateCredentialKind[];
    projectId?: string;
    purpose: string;
    tags?: string[];
    userId: string;
  }): MaskedPrivateCredential[] {
    const agentId = requiredMetadataValue(input.agentId, "Agent ID", 500);
    const projectId = input.projectId
      ? requiredMetadataValue(input.projectId, "Project ID", 500)
      : undefined;
    const purpose = requiredMetadataValue(
      input.purpose,
      "Credential purpose",
      500,
    );
    const filter = normalizeCredentialFilter({
      kinds: input.kinds,
      purposes: [purpose],
      tags: input.tags,
    });
    return this.#listPrivateCredentials(input.userId)
      .filter((credential) => credentialMatchesFilter(credential, filter))
      .filter(
        (credential) =>
          credentialAccessDecision(credential, {
            agentId,
            approved: false,
            projectId,
            purpose,
          }) === "allowed",
      )
      .map(maskPrivateCredential);
  }

  readPrivateCredentialForAgent(input: {
    agentId: string;
    approved?: boolean;
    credentialId: string;
    projectId?: string;
    purpose: string;
    userId: string;
  }): PrivateCredential | null {
    const credentialId = requiredUuid(input.credentialId, "Credential ID");
    const agentId = requiredMetadataValue(input.agentId, "Agent ID", 500);
    const projectId = input.projectId
      ? requiredMetadataValue(input.projectId, "Project ID", 500)
      : undefined;
    const purpose = requiredMetadataValue(
      input.purpose,
      "Credential purpose",
      500,
    );
    const credential = this.#getPrivateCredential(input.userId, credentialId);
    const reason = credential
      ? credentialAccessDecision(credential, {
          agentId,
          approved: input.approved === true,
          projectId,
          purpose,
        })
      : "credential_not_found";
    this.#recordCredentialAccessAudit({
      agentId,
      credentialId,
      decision: reason === "allowed" ? "allow" : "deny",
      projectId,
      purpose,
      reason,
      userId: input.userId,
    });
    return reason === "allowed" ? credential : null;
  }

  revealPrivateCredentialAuthorized(
    userId: string,
    credentialIdValue: string,
  ): PrivateCredential | null {
    const credentialId = requiredUuid(credentialIdValue, "Credential ID");
    const credential = this.#getPrivateCredential(userId, credentialId);
    this.#recordCredentialAccessAudit({
      agentId: "user",
      credentialId,
      decision: credential ? "allow" : "deny",
      purpose: "user.reveal",
      reason: credential ? "allowed" : "credential_not_found",
      userId,
    });
    return credential;
  }

  deletePrivateCredential(userId: string, credentialIdValue: string): boolean {
    const credentialId = requiredUuid(credentialIdValue, "Credential ID");
    const modelSourceId = this.#modelSourceIdForPrivateCredentialId(
      userId,
      credentialId,
    );
    if (modelSourceId) return this.ignoreModelCredential(userId, modelSourceId);
    const current = this.#getPrivateCredential(userId, credentialId);
    if (!current) return false;
    const deletedAt = nextCredentialTimestamp(current.updatedAt);
    this.#database.exec("BEGIN IMMEDIATE");
    try {
      this.#database
        .prepare(
          "DELETE FROM private_credentials WHERE user_id = ? AND id = ?",
        )
        .run(userId, credentialId);
      this.#database
        .prepare(
          `INSERT INTO private_credential_tombstones
             (user_id, credential_id, deleted_at)
           VALUES (?, ?, ?)
           ON CONFLICT(user_id, credential_id) DO UPDATE SET
             deleted_at = excluded.deleted_at`,
        )
        .run(userId, credentialId, deletedAt);
      this.#touch(userId);
      this.#database.exec("COMMIT");
    } catch (error) {
      this.#database.exec("ROLLBACK");
      throw error;
    }
    return true;
  }

  listCredentialAccessAuditEvents(
    userId: string,
    limit = 100,
  ): CredentialAccessAuditEvent[] {
    const safeLimit = Number.isSafeInteger(limit)
      ? Math.min(Math.max(limit, 1), 200)
      : 100;
    const rows = this.#database
      .prepare(
        `SELECT id, credential_id, agent_id, project_id, purpose, decision,
                reason, created_at
           FROM credential_access_audit_events
          WHERE user_id = ?
          ORDER BY created_at DESC, id DESC
          LIMIT ?`,
      )
      .all(userId, safeLimit) as Array<{
      agent_id: string;
      created_at: string;
      credential_id: string;
      decision: CredentialAccessAuditEvent["decision"];
      id: string;
      project_id: string | null;
      purpose: string;
      reason: CredentialAccessAuditEvent["reason"];
    }>;
    return rows.map((row) => ({
      agentId: row.agent_id,
      createdAt: row.created_at,
      credentialId: row.credential_id,
      decision: row.decision,
      id: row.id,
      ...(row.project_id ? { projectId: row.project_id } : {}),
      purpose: row.purpose,
      reason: row.reason,
    }));
  }

  recordCredentialAuditEvent(input: {
    agentId: string;
    credentialId: string;
    projectId?: string;
    purpose: string;
    userId: string;
  }): void {
    this.#recordCredentialAccessAudit({
      agentId: requiredMetadataValue(input.agentId, "Agent ID", 500),
      credentialId: requiredUuid(input.credentialId, "Credential ID"),
      decision: "allow",
      ...(input.projectId
        ? {
            projectId: requiredMetadataValue(
              input.projectId,
              "Project ID",
              500,
            ),
          }
        : {}),
      purpose: requiredMetadataValue(
        input.purpose,
        "Credential audit purpose",
        500,
      ),
      reason: "allowed",
      userId: requiredMetadataValue(input.userId, "User ID", 500),
    });
  }

  #listPrivateCredentials(userId: string): PrivateCredential[] {
    const stored = (
      this.#database
        .prepare(
          `SELECT id, user_id, payload, created_at, updated_at
             FROM private_credentials
            WHERE user_id = ?
            ORDER BY updated_at DESC, id`,
        )
        .all(userId) as unknown as PrivateCredentialRow[]
    ).map((row) => this.#credentialFromRow(row));
    return [...stored, ...this.#listModelPrivateCredentials(userId)].sort(
      (left, right) =>
        Date.parse(right.updatedAt) - Date.parse(left.updatedAt) ||
        left.id.localeCompare(right.id),
    );
  }

  #getPrivateCredential(
    userId: string,
    credentialId: string,
  ): PrivateCredential | null {
    const row = this.#database
      .prepare(
        `SELECT id, user_id, payload, created_at, updated_at
           FROM private_credentials WHERE user_id = ? AND id = ?`,
      )
      .get(userId, credentialId) as unknown as PrivateCredentialRow | undefined;
    if (row) return this.#credentialFromRow(row);
    return (
      this.#listModelPrivateCredentials(userId).find(
        (credential) => credential.id === credentialId,
      ) ?? null
    );
  }

  #credentialFromRow(row: PrivateCredentialRow): PrivateCredential {
    const credential = privateCredentialSchema.parse(
      JSON.parse(
        this.#decrypt(
          row.payload,
          `private-credential:${row.user_id}:${row.id}`,
        ),
      ) as unknown,
    );
    if (
      credential.id !== row.id ||
      credential.createdAt !== row.created_at ||
      credential.updatedAt !== row.updated_at
    ) {
      throw new Error("Stored private credential metadata is invalid.");
    }
    return credential;
  }

  #listModelPrivateCredentials(userId: string): PrivateCredential[] {
    const rows = this.#database
      .prepare(
        `SELECT user_id, source_id, api_key, created_at, updated_at
           FROM model_credentials WHERE user_id = ? ORDER BY source_id`,
      )
      .all(userId) as unknown as ModelCredentialRow[];
    return rows.map((row) => this.#modelCredentialFromRow(row));
  }

  #modelCredentialFromRow(row: ModelCredentialRow): PrivateCredential {
    return privateCredentialSchema.parse({
      accessPolicy: {
        ...defaultPrivateCredentialAccessPolicy,
        allowedAgentIds: [],
        allowedProjectIds: [],
        deniedAgentIds: [],
        deniedProjectIds: [],
      },
      createdAt: row.created_at,
      expiresAt: null,
      fields: { sourceId: row.source_id },
      id: modelPrivateCredentialId(row.user_id, row.source_id),
      kind: "model",
      label: `Model source: ${row.source_id}`,
      purposes: ["model.api", "model.configure"],
      secrets: {
        apiKey: this.#decrypt(
          row.api_key,
          `model-source:${row.user_id}:${row.source_id}`,
        ),
      },
      source: { type: "scan" },
      tags: ["model-wallet"],
      updatedAt: row.updated_at,
    });
  }

  #modelSourceIdForPrivateCredentialId(
    userId: string,
    credentialId: string,
  ): string | undefined {
    const rows = this.#database
      .prepare(
        "SELECT source_id FROM model_credentials WHERE user_id = ?",
      )
      .all(userId) as Array<{ source_id: string }>;
    return rows.find(
      (row) => modelPrivateCredentialId(userId, row.source_id) === credentialId,
    )?.source_id;
  }

  #recordCredentialAccessAudit(input: {
    agentId: string;
    credentialId: string;
    decision: CredentialAccessAuditEvent["decision"];
    projectId?: string;
    purpose: string;
    reason: CredentialAccessAuditEvent["reason"];
    userId: string;
  }): void {
    const latest = this.#database
      .prepare(
        `SELECT MAX(created_at) AS created_at
           FROM credential_access_audit_events WHERE user_id = ?`,
      )
      .get(input.userId) as { created_at: string | null } | undefined;
    this.#database
      .prepare(
        `INSERT INTO credential_access_audit_events
           (id, user_id, credential_id, agent_id, project_id, purpose,
            decision, reason, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        randomUUID(),
        input.userId,
        input.credentialId,
        input.agentId,
        input.projectId ?? null,
        input.purpose,
        input.decision,
        input.reason,
        nextCredentialTimestamp(latest?.created_at ?? undefined),
      );
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
    const modelCredentialRows = this.#database
      .prepare(
        `SELECT source_id, api_key, created_at, updated_at
           FROM model_credentials WHERE user_id = ? ORDER BY source_id`,
      )
      .all(userId) as Array<{
      api_key: string;
      created_at: string;
      source_id: string;
      updated_at: string;
    }>;
    const ignoredModelSources = this.#database
      .prepare(
        "SELECT source_id, updated_at FROM model_credential_ignores WHERE user_id = ? ORDER BY source_id",
      )
      .all(userId) as Array<{ source_id: string; updated_at: string }>;
    const privateCredentialRows = this.#database
      .prepare(
        `SELECT id, user_id, payload, created_at, updated_at
           FROM private_credentials WHERE user_id = ? ORDER BY id`,
      )
      .all(userId) as unknown as PrivateCredentialRow[];
    const privateCredentialTombstones = this.#database
      .prepare(
        `SELECT credential_id, deleted_at
           FROM private_credential_tombstones
          WHERE user_id = ? ORDER BY credential_id`,
      )
      .all(userId) as Array<{
      credential_id: string;
      deleted_at: string;
    }>;

    return permissionVaultBundleSchema.parse({
      connections: connectionRows.map((row) => ({
        ...toConnection(row, false),
        credential: parseCredential(
          this.#decrypt(row.credentials, `connection:${userId}:${row.id}`),
        ),
      })),
      format: "one-status.permission-vault-bundle",
      grants: this.listGrants(userId),
      modelCredentials: modelCredentialRows.map((row) => ({
        apiKey: this.#decrypt(
          row.api_key,
          `model-source:${userId}:${row.source_id}`,
        ),
        createdAt: row.created_at,
        sourceId: row.source_id,
        updatedAt: row.updated_at,
      })),
      modelCredentialIgnores: ignoredModelSources.map((row) => ({
        sourceId: row.source_id,
        updatedAt: row.updated_at,
      })),
      privateCredentials: privateCredentialRows.map((row) =>
        this.#credentialFromRow(row),
      ),
      privateCredentialTombstones: privateCredentialTombstones.map((row) => ({
        credentialId: row.credential_id,
        deletedAt: row.deleted_at,
      })),
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
    const ignoredSourceIds = new Set(
      (bundle.modelCredentialIgnores ?? []).map((entry) => entry.sourceId),
    );
    if (
      bundle.modelCredentials.some((entry) =>
        ignoredSourceIds.has(entry.sourceId),
      )
    ) {
      throw new Error(
        "Permission Vault bundle cannot store and ignore the same model source.",
      );
    }
    const privateCredentials = bundle.privateCredentials ?? [];
    const privateCredentialTombstones =
      bundle.privateCredentialTombstones ?? [];
    assertUniqueValues(
      privateCredentials.map((entry) => entry.id),
      "Permission Vault bundle contains duplicate private credentials.",
    );
    assertUniqueValues(
      privateCredentialTombstones.map((entry) => entry.credentialId),
      "Permission Vault bundle contains duplicate private credential tombstones.",
    );
    const privateCredentialIds = new Set(
      privateCredentials.map((entry) => entry.id),
    );
    if (
      privateCredentialTombstones.some((entry) =>
        privateCredentialIds.has(entry.credentialId),
      )
    ) {
      throw new Error(
        "Permission Vault bundle cannot store and delete the same private credential.",
      );
    }
    const replacesPrivateCredentials =
      bundle.privateCredentials !== undefined ||
      bundle.privateCredentialTombstones !== undefined;

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
      this.#database
        .prepare("DELETE FROM model_credentials WHERE user_id = ?")
        .run(userId);
      if (bundle.modelCredentialIgnores) {
        this.#database
          .prepare("DELETE FROM model_credential_ignores WHERE user_id = ?")
          .run(userId);
      }
      if (replacesPrivateCredentials) {
        this.#database
          .prepare("DELETE FROM private_credentials WHERE user_id = ?")
          .run(userId);
        this.#database
          .prepare(
            "DELETE FROM private_credential_tombstones WHERE user_id = ?",
          )
          .run(userId);
      }

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

      for (const credential of bundle.modelCredentials) {
        const sourceId = requiredControlId(
          credential.sourceId,
          "Model source ID",
        );
        this.#database
          .prepare(
            `INSERT INTO model_credentials
               (user_id, source_id, api_key, created_at, updated_at)
             VALUES (?, ?, ?, ?, ?)`,
          )
          .run(
            userId,
            sourceId,
            this.#encrypt(
              requiredSecretValue(credential.apiKey, "Model API key", 32_000),
              `model-source:${userId}:${sourceId}`,
            ),
            credential.createdAt,
            credential.updatedAt,
          );
      }

      for (const ignored of bundle.modelCredentialIgnores ?? []) {
        this.#database
          .prepare(
            "INSERT INTO model_credential_ignores (user_id, source_id, updated_at) VALUES (?, ?, ?)",
          )
          .run(
            userId,
            requiredControlId(ignored.sourceId, "Model source ID"),
            ignored.updatedAt,
          );
      }

      if (replacesPrivateCredentials) {
        for (const credential of privateCredentials) {
          this.#database
            .prepare(
              `INSERT INTO private_credentials
                 (id, user_id, payload, created_at, updated_at)
               VALUES (?, ?, ?, ?, ?)`,
            )
            .run(
              credential.id,
              userId,
              this.#encrypt(
                JSON.stringify(credential),
                `private-credential:${userId}:${credential.id}`,
              ),
              credential.createdAt,
              credential.updatedAt,
            );
        }
        for (const tombstone of privateCredentialTombstones) {
          this.#database
            .prepare(
              `INSERT INTO private_credential_tombstones
                 (user_id, credential_id, deleted_at)
               VALUES (?, ?, ?)`,
            )
            .run(userId, tombstone.credentialId, tombstone.deletedAt);
        }
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
             UNION ALL
             SELECT updated_at FROM model_credentials WHERE user_id = ?
             UNION ALL
             SELECT updated_at FROM model_credential_ignores WHERE user_id = ?
             UNION ALL
             SELECT updated_at FROM private_credentials WHERE user_id = ?
             UNION ALL
             SELECT deleted_at AS updated_at
               FROM private_credential_tombstones WHERE user_id = ?
           )`,
      )
      .get(
        userId,
        userId,
        userId,
        userId,
        userId,
        userId,
        userId,
        userId,
      ) as
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

const credentialMetadataSchema = z
  .string()
  .min(1)
  .max(500)
  .refine((value) => value === value.trim() && !/[\u0000-\u001f\u007f]/.test(value));

const credentialMapKeySchema = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[A-Za-z][A-Za-z0-9_.-]*$/);

const credentialFieldsSchema = z
  .record(
    credentialMapKeySchema,
    z
      .string()
      .min(1)
      .max(8_000)
      .refine((value) => !value.includes("\0")),
  )
  .refine((value) => Object.keys(value).length <= 64);

const credentialSecretsSchema = z
  .record(
    credentialMapKeySchema,
    z
      .string()
      .min(1)
      .max(128_000)
      .refine((value) => value.trim().length > 0 && !value.includes("\0")),
  )
  .refine(
    (value) =>
      Object.keys(value).length >= 1 && Object.keys(value).length <= 64,
  );

const credentialStringListSchema = z
  .array(credentialMetadataSchema)
  .max(64)
  .refine((values) => new Set(values).size === values.length);

const privateCredentialSourceSchema: z.ZodType<PrivateCredentialSource> = z
  .object({
    agentId: credentialMetadataSchema.optional(),
    deviceId: credentialMetadataSchema.optional(),
    projectId: credentialMetadataSchema.optional(),
    type: z.enum(["user", "agent", "scan", "import"]),
  })
  .strict()
  .superRefine((source, context) => {
    if (source.type === "agent" && !source.agentId) {
      context.addIssue({
        code: "custom",
        message: "Agent-sourced credentials require an Agent ID.",
        path: ["agentId"],
      });
    }
  });

const privateCredentialAccessPolicySchema = z
  .object({
    allowAgentRead: z.boolean(),
    allowedAgentIds: credentialStringListSchema,
    allowedProjectIds: credentialStringListSchema,
    deniedAgentIds: credentialStringListSchema,
    deniedProjectIds: credentialStringListSchema,
    requireApproval: z.boolean(),
  })
  .strict();

const privateCredentialSchema: z.ZodType<PrivateCredential> = z
  .object({
    accessPolicy: privateCredentialAccessPolicySchema,
    createdAt: z.iso.datetime({ offset: true }),
    expiresAt: z.iso.datetime({ offset: true }).nullable(),
    fields: credentialFieldsSchema,
    id: z.uuid(),
    kind: z.enum(privateCredentialKinds),
    label: credentialMetadataSchema,
    purposes: credentialStringListSchema.min(1).max(32),
    secrets: credentialSecretsSchema,
    source: privateCredentialSourceSchema,
    tags: credentialStringListSchema.max(50),
    updatedAt: z.iso.datetime({ offset: true }),
  })
  .strict()
  .superRefine((credential, context) => {
    if (Date.parse(credential.updatedAt) < Date.parse(credential.createdAt)) {
      context.addIssue({
        code: "custom",
        message: "Credential update time precedes its creation time.",
        path: ["updatedAt"],
      });
    }
    const policy = credential.accessPolicy;
    if (
      policy.allowedAgentIds.some((agentId) =>
        policy.deniedAgentIds.includes(agentId),
      )
    ) {
      context.addIssue({
        code: "custom",
        message: "Credential Agent allow and deny lists overlap.",
        path: ["accessPolicy"],
      });
    }
    if (
      policy.allowedProjectIds.some((projectId) =>
        policy.deniedProjectIds.includes(projectId),
      )
    ) {
      context.addIssue({
        code: "custom",
        message: "Credential project allow and deny lists overlap.",
        path: ["accessPolicy"],
      });
    }
  });

const privateCredentialTombstoneSchema: z.ZodType<PrivateCredentialTombstone> =
  z
    .object({
      credentialId: z.uuid(),
      deletedAt: z.iso.datetime({ offset: true }),
    })
    .strict();

const upsertPrivateCredentialInputSchema = z
  .object({
    accessPolicy: privateCredentialAccessPolicySchema.partial().optional(),
    expiresAt: z.iso.datetime({ offset: true }).nullable().optional(),
    fields: credentialFieldsSchema.optional(),
    id: z.uuid().optional(),
    kind: z.enum(privateCredentialKinds),
    label: z.string().min(1).max(500),
    purposes: z.array(z.string().min(1).max(500)).min(1).max(32),
    secrets: credentialSecretsSchema.optional(),
    source: z
      .object({
        agentId: z.string().min(1).max(500).optional(),
        deviceId: z.string().min(1).max(500).optional(),
        projectId: z.string().min(1).max(500).optional(),
        type: z.enum(["user", "agent", "scan", "import"]),
      })
      .strict()
      .optional(),
    tags: z.array(z.string().min(1).max(500)).max(50).optional(),
    userId: z.string().min(1).max(500),
  })
  .strict();

const patchPrivateCredentialInputSchema = z
  .object({
    accessPolicy: privateCredentialAccessPolicySchema.partial().optional(),
    credentialId: z.uuid(),
    expiresAt: z.iso.datetime({ offset: true }).nullable().optional(),
    fields: credentialFieldsSchema.optional(),
    kind: z.enum(privateCredentialKinds).optional(),
    label: z.string().min(1).max(500).optional(),
    purposes: z.array(z.string().min(1).max(500)).min(1).max(32).optional(),
    secrets: credentialSecretsSchema.optional(),
    source: z
      .object({
        agentId: z.string().min(1).max(500).optional(),
        deviceId: z.string().min(1).max(500).optional(),
        projectId: z.string().min(1).max(500).optional(),
        type: z.enum(["user", "agent", "scan", "import"]).optional(),
      })
      .strict()
      .optional(),
    tags: z.array(z.string().min(1).max(500)).max(50).optional(),
    userId: z.string().min(1).max(500),
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
    modelCredentials: z
      .array(
        z
          .object({
            apiKey: z.string().min(1).max(32_000),
            createdAt: z.iso.datetime({ offset: true }),
            sourceId: z
              .string()
              .min(1)
              .max(200)
              .regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/),
            updatedAt: z.iso.datetime({ offset: true }),
          })
          .strict(),
      )
      .default([]),
    modelCredentialIgnores: z
      .array(
        z
          .object({
            sourceId: z
              .string()
              .min(1)
              .max(200)
              .regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/),
            updatedAt: z.iso.datetime({ offset: true }),
          })
          .strict(),
      )
      .optional(),
    privateCredentialTombstones: z
      .array(privateCredentialTombstoneSchema)
      .optional(),
    privateCredentials: z.array(privateCredentialSchema).optional(),
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
    modelCredentials: Array.isArray(bundle.modelCredentials)
      ? bundle.modelCredentials
      : [],
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

function modelPrivateCredentialId(userId: string, sourceId: string): string {
  const bytes = createHash("sha256")
    .update("one-status/model-private-credential/v1\0", "utf8")
    .update(userId, "utf8")
    .update("\0", "utf8")
    .update(sourceId, "utf8")
    .digest()
    .subarray(0, 16);
  bytes[6] = (bytes[6]! & 0x0f) | 0x50;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return [
    hex.slice(0, 8),
    hex.slice(8, 12),
    hex.slice(12, 16),
    hex.slice(16, 20),
    hex.slice(20),
  ].join("-");
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

const defaultPrivateCredentialAccessPolicy: PrivateCredentialAccessPolicy = {
  allowAgentRead: true,
  allowedAgentIds: [],
  allowedProjectIds: [],
  deniedAgentIds: [],
  deniedProjectIds: [],
  requireApproval: false,
};

function normalizePrivateCredentialInput(
  value: UpsertPrivateCredentialInput,
): {
  accessPolicy: PrivateCredentialAccessPolicy;
  expiresAt: string | null;
  fields: Record<string, string>;
  id?: string;
  kind: PrivateCredentialKind;
  label: string;
  purposes: string[];
  secrets: Record<string, string>;
  source: PrivateCredentialSource;
  tags: string[];
  userId: string;
} {
  const input = upsertPrivateCredentialInputSchema.parse(value);
  const accessPolicy: PrivateCredentialAccessPolicy = {
    allowAgentRead:
      input.accessPolicy?.allowAgentRead ??
      defaultPrivateCredentialAccessPolicy.allowAgentRead,
    allowedAgentIds: normalizeCredentialStringList(
      input.accessPolicy?.allowedAgentIds ?? [],
      "Allowed Agent ID",
    ),
    allowedProjectIds: normalizeCredentialStringList(
      input.accessPolicy?.allowedProjectIds ?? [],
      "Allowed project ID",
    ),
    deniedAgentIds: normalizeCredentialStringList(
      input.accessPolicy?.deniedAgentIds ?? [],
      "Denied Agent ID",
    ),
    deniedProjectIds: normalizeCredentialStringList(
      input.accessPolicy?.deniedProjectIds ?? [],
      "Denied project ID",
    ),
    requireApproval:
      input.accessPolicy?.requireApproval ??
      defaultPrivateCredentialAccessPolicy.requireApproval,
  };
  assertDisjointValues(
    accessPolicy.allowedAgentIds,
    accessPolicy.deniedAgentIds,
    "Credential Agent allow and deny lists overlap.",
  );
  assertDisjointValues(
    accessPolicy.allowedProjectIds,
    accessPolicy.deniedProjectIds,
    "Credential project allow and deny lists overlap.",
  );
  const source: PrivateCredentialSource = {
    type: input.source?.type ?? "user",
    ...(input.source?.agentId
      ? {
          agentId: requiredMetadataValue(
            input.source.agentId,
            "Source Agent ID",
            500,
          ),
        }
      : {}),
    ...(input.source?.deviceId
      ? {
          deviceId: requiredMetadataValue(
            input.source.deviceId,
            "Source device ID",
            500,
          ),
        }
      : {}),
    ...(input.source?.projectId
      ? {
          projectId: requiredMetadataValue(
            input.source.projectId,
            "Source project ID",
            500,
          ),
        }
      : {}),
  };
  privateCredentialSourceSchema.parse(source);
  return {
    accessPolicy,
    expiresAt: input.expiresAt ?? null,
    fields: normalizeCredentialMap(input.fields ?? {}, true),
    ...(input.id ? { id: input.id } : {}),
    kind: input.kind,
    label: requiredMetadataValue(input.label, "Credential label", 500),
    purposes: normalizeCredentialStringList(
      input.purposes,
      "Credential purpose",
    ),
    secrets: normalizeCredentialMap(input.secrets ?? {}, false),
    source,
    tags: normalizeCredentialStringList(input.tags ?? [], "Credential tag"),
    userId: requiredMetadataValue(input.userId, "User ID", 500),
  };
}

function normalizeCredentialMap(
  values: Record<string, string>,
  trimValues: boolean,
): Record<string, string> {
  return Object.fromEntries(
    Object.entries(values)
      .map(([key, value]) => [key, trimValues ? value.trim() : value] as const)
      .sort(([left], [right]) => left.localeCompare(right)),
  );
}

function normalizeCredentialStringList(
  values: string[],
  label: string,
): string[] {
  return [
    ...new Set(
      values.map((value) => requiredMetadataValue(value, label, 500)),
    ),
  ].sort((left, right) => left.localeCompare(right));
}

function normalizeCredentialFilter(filter: {
  kinds?: PrivateCredentialKind[];
  purposes?: string[];
  tags?: string[];
}): {
  kinds: PrivateCredentialKind[];
  purposes: string[];
  tags: string[];
} {
  return {
    kinds: [
      ...new Set(
        (filter.kinds ?? []).map((kind) =>
          z.enum(privateCredentialKinds).parse(kind),
        ),
      ),
    ],
    purposes: normalizeCredentialStringList(
      filter.purposes ?? [],
      "Credential purpose",
    ),
    tags: normalizeCredentialStringList(filter.tags ?? [], "Credential tag"),
  };
}

function credentialMatchesFilter(
  credential: PrivateCredential,
  filter: { kinds: PrivateCredentialKind[]; purposes: string[]; tags: string[] },
): boolean {
  if (filter.kinds.length > 0 && !filter.kinds.includes(credential.kind)) {
    return false;
  }
  if (
    filter.purposes.length > 0 &&
    !filter.purposes.every((purpose) =>
      credential.purposes.some((stored) =>
        credentialPurposeMatches(stored, purpose),
      ),
    )
  ) {
    return false;
  }
  const tags = new Set(credential.tags.map((tag) => tag.toLocaleLowerCase()));
  return filter.tags.every((tag) => tags.has(tag.toLocaleLowerCase()));
}

function credentialPurposeMatches(
  storedValue: string,
  requestedValue: string,
): boolean {
  const stored = storedValue.toLocaleLowerCase();
  const requested = requestedValue.toLocaleLowerCase();
  if (stored === "*" || stored === requested) return true;
  return [".", ":", "/"].some(
    (separator) =>
      stored.startsWith(`${requested}${separator}`) ||
      requested.startsWith(`${stored}${separator}`),
  );
}

function credentialAccessDecision(
  credential: PrivateCredential,
  input: {
    agentId: string;
    approved: boolean;
    projectId?: string;
    purpose: string;
  },
): CredentialAccessAuditEvent["reason"] {
  if (
    credential.expiresAt &&
    Date.parse(credential.expiresAt) <= Date.now()
  ) {
    return "credential_expired";
  }
  if (
    !credential.purposes.some((purpose) =>
      credentialPurposeMatches(purpose, input.purpose),
    )
  ) {
    return "purpose_mismatch";
  }
  const policy = credential.accessPolicy;
  if (!policy.allowAgentRead || policy.deniedAgentIds.includes(input.agentId)) {
    return "agent_denied";
  }
  if (
    policy.allowedAgentIds.length > 0 &&
    !policy.allowedAgentIds.includes(input.agentId)
  ) {
    return "agent_not_allowed";
  }
  if (input.projectId && policy.deniedProjectIds.includes(input.projectId)) {
    return "project_denied";
  }
  if (
    policy.allowedProjectIds.length > 0 &&
    (!input.projectId || !policy.allowedProjectIds.includes(input.projectId))
  ) {
    return "project_not_allowed";
  }
  if (policy.requireApproval && !input.approved) return "approval_required";
  return "allowed";
}

function maskPrivateCredential(
  credential: PrivateCredential,
): MaskedPrivateCredential {
  return {
    ...credential,
    secrets: Object.fromEntries(
      Object.keys(credential.secrets).map((key) => [key, "********" as const]),
    ),
  };
}

function samePrivateCredentialContent(
  left: PrivateCredential,
  right: PrivateCredential,
): boolean {
  const withoutTimestamps = (credential: PrivateCredential) => {
    const { createdAt: _createdAt, updatedAt: _updatedAt, ...content } =
      credential;
    return content;
  };
  return (
    JSON.stringify(withoutTimestamps(left)) ===
    JSON.stringify(withoutTimestamps(right))
  );
}

function nextCredentialTimestamp(...values: Array<string | undefined>): string {
  const previous = Math.max(
    0,
    ...values
      .map((value) => (value ? Date.parse(value) : Number.NaN))
      .filter(Number.isFinite),
  );
  return new Date(Math.max(Date.now(), previous + 1)).toISOString();
}

function requiredUuid(value: string, label: string): string {
  const result = z.uuid().safeParse(value);
  if (!result.success) throw new Error(`${label} is invalid.`);
  return result.data;
}

function requiredMetadataValue(
  value: string,
  label: string,
  maxLength: number,
): string {
  const normalized = value.trim();
  if (
    !normalized ||
    normalized.length > maxLength ||
    /[\u0000-\u001f\u007f]/.test(normalized)
  ) {
    throw new Error(`${label} is invalid.`);
  }
  return normalized;
}

function assertDisjointValues(
  left: string[],
  right: string[],
  message: string,
): void {
  const rightValues = new Set(right);
  if (left.some((value) => rightValues.has(value))) throw new Error(message);
}

function assertUniqueValues(values: string[], message: string): void {
  if (new Set(values).size !== values.length) throw new Error(message);
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

function safeSecretEqual(left: string, right: string): boolean {
  const digest = (value: string) =>
    createHash("sha256")
      .update("one-status/secret-comparison/v1\0", "utf8")
      .update(value, "utf8")
      .digest();
  return timingSafeEqual(digest(left), digest(right));
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

function requiredControlId(value: string, label: string): string {
  const normalized = value.trim();
  if (
    normalized.length < 1 ||
    normalized.length > 200 ||
    !/^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(normalized)
  ) {
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
