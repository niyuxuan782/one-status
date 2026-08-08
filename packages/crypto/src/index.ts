import {
  createCipheriv,
  createDecipheriv,
  randomBytes,
} from "node:crypto";
import {
  encryptedEnvelopeSchema,
  parseStatusDocument,
  type EncryptedEnvelope,
  type StatusDocument,
} from "@one-status/protocol";

const KEY_BYTES = 32;
const IV_BYTES = 12;
const KEY_PREFIX = "os1_";

export class StatusDecryptionError extends Error {
  constructor() {
    super("Unable to decrypt status. Check the Status Key and encrypted data.");
    this.name = "StatusDecryptionError";
  }
}

export function generateStatusKey(): Uint8Array {
  return randomBytes(KEY_BYTES);
}

export function exportStatusKey(key: Uint8Array): string {
  assertKeyLength(key);
  return `${KEY_PREFIX}${Buffer.from(key).toString("base64url")}`;
}

export function importStatusKey(value: string): Uint8Array {
  if (!value.startsWith(KEY_PREFIX)) {
    throw new Error(`Status Key must start with ${KEY_PREFIX}`);
  }

  const key = Buffer.from(value.slice(KEY_PREFIX.length), "base64url");
  assertKeyLength(key);
  return key;
}

export function encryptStatus(
  status: StatusDocument,
  key: Uint8Array,
  revision: number,
): EncryptedEnvelope {
  assertKeyLength(key);
  assertRevision(revision);
  const plaintext = Buffer.from(JSON.stringify(status), "utf8");
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  cipher.setAAD(additionalData(revision));
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);

  return {
    format: "one-status.encrypted-status",
    version: 1,
    algorithm: "AES-256-GCM",
    revision,
    iv: iv.toString("base64url"),
    ciphertext: ciphertext.toString("base64url"),
    authTag: cipher.getAuthTag().toString("base64url"),
  };
}

export function decryptStatus(
  envelopeValue: EncryptedEnvelope,
  key: Uint8Array,
  expectedRevision: number,
): StatusDocument {
  assertKeyLength(key);
  assertRevision(expectedRevision);
  const envelope = encryptedEnvelopeSchema.parse(envelopeValue);

  try {
    if (envelope.revision !== expectedRevision) {
      throw new Error("Encrypted revision does not match the status snapshot.");
    }
    const decipher = createDecipheriv(
      "aes-256-gcm",
      key,
      Buffer.from(envelope.iv, "base64url"),
    );
    decipher.setAAD(additionalData(expectedRevision));
    decipher.setAuthTag(Buffer.from(envelope.authTag, "base64url"));
    const plaintext = Buffer.concat([
      decipher.update(Buffer.from(envelope.ciphertext, "base64url")),
      decipher.final(),
    ]);
    return parseStatusDocument(JSON.parse(plaintext.toString("utf8")));
  } catch {
    throw new StatusDecryptionError();
  }
}

function assertKeyLength(key: Uint8Array): void {
  if (key.byteLength !== KEY_BYTES) {
    throw new Error(`Status Key must be ${KEY_BYTES} bytes`);
  }
}

function assertRevision(revision: number): void {
  if (!Number.isSafeInteger(revision) || revision < 1) {
    throw new Error("Status revision must be a positive safe integer.");
  }
}

function additionalData(revision: number): Buffer {
  return Buffer.from(`one-status/status-v1/revision:${revision}`, "utf8");
}
