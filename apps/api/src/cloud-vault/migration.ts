import { createHmac, randomBytes, randomUUID } from "node:crypto";
import type {
  PermissionVault,
  PrivateCredential,
  PrivateCredentialSource,
} from "../permission-vault.js";
import type { CloudVaultRepository } from "./repository.js";
import type { CloudVaultService } from "./service.js";
import type {
  CloudVaultAuditEvent,
  CloudVaultCredentialPlaintext,
  CloudVaultMigrationRecord,
  CloudVaultMigrationState,
  CloudVaultMigrationVerification,
} from "./types.js";

export interface LegacyPermissionVaultStore {
  deleteCredential(userId: string, credentialId: string): Promise<boolean>;
  listCredentials(userId: string): Promise<CloudVaultCredentialPlaintext[]>;
  upsertCredential(credential: CloudVaultCredentialPlaintext): Promise<void>;
}

export class LocalPermissionVaultMigrationAdapter
  implements LegacyPermissionVaultStore
{
  constructor(
    private readonly vault: Pick<
      PermissionVault,
      | "deletePrivateCredential"
      | "exportBundle"
      | "getModelCredential"
      | "listPrivateCredentials"
      | "setModelCredential"
      | "upsertPrivateCredential"
    >,
  ) {}

  async listCredentials(
    userId: string,
  ): Promise<CloudVaultCredentialPlaintext[]> {
    const bundle = this.vault.exportBundle(userId);
    const privateCredentials = (bundle.privateCredentials ?? []).map((entry) =>
      localCredentialToCloud(userId, entry),
    );
    const models = this.vault
      .listPrivateCredentials(userId, { kinds: ["model"] })
      .flatMap((metadata) => {
        const sourceId = metadata.fields.sourceId;
        if (!sourceId) return [];
        const apiKey = this.vault.getModelCredential(userId, sourceId);
        if (!apiKey) return [];
        return [
          {
            accessPolicy: metadata.accessPolicy,
            createdAt: metadata.createdAt,
            expiresAt: metadata.expiresAt,
            fields: metadata.fields,
            id: metadata.id,
            kind: metadata.kind,
            label: metadata.label,
            purposes: metadata.purposes,
            secrets: { apiKey },
            source: metadata.source,
            tags: metadata.tags,
            updatedAt: metadata.updatedAt,
            userId,
          } satisfies CloudVaultCredentialPlaintext,
        ];
      });
    return [...new Map(
      [...privateCredentials, ...models].map((credential) => [
        credential.id,
        credential,
      ]),
    ).values()].sort((left, right) => left.id.localeCompare(right.id));
  }

  async upsertCredential(
    credential: CloudVaultCredentialPlaintext,
  ): Promise<void> {
    const modelSourceId = credential.fields.sourceId;
    if (
      credential.kind === "model" &&
      modelSourceId &&
      credential.secrets.apiKey &&
      Object.keys(credential.secrets).length === 1
    ) {
      this.vault.setModelCredential(
        credential.userId,
        modelSourceId,
        credential.secrets.apiKey,
      );
      return;
    }
    this.vault.upsertPrivateCredential({
      accessPolicy: credential.accessPolicy,
      expiresAt: credential.expiresAt,
      fields: credential.fields,
      id: credential.id,
      kind: credential.kind,
      label: credential.label,
      purposes: credential.purposes,
      secrets: credential.secrets,
      source: localSource(credential.source),
      tags: credential.tags,
      userId: credential.userId,
    });
  }

  async deleteCredential(
    userId: string,
    credentialId: string,
  ): Promise<boolean> {
    return this.vault.deletePrivateCredential(userId, credentialId);
  }
}

export class CloudVaultMigrationCoordinator {
  readonly #cloud: CloudVaultService;
  readonly #local: LegacyPermissionVaultStore;
  readonly #now: () => Date;
  readonly #repository: CloudVaultRepository;

  constructor(options: {
    cloud: CloudVaultService;
    local: LegacyPermissionVaultStore;
    now?: () => Date;
    repository: CloudVaultRepository;
  }) {
    this.#cloud = options.cloud;
    this.#local = options.local;
    this.#now = options.now ?? (() => new Date());
    this.#repository = options.repository;
  }

