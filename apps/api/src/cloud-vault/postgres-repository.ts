import type { CloudVaultRepository } from "./repository.js";
import type {
  CloudVaultAgentGrant,
  CloudVaultAgentApproval,
  CloudVaultAgentSession,
  CloudVaultAuditEvent,
  CloudVaultCredentialQuery,
  CloudVaultCredentialRecord,
  CloudVaultCredentialAccessPolicy,
  CloudVaultCredentialSource,
  CloudVaultMigrationRecord,
  CloudVaultMigrationState,
  CloudVaultSecretEnvelope,
  CloudVaultWalletPakeRecord,
} from "./types.js";

export interface PostgresQueryResult<Row> {
  rowCount: number | null;
  rows: Row[];
}

export interface PostgresQueryExecutor {
  query<Row extends Record<string, unknown> = Record<string, unknown>>(
    text: string,
    values?: unknown[],
  ): Promise<PostgresQueryResult<Row>>;
  connect?(): Promise<PostgresTransactionClient>;
}

export interface PostgresTransactionClient extends PostgresQueryExecutor {
  release?(): void;
}

export const cloudVaultPostgresMigrationUrl = new URL(
  "./migrations/001_cloud_vault.sql",
  import.meta.url,
);

export class PostgresCloudVaultRepository implements CloudVaultRepository {
  constructor(private readonly database: PostgresQueryExecutor) {}

  async transaction<T>(
    operation: (repository: CloudVaultRepository) => Promise<T>,
  ): Promise<T> {
    if (!this.database.connect) {
      throw new Error("Cloud Vault repository transactions are unavailable.");
    }
    const client = await this.database.connect();
    try {
      await client.query("BEGIN");
      const result = await operation(new PostgresCloudVaultRepository(client));
      await client.query("COMMIT");
      return result;
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      client.release?.();
    }
  }

  async createCredential(record: CloudVaultCredentialRecord): Promise<void> {
    const result = await this.database.query(
      `INSERT INTO cloud_vault_credentials
         (user_id, id, kind, label, purposes, fields, tags, secret_keys,
          source, encryption_version, kms_provider, kms_key_id, wrapped_dek,
          ciphertext, iv, auth_tag, revision, created_at, updated_at, deleted_at,
          access_policy, expires_at)
       VALUES
         ($1, $2, $3, $4, $5::jsonb, $6::jsonb, $7::jsonb, $8::jsonb,
          $9::jsonb, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20,
          $21::jsonb, $22)`,
      credentialValues(record),
    );
    if (result.rowCount !== 1) {
      throw new Error("Cloud Vault credential insert did not persist.");
    }
  }

  async createAgentApproval(approval: CloudVaultAgentApproval): Promise<void> {
    const result = await this.database.query(
      `INSERT INTO cloud_vault_agent_approvals
         (user_id, id, token_hash, request_digest, session_id, agent_id,
          client_id, operation, summary, status, expires_at, created_at,
          decided_at, consumed_at)
       VALUES
         ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb, $10, $11, $12,
          $13, $14)`,
      [
        approval.userId,
        approval.id,
        approval.tokenHash,
        approval.requestDigest,
        approval.sessionId,
        approval.agentId,
        approval.clientId,
        approval.operation,
        JSON.stringify(approval.summary),
        approval.status,
        approval.expiresAt,
        approval.createdAt,
        approval.decidedAt,
        approval.consumedAt,
      ],
    );
    if (result.rowCount !== 1) {
      throw new Error("Cloud Vault Agent approval insert did not persist.");
    }
  }

  async findAgentApprovalByTokenHash(
    tokenHash: string,
    now: string,
  ): Promise<CloudVaultAgentApproval | null> {
    const result = await this.database.query<AgentApprovalRow>(
      `SELECT *
         FROM cloud_vault_agent_approvals
        WHERE token_hash = $1
          AND expires_at > $2
          AND status IN ('pending', 'approved')`,
      [tokenHash, now],
    );
    return result.rows[0] ? agentApprovalFromRow(result.rows[0]) : null;
  }

