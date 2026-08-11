import {
  SelfHostedCloudVaultKekProvider,
  TencentCloudKmsHttpProvider,
  createCloudVaultPostgresRuntime,
  runCloudVaultPostgresMigration,
  verifyCloudVaultKmsAccess,
  verifyCloudVaultKmsBinding,
  type CloudVaultKmsProvider,
  type PostgresMigrationClient,
  type PostgresMigrationPool,
  type PostgresQueryResult,
} from "@one-status/api/cloud-vault";
import {
  closeSync,
  constants as fsConstants,
  fstatSync,
  openSync,
  readSync,
} from "node:fs";
import { isAbsolute } from "node:path";
import pg, { type Pool, type PoolClient } from "pg";
import { OpaquePasswordAuthority } from "@one-status/pake/authority";
import { createVaultServiceApp } from "./app.js";

const { Pool: PgPool } = pg;
const MAX_SECRET_FILE_BYTES = 1_024;
const KEK_ID_PATTERN = /^[A-Za-z0-9._:-]{1,256}$/u;

export interface VaultRuntimeConfig {
  databaseCa?: string;
  databaseMaxConnections: number;
  databaseSsl: "disable" | "require" | "verify-full";
  databaseUrl: string;
  host: string;
  kms:
    | {
        kek: Uint8Array;
        keyId: string;
        provider: "self-hosted";
      }
    | {
        endpoint?: string;
        keyId: string;
        provider: "tencent-kms";
        region: string;
        secretId: string;
        secretKey: string;
        sessionToken?: string;
      };
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
  const kms = loadVaultKmsConfig(env);
  try {
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
      kms,
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
  } catch (error) {
    clearDecodedKek(kms);
    throw error;
  }
}

export async function startVaultServerFromEnv(
  options: StartVaultServerOptions = {},
) {
  const config = loadVaultRuntimeConfig(options.env);
  let kms: CloudVaultKmsProvider | undefined;
  let pool: Pool | undefined;
  try {
    kms = createVaultKmsProvider(config.kms);
    const activePool = new PgPool({
      application_name: "one-status-vault",
      connectionString: config.databaseUrl,
      max: config.databaseMaxConnections,
      ssl: postgresSsl(config),
    });
    pool = activePool;
    const database = new PgPoolAdapter(activePool);
    if (options.migrate ?? config.migrate) {
      await runCloudVaultPostgresMigration(database);
    }
    await verifyCloudVaultKmsAccess(kms);
    await verifyCloudVaultKmsBinding(database, kms);
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
      kmsProvider: config.kms.provider,
      kmsVerifiedAt,
      service,
      serviceToken: config.serviceToken,
      walletPake,
    });
    app.addHook("onClose", () => destroyVaultKmsProvider(kms));
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
        try {
          await app.close();
        } finally {
          destroyVaultKmsProvider(kms);
          await activePool.end();
        }
      },
    };
  } catch (error) {
    clearDecodedKek(config.kms);
    destroyVaultKmsProvider(kms);
    await pool?.end().catch(() => undefined);
    throw error;
  }
}

function loadVaultKmsConfig(env: NodeJS.ProcessEnv): VaultRuntimeConfig["kms"] {
  const provider = requiredEnv(env, "ONE_STATUS_VAULT_KMS_PROVIDER");
  if (provider === "self-hosted") {
    const encodedKek = secretEnv(
      env,
      "ONE_STATUS_VAULT_KEK",
      "ONE_STATUS_VAULT_KEK_FILE",
    );
    if (!/^[A-Za-z0-9_-]{43}$/.test(encodedKek)) {
      throw new Error(
        "ONE_STATUS_VAULT_KEK must be an unpadded Base64URL 256-bit key.",
      );
    }
    const kek = Buffer.from(encodedKek, "base64url");
    try {
      if (kek.byteLength !== 32 || kek.toString("base64url") !== encodedKek) {
        throw new Error(
          "ONE_STATUS_VAULT_KEK must be an unpadded Base64URL 256-bit key.",
        );
      }
      return {
        kek,
        keyId: kekIdEnv(env, "ONE_STATUS_VAULT_KEK_ID"),
        provider,
      };
    } catch (error) {
      kek.fill(0);
      throw error;
    }
  }
  if (provider === "tencent-kms") {
    return {
      ...(env.ONE_STATUS_VAULT_KMS_ENDPOINT
        ? { endpoint: env.ONE_STATUS_VAULT_KMS_ENDPOINT }
        : {}),
      keyId: kekIdEnv(env, "ONE_STATUS_VAULT_KMS_KEY_ID"),
      provider,
      region:
        env.ONE_STATUS_VAULT_KMS_REGION?.trim() ||
        requiredEnv(env, "TENCENTCLOUD_REGION"),
      secretId: requiredEnv(env, "TENCENTCLOUD_SECRET_ID"),
      secretKey: requiredEnv(env, "TENCENTCLOUD_SECRET_KEY", false),
      ...(env.TENCENTCLOUD_SESSION_TOKEN
        ? { sessionToken: env.TENCENTCLOUD_SESSION_TOKEN }
        : {}),
    };
  }
  throw new Error(
    "ONE_STATUS_VAULT_KMS_PROVIDER must be self-hosted or tencent-kms.",
  );
}

