import {
  createCipheriv,
  createDecipheriv,
  randomBytes,
} from "node:crypto";
import type {
  CloudVaultKmsContext,
  CloudVaultKmsProvider,
} from "./kms.js";
import type { CloudVaultSecretEnvelope } from "./types.js";

const GCM_IV_BYTES = 12;
const DATA_KEY_BYTES = 32;

export class CloudVaultDecryptionError extends Error {
  constructor() {
    super("Cloud Vault credential could not be decrypted.");
  }
}

export interface EncryptCloudVaultSecretsInput {
  credentialId: string;
  kms: CloudVaultKmsProvider;
  revision: number;
  secrets: Record<string, string>;
  userId: string;
}

export async function encryptCloudVaultSecrets(
  input: EncryptCloudVaultSecretsInput,
): Promise<CloudVaultSecretEnvelope> {
  const secrets = normalizeSecrets(input.secrets);
  const context = cloudVaultKmsContext(
    input.userId,
    input.credentialId,
    input.revision,
  );
  const generated = await input.kms.generateDataKey(context);
  const key = Buffer.from(generated.plaintextKey);
  if (key.byteLength !== DATA_KEY_BYTES) {
    generated.plaintextKey.fill(0);
    key.fill(0);
    throw new Error("Cloud Vault KMS returned an invalid data key.");
  }
  const iv = randomBytes(GCM_IV_BYTES);
  const plaintext = Buffer.from(canonicalJson(secrets), "utf8");
  try {
    const cipher = createCipheriv("aes-256-gcm", key, iv);
    cipher.setAAD(
      credentialAad({
        context,
        keyId: generated.keyId,
        providerId: input.kms.providerId,
      }),
    );
    const ciphertext = Buffer.concat([
      cipher.update(plaintext),
      cipher.final(),
    ]);
    return {
      algorithm: "AES-256-GCM",
      authTag: cipher.getAuthTag().toString("base64url"),
      ciphertext: ciphertext.toString("base64url"),
      iv: iv.toString("base64url"),
      kmsKeyId: generated.keyId,
      kmsProvider: input.kms.providerId,
      version: 1,
      wrappedDek: generated.wrappedKey,
    };
  } finally {
    generated.plaintextKey.fill(0);
    key.fill(0);
    plaintext.fill(0);
  }
}

export async function decryptCloudVaultSecrets(input: {
  credentialId: string;
  envelope: CloudVaultSecretEnvelope;
  kms: CloudVaultKmsProvider;
  revision: number;
  userId: string;
}): Promise<Record<string, string>> {
  if (
    input.envelope.algorithm !== "AES-256-GCM" ||
    input.envelope.version !== 1 ||
    input.envelope.kmsProvider !== input.kms.providerId
  ) {
    throw new CloudVaultDecryptionError();
  }
  const context = cloudVaultKmsContext(
    input.userId,
    input.credentialId,
    input.revision,
  );
  let unwrapped: Uint8Array;
  try {
    unwrapped = await input.kms.unwrapDataKey({
      context,
      keyId: input.envelope.kmsKeyId,
      wrappedKey: input.envelope.wrappedDek,
    });
  } catch {
    throw new CloudVaultDecryptionError();
  }
  const key = Buffer.from(unwrapped);
  let plaintext: Buffer | undefined;
  try {
    if (key.byteLength !== DATA_KEY_BYTES) {
      throw new CloudVaultDecryptionError();
    }
    const decipher = createDecipheriv(
      "aes-256-gcm",
      key,
      Buffer.from(input.envelope.iv, "base64url"),
    );
    decipher.setAAD(
      credentialAad({
        context,
        keyId: input.envelope.kmsKeyId,
        providerId: input.envelope.kmsProvider,
      }),
    );
    decipher.setAuthTag(Buffer.from(input.envelope.authTag, "base64url"));
    plaintext = Buffer.concat([
      decipher.update(Buffer.from(input.envelope.ciphertext, "base64url")),
      decipher.final(),
    ]);
    const parsed = JSON.parse(plaintext.toString("utf8")) as unknown;
    return normalizeSecrets(assertSecretObject(parsed));
  } catch (error) {
    if (error instanceof CloudVaultDecryptionError) throw error;
    throw new CloudVaultDecryptionError();
  } finally {
    unwrapped.fill(0);
    key.fill(0);
    plaintext?.fill(0);
  }
}

export function cloudVaultKmsContext(
  userId: string,
  credentialId: string,
  revision: number,
): CloudVaultKmsContext {
  if (!Number.isSafeInteger(revision) || revision < 1) {
    throw new Error("Cloud Vault credential revision is invalid.");
  }
  return {
    credentialId: requiredMetadata(credentialId, "Credential ID"),
    purpose: "one-status-cloud-vault-dek-v1",
    revision: String(revision),
    userId: requiredMetadata(userId, "User ID"),
  };
}

function credentialAad(input: {
  context: CloudVaultKmsContext;
  keyId: string;
  providerId: string;
}): Buffer {
  return Buffer.from(
    canonicalJson({
      context: input.context,
      keyId: input.keyId,
      protocol: "one-status/cloud-vault/v1",
      providerId: input.providerId,
    }),
    "utf8",
  );
}

function normalizeSecrets(
  values: Record<string, string>,
): Record<string, string> {
  const entries = Object.entries(values);
  if (entries.length === 0 || entries.length > 64) {
    throw new Error("Cloud Vault credential must contain 1 to 64 secrets.");
  }
  return Object.fromEntries(
    entries
      .map(([key, value]) => {
        if (!/^[A-Za-z][A-Za-z0-9_.-]{0,127}$/.test(key)) {
          throw new Error("Cloud Vault secret field name is invalid.");
        }
        if (typeof value !== "string" || value.length === 0) {
          throw new Error("Cloud Vault secret value is invalid.");
        }
        return [key, value] as const;
      })
      .sort(([left], [right]) => left.localeCompare(right)),
  );
}

function assertSecretObject(value: unknown): Record<string, string> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new CloudVaultDecryptionError();
  }
  return value as Record<string, string>;
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

function requiredMetadata(value: string, label: string): string {
  const normalized = value.trim();
  if (!normalized || /[\u0000-\u001f\u007f]/.test(normalized)) {
    throw new Error(`${label} is invalid.`);
  }
  return normalized;
}