  async listAgentApprovals(
    userId: string,
    limit = 100,
  ): Promise<CloudVaultAgentApproval[]> {
    const result = await this.database.query<AgentApprovalRow>(
      `SELECT *
         FROM cloud_vault_agent_approvals
        WHERE user_id = $1
        ORDER BY created_at DESC, id DESC
        LIMIT $2`,
      [userId, clampInteger(limit, 100, 1, 500)],
    );
    return result.rows.map(agentApprovalFromRow);
  }

  async decideAgentApproval(
    userId: string,
    approvalId: string,
    decision: "approved" | "denied",
    decidedAt: string,
  ): Promise<boolean> {
    const result = await this.database.query(
      `UPDATE cloud_vault_agent_approvals
          SET status = $3, decided_at = $4
        WHERE user_id = $1
          AND id = $2
          AND status = 'pending'
          AND expires_at > $4`,
      [userId, approvalId, decision, decidedAt],
    );
    return result.rowCount === 1;
  }

  async consumeAgentApproval(
    userId: string,
    approvalId: string,
    consumedAt: string,
  ): Promise<boolean> {
    const result = await this.database.query(
      `UPDATE cloud_vault_agent_approvals
          SET status = 'consumed', consumed_at = $3
        WHERE user_id = $1
          AND id = $2
          AND status = 'approved'
          AND expires_at > $3`,
      [userId, approvalId, consumedAt],
    );
    return result.rowCount === 1;
  }

  async updateCredential(
    record: CloudVaultCredentialRecord,
    expectedRevision: number,
  ): Promise<boolean> {
    const values = credentialValues(record);
    const result = await this.database.query(
      `UPDATE cloud_vault_credentials
          SET kind = $3,
              label = $4,
              purposes = $5::jsonb,
              fields = $6::jsonb,
              tags = $7::jsonb,
              secret_keys = $8::jsonb,
              source = $9::jsonb,
              encryption_version = $10,
              kms_provider = $11,
              kms_key_id = $12,
              wrapped_dek = $13,
              ciphertext = $14,
              iv = $15,
              auth_tag = $16,
              revision = $17,
              updated_at = $19,
              access_policy = $21::jsonb,
              expires_at = $22
        WHERE user_id = $1
          AND id = $2
          AND revision = $23
          AND deleted_at IS NULL`,
      [...values, expectedRevision],
    );
    return result.rowCount === 1;
  }

  async deleteCredential(
    userId: string,
    credentialId: string,
    expectedRevision: number,
    deletedAt: string,
  ): Promise<boolean> {
    const result = await this.database.query(
      `UPDATE cloud_vault_credentials
          SET wrapped_dek = '',
              ciphertext = '',
              iv = '',
              auth_tag = '',
              secret_keys = '[]'::jsonb,
              revision = revision + 1,
              updated_at = $4,
              deleted_at = $4
        WHERE user_id = $1
          AND id = $2
          AND revision = $3
          AND deleted_at IS NULL`,
      [userId, credentialId, expectedRevision, deletedAt],
    );
    return result.rowCount === 1;
  }

  async getCredential(
    userId: string,
    credentialId: string,
    includeDeleted = false,
  ): Promise<CloudVaultCredentialRecord | null> {
    const result = await this.database.query<CredentialRow>(
      `SELECT *
         FROM cloud_vault_credentials
        WHERE user_id = $1
          AND id = $2
          ${includeDeleted ? "" : "AND deleted_at IS NULL"}`,
      [userId, credentialId],
    );
    return result.rows[0] ? credentialFromRow(result.rows[0]) : null;
  }

