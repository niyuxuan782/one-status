import {
  createHash,
  createCipheriv,
  createDecipheriv,
  hkdfSync,
  randomBytes,
} from "node:crypto";
import type { EncryptedPermissionVault } from "@one-status/protocol";
import type { DashboardBackend } from "./dashboard-backend.js";
import {
  PermissionVault,
  type PermissionVaultBundle,
} from "./permission-vault.js";
import { ToolConnectionExpiredError } from "./tool-gateway.js";

const EMPTY_UPDATED_AT = "1970-01-01T00:00:00.000Z";
const KEY_INFO = "one-status/permission-vault-sync-v1";
const DEFAULT_REFRESH_RETRY_DELAYS_MS = [100, 250, 500, 1_000];

export interface PermissionSyncContext {
  statusKey: Uint8Array;
  userId: string;
}

export interface PermissionSyncOptions {
  refreshRetryDelaysMs?: number[];
  sleep?: (milliseconds: number) => Promise<void>;
}

export class PermissionSyncService {
  #queue: Promise<void> = Promise.resolve();

  constructor(
    private readonly backend: DashboardBackend,
    private readonly vault: PermissionVault,
    private readonly loadContext: () => Promise<PermissionSyncContext>,
    private readonly options: PermissionSyncOptions = {},
  ) {}

  run<T>(operation: () => Promise<T> | T): Promise<T> {
    const execution = this.#queue.then(() => this.#run(operation));
    this.#queue = execution.then(
      () => undefined,
      () => undefined,
    );
    return execution;
  }

  async #run<T>(operation: () => Promise<T> | T): Promise<T> {
    const context = await this.loadContext();
    let base = await this.#reconcile(context);
    let localBaseline = this.vault.exportBundle(context.userId);
    try {
      try {
        return await operation();
      } catch (error) {
        if (
          !(error instanceof ToolConnectionExpiredError) ||
          !error.recoverableFromSync
        ) {
          throw error;
        }
        for (const delay of this.options.refreshRetryDelaysMs ??
          DEFAULT_REFRESH_RETRY_DELAYS_MS) {
          await (this.options.sleep ?? sleep)(delay);
          const reconciled = await this.#reconcile(context);
          if (bundleFingerprint(reconciled) !== bundleFingerprint(base)) {
            base = reconciled;
            localBaseline = this.vault.exportBundle(context.userId);
            return await operation();
          }
        }
        throw error;
      }
    } finally {
      const local = this.vault.exportBundle(context.userId);
      if (bundleFingerprint(local) !== bundleFingerprint(localBaseline)) {
        await this.#push(context, base, local);
      }
    }
  }

  async #reconcile(
    context: PermissionSyncContext,
  ): Promise<PermissionVaultBundle> {
    const snapshot = await this.backend.getSnapshot();
    if (snapshot.profile.userId !== context.userId) {
      throw new Error("Permission Vault sync account does not match the profile.");
    }
    const local = this.vault.exportBundle(context.userId);
    const envelope = snapshot.status.permissions.vault;
    if (!envelope) {
      if (local.updatedAt !== EMPTY_UPDATED_AT) {
        return this.#push(context, emptyBundle(), local);
      }
      return local;
    }

    const remote = decryptBundle(envelope, context);
    if (remote.updatedAt !== envelope.updatedAt) {
      throw new PermissionVaultSyncError();
    }
    this.vault.importBundle(context.userId, remote);
    return remote;
  }

  async #push(
    context: PermissionSyncContext,
    base: PermissionVaultBundle,
    local: PermissionVaultBundle,
  ): Promise<PermissionVaultBundle> {
    let published: PermissionVaultBundle | undefined;
    await this.backend.mutateStatus((status) => {
      const currentEnvelope = status.permissions.vault;
      const current = currentEnvelope
        ? decryptBundle(currentEnvelope, context)
        : emptyBundle();
      if (currentEnvelope && current.updatedAt !== currentEnvelope.updatedAt) {
        throw new PermissionVaultSyncError();
      }
      published = mergePermissionBundles(base, local, current);
      status.permissions.vault = encryptBundle(published, context);
    });
    if (!published) throw new PermissionVaultSyncError();
    this.vault.importBundle(context.userId, published);
    return published;
  }
}

