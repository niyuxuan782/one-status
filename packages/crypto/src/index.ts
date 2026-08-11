import {
  createCipheriv,
  createDecipheriv,
  createHash,
  hkdfSync,
  randomBytes,
  scrypt,
} from "node:crypto";
import {
  encryptedEnvelopeSchema,
  parseStatusDocument,
  wrappedStatusKeySchema,
  type EncryptedEnvelope,
  type StatusDocument,
  type WrappedStatusKey,
} from "@one-status/protocol";

const KEY_BYTES = 32;
const IV_BYTES = 12;
const KEY_PREFIX = "os1_";
const STATUS_KEY_WRAP_AAD = Buffer.from(
  "one-status/wrapped-status-key-v1",
  "utf8",
);
const STATUS_KEY_OPAQUE_WRAP_INFO = Buffer.from(
  "one-status/wrapped-status-key-v2/opaque-export-key",
  "utf8",
);
const STATUS_KEY_WRAP_SCRYPT = {
  N: 16_384,
  r: 8,
  p: 1,
  maxmem: 64 * 1024 * 1024,
} as const;

export class StatusDecryptionError extends Error {
  constructor() {
    super("Unable to decrypt status. Check the Status Key and encrypted data.");
    this.name = "StatusDecryptionError";
  }
}

