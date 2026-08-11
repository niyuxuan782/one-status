import { readFile } from "node:fs/promises";
import type { CloudVaultKmsProvider } from "./kms.js";
import {
  PostgresCloudVaultRepository,
  cloudVaultPostgresMigrationUrl,
  type PostgresQueryExecutor,
} from "./postgres-repository.js";
import { CloudVaultService } from "./service.js";

const CLOUD_VAULT_MIGRATION_LOCK = 1_391_406_412;

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
