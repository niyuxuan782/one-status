import { readFile } from "node:fs/promises";
import { createHash, timingSafeEqual } from "node:crypto";
import {
  CloudVaultKmsError,
  type CloudVaultKmsContext,
  type CloudVaultKmsProvider,
} from "./kms.js";
import {
  PostgresCloudVaultRepository,
  cloudVaultPostgresMigrationUrl,
  type PostgresQueryExecutor,
} from "./postgres-repository.js";
import { CloudVaultService } from "./service.js";

const CLOUD_VAULT_MIGRATION_LOCK = 1_391_406_412;
const CLOUD_VAULT_KMS_BINDING_ID = "primary";
const CLOUD_VAULT_KMS_BINDING_CONTEXT: CloudVaultKmsContext = {
  bindingId: CLOUD_VAULT_KMS_BINDING_ID,
  purpose: "one-status-cloud-vault-kms-binding-v1",
};

export interface PostgresMigrationClient extends PostgresQueryExecutor {
  release?(): void;
}

export interface PostgresMigrationPool extends PostgresQueryExecutor {
  connect?(): Promise<PostgresMigrationClient>;
}

export async function runCloudVaultPostgresMigration(
  database: PostgresMigrationPool,
): Promise<void> {
  const client = database.connect ? await database.connect() : database;
  let locked = false;
  try {
    await client.query("SELECT pg_advisory_lock($1)", [
      CLOUD_VAULT_MIGRATION_LOCK,
    ]);
    locked = true;
    const sql = await readFile(cloudVaultPostgresMigrationUrl, "utf8");
    await client.query(sql);
  } finally {
    if (locked) {
      await client
        .query("SELECT pg_advisory_unlock($1)", [CLOUD_VAULT_MIGRATION_LOCK])
        .catch(() => undefined);
    }
    if ("release" in client && typeof client.release === "function") {
      client.release();
    }
  }
}

export async function verifyCloudVaultKmsBinding(
  database: PostgresQueryExecutor,
  kms: CloudVaultKmsProvider,
): Promise<void> {
  let binding = await readCloudVaultKmsBinding(database);
  if (!binding) {
    const generated = await kms.generateDataKey(
      CLOUD_VAULT_KMS_BINDING_CONTEXT,
    );
    try {
      await database.query(
        `INSERT INTO cloud_vault_kms_binding
           (id, kms_provider, kms_key_id, wrapped_dek, verification_hash,
            created_at)
         VALUES ($1, $2, $3, $4, $5, $6)
         ON CONFLICT (id) DO NOTHING`,
        [
          CLOUD_VAULT_KMS_BINDING_ID,
          kms.providerId,
          generated.keyId,
          generated.wrappedKey,
          cloudVaultKmsBindingHash(generated.plaintextKey),
          new Date().toISOString(),
        ],
      );
    } finally {
      generated.plaintextKey.fill(0);
    }
    binding = await readCloudVaultKmsBinding(database);
  }
  if (!binding) {
    throw new CloudVaultKmsError("binding_missing_after_create");
  }
  if (binding.kms_provider !== kms.providerId) {
    throw new CloudVaultKmsError("binding_provider_mismatch");
  }
  let plaintext: Uint8Array | undefined;
  let actualHash: Buffer | undefined;
  let expectedHash: Buffer | undefined;
  try {
    if (
      typeof binding.kms_provider !== "string" ||
      binding.kms_provider.length > 128 ||
      !binding.kms_key_id ||
      binding.kms_key_id.length > 256 ||
      !binding.wrapped_dek ||
      binding.wrapped_dek.length > 16_384 ||
      !/^[A-Za-z0-9_-]{43}$/.test(binding.verification_hash) ||
      Buffer.from(binding.verification_hash, "base64url").toString(
        "base64url",
      ) !== binding.verification_hash
    ) {
      throw new CloudVaultKmsError("binding_record_invalid");
    }
    expectedHash = Buffer.from(binding.verification_hash, "base64url");
    if (expectedHash.byteLength !== 32) {
      throw new CloudVaultKmsError("binding_record_invalid");
    }
    plaintext = await kms.unwrapDataKey({
      context: CLOUD_VAULT_KMS_BINDING_CONTEXT,
      keyId: binding.kms_key_id,
      wrappedKey: binding.wrapped_dek,
    });
    actualHash = Buffer.from(cloudVaultKmsBindingHash(plaintext), "base64url");
    if (!timingSafeEqual(actualHash, expectedHash)) {
      throw new CloudVaultKmsError("binding_verification_failed");
    }
  } catch (error) {
    if (error instanceof CloudVaultKmsError) throw error;
    throw new CloudVaultKmsError("binding_verification_failed");
  } finally {
    plaintext?.fill(0);
    actualHash?.fill(0);
    expectedHash?.fill(0);
  }
}

interface CloudVaultKmsBindingRow extends Record<string, unknown> {
  kms_key_id: string;
  kms_provider: string;
  verification_hash: string;
  wrapped_dek: string;
}

async function readCloudVaultKmsBinding(
  database: PostgresQueryExecutor,
): Promise<CloudVaultKmsBindingRow | null> {
  const result = await database.query<CloudVaultKmsBindingRow>(
    `SELECT kms_provider, kms_key_id, wrapped_dek, verification_hash
       FROM cloud_vault_kms_binding
      WHERE id = $1`,
    [CLOUD_VAULT_KMS_BINDING_ID],
  );
  return result.rows[0] ?? null;
}

function cloudVaultKmsBindingHash(value: Uint8Array): string {
  return createHash("sha256").update(value).digest("base64url");
}

export function createCloudVaultPostgresRuntime(options: {
  database: PostgresQueryExecutor;
  kms: CloudVaultKmsProvider;
  now?: () => Date;
}) {
  const repository = new PostgresCloudVaultRepository(options.database);
  const service = new CloudVaultService({
    kms: options.kms,
    now: options.now,
    repository,
  });
  return { repository, service };
}
