import { createHash, randomBytes, randomUUID, scrypt, timingSafeEqual } from "node:crypto";
import { chmodSync, mkdirSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname } from "node:path";
import { promisify } from "node:util";
import type { DatabaseSync as DatabaseSyncType } from "node:sqlite";
import {
  encryptedEnvelopeSchema,
  wrappedStatusKeySchema,
  type AccountResponse,
  type AuthResponse,
  type EncryptedEnvelope,
  type StatusKeyMigrationResponse,
  type StatusSnapshot,
  type WrappedStatusKey,
} from "@one-status/protocol";

const scryptAsync = promisify(scrypt);
const nodeRequire = createRequire(import.meta.url);
const PASSWORD_HASH_BYTES = 64;
const SESSION_DAYS = 30;
const AGENT_CREDENTIAL_HOURS = 24;
const AGENT_CREDENTIAL_PREFIX = "osa1_";
const MUTATION_RECEIPT_DAYS = 30;
const MAX_MUTATION_RECEIPTS_PER_USER = 10_000;
const DEVICE_ONLINE_WINDOW_MS = 90_000;
const DEVICE_TOUCH_INTERVAL_MS = 15_000;

interface UserRow {
  id: string;
  email: string;
  password_salt: string;
  password_hash: string;
  wrapped_status_key: string | null;
  deny_new_device_logins: number;
  created_at: string;
}

interface SessionRow {
  status_key_migration_eligible: number;
  user_id: string;
  device_id: string;
  expires_at: string;
}

interface AgentCredentialRow {
  credential_id: string;
  user_id: string;
  device_id: string;
  agent_id: string;
  expires_at: string;
}

interface StatusRow {
  version: number;
  envelope: string;
  updated_at: string;
}

interface MutationReceiptRow {
  mutation_digest: string;
  resulting_version: number;
  created_at: string;
}

interface DeviceRow {
  id: string;
  name: string;
  created_at: string;
  last_seen_at: string;
  blocked: number;
}

export class EmailAlreadyRegisteredError extends Error {}
export class InvalidCredentialsError extends Error {}
export class DeviceLoginBlockedError extends Error {}
export class NewDeviceLoginDeniedError extends Error {}
export class StatusKeyMigrationNotAllowedError extends Error {}
export class MutationIdConflictError extends Error {}

export class VersionConflictError extends Error {
  constructor(readonly currentVersion: number) {
    super(`Status version conflict. Current version is ${currentVersion}.`);
  }
}

export interface AuthenticatedSession {
  userId: string;
  deviceId: string;
  expiresAt?: string;
  statusKeyMigrationEligible?: boolean;
}

export interface AuthenticatedAgentSession extends AuthenticatedSession {
  agentId: string;
  credentialId: string;
  authentication: "agent";
}

export interface IssuedAgentCredential {
  agentId: string;
  credentialId: string;
  deviceId: string;
  expiresAt: string;
  token: string;
}

export class OneStatusDatabase {
  readonly #database: DatabaseSyncType;

