import { describe, expect, it, vi } from "vitest";
import { FakeCloudVaultKmsProvider } from "./kms.js";
import {
  PostgresCloudVaultRepository,
  type PostgresQueryExecutor,
  type PostgresQueryResult,
} from "./postgres-repository.js";
import {
  createCloudVaultPostgresRuntime,
  runCloudVaultPostgresMigration,
} from "./postgres-runtime.js";
import type { CloudVaultCredentialRecord } from "./types.js";

describe("PostgresCloudVaultRepository", () => {
  it("persists only envelope columns and maps PostgreSQL rows", async () => {
    const calls: Array<{ sql: string; values: unknown[] }> = [];
    const row = credentialRow();
    const database: PostgresQueryExecutor = {
      async query<Row extends Record<string, unknown>>(
        sql: string,
        values: unknown[] = [],
      ): Promise<PostgresQueryResult<Row>> {
        calls.push({ sql, values });
        return {
          rowCount: sql.startsWith("INSERT") ? 1 : 1,
          rows: sql.startsWith("SELECT *")
            ? ([row] as unknown as Row[])
            : [],
        };
      },
    };
    const repository = new PostgresCloudVaultRepository(database);
    const record = credentialRecord();
    await repository.createCredential(record);
    await expect(
      repository.getCredential("user-1", record.id),
    ).resolves.toEqual(record);

    const insert = calls[0]!;
    expect(insert.sql).toContain("wrapped_dek");
    expect(insert.sql).toContain("ciphertext");
    expect(insert.sql).toContain("auth_tag");
    expect(JSON.stringify(insert.values)).not.toContain("plaintext-password");
  });

  it("uses parameterized metadata search and tenant filters", async () => {
    const calls: Array<[string, unknown[]]> = [];
    const repository = new PostgresCloudVaultRepository({
      async query<Row extends Record<string, unknown>>(
        sql: string,
        values: unknown[] = [],
      ): Promise<PostgresQueryResult<Row>> {
        calls.push([sql, values]);
        return { rowCount: 0, rows: [] };
      },
    });
    await repository.listCredentials({
      kinds: ["ssh"],
      purposes: ["ssh.connect"],
      search: "100%_server",
      tags: ["production"],
      userId: "user-1",
    });

    const [sql, values] = calls[0]!;
    expect(sql).toContain("user_id = $1");
    expect(sql).toContain("jsonb_array_elements_text(purposes)");
    expect(sql).toContain(
      "lower(requested.value) LIKE lower(stored.value) || '.%'",
    );
    expect(sql).not.toContain(
      "lower(stored.value) LIKE lower(requested.value) || '.%'",
    );
    expect(sql).toContain("fields::text ILIKE");
    expect(sql).not.toContain("100%_server");
    expect(values).toContain("%100\\%\\_server%");
  });

  it("runs the idempotent SQL migration under a PostgreSQL advisory lock", async () => {
    const calls: string[] = [];
    const release = vi.fn();
    const client = {
      async query<Row extends Record<string, unknown>>(
        sql: string,
      ): Promise<PostgresQueryResult<Row>> {
        calls.push(sql);
        return { rowCount: 1, rows: [] };
      },
      release,
    };
    await runCloudVaultPostgresMigration({
      connect: async () => client,
      query: client.query.bind(client),
    });

    expect(calls[0]).toContain("pg_advisory_lock");
    expect(calls[1]).toContain("CREATE TABLE IF NOT EXISTS cloud_vault_credentials");
    expect(calls[1]).toContain("cloud_vault_agent_grants");
    expect(calls[1]).toContain("cloud_vault_agent_sessions");
    expect(calls[1]).toContain("cloud_vault_audit_events");
    expect(calls[1]).toContain("cloud_vault_migrations");
    expect(calls.at(-1)).toContain("pg_advisory_unlock");
    expect(release).toHaveBeenCalledOnce();
  });

  it("constructs a PostgreSQL runtime only with an explicitly supplied KMS", () => {
    const database: PostgresQueryExecutor = {
      async query<Row extends Record<string, unknown>>() {
        return { rowCount: 0, rows: [] as Row[] };
      },
    };
    const runtime = createCloudVaultPostgresRuntime({
      database,
      kms: new FakeCloudVaultKmsProvider(new Uint8Array(32).fill(8)),
    });
    expect(runtime.repository).toBeInstanceOf(PostgresCloudVaultRepository);
    expect(runtime.service).toBeDefined();
  });
});

function credentialRecord(): CloudVaultCredentialRecord {
  return {
    accessPolicy: {
      allowAgentRead: true,
      allowedAgentIds: [],
      allowedProjectIds: [],
      deniedAgentIds: [],
      deniedProjectIds: [],
      requireApproval: false,
    },
    createdAt: "2026-08-11T04:00:00.000Z",
    deletedAt: null,
    envelope: {
      algorithm: "AES-256-GCM",
      authTag: "auth-tag",
      ciphertext: "encrypted-credential-payload",
      iv: "credential-iv",
      kmsKeyId: "kms-key-1",
      kmsProvider: "tencent-cloud-kms-sdk",
      version: 1,
      wrappedDek: "kms-wrapped-dek",
    },
    expiresAt: null,
    fields: { host: "server.example", username: "ubuntu" },
    id: "27a8701f-41c6-49b1-8e98-e1a7a702392c",
    kind: "ssh",
    label: "Server SSH",
    purposes: ["ssh.connect"],
    revision: 1,
    secretKeys: ["password"],
    source: { agentId: "codex", type: "agent" },
    tags: ["production"],
    updatedAt: "2026-08-11T04:00:00.000Z",
    userId: "user-1",
  };
}

function credentialRow() {
  const record = credentialRecord();
  return {
    access_policy: record.accessPolicy,
    auth_tag: record.envelope.authTag,
    ciphertext: record.envelope.ciphertext,
    created_at: new Date(record.createdAt),
    deleted_at: null,
    encryption_version: record.envelope.version,
    expires_at: record.expiresAt,
    fields: record.fields,
    id: record.id,
    iv: record.envelope.iv,
    kind: record.kind,
    kms_key_id: record.envelope.kmsKeyId,
    kms_provider: record.envelope.kmsProvider,
    label: record.label,
    purposes: record.purposes,
    revision: record.revision,
    secret_keys: record.secretKeys,
    source: record.source,
    tags: record.tags,
    updated_at: new Date(record.updatedAt),
    user_id: record.userId,
    wrapped_dek: record.envelope.wrappedDek,
  };
}
