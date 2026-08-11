import {
  TencentCloudKmsHttpProvider,
  createCloudVaultPostgresRuntime,
  runCloudVaultPostgresMigration,
  verifyCloudVaultKmsAccess,
  type PostgresMigrationClient,
  type PostgresMigrationPool,
  type PostgresQueryResult,
} from "@one-status/api/cloud-vault";
import pg, { type Pool, type PoolClient } from "pg";
import { OpaquePasswordAuthority } from "@one-status/pake/authority";
import { createVaultServiceApp } from "./app.js";

const { Pool: PgPool } = pg;

export interface VaultRuntimeConfig {
  databaseCa?: string;
  databaseMaxConnections: number;
  databaseSsl: "disable" | "require" | "verify-full";
  databaseUrl: string;
  host: string;
  kmsEndpoint?: string;
  kmsKeyId: string;
  kmsRegion: string;
  kmsSecretId: string;
  kmsSecretKey: string;
  kmsSessionToken?: string;
  migrate: boolean;
  port: number;
  serviceToken: string;
  walletOpaqueServerSetup: string;
}

export interface StartVaultServerOptions {
  env?: NodeJS.ProcessEnv;
  host?: string;
  logger?: boolean;
  migrate?: boolean;
  port?: number;
}

export function loadVaultRuntimeConfig(
  env: NodeJS.ProcessEnv = process.env,
): VaultRuntimeConfig {
  const databaseUrl = requiredEnv(env, "ONE_STATUS_VAULT_DATABASE_URL");
  const parsedDatabaseUrl = new URL(databaseUrl);
  if (!['postgres:', 'postgresql:'].includes(parsedDatabaseUrl.protocol)) {
    throw new Error("ONE_STATUS_VAULT_DATABASE_URL must use PostgreSQL.");
  }
  const databaseSsl =
    env.ONE_STATUS_VAULT_DATABASE_SSL?.trim() || "verify-full";
  if (!['disable', 'require', 'verify-full'].includes(databaseSsl)) {
    throw new Error(
      "ONE_STATUS_VAULT_DATABASE_SSL must be disable, require, or verify-full.",
    );
  }
  return {
    ...(env.ONE_STATUS_VAULT_DATABASE_CA
      ? { databaseCa: env.ONE_STATUS_VAULT_DATABASE_CA }
      : {}),
    databaseMaxConnections: integerEnv(
      env.ONE_STATUS_VAULT_DATABASE_MAX_CONNECTIONS ?? "10",
      "ONE_STATUS_VAULT_DATABASE_MAX_CONNECTIONS",
      1,
      100,
    ),
    databaseSsl: databaseSsl as VaultRuntimeConfig["databaseSsl"],
    databaseUrl,
    host: env.ONE_STATUS_VAULT_HOST?.trim() || "127.0.0.1",
    ...(env.ONE_STATUS_VAULT_KMS_ENDPOINT
      ? { kmsEndpoint: env.ONE_STATUS_VAULT_KMS_ENDPOINT }
      : {}),
    kmsKeyId: requiredEnv(env, "ONE_STATUS_VAULT_KMS_KEY_ID"),
    kmsRegion:
      env.ONE_STATUS_VAULT_KMS_REGION?.trim() ||
      requiredEnv(env, "TENCENTCLOUD_REGION"),
    kmsSecretId: requiredEnv(env, "TENCENTCLOUD_SECRET_ID"),
    kmsSecretKey: requiredEnv(env, "TENCENTCLOUD_SECRET_KEY", false),
    ...(env.TENCENTCLOUD_SESSION_TOKEN
      ? { kmsSessionToken: env.TENCENTCLOUD_SESSION_TOKEN }
      : {}),
    migrate: booleanEnv(
      env.ONE_STATUS_VAULT_MIGRATE ?? "true",
      "ONE_STATUS_VAULT_MIGRATE",
    ),
    port: integerEnv(
      env.ONE_STATUS_VAULT_PORT ?? "8791",
      "ONE_STATUS_VAULT_PORT",
      1,
      65_535,
    ),
    serviceToken: requiredEnv(
      env,
      "ONE_STATUS_VAULT_SERVICE_TOKEN",
      false,
    ),
    walletOpaqueServerSetup: requiredEnv(
      env,
      "ONE_STATUS_VAULT_OPAQUE_SERVER_SETUP",
      false,
    ),
  };
}