  constructor(path: string) {
    const persistent = path !== ":memory:";
    if (persistent) {
      const directory = dirname(path);
      const created = mkdirSync(directory, { recursive: true, mode: 0o700 });
      if (created) chmodSync(directory, 0o700);
    }
    const { DatabaseSync } = nodeRequire("node:sqlite") as typeof import("node:sqlite");
    this.#database = new DatabaseSync(path);
    if (persistent) chmodSync(path, 0o600);
    this.#database.exec("PRAGMA foreign_keys = ON");
    this.#database.exec("PRAGMA busy_timeout = 500");
    this.#database.exec("PRAGMA journal_mode = WAL");
    this.#database.exec(`
      CREATE TABLE IF NOT EXISTS users (
        id TEXT PRIMARY KEY,
        email TEXT NOT NULL UNIQUE,
        password_salt TEXT NOT NULL,
        password_hash TEXT NOT NULL,
        wrapped_status_key TEXT,
        deny_new_device_logins INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS devices (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        name TEXT NOT NULL,
        created_at TEXT NOT NULL,
        last_seen_at TEXT NOT NULL,
        blocked INTEGER NOT NULL DEFAULT 0
      );

      CREATE TABLE IF NOT EXISTS sessions (
        token_hash TEXT PRIMARY KEY,
        user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        device_id TEXT NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
        expires_at TEXT NOT NULL,
        status_key_migration_eligible INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS agent_credentials (
        credential_id TEXT PRIMARY KEY,
        token_hash TEXT NOT NULL UNIQUE,
        user_id TEXT NOT NULL,
        device_id TEXT NOT NULL,
        agent_id TEXT NOT NULL,
        expires_at TEXT NOT NULL,
        revoked_at TEXT,
        created_at TEXT NOT NULL,
        last_used_at TEXT
      );

      CREATE INDEX IF NOT EXISTS agent_credentials_identity
        ON agent_credentials(user_id, device_id, agent_id);

      CREATE INDEX IF NOT EXISTS agent_credentials_expiry
        ON agent_credentials(expires_at);

      CREATE TABLE IF NOT EXISTS status_vaults (
        user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
        version INTEGER NOT NULL,
        envelope TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS status_mutation_receipts (
        user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        mutation_id TEXT NOT NULL,
        mutation_digest TEXT NOT NULL,
        resulting_version INTEGER NOT NULL,
        created_at TEXT NOT NULL,
        PRIMARY KEY (user_id, mutation_id)
      );

      CREATE INDEX IF NOT EXISTS status_mutation_receipts_created
        ON status_mutation_receipts(user_id, created_at);

      DROP TABLE IF EXISTS status_mutations;
    `);
    ensureColumn(this.#database, "users", "wrapped_status_key", "TEXT");
    ensureColumn(
      this.#database,
      "users",
      "deny_new_device_logins",
      "INTEGER NOT NULL DEFAULT 0",
    );
    ensureColumn(
      this.#database,
      "sessions",
      "status_key_migration_eligible",
      "INTEGER NOT NULL DEFAULT 0",
    );
    ensureColumn(
      this.#database,
      "devices",
      "blocked",
      "INTEGER NOT NULL DEFAULT 0",
    );
  }

  close(): void {
    this.#database.close();
  }

  async register(
    email: string,
    password: string,
    deviceName: string,
    initialEnvelope: EncryptedEnvelope,
    wrappedStatusKey: WrappedStatusKey | undefined,
    installationId?: string,
  ): Promise<AuthResponse> {
    const existing = this.#database
      .prepare("SELECT id FROM users WHERE email = ?")
      .get(email);
    if (existing) {
      throw new EmailAlreadyRegisteredError("Email is already registered.");
    }

    const now = new Date().toISOString();
    const userId = randomUUID();
    const salt = randomBytes(16);
    const passwordHash = await derivePasswordHash(password, salt);

    this.#database.exec("BEGIN IMMEDIATE");
    try {
      this.#database
        .prepare(
          `INSERT INTO users
             (id, email, password_salt, password_hash, wrapped_status_key,
              created_at)
           VALUES (?, ?, ?, ?, ?, ?)`,
        )
        .run(
          userId,
          email,
          salt.toString("base64url"),
          passwordHash.toString("base64url"),
          wrappedStatusKey ? JSON.stringify(wrappedStatusKey) : null,
          now,
        );
      const response = this.#createDeviceSession(
        userId,
        deviceName,
        now,
        wrappedStatusKey ?? null,
        wrappedStatusKey === undefined,
        installationId,
      );
      this.#database
        .prepare(
          `INSERT INTO status_vaults (user_id, version, envelope, updated_at)
           VALUES (?, 1, ?, ?)`,
        )
        .run(userId, JSON.stringify(initialEnvelope), now);
      this.#database.exec("COMMIT");
      return response;
    } catch (error) {
      this.#database.exec("ROLLBACK");
      if (String(error).includes("UNIQUE constraint failed: users.email")) {
        throw new EmailAlreadyRegisteredError("Email is already registered.");
      }
      throw error;
    }
  }

  async login(
    email: string,
    password: string,
    deviceName: string,
    installationId?: string,
  ): Promise<AuthResponse> {
    const user = this.#database
      .prepare("SELECT * FROM users WHERE email = ?")
      .get(email) as unknown as UserRow | undefined;

    if (!user) {
      await derivePasswordHash(password, randomBytes(16));
      throw new InvalidCredentialsError("Invalid email or password.");
    }

    const actualHash = await derivePasswordHash(
      password,
      Buffer.from(user.password_salt, "base64url"),
    );
    const expectedHash = Buffer.from(user.password_hash, "base64url");
    if (!timingSafeEqual(actualHash, expectedHash)) {
      throw new InvalidCredentialsError("Invalid email or password.");
    }

    const deviceId = installationId ?? randomUUID();
    const existingDevice = this.#database
      .prepare("SELECT user_id, blocked FROM devices WHERE id = ?")
      .get(deviceId) as { user_id: string; blocked: number } | undefined;
    if (existingDevice?.user_id === user.id && existingDevice.blocked === 1) {
      throw new DeviceLoginBlockedError("This device has been blocked.");
    }
    if (!existingDevice && user.deny_new_device_logins === 1) {
      throw new NewDeviceLoginDeniedError(
        "New device logins are disabled for this account.",
      );
    }

    this.#database.exec("BEGIN IMMEDIATE");
    try {
      const response = this.#createDeviceSession(
        user.id,
        deviceName,
        new Date().toISOString(),
        user.wrapped_status_key
          ? wrappedStatusKeySchema.parse(JSON.parse(user.wrapped_status_key))
          : null,
        existingDevice?.user_id === user.id,
        deviceId,
      );
      this.#database.exec("COMMIT");
      return response;
    } catch (error) {
      this.#database.exec("ROLLBACK");
      throw error;
    }
  }

  authenticate(token: string): AuthenticatedSession | null {
    const now = new Date().toISOString();
    const session = this.#database
      .prepare(
        `SELECT user_id, device_id, expires_at,
                status_key_migration_eligible
           FROM sessions
          WHERE token_hash = ? AND expires_at > ?`,
      )
      .get(hashToken(token), now) as unknown as SessionRow | undefined;

    if (!session) {
      return null;
    }

    this.#touchDevice(session.user_id, session.device_id, now, false);

    return {
      userId: session.user_id,
      deviceId: session.device_id,
      expiresAt: session.expires_at,
      statusKeyMigrationEligible: Boolean(
        session.status_key_migration_eligible,
      ),
    };
  }

  issueAgentCredential(
    session: AuthenticatedSession,
    agentId: string,
    options: { now?: Date; ttlMs?: number } = {},
  ): IssuedAgentCredential {
    const normalizedAgentId = normalizeAgentId(agentId);
    const now = options.now ?? new Date();
    const nowIso = now.toISOString();
    const ttlMs =
      options.ttlMs ?? AGENT_CREDENTIAL_HOURS * 60 * 60 * 1_000;
    if (!Number.isSafeInteger(ttlMs) || ttlMs <= 0) {
      throw new Error("Agent credential lifetime must be a positive integer.");
    }
    const sessionExpiry = session.expiresAt
      ? Date.parse(session.expiresAt)
      : Number.POSITIVE_INFINITY;
    if (Number.isNaN(sessionExpiry) || sessionExpiry <= now.getTime()) {
      throw new Error("The device session has expired.");
    }
    const expiresAt = new Date(
      Math.min(now.getTime() + ttlMs, sessionExpiry),
    ).toISOString();
    const credentialId = randomUUID();
    const token = `${AGENT_CREDENTIAL_PREFIX}${randomBytes(32).toString("base64url")}`;

    this.#database.exec("BEGIN IMMEDIATE");
    try {
      this.#database
        .prepare("DELETE FROM agent_credentials WHERE expires_at <= ?")
        .run(nowIso);
      this.#database
        .prepare(
          `INSERT INTO agent_credentials
             (credential_id, token_hash, user_id, device_id, agent_id,
              expires_at, revoked_at, created_at, last_used_at)
           VALUES (?, ?, ?, ?, ?, ?, NULL, ?, NULL)`,
        )
        .run(
          credentialId,
          hashToken(token),
          session.userId,
          session.deviceId,
          normalizedAgentId,
          expiresAt,
          nowIso,
        );
      this.#database.exec("COMMIT");
    } catch (error) {
      this.#database.exec("ROLLBACK");
      throw error;
    }

    return {
      agentId: normalizedAgentId,
      credentialId,
      deviceId: session.deviceId,
      expiresAt,
      token,
    };
  }

  authenticateAgent(
    token: string,
    now = new Date(),
  ): AuthenticatedAgentSession | null {
    if (!token.startsWith(AGENT_CREDENTIAL_PREFIX)) return null;
    const nowIso = now.toISOString();
    const credential = this.#database
      .prepare(
        `SELECT credential_id, user_id, device_id, agent_id, expires_at
           FROM agent_credentials
          WHERE token_hash = ?
            AND revoked_at IS NULL
            AND expires_at > ?`,
      )
      .get(hashToken(token), nowIso) as unknown as
      | AgentCredentialRow
      | undefined;
    if (!credential) return null;

    this.#database
      .prepare(
        `UPDATE agent_credentials
            SET last_used_at = ?
          WHERE credential_id = ?`,
      )
      .run(nowIso, credential.credential_id);
    this.#touchDevice(credential.user_id, credential.device_id, nowIso, false);
    return {
      authentication: "agent",
      agentId: credential.agent_id,
      credentialId: credential.credential_id,
      deviceId: credential.device_id,
      expiresAt: credential.expires_at,
      userId: credential.user_id,
    };
  }

  revokeAgentCredential(
    userId: string,
    deviceId: string,
    credentialId: string,
  ): boolean {
    const result = this.#database
      .prepare(
        `UPDATE agent_credentials
            SET revoked_at = ?
          WHERE credential_id = ?
            AND user_id = ?
            AND device_id = ?
            AND revoked_at IS NULL`,
      )
      .run(new Date().toISOString(), credentialId, userId, deviceId);
    return Number(result.changes) > 0;
  }

  heartbeat(userId: string, deviceId: string): {
    deviceId: string;
    lastSeenAt: string;
    serverTime: string;
  } {
    const now = new Date().toISOString();
    this.#touchDevice(userId, deviceId, now, true);
    return { deviceId, lastSeenAt: now, serverTime: now };
  }

  revokeSession(token: string): boolean {
    const tokenHash = hashToken(token);
    const session = this.#database
      .prepare("SELECT user_id, device_id, expires_at FROM sessions WHERE token_hash = ?")
      .get(tokenHash) as unknown as SessionRow | undefined;
    if (!session) return false;
    const now = new Date().toISOString();
    this.#database.exec("BEGIN IMMEDIATE");
    try {
      this.#database
        .prepare("DELETE FROM sessions WHERE token_hash = ?")
        .run(tokenHash);
      this.#database
        .prepare(
          `UPDATE agent_credentials
              SET revoked_at = ?
            WHERE user_id = ? AND device_id = ? AND revoked_at IS NULL`,
        )
        .run(now, session.user_id, session.device_id);
      this.#database.exec("COMMIT");
      return true;
    } catch (error) {
      this.#database.exec("ROLLBACK");
      throw error;
    }
  }

  revokeDevice(userId: string, deviceId: string): boolean {
    const now = new Date().toISOString();
    this.#database.exec("BEGIN IMMEDIATE");
    try {
      this.#database
        .prepare(
          `UPDATE agent_credentials
              SET revoked_at = ?
            WHERE user_id = ? AND device_id = ? AND revoked_at IS NULL`,
        )
        .run(now, userId, deviceId);
      const result = this.#database
        .prepare("DELETE FROM devices WHERE user_id = ? AND id = ?")
        .run(userId, deviceId);
      this.#database.exec("COMMIT");
      return Number(result.changes) > 0;
    } catch (error) {
      this.#database.exec("ROLLBACK");
      throw error;
    }
  }

  revokeDeviceSessions(userId: string, deviceId: string): number | undefined {
    const existing = this.#database
      .prepare("SELECT 1 FROM devices WHERE user_id = ? AND id = ?")
      .get(userId, deviceId);
    if (!existing) return undefined;
    const now = new Date().toISOString();
    this.#database.exec("BEGIN IMMEDIATE");
    try {
      const result = this.#database
        .prepare("DELETE FROM sessions WHERE user_id = ? AND device_id = ?")
        .run(userId, deviceId);
      this.#database
        .prepare(
          `UPDATE agent_credentials
              SET revoked_at = ?
            WHERE user_id = ? AND device_id = ? AND revoked_at IS NULL`,
        )
        .run(now, userId, deviceId);
      this.#database.exec("COMMIT");
      return Number(result.changes);
    } catch (error) {
      this.#database.exec("ROLLBACK");
      throw error;
    }
  }

  blockDevice(userId: string, deviceId: string): boolean {
    const now = new Date().toISOString();
    this.#database.exec("BEGIN IMMEDIATE");
    try {
      const result = this.#database
        .prepare(
          "UPDATE devices SET blocked = 1 WHERE user_id = ? AND id = ?",
        )
        .run(userId, deviceId);
      if (Number(result.changes) === 0) {
        this.#database.exec("ROLLBACK");
        return false;
      }
      this.#database
        .prepare("DELETE FROM sessions WHERE user_id = ? AND device_id = ?")
        .run(userId, deviceId);
      this.#database
        .prepare(
          `UPDATE agent_credentials
              SET revoked_at = ?
            WHERE user_id = ? AND device_id = ? AND revoked_at IS NULL`,
        )
        .run(now, userId, deviceId);
      this.#database.exec("COMMIT");
      return true;
    } catch (error) {
      this.#database.exec("ROLLBACK");
      throw error;
    }
  }

  unblockDevice(userId: string, deviceId: string): boolean {
    const result = this.#database
      .prepare(
        "UPDATE devices SET blocked = 0 WHERE user_id = ? AND id = ? AND blocked = 1",
      )
      .run(userId, deviceId);
    return Number(result.changes) > 0;
  }

  setDeviceLoginPolicy(
    userId: string,
    denyNewDeviceLogins: boolean,
  ): { denyNewDeviceLogins: boolean } {
    this.#database
      .prepare(
        "UPDATE users SET deny_new_device_logins = ? WHERE id = ?",
      )
      .run(denyNewDeviceLogins ? 1 : 0, userId);
    return { denyNewDeviceLogins };
  }

  async migrateWrappedStatusKey(
    session: AuthenticatedSession,
    password: string,
    wrappedStatusKey: WrappedStatusKey,
  ): Promise<StatusKeyMigrationResponse> {
    const user = this.#database
      .prepare("SELECT * FROM users WHERE id = ?")
      .get(session.userId) as unknown as UserRow | undefined;
    if (!user) throw new InvalidCredentialsError("Invalid email or password.");
    const actualHash = await derivePasswordHash(
      password,
      Buffer.from(user.password_salt, "base64url"),
    );
    const expectedHash = Buffer.from(user.password_hash, "base64url");
    if (!timingSafeEqual(actualHash, expectedHash)) {
      throw new InvalidCredentialsError("Invalid email or password.");
    }

    if (user.wrapped_status_key) {
      return {
        migrated: false,
        wrappedStatusKey: wrappedStatusKeySchema.parse(
          JSON.parse(user.wrapped_status_key),
        ),
      };
    }
    if (session.statusKeyMigrationEligible !== true) {
      throw new StatusKeyMigrationNotAllowedError(
        "Status Key migration must be completed from a previously connected device.",
      );
    }

    const serialized = JSON.stringify(wrappedStatusKey);
    this.#database
      .prepare(
        `UPDATE users SET wrapped_status_key = ?
          WHERE id = ? AND wrapped_status_key IS NULL`,
      )
      .run(serialized, session.userId);
    const stored = this.#database
      .prepare("SELECT wrapped_status_key FROM users WHERE id = ?")
      .get(session.userId) as { wrapped_status_key: string | null };
    if (!stored.wrapped_status_key) {
      throw new Error("Status Key migration did not persist.");
    }
    return {
      migrated: stored.wrapped_status_key === serialized,
      wrappedStatusKey: wrappedStatusKeySchema.parse(
        JSON.parse(stored.wrapped_status_key),
      ),
    };
  }

  getStatus(userId: string): StatusSnapshot {
    const row = this.#database
      .prepare(
        "SELECT version, envelope, updated_at FROM status_vaults WHERE user_id = ?",
      )
      .get(userId) as unknown as StatusRow | undefined;

    if (!row) {
      return { version: 0, envelope: null, updatedAt: null };
    }

    return {
      version: row.version,
      envelope: encryptedEnvelopeSchema.parse(JSON.parse(row.envelope)),
      updatedAt: row.updated_at,
    };
  }

  putStatus(
    userId: string,
    mutationId: string,
    mutationDigest: string,
    baseVersion: number,
    envelope: EncryptedEnvelope,
  ): StatusSnapshot {
    const now = new Date().toISOString();
    this.#database.exec("BEGIN IMMEDIATE");
    try {
      const previousMutation = this.#database
        .prepare(
          `SELECT mutation_digest, resulting_version, created_at
             FROM status_mutation_receipts
            WHERE user_id = ? AND mutation_id = ?`,
        )
        .get(userId, mutationId) as unknown as MutationReceiptRow | undefined;
      if (previousMutation) {
        if (previousMutation.mutation_digest !== mutationDigest) {
          throw new MutationIdConflictError(
            "mutationId was already used for a different logical mutation.",
          );
        }
        this.#database.exec("COMMIT");
        return { ...this.getStatus(userId), deduplicated: true };
      }

      const current = this.#database
        .prepare("SELECT version FROM status_vaults WHERE user_id = ?")
        .get(userId) as { version: number } | undefined;
      const currentVersion = current?.version ?? 0;
      if (currentVersion !== baseVersion) {
        throw new VersionConflictError(currentVersion);
      }

      const nextVersion = currentVersion + 1;
      this.#database
        .prepare(
          `INSERT INTO status_vaults (user_id, version, envelope, updated_at)
           VALUES (?, ?, ?, ?)
           ON CONFLICT(user_id) DO UPDATE SET
             version = excluded.version,
             envelope = excluded.envelope,
             updated_at = excluded.updated_at`,
        )
        .run(userId, nextVersion, JSON.stringify(envelope), now);
      this.#database
        .prepare(
          `INSERT INTO status_mutation_receipts
             (user_id, mutation_id, mutation_digest, resulting_version, created_at)
           VALUES (?, ?, ?, ?, ?)`,
        )
        .run(userId, mutationId, mutationDigest, nextVersion, now);
      this.#pruneMutationReceipts(userId, now);
      this.#database.exec("COMMIT");
      return { version: nextVersion, envelope, updatedAt: now };
    } catch (error) {
      this.#database.exec("ROLLBACK");
      throw error;
    }
  }

  getAccount(userId: string): AccountResponse {
    const user = this.#database
      .prepare(
        `SELECT id, email, created_at, deny_new_device_logins
           FROM users
          WHERE id = ?`,
      )
      .get(userId) as {
        id: string;
        email: string;
        created_at: string;
        deny_new_device_logins: number;
      };
    const devices = this.#database
      .prepare(
        `SELECT id, name, created_at, last_seen_at, blocked
           FROM devices
          WHERE user_id = ?
          ORDER BY created_at ASC`,
      )
      .all(userId) as unknown as DeviceRow[];

    const onlineCutoff = Date.now() - DEVICE_ONLINE_WINDOW_MS;
    return {
      user: { id: user.id, email: user.email, createdAt: user.created_at },
      devices: devices.map((device) => ({
        id: device.id,
        name: device.name,
        createdAt: device.created_at,
        lastSeenAt: device.last_seen_at,
        online: Date.parse(device.last_seen_at) >= onlineCutoff,
        blocked: Boolean(device.blocked),
      })),
      deviceLoginPolicy: {
        denyNewDeviceLogins: Boolean(user.deny_new_device_logins),
      },
    };
  }

  #createDeviceSession(
    userId: string,
    deviceName: string,
    now: string,
    wrappedStatusKey: WrappedStatusKey | null,
    statusKeyMigrationEligible: boolean,
    installationId?: string,
  ): AuthResponse {
    const deviceId = installationId ?? randomUUID();
    const token = randomBytes(32).toString("base64url");
    const expiresAt = new Date(
      Date.parse(now) + SESSION_DAYS * 24 * 60 * 60 * 1_000,
    ).toISOString();

    this.#database
      .prepare("DELETE FROM sessions WHERE expires_at <= ?")
      .run(now);

    const existingDevice = this.#database
      .prepare("SELECT user_id FROM devices WHERE id = ?")
      .get(deviceId) as { user_id: string } | undefined;
    if (existingDevice && existingDevice.user_id !== userId) {
      throw new Error("Installation ID is already assigned to another account.");
    }
    this.#database
      .prepare(
        `INSERT INTO devices (id, user_id, name, created_at, last_seen_at)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           name = excluded.name,
           last_seen_at = excluded.last_seen_at`,
      )
      .run(deviceId, userId, deviceName, now, now);
    this.#database
      .prepare(
        `INSERT INTO sessions
           (token_hash, user_id, device_id, expires_at,
            status_key_migration_eligible, created_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(
        hashToken(token),
        userId,
        deviceId,
        expiresAt,
        statusKeyMigrationEligible ? 1 : 0,
        now,
      );

    return { userId, deviceId, token, expiresAt, wrappedStatusKey };
  }

  #touchDevice(
    userId: string,
    deviceId: string,
    now: string,
    force: boolean,
  ): void {
    const cutoff = new Date(
      Date.parse(now) - DEVICE_TOUCH_INTERVAL_MS,
    ).toISOString();
    this.#database
      .prepare(
        `UPDATE devices
            SET last_seen_at = ?
          WHERE user_id = ? AND id = ?
            AND (? = 1 OR last_seen_at < ?)`,
      )
      .run(now, userId, deviceId, force ? 1 : 0, cutoff);
  }

  #pruneMutationReceipts(userId: string, now: string): void {
    const cutoff = new Date(
      Date.parse(now) - MUTATION_RECEIPT_DAYS * 24 * 60 * 60 * 1_000,
    ).toISOString();
    this.#database
      .prepare(
        `DELETE FROM status_mutation_receipts
          WHERE user_id = ? AND created_at < ?`,
      )
      .run(userId, cutoff);
    this.#database
      .prepare(
        `DELETE FROM status_mutation_receipts
          WHERE rowid IN (
            SELECT rowid
              FROM status_mutation_receipts
             WHERE user_id = ?
             ORDER BY created_at DESC, rowid DESC
             LIMIT -1 OFFSET ?
          )`,
      )
      .run(userId, MAX_MUTATION_RECEIPTS_PER_USER);
  }
}

function ensureColumn(
  database: DatabaseSyncType,
  table: "devices" | "sessions" | "users",
  column: string,
  definition: string,
): void {
  const columns = database.prepare(`PRAGMA table_info(${table})`).all() as Array<{
    name: string;
  }>;
  if (columns.some((entry) => entry.name === column)) return;
  database.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
}

async function derivePasswordHash(
  password: string,
  salt: Uint8Array,
): Promise<Buffer> {
  return (await scryptAsync(password, salt, PASSWORD_HASH_BYTES)) as Buffer;
}

function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("base64url");
}

function normalizeAgentId(value: string): string {
  const normalized = value.trim();
  if (
    normalized.length < 1 ||
    normalized.length > 120 ||
    !/^[a-zA-Z0-9._:-]+$/.test(normalized)
  ) {
    throw new Error("Agent ID is invalid.");
  }
  return normalized;
}