  async initialize(userId: string): Promise<CloudVaultMigrationRecord> {
    const existing = await this.#repository.getMigration(userId);
    if (existing) return existing;
    const now = this.#now().toISOString();
    const created: CloudVaultMigrationRecord = {
      cloudCount: null,
      cloudDigest: null,
      createdAt: now,
      failureCode: null,
      localCount: null,
      localDigest: null,
      state: "local_only",
      updatedAt: now,
      userId,
      verifiedAt: null,
    };
    if (await this.#repository.createMigration(created)) return created;
    const raced = await this.#repository.getMigration(userId);
    if (!raced) throw new Error("Cloud Vault migration state was not created.");
    return raced;
  }

  async backfill(userId: string): Promise<CloudVaultMigrationRecord> {
    let state = await this.initialize(userId);
    if (!["local_only", "failed"].includes(state.state)) {
      throw new Error("Cloud Vault migration cannot start from this state.");
    }
    state = await this.#transition(state, "backfilling", {
      cloudCount: null,
      cloudDigest: null,
      failureCode: null,
      localCount: null,
      localDigest: null,
      verifiedAt: null,
    });
    try {
      const local = await this.#local.listCredentials(userId);
      const localIds = new Set(local.map((credential) => credential.id));
      for (const credential of local) {
        await this.#cloud.upsertMigratedCredential(credential);
      }
      const cloud = await this.#cloud.exportPlaintextForMigration(userId);
      for (const credential of cloud) {
        if (!localIds.has(credential.id)) {
          await this.#cloud.deleteMigratedCredential(userId, credential.id);
        }
      }
      const next = await this.#transition(state, "dual_write", {
        cloudCount: local.length,
        failureCode: null,
        localCount: local.length,
      });
      await this.#audit(userId, "migration.backfill", "backfill_completed", {
        count: local.length,
      });
      return next;
    } catch (error) {
      await this.fail(userId, "backfill_failed", state);
      throw error;
    }
  }

  async verify(userId: string): Promise<CloudVaultMigrationVerification> {
    const current = await this.#requiredState(userId);
    if (current.state !== "dual_write") {
      throw new Error("Cloud Vault migration is not ready for validation.");
    }
    const validating = await this.#transition(current, "validating");
    try {
      const [local, cloud] = await Promise.all([
        this.#local.listCredentials(userId),
        this.#cloud.exportPlaintextForMigration(userId),
      ]);
      const validationKey = randomBytes(32);
      const verifiedAt = this.#now().toISOString();
      const localDigest = credentialSetDigest(local, validationKey);
      const cloudDigest = credentialSetDigest(cloud, validationKey);
      validationKey.fill(0);
      const verification: CloudVaultMigrationVerification = {
        cloudCount: cloud.length,
        cloudDigest,
        countMatches: local.length === cloud.length,
        digestMatches: localDigest === cloudDigest,
        localCount: local.length,
        localDigest,
        matches: local.length === cloud.length && localDigest === cloudDigest,
        verifiedAt,
      };
      const nextState = verification.matches ? "cutover_ready" : "failed";
      await this.#transition(validating, nextState, {
        cloudCount: verification.cloudCount,
        cloudDigest: verification.cloudDigest,
        failureCode: verification.matches ? null : "verification_mismatch",
        localCount: verification.localCount,
        localDigest: verification.localDigest,
        verifiedAt,
      });
      await this.#audit(
        userId,
        "migration.validate",
        verification.matches ? "verification_match" : "verification_mismatch",
        {
          cloudCount: cloud.length,
          localCount: local.length,
          matches: verification.matches,
        },
        verification.matches ? "allow" : "deny",
      );
      return verification;
    } catch (error) {
      const latest = await this.#repository.getMigration(userId);
      if (latest?.state === "validating") {
        await this.fail(userId, "validation_failed", latest);
      }
      throw error;
    }
  }

  async cutover(userId: string): Promise<CloudVaultMigrationRecord> {
    const current = await this.#requiredState(userId);
    if (current.state !== "cutover_ready") {
      throw new Error("Cloud Vault migration validation is incomplete.");
    }
    const next = await this.#transition(current, "cutover");
    await this.#audit(userId, "migration.cutover", "cloud_primary", {});
    return next;
  }

  async fail(
    userId: string,
    failureCode: string,
    knownState?: CloudVaultMigrationRecord,
  ): Promise<CloudVaultMigrationRecord> {
    const current = knownState ?? (await this.#requiredState(userId));
    if (current.state === "failed") return current;
    return this.#transition(current, "failed", {
      failureCode: safeFailureCode(failureCode),
    });
  }

  status(userId: string) {
    return this.#repository.getMigration(userId);
  }

  async #requiredState(userId: string): Promise<CloudVaultMigrationRecord> {
    const state = await this.#repository.getMigration(userId);
    if (!state) throw new Error("Cloud Vault migration is not initialized.");
    return state;
  }

  async #transition(
    current: CloudVaultMigrationRecord,
    state: CloudVaultMigrationState,
    patch: Partial<CloudVaultMigrationRecord> = {},
  ): Promise<CloudVaultMigrationRecord> {
    const next: CloudVaultMigrationRecord = {
      ...current,
      ...patch,
      state,
      updatedAt: this.#now().toISOString(),
    };
    if (!(await this.#repository.updateMigration(next, current.state))) {
      throw new Error("Cloud Vault migration state changed concurrently.");
    }
    return next;
  }

  async #audit(
    userId: string,
    action: CloudVaultAuditEvent["action"],
    reason: string,
    metadata: CloudVaultAuditEvent["metadata"],
    decision: CloudVaultAuditEvent["decision"] = "allow",
  ): Promise<void> {
    await this.#repository.insertAuditEvent({
      action,
      actorId: "permission-vault-migration",
      actorType: "migration",
      createdAt: this.#now().toISOString(),
      credentialId: null,
      decision,
      id: randomUUID(),
      metadata,
      projectId: null,
      purpose: null,
      reason,
      sessionId: null,
      userId,
    });
  }
}

