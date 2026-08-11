import {
  createCipheriv,
  createDecipheriv,
  createHash,
  createHmac,
  randomBytes,
  timingSafeEqual,
} from "node:crypto";

const DATA_KEY_BYTES = 32;
const GCM_IV_BYTES = 12;
const GCM_AUTH_TAG_BYTES = 16;
const SELF_HOSTED_KEK_PROVIDER_ID = "self-hosted-kek";
const SELF_HOSTED_WRAPPED_KEY_PREFIX = "oswk1.self-hosted-kek.";
const SELF_HOSTED_WRAPPED_KEY_MAX_LENGTH = 2_048;
const SELF_HOSTED_KEY_ID_PATTERN = /^[A-Za-z0-9._:-]{1,256}$/u;
const BASE64URL_12_BYTES_PATTERN = /^[A-Za-z0-9_-]{16}$/u;
const BASE64URL_16_BYTES_PATTERN = /^[A-Za-z0-9_-]{22}$/u;
const BASE64URL_32_BYTES_PATTERN = /^[A-Za-z0-9_-]{43}$/u;

export type CloudVaultKmsContext = Record<string, string>;

export interface CloudVaultGeneratedDataKey {
  keyId: string;
  plaintextKey: Uint8Array;
  wrappedKey: string;
}

export interface CloudVaultKmsProvider {
  readonly providerId: string;
  destroy?(): void;
  generateDataKey(
    context: CloudVaultKmsContext,
  ): Promise<CloudVaultGeneratedDataKey>;
  unwrapDataKey(input: {
    context: CloudVaultKmsContext;
    keyId: string;
    wrappedKey: string;
  }): Promise<Uint8Array>;
}

export async function verifyCloudVaultKmsAccess(
  kms: CloudVaultKmsProvider,
): Promise<void> {
  const context = {
    purpose: "one-status-cloud-vault-kms-readiness-v1",
  };
  const generated = await kms.generateDataKey(context);
  let unwrapped: Uint8Array | undefined;
  const generatedKey = Buffer.from(generated.plaintextKey);
  let unwrappedKey: Buffer | undefined;
  try {
    if (
      generatedKey.byteLength !== DATA_KEY_BYTES ||
      !generated.keyId.trim() ||
      !generated.wrappedKey.trim()
    ) {
      throw new CloudVaultKmsError("readiness_generate_invalid");
    }
    unwrapped = await kms.unwrapDataKey({
      context,
      keyId: generated.keyId,
      wrappedKey: generated.wrappedKey,
    });
    unwrappedKey = Buffer.from(unwrapped);
    if (
      unwrappedKey.byteLength !== DATA_KEY_BYTES ||
      !timingSafeEqual(generatedKey, unwrappedKey)
    ) {
      throw new CloudVaultKmsError("readiness_round_trip_mismatch");
    }
  } finally {
    generated.plaintextKey.fill(0);
    generatedKey.fill(0);
    unwrapped?.fill(0);
    unwrappedKey?.fill(0);
  }
}

export class CloudVaultKmsError extends Error {
  constructor(readonly code: string) {
    super("Cloud Vault KMS operation failed.");
  }
}

export class FakeCloudVaultKmsProvider implements CloudVaultKmsProvider {
  readonly providerId = "fake-test-kms";
  readonly #keyId: string;
  readonly #masterKey: Buffer;

  constructor(masterKey: Uint8Array, keyId = "fake-test-key") {
    if (masterKey.byteLength !== DATA_KEY_BYTES) {
      throw new Error("Fake KMS master key must be 32 bytes.");
    }
    this.#masterKey = Buffer.from(masterKey);
    this.#keyId = requiredString(keyId, "Fake KMS key ID");
  }