  async listCredentials(
    query: CloudVaultCredentialQuery,
  ): Promise<CloudVaultCredentialRecord[]> {
    const values: unknown[] = [query.userId];
    const clauses = ["user_id = $1", "deleted_at IS NULL"];
    if (query.kinds?.length) {
      values.push(query.kinds);
      clauses.push(`kind = ANY($${values.length}::text[])`);
    }
    if (query.purposes?.length) {
      values.push(query.purposes);
      const parameter = `$${values.length}::text[]`;
      clauses.push(
        `EXISTS (
           SELECT 1
             FROM jsonb_array_elements_text(purposes) AS stored(value)
             JOIN unnest(${parameter}) AS requested(value)
               ON stored.value = '*'
               OR lower(stored.value) = lower(requested.value)
               OR lower(requested.value) LIKE lower(stored.value) || '.%'
               OR lower(requested.value) LIKE lower(stored.value) || ':%'
               OR lower(requested.value) LIKE lower(stored.value) || '/%'
         )`,
      );
    }
    if (query.tags?.length) {
      values.push(query.tags);
      clauses.push(
        `NOT EXISTS (
           SELECT 1
             FROM unnest($${values.length}::text[]) AS requested(value)
            WHERE NOT EXISTS (
              SELECT 1
                FROM jsonb_array_elements_text(tags) AS stored(value)
               WHERE lower(stored.value) = lower(requested.value)
            )
         )`,
      );
    }
    if (query.search?.trim()) {
      values.push(`%${escapeLike(query.search.trim())}%`);
      const parameter = `$${values.length}`;
      clauses.push(
        `(label ILIKE ${parameter} ESCAPE '\\'
          OR fields::text ILIKE ${parameter} ESCAPE '\\'
          OR tags::text ILIKE ${parameter} ESCAPE '\\')`,
      );
    }
    values.push(clampInteger(query.limit, 100, 1, 500));
    const limit = `$${values.length}`;
    values.push(clampInteger(query.offset, 0, 0, 1_000_000));
    const offset = `$${values.length}`;
    const result = await this.database.query<CredentialRow>(
      `SELECT *
         FROM cloud_vault_credentials
        WHERE ${clauses.join("\n          AND ")}
        ORDER BY updated_at DESC, id
        LIMIT ${limit} OFFSET ${offset}`,
      values,
    );
    return result.rows.map(credentialFromRow);
  }

  async createAgentGrant(grant: CloudVaultAgentGrant): Promise<void> {
    const result = await this.database.query(
      `INSERT INTO cloud_vault_agent_grants
         (user_id, id, agent_id, credential_id, purposes, project_ids,
          expires_at, revoked_at, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5::jsonb, $6::jsonb, $7, $8, $9, $10)`,
      [
        grant.userId,
        grant.id,
        grant.agentId,
        grant.credentialId,
        JSON.stringify(grant.purposes),
        JSON.stringify(grant.projectIds),
        grant.expiresAt,
        grant.revokedAt,
        grant.createdAt,
        grant.updatedAt,
      ],
    );
    if (result.rowCount !== 1) {
      throw new Error("Cloud Vault Agent grant insert did not persist.");
    }
  }

  async listAgentGrants(
    userId: string,
    agentId: string,
    now: string,
  ): Promise<CloudVaultAgentGrant[]> {
    const result = await this.database.query<AgentGrantRow>(
      `SELECT *
         FROM cloud_vault_agent_grants
        WHERE user_id = $1
          AND agent_id = $2
          AND revoked_at IS NULL
          AND (expires_at IS NULL OR expires_at > $3)
        ORDER BY created_at, id`,
      [userId, agentId, now],
    );
    return result.rows.map(agentGrantFromRow);
  }

  async revokeAgentGrant(
    userId: string,
    grantId: string,
    revokedAt: string,
  ): Promise<boolean> {
    const result = await this.database.query(
      `UPDATE cloud_vault_agent_grants
          SET revoked_at = $3, updated_at = $3
        WHERE user_id = $1 AND id = $2 AND revoked_at IS NULL`,
      [userId, grantId, revokedAt],
    );
    return result.rowCount === 1;
  }