function sleep(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

export class PermissionVaultSyncError extends Error {
  constructor() {
    super("Unable to decrypt the synced Permission Vault.");
    this.name = "PermissionVaultSyncError";
  }
}

function encryptBundle(
  bundle: PermissionVaultBundle,
  context: PermissionSyncContext,
): EncryptedPermissionVault {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", deriveKey(context), iv);
  cipher.setAAD(additionalData(context.userId, bundle.updatedAt));
  const ciphertext = Buffer.concat([
    cipher.update(JSON.stringify(bundle), "utf8"),
    cipher.final(),
  ]);
  return {
    algorithm: "AES-256-GCM",
    authTag: cipher.getAuthTag().toString("base64url"),
    ciphertext: ciphertext.toString("base64url"),
    format: "one-status.encrypted-permission-vault",
    iv: iv.toString("base64url"),
    updatedAt: bundle.updatedAt,
    version: 1,
  };
}

function decryptBundle(
  envelope: EncryptedPermissionVault,
  context: PermissionSyncContext,
): PermissionVaultBundle {
  try {
    const decipher = createDecipheriv(
      "aes-256-gcm",
      deriveKey(context),
      Buffer.from(envelope.iv, "base64url"),
    );
    decipher.setAAD(additionalData(context.userId, envelope.updatedAt));
    decipher.setAuthTag(Buffer.from(envelope.authTag, "base64url"));
    const plaintext = Buffer.concat([
      decipher.update(Buffer.from(envelope.ciphertext, "base64url")),
      decipher.final(),
    ]).toString("utf8");
    return JSON.parse(plaintext) as PermissionVaultBundle;
  } catch {
    throw new PermissionVaultSyncError();
  }
}

function deriveKey(context: PermissionSyncContext): Buffer {
  if (context.statusKey.byteLength !== 32) {
    throw new Error("Status Key must contain 32 bytes.");
  }
  return Buffer.from(
    hkdfSync(
      "sha256",
      context.statusKey,
      Buffer.from(context.userId, "utf8"),
      Buffer.from(KEY_INFO, "utf8"),
      32,
    ),
  );
}

function additionalData(userId: string, updatedAt: string): Buffer {
  return Buffer.from(
    `one-status/permission-vault-sync-v1/user:${userId}/updated:${updatedAt}`,
    "utf8",
  );
}

function emptyBundle(): PermissionVaultBundle {
  return {
    connections: [],
    format: "one-status.permission-vault-bundle",
    grants: [],
    providers: [],
    updatedAt: EMPTY_UPDATED_AT,
    version: 1,
  };
}

function mergePermissionBundles(
  base: PermissionVaultBundle,
  local: PermissionVaultBundle,
  remote: PermissionVaultBundle,
): PermissionVaultBundle {
  const connections = mergeRecords(
    base.connections,
    local.connections,
    remote.connections,
    (entry) => entry.id,
  );
  const connectionIds = new Set(connections.map((entry) => entry.id));
  return {
    connections,
    format: "one-status.permission-vault-bundle",
    grants: mergeRecords(
      base.grants,
      local.grants,
      remote.grants,
      (entry) => `${entry.connectionId}\u0000${entry.agentId}`,
    ).filter((entry) => connectionIds.has(entry.connectionId)),
    providers: mergeRecords(
      base.providers,
      local.providers,
      remote.providers,
      (entry) => entry.provider,
    ),
    updatedAt: nextUpdatedAt(
      base.updatedAt,
      local.updatedAt,
      remote.updatedAt,
    ),
    version: 1,
  };
}

function mergeRecords<T>(
  base: readonly T[],
  local: readonly T[],
  remote: readonly T[],
  key: (entry: T) => string,
): T[] {
  const baseByKey = new Map(base.map((entry) => [key(entry), entry]));
  const localByKey = new Map(local.map((entry) => [key(entry), entry]));
  const remoteByKey = new Map(remote.map((entry) => [key(entry), entry]));
  const keys = new Set([
    ...baseByKey.keys(),
    ...localByKey.keys(),
    ...remoteByKey.keys(),
  ]);
  const merged: T[] = [];
  for (const recordKey of [...keys].sort()) {
    const baseEntry = baseByKey.get(recordKey);
    const localEntry = localByKey.get(recordKey);
    const remoteEntry = remoteByKey.get(recordKey);
    const localChanged = !sameRecord(localEntry, baseEntry);
    const remoteChanged = !sameRecord(remoteEntry, baseEntry);
    const selected = !localChanged
      ? remoteEntry
      : !remoteChanged || sameRecord(localEntry, remoteEntry)
        ? localEntry
        : localEntry === undefined || remoteEntry === undefined
          ? undefined
          : remoteEntry;
    if (selected !== undefined) merged.push(selected);
  }
  return merged;
}

function sameRecord(left: unknown, right: unknown): boolean {
  return stableJson(left) === stableJson(right);
}

function bundleFingerprint(bundle: PermissionVaultBundle): string {
  return createHash("sha256")
    .update(stableJson(bundle), "utf8")
    .digest("hex");
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .filter(([, entry]) => entry !== undefined)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => `${JSON.stringify(key)}:${stableJson(entry)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value) ?? "undefined";
}

function nextUpdatedAt(...values: string[]): string {
  const latest = Math.max(
    Date.now(),
    ...values.map((value) => Date.parse(value)).filter(Number.isFinite),
  );
  return new Date(latest + 1).toISOString();
}