export class StatusKeyUnwrapError extends Error {
  constructor() {
    super("Unable to unlock the encrypted Status Key.");
    this.name = "StatusKeyUnwrapError";
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

export async function wrapStatusKey(
  statusKey: Uint8Array,
  password: string,
): Promise<WrappedStatusKey> {
  assertKeyLength(statusKey);
  const salt = randomBytes(16);
  const wrappingKey = await deriveStatusKeyWrappingKey(password, salt);
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv("aes-256-gcm", wrappingKey, iv);
  cipher.setAAD(STATUS_KEY_WRAP_AAD);
  const ciphertext = Buffer.concat([
    cipher.update(statusKey),
    cipher.final(),
  ]);
  return wrappedStatusKeySchema.parse({
    format: "one-status.wrapped-status-key",
    version: 1,
    algorithm: "AES-256-GCM",
    kdf: {
      algorithm: "scrypt",
      salt: salt.toString("base64url"),
      cost: STATUS_KEY_WRAP_SCRYPT.N,
      blockSize: STATUS_KEY_WRAP_SCRYPT.r,
      parallelization: STATUS_KEY_WRAP_SCRYPT.p,
      keyLength: KEY_BYTES,
    },
    iv: iv.toString("base64url"),
    ciphertext: ciphertext.toString("base64url"),
    authTag: cipher.getAuthTag().toString("base64url"),
  });
}

export async function unwrapStatusKey(
  envelopeValue: WrappedStatusKey,
  password: string,
): Promise<Uint8Array> {
  const envelope = wrappedStatusKeySchema.parse(envelopeValue);
  if (envelope.version !== 1) throw new StatusKeyUnwrapError();
  try {
    const wrappingKey = await deriveStatusKeyWrappingKey(
      password,
      Buffer.from(envelope.kdf.salt, "base64url"),
    );
    const decipher = createDecipheriv(
      "aes-256-gcm",
      wrappingKey,
      Buffer.from(envelope.iv, "base64url"),
    );
    decipher.setAAD(STATUS_KEY_WRAP_AAD);
    decipher.setAuthTag(Buffer.from(envelope.authTag, "base64url"));
    const statusKey = Buffer.concat([
      decipher.update(Buffer.from(envelope.ciphertext, "base64url")),
      decipher.final(),
    ]);
    assertKeyLength(statusKey);
    return statusKey;
  } catch {
    throw new StatusKeyUnwrapError();
  }
}

export function wrapStatusKeyWithOpaqueExportKey(
  statusKey: Uint8Array,
  exportKey: string,
  userIdentifier: string,
): WrappedStatusKey {
  assertKeyLength(statusKey);
  const binding = opaqueUserBinding(userIdentifier);
  const wrappingKey = deriveOpaqueWrappingKey(exportKey, binding);
  const iv = randomBytes(IV_BYTES);
  try {
    const cipher = createCipheriv("aes-256-gcm", wrappingKey, iv);
    cipher.setAAD(opaqueWrapAdditionalData(binding));
    const ciphertext = Buffer.concat([
      cipher.update(statusKey),
      cipher.final(),
    ]);
    return wrappedStatusKeySchema.parse({
      format: "one-status.wrapped-status-key",
      version: 2,
      algorithm: "AES-256-GCM",
      kdf: {
        algorithm: "HKDF-SHA-256",
        source: "OPAQUE-export-key",
        suite: "opaque-rfc9807-ristretto255-sha512",
        binding: binding.toString("base64url"),
        keyLength: KEY_BYTES,
      },
      iv: iv.toString("base64url"),
      ciphertext: ciphertext.toString("base64url"),
      authTag: cipher.getAuthTag().toString("base64url"),
    });
  } finally {
    wrappingKey.fill(0);
  }
}

export function unwrapStatusKeyWithOpaqueExportKey(
  envelopeValue: WrappedStatusKey,
  exportKey: string,
  userIdentifier: string,
): Uint8Array {
  const envelope = wrappedStatusKeySchema.parse(envelopeValue);
  if (envelope.version !== 2) throw new StatusKeyUnwrapError();
  const binding = opaqueUserBinding(userIdentifier);
  if (envelope.kdf.binding !== binding.toString("base64url")) {
    throw new StatusKeyUnwrapError();
  }
  const wrappingKey = deriveOpaqueWrappingKey(exportKey, binding);
  try {
    const decipher = createDecipheriv(
      "aes-256-gcm",
      wrappingKey,
      Buffer.from(envelope.iv, "base64url"),
    );
    decipher.setAAD(opaqueWrapAdditionalData(binding));
    decipher.setAuthTag(Buffer.from(envelope.authTag, "base64url"));
    const statusKey = Buffer.concat([
      decipher.update(Buffer.from(envelope.ciphertext, "base64url")),
      decipher.final(),
    ]);
    assertKeyLength(statusKey);
    return statusKey;
  } catch {
    throw new StatusKeyUnwrapError();
  } finally {
    wrappingKey.fill(0);
  }
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

async function deriveStatusKeyWrappingKey(
  password: string,
  salt: Uint8Array,
): Promise<Buffer> {
  if (password.length < 10 || password.length > 256) {
    throw new StatusKeyUnwrapError();
  }
  return new Promise<Buffer>((resolve, reject) => {
    scrypt(
      password,
      salt,
      KEY_BYTES,
      STATUS_KEY_WRAP_SCRYPT,
      (error, derivedKey) => {
        if (error) {
          reject(error);
          return;
        }
        resolve(derivedKey);
      },
    );
  });
}

function deriveOpaqueWrappingKey(exportKey: string, binding: Buffer): Buffer {
  const decoded = Buffer.from(exportKey, "base64url");
  if (decoded.byteLength !== 64) throw new StatusKeyUnwrapError();
  try {
    return Buffer.from(
      hkdfSync(
        "sha256",
        decoded,
        binding,
        STATUS_KEY_OPAQUE_WRAP_INFO,
        KEY_BYTES,
      ),
    );
  } finally {
    decoded.fill(0);
  }
}

function opaqueUserBinding(userIdentifier: string): Buffer {
  const normalized = userIdentifier.trim().toLowerCase();
  if (!normalized || normalized.length > 500) throw new StatusKeyUnwrapError();
  return createHash("sha256")
    .update(`one-status/opaque-user/${normalized}`, "utf8")
    .digest();
}

function opaqueWrapAdditionalData(binding: Buffer): Buffer {
  return Buffer.from(
    `one-status/wrapped-status-key-v2/binding:${binding.toString("base64url")}`,
    "utf8",
  );
}

function additionalData(revision: number): Buffer {
  return Buffer.from(`one-status/status-v1/revision:${revision}`, "utf8");
}