  async createAgentSession(session: CloudVaultAgentSession): Promise<void> {
    const result = await this.database.query(
      `INSERT INTO cloud_vault_agent_sessions
         (user_id, id, token_hash, agent_id, client_id, project_ids, expires_at,
          revoked_at, created_at, last_used_at)
       VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7, $8, $9, $10)`,
      [
        session.userId,
        session.id,
        session.tokenHash,
        session.agentId,
        session.clientId,
        JSON.stringify(session.projectIds),
        session.expiresAt,
        session.revokedAt,
        session.createdAt,
        session.lastUsedAt,
      ],
    );
    if (result.rowCount !== 1) {
      throw new Error("Cloud Vault Agent session insert did not persist.");
    }
  }

  async findAgentSessionByTokenHash(
    tokenHash: string,
    now: string,
  ): Promise<CloudVaultAgentSession | null> {
    const result = await this.database.query<AgentSessionRow>(
      `SELECT *
         FROM cloud_vault_agent_sessions
        WHERE token_hash = $1
          AND revoked_at IS NULL
          AND expires_at > $2`,
      [tokenHash, now],
    );
    return result.rows[0] ? agentSessionFromRow(result.rows[0]) : null;
  }

  async touchAgentSession(sessionId: string, lastUsedAt: string): Promise<void> {
    await this.database.query(
      `UPDATE cloud_vault_agent_sessions
          SET last_used_at = $2
        WHERE id = $1 AND revoked_at IS NULL`,
      [sessionId, lastUsedAt],
    );
  }

  async revokeAgentSession(
    userId: string,
    sessionId: string,
    revokedAt: string,
  ): Promise<boolean> {
    const result = await this.database.query(
      `UPDATE cloud_vault_agent_sessions
          SET revoked_at = $3
        WHERE user_id = $1 AND id = $2 AND revoked_at IS NULL`,
      [userId, sessionId, revokedAt],
    );
    return result.rowCount === 1;
  }

  async purgeExpiredAgentSessions(now: string): Promise<number> {
    const result = await this.database.query(
      `DELETE FROM cloud_vault_agent_sessions
        WHERE expires_at <= $1 OR revoked_at IS NOT NULL`,
      [now],
    );
    return result.rowCount ?? 0;
  }

  async purgeExpiredAgentApprovals(before: string): Promise<number> {
    const result = await this.database.query(
      "DELETE FROM cloud_vault_agent_approvals WHERE expires_at <= $1",
      [before],
    );
    return result.rowCount ?? 0;
  }

  async purgeExpiredAgentGrants(before: string): Promise<number> {
    const result = await this.database.query(
      `DELETE FROM cloud_vault_agent_grants
        WHERE (expires_at IS NOT NULL AND expires_at <= $1)
           OR (revoked_at IS NOT NULL AND revoked_at <= $1)`,
      [before],
    );
    return result.rowCount ?? 0;
  }

  async insertAuditEvent(event: CloudVaultAuditEvent): Promise<void> {
    const result = await this.database.query(
      `INSERT INTO cloud_vault_audit_events
         (user_id, id, actor_type, actor_id, session_id, credential_id,
          project_id, purpose, action, decision, reason, metadata, created_at)
       VALUES
         ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12::jsonb, $13)`,
      [
        event.userId,
        event.id,
        event.actorType,
        event.actorId,
        event.sessionId,
        event.credentialId,
        event.projectId,
        event.purpose,
        event.action,
        event.decision,
        event.reason,
        JSON.stringify(event.metadata),
        event.createdAt,
      ],
    );
    if (result.rowCount !== 1) {
      throw new Error("Cloud Vault audit event insert did not persist.");
    }
  }