  async generateDataKey(
    context: CloudVaultKmsContext,
  ): Promise<CloudVaultGeneratedDataKey> {
    const plaintextKey = randomBytes(DATA_KEY_BYTES);
    const iv = randomBytes(GCM_IV_BYTES);
    const cipher = createCipheriv("aes-256-gcm", this.#masterKey, iv);
    cipher.setAAD(contextBytes(context));
    const ciphertext = Buffer.concat([
      cipher.update(plaintextKey),
      cipher.final(),
    ]);
    return {
      keyId: this.#keyId,
      plaintextKey,
      wrappedKey: Buffer.from(
        JSON.stringify({
          authTag: cipher.getAuthTag().toString("base64url"),
          ciphertext: ciphertext.toString("base64url"),
          iv: iv.toString("base64url"),
          version: 1,
        }),
        "utf8",
      ).toString("base64url"),
    };
  }

  async unwrapDataKey(input: {
    context: CloudVaultKmsContext;
    keyId: string;
    wrappedKey: string;
  }): Promise<Uint8Array> {
    if (input.keyId !== this.#keyId) {
      throw new CloudVaultKmsError("fake_key_id_mismatch");
    }
    try {
      const envelope = JSON.parse(
        Buffer.from(input.wrappedKey, "base64url").toString("utf8"),
      ) as {
        authTag: string;
        ciphertext: string;
        iv: string;
        version: number;
      };
      if (envelope.version !== 1) throw new Error("version");
      const decipher = createDecipheriv(
        "aes-256-gcm",
        this.#masterKey,
        Buffer.from(envelope.iv, "base64url"),
      );
      decipher.setAAD(contextBytes(input.context));
      decipher.setAuthTag(Buffer.from(envelope.authTag, "base64url"));
      const plaintext = Buffer.concat([
        decipher.update(Buffer.from(envelope.ciphertext, "base64url")),
        decipher.final(),
      ]);
      return validDataKey(plaintext);
    } catch {
      throw new CloudVaultKmsError("fake_unwrap_failed");
    }
  }
}

export interface SelfHostedCloudVaultKekProviderOptions {
  kek: Uint8Array;
  keyId: string;
}

/**
 * Wraps per-credential DEKs with a server-managed KEK. The KEK must be supplied
 * through a protected deployment secret and must never be persisted in the
 * credential database.
 */
export class SelfHostedCloudVaultKekProvider
  implements CloudVaultKmsProvider
{
  readonly providerId = SELF_HOSTED_KEK_PROVIDER_ID;
  #destroyed = false;
  readonly #kek: Buffer;
  readonly #keyId: string;

  constructor(options: SelfHostedCloudVaultKekProviderOptions) {
    if (options.kek.byteLength !== DATA_KEY_BYTES) {
      throw new Error("Self-hosted Vault KEK must be 32 bytes.");
    }
    this.#kek = Buffer.from(options.kek);
    try {
      this.#keyId = validSelfHostedKeyId(options.keyId);
    } catch (error) {
      this.#kek.fill(0);
      throw error;
    }
  }

  destroy(): void {
    if (this.#destroyed) return;
    this.#destroyed = true;
    this.#kek.fill(0);
  }

  async generateDataKey(
    context: CloudVaultKmsContext,
  ): Promise<CloudVaultGeneratedDataKey> {
    this.#assertActive();
    let aad: Buffer | undefined;
    let authTag: Buffer | undefined;
    let ciphertext: Buffer | undefined;
    let iv: Buffer | undefined;
    let plaintextKey: Buffer | undefined;
    try {
      plaintextKey = randomBytes(DATA_KEY_BYTES);
      iv = randomBytes(GCM_IV_BYTES);
      const cipher = createCipheriv("aes-256-gcm", this.#kek, iv);
      aad = selfHostedKekAad(context, this.#keyId);
      cipher.setAAD(aad);
      ciphertext = Buffer.concat([
        cipher.update(plaintextKey),
        cipher.final(),
      ]);
      authTag = cipher.getAuthTag();
      const wrappedKey = encodeSelfHostedWrappedKey({
        authTag,
        ciphertext,
        iv,
        keyId: this.#keyId,
      });
      return {
        keyId: this.#keyId,
        plaintextKey,
        wrappedKey,
      };
    } catch (error) {
      plaintextKey?.fill(0);
      if (error instanceof CloudVaultKmsError) throw error;
      throw new CloudVaultKmsError("self_hosted_generate_failed");
    } finally {
      aad?.fill(0);
      authTag?.fill(0);
      ciphertext?.fill(0);
      iv?.fill(0);
    }
  }

  async unwrapDataKey(input: {
    context: CloudVaultKmsContext;
    keyId: string;
    wrappedKey: string;
  }): Promise<Uint8Array> {
    this.#assertActive();
    if (input.keyId !== this.#keyId) {
      throw new CloudVaultKmsError("self_hosted_key_id_mismatch");
    }
    let aad: Buffer | undefined;
    let ciphertext: Buffer | undefined;
    let iv: Buffer | undefined;
    let authTag: Buffer | undefined;
    try {
      const envelope = decodeSelfHostedWrappedKey(input.wrappedKey);
      if (envelope.keyId !== input.keyId) {
        throw new CloudVaultKmsError("self_hosted_envelope_key_id_mismatch");
      }
      ciphertext = Buffer.from(envelope.ciphertext, "base64url");
      iv = Buffer.from(envelope.iv, "base64url");
      authTag = Buffer.from(envelope.authTag, "base64url");
      if (
        ciphertext.byteLength !== DATA_KEY_BYTES ||
        iv.byteLength !== GCM_IV_BYTES ||
        authTag.byteLength !== GCM_AUTH_TAG_BYTES
      ) {
        throw new CloudVaultKmsError("self_hosted_envelope_invalid");
      }
      const decipher = createDecipheriv("aes-256-gcm", this.#kek, iv);
      aad = selfHostedKekAad(input.context, input.keyId);
      decipher.setAAD(aad);
      decipher.setAuthTag(authTag);
      const plaintext = Buffer.concat([
        decipher.update(ciphertext),
        decipher.final(),
      ]);
      try {
        return validDataKey(plaintext);
      } finally {
        plaintext.fill(0);
      }
    } catch (error) {
      if (
        error instanceof CloudVaultKmsError &&
        error.code === "self_hosted_key_id_mismatch"
      ) {
        throw error;
      }
      throw new CloudVaultKmsError("self_hosted_unwrap_failed");
    } finally {
      aad?.fill(0);
      ciphertext?.fill(0);
      iv?.fill(0);
      authTag?.fill(0);
    }
  }

  #assertActive(): void {
    if (this.#destroyed) {
      throw new CloudVaultKmsError("self_hosted_provider_destroyed");
    }
  }
}

export interface TencentCloudKmsSdkClient {
  Decrypt(input: {
    CiphertextBlob: string;
    EncryptionContext?: string;
  }): Promise<{
    KeyId?: string;
    Plaintext?: string;
    Response?: { KeyId?: string; Plaintext?: string };
  }>;
  GenerateDataKey(input: {
    EncryptionContext?: string;
    KeyId: string;
    KeySpec: "AES_256";
  }): Promise<{
    CiphertextBlob?: string;
    KeyId?: string;
    Plaintext?: string;
    Response?: {
      CiphertextBlob?: string;
      KeyId?: string;
      Plaintext?: string;
    };
  }>;
}

export interface TencentCloudKmsSdkProviderOptions {
  client: TencentCloudKmsSdkClient;
  keyId: string;
}

export class TencentCloudKmsSdkProvider implements CloudVaultKmsProvider {
  readonly providerId = "tencent-cloud-kms-sdk";
  readonly #client: TencentCloudKmsSdkClient;
  readonly #keyId: string;

  constructor(options: TencentCloudKmsSdkProviderOptions) {
    this.#client = options.client;
    this.#keyId = requiredString(options.keyId, "Tencent Cloud KMS key ID");
  }

  async generateDataKey(
    context: CloudVaultKmsContext,
  ): Promise<CloudVaultGeneratedDataKey> {
    try {
      const response = await this.#client.GenerateDataKey({
        EncryptionContext: stableJson(context),
        KeyId: this.#keyId,
        KeySpec: "AES_256",
      });
      const result = response.Response ?? response;
      return generatedTencentDataKey(result, this.#keyId);
    } catch (error) {
      if (error instanceof CloudVaultKmsError) throw error;
      throw new CloudVaultKmsError("tencent_sdk_generate_failed");
    }
  }

  async unwrapDataKey(input: {
    context: CloudVaultKmsContext;
    keyId: string;
    wrappedKey: string;
  }): Promise<Uint8Array> {
    try {
      const response = await this.#client.Decrypt({
        CiphertextBlob: input.wrappedKey,
        EncryptionContext: stableJson(input.context),
      });
      const result = response.Response ?? response;
      if (result.KeyId && result.KeyId !== input.keyId) {
        throw new CloudVaultKmsError("tencent_sdk_key_id_mismatch");
      }
      return decodedTencentPlaintext(result.Plaintext);
    } catch (error) {
      if (error instanceof CloudVaultKmsError) throw error;
      throw new CloudVaultKmsError("tencent_sdk_decrypt_failed");
    }
  }
}

export interface TencentCloudKmsHttpProviderOptions {
  endpoint?: string;
  fetch?: typeof fetch;
  keyId: string;
  now?: () => Date;
  region: string;
  secretId: string;
  secretKey: string;
  sessionToken?: string;
}

export class TencentCloudKmsHttpProvider implements CloudVaultKmsProvider {
  readonly providerId = "tencent-cloud-kms-http";
  readonly #endpoint: URL;
  readonly #fetch: typeof fetch;
  readonly #keyId: string;
  readonly #now: () => Date;
  readonly #region: string;
  readonly #secretId: string;
  readonly #secretKey: string;
  readonly #sessionToken?: string;

