import {
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
    let syncedAt = await this.#reconcile(context);
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
          const reconciledAt = await this.#reconcile(context);
          if (Date.parse(reconciledAt) > Date.parse(syncedAt)) {
            syncedAt = reconciledAt;
            return await operation();
          }
        }
        throw error;
      }
    } finally {
      const local = this.vault.exportBundle(context.userId);
      if (Date.parse(local.updatedAt) > Date.parse(syncedAt)) {
        await this.#push(context, local);
        syncedAt = local.updatedAt;
      }
    }
  }

  async #reconcile(context: PermissionSyncContext): Promise<string> {
    const snapshot = await this.backend.getSnapshot();
    if (snapshot.profile.userId !== context.userId) {
      throw new Error("Permission Vault sync account does not match the profile.");
    }
    const local = this.vault.exportBundle(context.userId);
    const envelope = snapshot.status.permissions.vault;
    if (!envelope) {
      if (local.updatedAt !== EMPTY_UPDATED_AT) {
        await this.#push(context, local);
        return local.updatedAt;
      }
      return EMPTY_UPDATED_AT;
    }

    const remote = decryptBundle(envelope, context);
    if (remote.updatedAt !== envelope.updatedAt) {
      throw new PermissionVaultSyncError();
    }
    const remoteTime = Date.parse(remote.updatedAt);
    const localTime = Date.parse(local.updatedAt);
    if (remoteTime > localTime) {
      this.vault.importBundle(context.userId, remote);
      return remote.updatedAt;
    }
    if (localTime > remoteTime) {
      await this.#push(context, local);
      return local.updatedAt;
    }
    return remote.updatedAt;
  }

  async #push(
    context: PermissionSyncContext,
    bundle: PermissionVaultBundle,
  ): Promise<void> {
    const envelope = encryptBundle(bundle, context);
    await this.backend.mutateStatus((status) => {
      const current = status.permissions.vault;
      if (
        !current ||
        Date.parse(envelope.updatedAt) >= Date.parse(current.updatedAt)
      ) {
        status.permissions.vault = envelope;
      }
    });
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