  async listAuditEvents(
    userId: string,
    limit = 100,
  ): Promise<CloudVaultAuditEvent[]> {
    const result = await this.database.query<AuditRow>(
      `SELECT *
         FROM cloud_vault_audit_events
        WHERE user_id = $1
        ORDER BY created_at DESC, id DESC
        LIMIT $2`,
      [userId, clampInteger(limit, 100, 1, 500)],
    );
    return result.rows.map(auditFromRow);
  }

  async createMigration(record: CloudVaultMigrationRecord): Promise<boolean> {
    const result = await this.database.query(
      `INSERT INTO cloud_vault_migrations
         (user_id, state, local_count, cloud_count, local_digest,
          cloud_digest, verified_at, failure_code, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
       ON CONFLICT (user_id) DO NOTHING`,
      migrationValues(record),
    );
    return result.rowCount === 1;
  }

  async getWalletPake(
    userId: string,
  ): Promise<CloudVaultWalletPakeRecord | null> {
    const result = await this.database.query<WalletPakeRow>(
      "SELECT * FROM cloud_vault_wallet_pake WHERE user_id = $1",
      [userId],
    );
    const row = result.rows[0];
    return row
      ? {
          createdAt: iso(row.created_at),
          profile: jsonValue<CloudVaultWalletPakeRecord["profile"]>(row.profile),
          registrationRecord: row.registration_record,
          updatedAt: iso(row.updated_at),
          userId: row.user_id,
        }
      : null;
  }

  async upsertWalletPake(record: CloudVaultWalletPakeRecord): Promise<void> {
    const result = await this.database.query(
      `INSERT INTO cloud_vault_wallet_pake
         (user_id, registration_record, profile, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (user_id) DO UPDATE SET
         registration_record = excluded.registration_record,
         profile = excluded.profile,
         updated_at = excluded.updated_at`,
      [
        record.userId,
        record.registrationRecord,
        JSON.stringify(record.profile),
        record.createdAt,
        record.updatedAt,
      ],
    );
    if (result.rowCount !== 1) {
      throw new Error("Cloud Vault wallet OPAQUE record did not persist.");
    }
  }

  async getMigration(userId: string): Promise<CloudVaultMigrationRecord | null> {
    const result = await this.database.query<MigrationRow>(
      "SELECT * FROM cloud_vault_migrations WHERE user_id = $1",
      [userId],
    );
    return result.rows[0] ? migrationFromRow(result.rows[0]) : null;
  }

  async updateMigration(
    record: CloudVaultMigrationRecord,
    expectedState: CloudVaultMigrationState,
  ): Promise<boolean> {
    const result = await this.database.query(
      `UPDATE cloud_vault_migrations
          SET state = $2,
              local_count = $3,
              cloud_count = $4,
              local_digest = $5,
              cloud_digest = $6,
              verified_at = $7,
              failure_code = $8,
              updated_at = $10
        WHERE user_id = $1 AND state = $11`,
      [...migrationValues(record), expectedState],
    );
    return result.rowCount === 1;
  }
}

type CredentialRow = Record<string, unknown> & {
  access_policy: unknown;
  auth_tag: string;
  ciphertext: string;
  created_at: string | Date;
  deleted_at: string | Date | null;
  encryption_version: number;
  expires_at: string | Date | null;
  fields: unknown;
  id: string;
  iv: string;
  kind: CloudVaultCredentialRecord["kind"];
  kms_key_id: string;
  kms_provider: string;
  label: string;
  purposes: unknown;
  revision: number;
  secret_keys: unknown;
  source: unknown;
  tags: unknown;
  updated_at: string | Date;
  user_id: string;
  wrapped_dek: string;
};

type AgentGrantRow = Record<string, unknown> & {
  agent_id: string;
  created_at: string | Date;
  credential_id: string | null;
  expires_at: string | Date | null;
  id: string;
  project_ids: unknown;
  purposes: unknown;
  revoked_at: string | Date | null;
  updated_at: string | Date;
  user_id: string;
};