  constructor(options: TencentCloudKmsHttpProviderOptions) {
    this.#endpoint = validTencentEndpoint(
      options.endpoint ?? "https://kms.tencentcloudapi.com",
    );
    this.#fetch = options.fetch ?? fetch;
    this.#keyId = requiredString(options.keyId, "Tencent Cloud KMS key ID");
    this.#now = options.now ?? (() => new Date());
    this.#region = requiredString(options.region, "Tencent Cloud region");
    this.#secretId = requiredString(options.secretId, "Tencent Cloud SecretId");
    this.#secretKey = requiredString(options.secretKey, "Tencent Cloud SecretKey");
    this.#sessionToken = options.sessionToken?.trim() || undefined;
  }

  async generateDataKey(
    context: CloudVaultKmsContext,
  ): Promise<CloudVaultGeneratedDataKey> {
    const result = await this.#request("GenerateDataKey", {
      EncryptionContext: stableJson(context),
      KeyId: this.#keyId,
      KeySpec: "AES_256",
    });
    return generatedTencentDataKey(result, this.#keyId);
  }

  async unwrapDataKey(input: {
    context: CloudVaultKmsContext;
    keyId: string;
    wrappedKey: string;
  }): Promise<Uint8Array> {
    const result = await this.#request("Decrypt", {
      CiphertextBlob: input.wrappedKey,
      EncryptionContext: stableJson(input.context),
    });
    if (typeof result.KeyId === "string" && result.KeyId !== input.keyId) {
      throw new CloudVaultKmsError("tencent_http_key_id_mismatch");
    }
    return decodedTencentPlaintext(
      typeof result.Plaintext === "string" ? result.Plaintext : undefined,
    );
  }

  async #request(
    action: "Decrypt" | "GenerateDataKey",
    payload: Record<string, string>,
  ): Promise<Record<string, unknown>> {
    const body = JSON.stringify(payload);
    const timestamp = Math.floor(this.#now().getTime() / 1_000);
    const authorization = tencentCloudAuthorization({
      action,
      body,
      host: this.#endpoint.host,
      secretId: this.#secretId,
      secretKey: this.#secretKey,
      timestamp,
    });
    let response: Response;
    try {
      response = await this.#fetch(this.#endpoint, {
        body,
        headers: {
          Authorization: authorization,
          "Content-Type": "application/json; charset=utf-8",
          Host: this.#endpoint.host,
          "X-TC-Action": action,
          "X-TC-Region": this.#region,
          ...(this.#sessionToken
            ? { "X-TC-Token": this.#sessionToken }
            : {}),
          "X-TC-Timestamp": String(timestamp),
          "X-TC-Version": "2019-01-18",
        },
        method: "POST",
        signal: AbortSignal.timeout(15_000),
      });
    } catch {
      throw new CloudVaultKmsError("tencent_http_unavailable");
    }
    let parsed: unknown;
    try {
      parsed = await response.json();
    } catch {
      throw new CloudVaultKmsError("tencent_http_invalid_response");
    }
    const result = responseObject(parsed);
    if (!response.ok || result.Error) {
      const errorCode =
        result.Error && typeof result.Error === "object"
          ? String((result.Error as { Code?: unknown }).Code ?? "unknown")
          : "http_error";
      throw new CloudVaultKmsError(`tencent_http_${safeErrorCode(errorCode)}`);
    }
    return result;
  }
}

