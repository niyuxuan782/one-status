import { randomBytes } from "node:crypto";
import type { LocalProfile } from "@one-status/local-config";
import {
  credentialSetDigest,
  type CloudVaultCredentialPlaintext,
  type LegacyPermissionVaultStore,
} from "./cloud-vault/index.js";

export interface PermissionCloudMigrationOptions {
  fetch?: typeof fetch;
  loadProfile(): Promise<LocalProfile>;
  local: Pick<
    LegacyPermissionVaultStore,
    "listCredentials"
  >;
}

export class PermissionCloudMigration {
  readonly #fetch: typeof fetch;
  readonly #loadProfile: () => Promise<LocalProfile>;
  readonly #local: Pick<
    LegacyPermissionVaultStore,
    "listCredentials"
  >;
  #lastUploadedVersion?: string;

  constructor(options: PermissionCloudMigrationOptions) {
    this.#fetch = options.fetch ?? fetch;
    this.#loadProfile = options.loadProfile;
    this.#local = options.local;
  }

  async run(): Promise<{ count: number; state: "skipped" | "verified" }> {
    const profile = await this.#loadProfile();
    const credentials = await this.#local.listCredentials(profile.userId);
    const version = credentialVersion(credentials);
    if (version === this.#lastUploadedVersion) {
      return { count: credentials.length, state: "skipped" };
    }
    const validationKey = randomBytes(32);
    try {
      const digest = credentialSetDigest(
        credentials,
        validationKey,
      );
      const response = await this.#fetch(
        `${cloudBaseUrl(profile.baseUrl)}/v1/vault/migrations/backfill`,
        {
          body: JSON.stringify({
            credentials: credentials.map(({ userId: _userId, ...credential }) =>
              credential,
            ),
            digest,
            validationKey: validationKey.toString("base64url"),
          }),
          headers: {
            accept: "application/json",
            authorization: `Bearer ${profile.token}`,
            "content-type": "application/json",
          },
          method: "POST",
          signal: AbortSignal.timeout(30_000),
        },
      );
      const payload = (await response.json().catch(() => null)) as unknown;
      if (!response.ok) {
        throw new Error(migrationErrorCode(payload, response.status));
      }
      if (
        !isRecord(payload) ||
        payload.verified !== true ||
        payload.count !== credentials.length ||
        payload.digest !== digest
      ) {
        throw new Error("cloud_vault_migration_verification_failed");
      }
      this.#lastUploadedVersion = version;
      return { count: credentials.length, state: "verified" };
    } finally {
      validationKey.fill(0);
    }
  }
}

function credentialVersion(
  credentials: CloudVaultCredentialPlaintext[],
): string {
  const credentialsVersion = credentials
    .map((credential) => `${credential.id}:${credential.updatedAt}`)
    .sort()
    .join("|");
  return credentialsVersion;
}

function cloudBaseUrl(value: string): string {
  const url = new URL(value);
  const loopback = ["127.0.0.1", "[::1]", "localhost"].includes(
    url.hostname.toLowerCase(),
  );
  if (url.protocol !== "https:" && !(url.protocol === "http:" && loopback)) {
    throw new Error("Cloud Vault migration requires HTTPS outside loopback.");
  }
  if (url.username || url.password || url.search || url.hash) {
    throw new Error("Cloud Vault migration URL is invalid.");
  }
  return url.toString().replace(/\/$/u, "");
}

function migrationErrorCode(value: unknown, status: number): string {
  const code =
    isRecord(value) &&
    isRecord(value.error) &&
    typeof value.error.code === "string"
      ? value.error.code
      : undefined;
  const allowed = new Set([
    "migration_verification_failed",
    "unauthorized",
  ]);
  if (code && allowed.has(code)) return code;
  if (status === 404) return "cloud_vault_migration_unavailable";
  return "cloud_vault_migration_failed";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