export class CloudVaultDualWriteStore {
  constructor(
    private readonly options: {
      cloud: CloudVaultService;
      local: LegacyPermissionVaultStore;
      migration: CloudVaultMigrationCoordinator;
    },
  ) {}

  async upsert(credential: CloudVaultCredentialPlaintext): Promise<void> {
    const state = await this.options.migration.status(credential.userId);
    if (state?.state === "cutover") {
      await this.options.cloud.upsertMigratedCredential(credential);
      return;
    }
    await this.options.local.upsertCredential(credential);
    if (!state || !dualWriteState(state.state)) return;
    try {
      await this.options.cloud.upsertMigratedCredential(credential);
    } catch (error) {
      await this.options.migration.fail(
        credential.userId,
        "dual_write_upsert_failed",
      );
      throw error;
    }
  }

  async delete(userId: string, credentialId: string): Promise<boolean> {
    const state = await this.options.migration.status(userId);
    if (state?.state === "cutover") {
      return this.options.cloud.deleteMigratedCredential(userId, credentialId);
    }
    const deleted = await this.options.local.deleteCredential(
      userId,
      credentialId,
    );
    if (!deleted || !state || !dualWriteState(state.state)) return deleted;
    try {
      await this.options.cloud.deleteMigratedCredential(userId, credentialId);
      return true;
    } catch (error) {
      await this.options.migration.fail(userId, "dual_write_delete_failed");
      throw error;
    }
  }
}

export function credentialSetDigest(
  credentials: CloudVaultCredentialPlaintext[],
  validationKey: Uint8Array,
): string {
  if (validationKey.byteLength < 32) {
    throw new Error("Migration validation key must contain at least 32 bytes.");
  }
  const canonical = credentials
    .map((credential) => ({
      accessPolicy: credential.accessPolicy,
      expiresAt: credential.expiresAt,
      fields: credential.fields,
      id: credential.id,
      kind: credential.kind,
      label: credential.label,
      purposes: [...credential.purposes].sort(),
      secrets: credential.secrets,
      source: credential.source,
      tags: [...credential.tags].sort(),
      userId: credential.userId,
    }))
    .sort((left, right) => left.id.localeCompare(right.id));
  return createHmac("sha256", validationKey)
    .update(canonicalJson(canonical), "utf8")
    .digest("base64url");
}

function localCredentialToCloud(
  userId: string,
  credential: PrivateCredential,
): CloudVaultCredentialPlaintext {
  return {
    accessPolicy: credential.accessPolicy,
    createdAt: credential.createdAt,
    expiresAt: credential.expiresAt,
    fields: credential.fields,
    id: credential.id,
    kind: credential.kind,
    label: credential.label,
    purposes: credential.purposes,
    secrets: credential.secrets,
    source: credential.source,
    tags: credential.tags,
    updatedAt: credential.updatedAt,
    userId,
  };
}

function localSource(
  source: CloudVaultCredentialPlaintext["source"],
): PrivateCredentialSource {
  return {
    ...source,
    type: source.type === "migration" ? "import" : source.type,
  };
}

function dualWriteState(state: CloudVaultMigrationState): boolean {
  return ["dual_write", "validating", "cutover_ready"].includes(state);
}

function safeFailureCode(value: string): string {
  const normalized = value.replaceAll(/[^a-z0-9_.-]/gi, "_").slice(0, 100);
  if (!normalized) throw new Error("Migration failure code is invalid.");
  return normalized;
}

function canonicalJson(value: unknown): string {
  return JSON.stringify(canonicalValue(value));
}

function canonicalValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalValue);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, item]) => [key, canonicalValue(item)]),
    );
  }
  return value;
}