interface TencentAuthorizationInput {
  action: string;
  body: string;
  host: string;
  secretId: string;
  secretKey: string;
  timestamp: number;
}

export function tencentCloudAuthorization(
  input: TencentAuthorizationInput,
): string {
  const algorithm = "TC3-HMAC-SHA256";
  const canonicalHeaders =
    `content-type:application/json; charset=utf-8\n` +
    `host:${input.host}\n` +
    `x-tc-action:${input.action.toLowerCase()}\n`;
  const signedHeaders = "content-type;host;x-tc-action";
  const canonicalRequest = [
    "POST",
    "/",
    "",
    canonicalHeaders,
    signedHeaders,
    sha256(input.body),
  ].join("\n");
  const date = new Date(input.timestamp * 1_000).toISOString().slice(0, 10);
  const credentialScope = `${date}/kms/tc3_request`;
  const stringToSign = [
    algorithm,
    String(input.timestamp),
    credentialScope,
    sha256(canonicalRequest),
  ].join("\n");
  const secretDate = hmac(`TC3${input.secretKey}`, date);
  const secretService = hmac(secretDate, "kms");
  const secretSigning = hmac(secretService, "tc3_request");
  const signature = hmac(secretSigning, stringToSign).toString("hex");
  return (
    `${algorithm} Credential=${input.secretId}/${credentialScope}, ` +
    `SignedHeaders=${signedHeaders}, Signature=${signature}`
  );
}