function createVaultKmsProvider(
  config: VaultRuntimeConfig["kms"],
): CloudVaultKmsProvider {
  if (config.provider === "self-hosted") {
    try {
      return new SelfHostedCloudVaultKekProvider({
        kek: config.kek,
        keyId: config.keyId,
      });
    } finally {
      config.kek.fill(0);
    }
  }
  return new TencentCloudKmsHttpProvider({
    endpoint: config.endpoint,
    keyId: config.keyId,
    region: config.region,
    secretId: config.secretId,
    secretKey: config.secretKey,
    sessionToken: config.sessionToken,
  });
}

function clearDecodedKek(config: VaultRuntimeConfig["kms"]): void {
  if (config.provider === "self-hosted") config.kek.fill(0);
}

function destroyVaultKmsProvider(
  provider: CloudVaultKmsProvider | undefined,
): void {
  provider?.destroy?.();
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

function secretEnv(
  env: NodeJS.ProcessEnv,
  valueName: string,
  fileName: string,
): string {
  const direct = env[valueName];
  const file = env[fileName]?.trim();
  if (direct && file) {
    throw new Error(`${valueName} and ${fileName} cannot both be set.`);
  }
  if (file) {
    if (!isAbsolute(file)) {
      throw new Error(`${fileName} must be an absolute path.`);
    }
    return readPrivateSecretFile(file, fileName);
  }
  return requiredSecret(direct, valueName);
}

function readPrivateSecretFile(path: string, name: string): string {
  let descriptor: number | undefined;
  let contents: Buffer | undefined;
  try {
    descriptor = openSync(
      path,
      fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW,
    );
    const metadata = fstatSync(descriptor);
    const effectiveUid = process.geteuid?.();
    if (
      !metadata.isFile() ||
      (effectiveUid !== undefined && metadata.uid !== effectiveUid) ||
      (metadata.mode & 0o077) !== 0
    ) {
      throw new Error(`${name} must reference a private regular file.`);
    }
    if (metadata.size > MAX_SECRET_FILE_BYTES) {
      throw new Error(
        `${name} must not exceed ${MAX_SECRET_FILE_BYTES} bytes.`,
      );
    }
    contents = Buffer.alloc(MAX_SECRET_FILE_BYTES + 1);
    let length = 0;
    while (length < contents.byteLength) {
      const count = readSync(
        descriptor,
        contents,
        length,
        contents.byteLength - length,
        null,
      );
      if (count === 0) break;
      length += count;
    }
    if (length > MAX_SECRET_FILE_BYTES) {
      throw new Error(
        `${name} must not exceed ${MAX_SECRET_FILE_BYTES} bytes.`,
      );
    }
    return requiredSecret(contents.subarray(0, length).toString("utf8"), name);
  } catch (error) {
    if (error instanceof Error && error.message.startsWith(`${name} `)) {
      throw error;
    }
    throw new Error(`${name} must reference a private regular file.`, {
      cause: error,
    });
  } finally {
    contents?.fill(0);
    if (descriptor !== undefined) closeSync(descriptor);
  }
}

function kekIdEnv(env: NodeJS.ProcessEnv, name: string): string {
  const value = requiredEnv(env, name);
  if (!KEK_ID_PATTERN.test(value)) {
    throw new Error(
      `${name} must contain 1-256 ASCII letters, numbers, dots, underscores, colons, or hyphens.`,
    );
  }
  return value;
}

function requiredSecret(value: string | undefined, name: string): string {
  const normalized = value?.trim();
  if (!normalized || /[\u0000-\u0020\u007f]/.test(normalized)) {
    throw new Error(`${name} is required.`);
  }
  return normalized;
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