type AgentApprovalRow = Record<string, unknown> & {
  agent_id: string;
  client_id: string | null;
  consumed_at: string | Date | null;
  created_at: string | Date;
  decided_at: string | Date | null;
  expires_at: string | Date;
  id: string;
  operation: CloudVaultAgentApproval["operation"];
  request_digest: string;
  session_id: string;
  status: CloudVaultAgentApproval["status"];
  summary: unknown;
  token_hash: string;
  user_id: string;
};

type AgentSessionRow = Record<string, unknown> & {
  agent_id: string;
  client_id: string | null;
  created_at: string | Date;
  expires_at: string | Date;
  id: string;
  last_used_at: string | Date | null;
  project_ids: unknown;
  revoked_at: string | Date | null;
  token_hash: string;
  user_id: string;
};

type AuditRow = Record<string, unknown> & {
  action: CloudVaultAuditEvent["action"];
  actor_id: string;
  actor_type: CloudVaultAuditEvent["actorType"];
  created_at: string | Date;
  credential_id: string | null;
  decision: CloudVaultAuditEvent["decision"];
  id: string;
  metadata: unknown;
  project_id: string | null;
  purpose: string | null;
  reason: string;
  session_id: string | null;
  user_id: string;
};

type MigrationRow = Record<string, unknown> & {
  cloud_count: number | null;
  cloud_digest: string | null;
  created_at: string | Date;
  failure_code: string | null;
  local_count: number | null;
  local_digest: string | null;
  state: CloudVaultMigrationState;
  updated_at: string | Date;
  user_id: string;
  verified_at: string | Date | null;
};

type WalletPakeRow = Record<string, unknown> & {
  created_at: string | Date;
  profile: unknown;
  registration_record: string;
  updated_at: string | Date;
  user_id: string;
};

function credentialValues(record: CloudVaultCredentialRecord): unknown[] {
  return [
    record.userId,
    record.id,
    record.kind,
    record.label,
    JSON.stringify(record.purposes),
    JSON.stringify(record.fields),
    JSON.stringify(record.tags),
    JSON.stringify(record.secretKeys),
    JSON.stringify(record.source),
    record.envelope.version,
    record.envelope.kmsProvider,
    record.envelope.kmsKeyId,
    record.envelope.wrappedDek,
    record.envelope.ciphertext,
    record.envelope.iv,
    record.envelope.authTag,
    record.revision,
    record.createdAt,
    record.updatedAt,
    record.deletedAt,
    JSON.stringify(record.accessPolicy),
    record.expiresAt,
  ];
}

function credentialFromRow(row: CredentialRow): CloudVaultCredentialRecord {
  const envelope: CloudVaultSecretEnvelope = {
    algorithm: "AES-256-GCM",
    authTag: row.auth_tag,
    ciphertext: row.ciphertext,
    iv: row.iv,
    kmsKeyId: row.kms_key_id,
    kmsProvider: row.kms_provider,
    version: assertEnvelopeVersion(row.encryption_version),
    wrappedDek: row.wrapped_dek,
  };
  return {
    accessPolicy: jsonValue<CloudVaultCredentialAccessPolicy>(row.access_policy),
    createdAt: iso(row.created_at),
    deletedAt: nullableIso(row.deleted_at),
    envelope,
    expiresAt: nullableIso(row.expires_at),
    fields: jsonObject(row.fields),
    id: row.id,
    kind: row.kind,
    label: row.label,
    purposes: jsonStrings(row.purposes),
    revision: row.revision,
    secretKeys: jsonStrings(row.secret_keys),
    source: jsonValue<CloudVaultCredentialSource>(row.source),
    tags: jsonStrings(row.tags),
    updatedAt: iso(row.updated_at),
    userId: row.user_id,
  };
}