function generatedTencentDataKey(
  result: {
    CiphertextBlob?: string;
    KeyId?: string;
    Plaintext?: string;
  },
  fallbackKeyId: string,
): CloudVaultGeneratedDataKey {
  if (!result.CiphertextBlob) {
    throw new CloudVaultKmsError("tencent_missing_wrapped_key");
  }
  return {
    keyId: result.KeyId || fallbackKeyId,
    plaintextKey: decodedTencentPlaintext(result.Plaintext),
    wrappedKey: result.CiphertextBlob,
  };
}

function decodedTencentPlaintext(value?: string): Uint8Array {
  if (!value) throw new CloudVaultKmsError("tencent_missing_plaintext");
  return validDataKey(Buffer.from(value, "base64"));
}

function validDataKey(value: Uint8Array): Uint8Array {
  if (value.byteLength !== DATA_KEY_BYTES) {
    throw new CloudVaultKmsError("invalid_data_key_length");
  }
  return new Uint8Array(value);
}

interface SelfHostedWrappedKeyEnvelope {
  algorithm: "A256GCM";
  authTag: string;
  ciphertext: string;
  iv: string;
  keyId: string;
  provider: typeof SELF_HOSTED_KEK_PROVIDER_ID;
  version: 1;
}

function encodeSelfHostedWrappedKey(input: {
  authTag: Uint8Array;
  ciphertext: Uint8Array;
  iv: Uint8Array;
  keyId: string;
}): string {
  const envelope: SelfHostedWrappedKeyEnvelope = {
    algorithm: "A256GCM",
    authTag: Buffer.from(input.authTag).toString("base64url"),
    ciphertext: Buffer.from(input.ciphertext).toString("base64url"),
    iv: Buffer.from(input.iv).toString("base64url"),
    keyId: input.keyId,
    provider: SELF_HOSTED_KEK_PROVIDER_ID,
    version: 1,
  };
  const wrappedKey =
    SELF_HOSTED_WRAPPED_KEY_PREFIX +
    Buffer.from(stableObjectJson(envelope), "utf8").toString("base64url");
  if (wrappedKey.length > SELF_HOSTED_WRAPPED_KEY_MAX_LENGTH) {
    throw new CloudVaultKmsError("self_hosted_envelope_too_large");
  }
  return wrappedKey;
}