export async function startVaultServerFromEnv(
  options: StartVaultServerOptions = {},
) {
  const config = loadVaultRuntimeConfig(options.env);
  const pool = new PgPool({
    application_name: "one-status-vault",
    connectionString: config.databaseUrl,
    max: config.databaseMaxConnections,
    ssl: postgresSsl(config),
  });
  const database = new PgPoolAdapter(pool);
  try {
    if (options.migrate ?? config.migrate) {
      await runCloudVaultPostgresMigration(database);
    }
    const kms = new TencentCloudKmsHttpProvider({
      endpoint: config.kmsEndpoint,
      keyId: config.kmsKeyId,
      region: config.kmsRegion,
      secretId: config.kmsSecretId,
      secretKey: config.kmsSecretKey,
      sessionToken: config.kmsSessionToken,
    });
    await verifyCloudVaultKmsAccess(kms);
    const kmsVerifiedAt = new Date().toISOString();
    const { repository, service } = createCloudVaultPostgresRuntime({
      database,
      kms,
    });
    const walletPake = new OpaquePasswordAuthority({
      serverSetup: config.walletOpaqueServerSetup,
      store: {
        get: (userId) => repository.getWalletPake(userId),
        set: (record) => repository.upsertWalletPake(record),
      },
    });
    const app = createVaultServiceApp({
      logger: options.logger ?? true,
      kmsVerifiedAt,
      service,
      serviceToken: config.serviceToken,
      walletPake,
    });
    const host = options.host ?? config.host;
    const port = options.port ?? config.port;
    await app.listen({ host, port });
    let closed = false;
    return {
      app,
      repository,
      service,
      url: `http://${displayHost(host)}:${port}`,
      async close() {
        if (closed) return;
        closed = true;
        await app.close();
        await pool.end();
      },
    };
  } catch (error) {
    await pool.end().catch(() => undefined);
    throw error;
  }
}

class PgPoolAdapter implements PostgresMigrationPool {
  constructor(private readonly pool: Pool) {}

  async query<Row extends Record<string, unknown>>(
    text: string,
    values?: unknown[],
  ): Promise<PostgresQueryResult<Row>> {
    const result = await this.pool.query(text, values);
    return {
      rowCount: result.rowCount,
      rows: result.rows as Row[],
    };
  }

  async connect(): Promise<PostgresMigrationClient> {
    return new PgClientAdapter(await this.pool.connect());
  }
}

class PgClientAdapter implements PostgresMigrationClient {
  constructor(private readonly client: PoolClient) {}

  async query<Row extends Record<string, unknown>>(
    text: string,
    values?: unknown[],
  ): Promise<PostgresQueryResult<Row>> {
    const result = await this.client.query(text, values);
    return {
      rowCount: result.rowCount,
      rows: result.rows as Row[],
    };
  }

  release(): void {
    this.client.release();
  }
}

function postgresSsl(config: VaultRuntimeConfig) {
  if (config.databaseSsl === "disable") return false;
  return {
    ...(config.databaseCa ? { ca: config.databaseCa } : {}),
    rejectUnauthorized: config.databaseSsl === "verify-full",
  };
}

function requiredEnv(
  env: NodeJS.ProcessEnv,
  name: string,
  trim = true,
): string {
  const raw = env[name];
  const value = trim ? raw?.trim() : raw;
  if (!value || /[\u0000-\u001f\u007f]/.test(value)) {
    throw new Error(`${name} is required.`);
  }
  return value;
}

function integerEnv(
  value: string,
  name: string,
  minimum: number,
  maximum: number,
): number {
  if (!/^\d+$/.test(value)) throw new Error(`${name} is invalid.`);
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new Error(`${name} is invalid.`);
  }
  return parsed;
}

function booleanEnv(value: string, name: string): boolean {
  if (value === "true") return true;
  if (value === "false") return false;
  throw new Error(`${name} must be true or false.`);
}

function displayHost(host: string): string {
  return host.includes(":") && !host.startsWith("[") ? `[${host}]` : host;
}