function agentGrantFromRow(row: AgentGrantRow): CloudVaultAgentGrant {
  return {
    agentId: row.agent_id,
    createdAt: iso(row.created_at),
    credentialId: row.credential_id,
    expiresAt: nullableIso(row.expires_at),
    id: row.id,
    projectIds: jsonStrings(row.project_ids),
    purposes: jsonStrings(row.purposes),
    revokedAt: nullableIso(row.revoked_at),
    updatedAt: iso(row.updated_at),
    userId: row.user_id,
  };
}

function agentApprovalFromRow(row: AgentApprovalRow): CloudVaultAgentApproval {
  return {
    agentId: row.agent_id,
    clientId: row.client_id,
    consumedAt: nullableIso(row.consumed_at),
    createdAt: iso(row.created_at),
    decidedAt: nullableIso(row.decided_at),
    expiresAt: iso(row.expires_at),
    id: row.id,
    operation: row.operation,
    requestDigest: row.request_digest,
    sessionId: row.session_id,
    status: row.status,
    summary: jsonValue<CloudVaultAgentApproval["summary"]>(row.summary),
    tokenHash: row.token_hash,
    userId: row.user_id,
  };
}

function agentSessionFromRow(row: AgentSessionRow): CloudVaultAgentSession {
  return {
    agentId: row.agent_id,
    clientId: row.client_id,
    createdAt: iso(row.created_at),
    expiresAt: iso(row.expires_at),
    id: row.id,
    lastUsedAt: nullableIso(row.last_used_at),
    projectIds: jsonStrings(row.project_ids),
    revokedAt: nullableIso(row.revoked_at),
    tokenHash: row.token_hash,
    userId: row.user_id,
  };
}

function auditFromRow(row: AuditRow): CloudVaultAuditEvent {
  return {
    action: row.action,
    actorId: row.actor_id,
    actorType: row.actor_type,
    createdAt: iso(row.created_at),
    credentialId: row.credential_id,
    decision: row.decision,
    id: row.id,
    metadata: jsonValue<CloudVaultAuditEvent["metadata"]>(row.metadata),
    projectId: row.project_id,
    purpose: row.purpose,
    reason: row.reason,
    sessionId: row.session_id,
    userId: row.user_id,
  };
}

function migrationValues(record: CloudVaultMigrationRecord): unknown[] {
  return [
    record.userId,
    record.state,
    record.localCount,
    record.cloudCount,
    record.localDigest,
    record.cloudDigest,
    record.verifiedAt,
    record.failureCode,
    record.createdAt,
    record.updatedAt,
  ];
}

function migrationFromRow(row: MigrationRow): CloudVaultMigrationRecord {
  return {
    cloudCount: row.cloud_count,
    cloudDigest: row.cloud_digest,
    createdAt: iso(row.created_at),
    failureCode: row.failure_code,
    localCount: row.local_count,
    localDigest: row.local_digest,
    state: row.state,
    updatedAt: iso(row.updated_at),
    userId: row.user_id,
    verifiedAt: nullableIso(row.verified_at),
  };
}

function jsonValue<T>(value: unknown): T {
  return (typeof value === "string" ? JSON.parse(value) : value) as T;
}

function jsonObject(value: unknown): Record<string, string> {
  return jsonValue<Record<string, string>>(value);
}

function jsonStrings(value: unknown): string[] {
  return jsonValue<string[]>(value);
}

function iso(value: string | Date): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

function nullableIso(value: string | Date | null): string | null {
  return value === null ? null : iso(value);
}

function assertEnvelopeVersion(value: number): 1 {
  if (value !== 1) throw new Error("Unsupported Cloud Vault envelope version.");
  return 1;
}

function clampInteger(
  value: number | undefined,
  fallback: number,
  minimum: number,
  maximum: number,
): number {
  return Number.isSafeInteger(value)
    ? Math.min(Math.max(value!, minimum), maximum)
    : fallback;
}

function escapeLike(value: string): string {
  return value.replaceAll("\\", "\\\\").replaceAll("%", "\\%").replaceAll("_", "\\_");
}