function decodeSelfHostedWrappedKey(
  wrappedKey: string,
): SelfHostedWrappedKeyEnvelope {
  if (
    typeof wrappedKey !== "string" ||
    wrappedKey.length > SELF_HOSTED_WRAPPED_KEY_MAX_LENGTH
  ) {
    throw new CloudVaultKmsError("self_hosted_envelope_size_invalid");
  }
  if (!wrappedKey.startsWith(SELF_HOSTED_WRAPPED_KEY_PREFIX)) {
    throw new CloudVaultKmsError("self_hosted_envelope_prefix_invalid");
  }
  const encoded = wrappedKey.slice(SELF_HOSTED_WRAPPED_KEY_PREFIX.length);
  if (!encoded || !/^[A-Za-z0-9_-]+$/.test(encoded)) {
    throw new CloudVaultKmsError("self_hosted_envelope_encoding_invalid");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8"));
  } catch {
    throw new CloudVaultKmsError("self_hosted_envelope_json_invalid");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new CloudVaultKmsError("self_hosted_envelope_invalid");
  }
  const envelope = parsed as Partial<SelfHostedWrappedKeyEnvelope>;
  if (
    envelope.algorithm !== "A256GCM" ||
    envelope.provider !== SELF_HOSTED_KEK_PROVIDER_ID ||
    envelope.version !== 1 ||
    !canonicalBase64Url(envelope.authTag, BASE64URL_16_BYTES_PATTERN) ||
    !canonicalBase64Url(envelope.ciphertext, BASE64URL_32_BYTES_PATTERN) ||
    !canonicalBase64Url(envelope.iv, BASE64URL_12_BYTES_PATTERN) ||
    !validSelfHostedKeyIdValue(envelope.keyId) ||
    Object.keys(envelope).sort().join(",") !==
      "algorithm,authTag,ciphertext,iv,keyId,provider,version"
  ) {
    throw new CloudVaultKmsError("self_hosted_envelope_invalid");
  }
  return envelope as SelfHostedWrappedKeyEnvelope;
}

function canonicalBase64Url(
  value: unknown,
  pattern: RegExp,
): value is string {
  return (
    typeof value === "string" &&
    pattern.test(value) &&
    Buffer.from(value, "base64url").toString("base64url") === value
  );
}

function validSelfHostedKeyId(value: string): string {
  const normalized = value.trim();
  if (!validSelfHostedKeyIdValue(normalized)) {
    throw new Error("Self-hosted Vault KEK ID is invalid.");
  }
  return normalized;
}

function validSelfHostedKeyIdValue(value: unknown): value is string {
  return typeof value === "string" && SELF_HOSTED_KEY_ID_PATTERN.test(value);
}

function selfHostedKekAad(
  context: CloudVaultKmsContext,
  keyId: string,
): Buffer {
  return Buffer.from(
    stableObjectJson({
      algorithm: "A256GCM",
      context,
      keyId,
      protocol: "one-status/cloud-vault/wrapped-dek/v1",
      provider: SELF_HOSTED_KEK_PROVIDER_ID,
      version: 1,
    }),
    "utf8",
  );
}

function validTencentEndpoint(value: string): URL {
  const endpoint = new URL(value);
  if (
    endpoint.protocol !== "https:" ||
    endpoint.username ||
    endpoint.password ||
    endpoint.pathname !== "/" ||
    endpoint.search ||
    endpoint.hash
  ) {
    throw new Error("Tencent Cloud KMS endpoint must be an HTTPS origin.");
  }
  return endpoint;
}

function contextBytes(context: CloudVaultKmsContext): Buffer {
  return Buffer.from(stableJson(context), "utf8");
}

function stableJson(value: Record<string, string>): string {
  return JSON.stringify(
    Object.fromEntries(
      Object.entries(value)
        .map(([key, item]) => [key, item] as const)
        .sort(([left], [right]) => left.localeCompare(right)),
    ),
  );
}

function stableObjectJson(value: unknown): string {
  return JSON.stringify(stableObjectValue(value));
}

function stableObjectValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableObjectValue);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, item]) => [key, stableObjectValue(item)]),
    );
  }
  return value;
}

function responseObject(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new CloudVaultKmsError("tencent_http_invalid_response");
  }
  const response = (value as { Response?: unknown }).Response;
  if (!response || typeof response !== "object" || Array.isArray(response)) {
    throw new CloudVaultKmsError("tencent_http_invalid_response");
  }
  return response as Record<string, unknown>;
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function hmac(key: string | Uint8Array, value: string): Buffer {
  return createHmac("sha256", key).update(value, "utf8").digest();
}

function requiredString(value: string, label: string): string {
  const normalized = value.trim();
  if (!normalized || /[\u0000-\u001f\u007f]/.test(normalized)) {
    throw new Error(`${label} is invalid.`);
  }
  return normalized;
}

function safeErrorCode(value: string): string {
  return value.replaceAll(/[^A-Za-z0-9_.-]/g, "_").slice(0, 100);
}
