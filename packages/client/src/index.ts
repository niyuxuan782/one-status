import { randomBytes, randomUUID } from "node:crypto";
import {
  decryptStatus,
  encryptStatus,
  unwrapStatusKeyWithOpaqueExportKey,
  wrapStatusKeyWithOpaqueExportKey,
} from "@one-status/crypto";
import {
  finishOpaqueLogin,
  finishOpaqueRegistration,
  startOpaqueLogin,
  startOpaqueRegistration,
} from "@one-status/pake";
import {
  accountResponseSchema,
  clientAuthInputSchema,
  authResponseSchema,
  createEmptyStatus,
  deviceBlockResponseSchema,
  deviceHeartbeatResponseSchema,
  deviceLoginPolicySchema,
  deviceRevocationResponseSchema,
  deviceSessionRevocationResponseSchema,
  opaqueLoginStartResponseSchema,
  opaqueProofFinishResponseSchema,
  opaqueRegistrationStartResponseSchema,
  parseStatusDocument,
  sessionRevocationResponseSchema,
  statusKeyMigrationResponseSchema,
  statusSnapshotSchema,
  type ClientAuthInput,
  type AuthResponse,
  type EncryptedEnvelope,
  type StatusDocument,
} from "@one-status/protocol";

export interface OneStatusClientOptions {
  baseUrl: string;
  token?: string;
  fetch?: typeof globalThis.fetch;
  requestTimeoutMs?: number;
}

export type AuthenticatedDeviceSession = AuthResponse & {
  statusKey: Uint8Array;
};

export interface StatusKeyMigrationCandidate {
  statusKey: Uint8Array;
  userId: string;
}

export interface StatusKeyMigrationOptions {
  currentPassword?: string;
}

export class OneStatusApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code: string,
    readonly body: unknown,
  ) {
    super(message);
    this.name = "OneStatusApiError";
  }
}

export class OneStatusTransportError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "OneStatusTransportError";
  }
}

export class StatusNotInitializedError extends Error {
  constructor() {
    super("The account has no encrypted Status vault.");
    this.name = "StatusNotInitializedError";
  }
}

export class StatusVersionConflictError extends OneStatusApiError {
  constructor(
    readonly currentVersion: number,
    body: unknown,
  ) {
    super(
      `Status version conflict. Current version is ${currentVersion}.`,
      409,
      "version_conflict",
      body,
    );
    this.name = "StatusVersionConflictError";
  }
}

export class OneStatusClient {
  readonly #baseUrl: string;
  readonly #token?: string;
  readonly #fetch: typeof globalThis.fetch;
  readonly #requestTimeoutMs: number;

  constructor(options: OneStatusClientOptions) {
    this.#baseUrl = validateBaseUrl(options.baseUrl);
    this.#token = options.token;
    this.#fetch = options.fetch ?? globalThis.fetch;
    this.#requestTimeoutMs = options.requestTimeoutMs ?? 10_000;
    if (!Number.isFinite(this.#requestTimeoutMs) || this.#requestTimeoutMs <= 0) {
      throw new Error("requestTimeoutMs must be a positive number.");
    }
  }

  async register(
    input: ClientAuthInput,
    statusKey: Uint8Array,
  ): Promise<AuthenticatedDeviceSession> {
    const auth = clientAuthInputSchema.parse(input);
    const start = await startOpaqueRegistration(auth.password);
    const challenge = opaqueRegistrationStartResponseSchema.parse(
      await this.#request("/v1/auth/opaque/register/start", {
        method: "POST",
        body: JSON.stringify({
          email: auth.email,
          registrationRequest: start.registrationRequest,
        }),
      }),
    );
    const registration = await finishOpaqueRegistration({
      clientRegistrationState: start.clientRegistrationState,
      password: auth.password,
      profile: challenge.profile,
      registrationResponse: challenge.registrationResponse,
    });
    assertOpaqueServerKey(
      registration.serverStaticPublicKey,
      challenge.serverPublicKey,
    );
    const wrappedStatusKey = wrapStatusKeyWithOpaqueExportKey(
      statusKey,
      registration.exportKey,
      challenge.accountBinding,
    );
    const initialEnvelope = encryptStatus(createEmptyStatus(), statusKey, 1);
    const session = authResponseSchema.parse(
      await this.#request("/v1/auth/opaque/register/finish", {
        method: "POST",
        body: JSON.stringify({
          deviceName: auth.deviceName,
          flowId: challenge.flowId,
          initialEnvelope,
          ...(auth.installationId
            ? { installationId: auth.installationId }
            : {}),
          registrationRecord: registration.registrationRecord,
          wrappedStatusKey,
        }),
      }),
    );
    if (session.userId !== challenge.accountBinding) {
      throw new Error("OPAQUE registration account binding changed.");
    }
    return { ...session, statusKey };
  }

  async login(
    input: ClientAuthInput,
    _migrationCandidate?: StatusKeyMigrationCandidate,
  ): Promise<AuthenticatedDeviceSession> {
    const auth = clientAuthInputSchema.parse(input);
    const start = await startOpaqueLogin(auth.password);
    const challenge = opaqueLoginStartResponseSchema.parse(
      await this.#request("/v1/auth/opaque/login/start", {
        method: "POST",
        body: JSON.stringify({
          email: auth.email,
          startLoginRequest: start.startLoginRequest,
        }),
      }),
    );
    const login = await finishOpaqueLogin({
      clientLoginState: start.clientLoginState,
      loginResponse: challenge.loginResponse,
      password: auth.password,
      profile: challenge.profile,
    });
    if (!login) throw invalidOpaqueCredentialsError();
    assertOpaqueServerKey(login.serverStaticPublicKey, challenge.serverPublicKey);
    const session = authResponseSchema.parse(
      await this.#request("/v1/auth/opaque/login/finish", {
        method: "POST",
        body: JSON.stringify({
          deviceName: auth.deviceName,
          finishLoginRequest: login.finishLoginRequest,
          flowId: challenge.flowId,
          ...(auth.installationId
            ? { installationId: auth.installationId }
            : {}),
        }),
      }),
    );
    if (!session.wrappedStatusKey) {
      throw statusKeyMigrationRequiredError();
    }
    try {
      return {
        ...session,
        statusKey: unwrapStatusKeyWithOpaqueExportKey(
          session.wrappedStatusKey,
          login.exportKey,
          session.userId,
        ),
      };
    } catch (error) {
      await this.#authenticated(session.token).logout().catch(() => undefined);
      throw error;
    }
  }

  async migrateStatusKey(
    nextPassword: string,
    statusKey: Uint8Array,
    options: StatusKeyMigrationOptions = {},
  ) {
    if (!this.#token) {
      throw new Error("A device session token is required to migrate a Status Key.");
    }
    const accountProof = options.currentPassword
      ? await this.#createAccountPasswordProof(options.currentPassword)
      : undefined;
    const start = await startOpaqueRegistration(nextPassword);
    const challenge = opaqueRegistrationStartResponseSchema.parse(
      await this.#request("/v1/account/opaque/register/start", {
        method: "POST",
        body: JSON.stringify({
          ...(accountProof ? { accountProof } : {}),
          registrationRequest: start.registrationRequest,
        }),
      }),
    );
    const registration = await finishOpaqueRegistration({
      clientRegistrationState: start.clientRegistrationState,
      password: nextPassword,
      profile: challenge.profile,
      registrationResponse: challenge.registrationResponse,
    });
    assertOpaqueServerKey(
      registration.serverStaticPublicKey,
      challenge.serverPublicKey,
    );
    const wrappedStatusKey = wrapStatusKeyWithOpaqueExportKey(
      statusKey,
      registration.exportKey,
      challenge.accountBinding,
    );
    return statusKeyMigrationResponseSchema.parse(
      await this.#request("/v1/account/opaque/register/finish", {
        method: "PUT",
        body: JSON.stringify({
          flowId: challenge.flowId,
          registrationRecord: registration.registrationRecord,
          wrappedStatusKey,
        }),
      }),
    );
  }

  async #createAccountPasswordProof(password: string): Promise<string> {
    const account = await this.getAccount();
    const start = await startOpaqueLogin(password);
    const challenge = opaqueLoginStartResponseSchema.parse(
      await this.#request("/v1/auth/opaque/proof/start", {
        method: "POST",
        body: JSON.stringify({
          email: account.user.email,
          purpose: "account-password-change",
          startLoginRequest: start.startLoginRequest,
        }),
      }),
    );
    const login = await finishOpaqueLogin({
      clientLoginState: start.clientLoginState,
      loginResponse: challenge.loginResponse,
      password,
      profile: challenge.profile,
    });
    if (!login) throw invalidOpaqueCredentialsError();
    assertOpaqueServerKey(login.serverStaticPublicKey, challenge.serverPublicKey);
    return opaqueProofFinishResponseSchema.parse(
      await this.#request("/v1/auth/opaque/proof/finish", {
        method: "POST",
        body: JSON.stringify({
          finishLoginRequest: login.finishLoginRequest,
          flowId: challenge.flowId,
        }),
      }),
    ).proofToken;
  }

  async getStatusSnapshot() {
    return statusSnapshotSchema.parse(await this.#request("/v1/status"));
  }

  async getAccount() {
    return accountResponseSchema.parse(await this.#request("/v1/account"));
  }

  async logout() {
    return sessionRevocationResponseSchema.parse(
      await this.#request("/v1/auth/logout", { method: "POST" }),
    );
  }

  async revokeDevice(deviceId: string) {
    return deviceRevocationResponseSchema.parse(
      await this.#request(`/v1/devices/${encodeURIComponent(deviceId)}`, {
        method: "DELETE",
      }),
    );
  }

  async revokeDeviceSessions(deviceId: string) {
    return deviceSessionRevocationResponseSchema.parse(
      await this.#request(
        `/v1/devices/${encodeURIComponent(deviceId)}/revoke-sessions`,
        { method: "POST" },
      ),
    );
  }

  async blockDevice(deviceId: string) {
    return deviceBlockResponseSchema.parse(
      await this.#request(`/v1/devices/${encodeURIComponent(deviceId)}/block`, {
        method: "PUT",
      }),
    );
  }

  async unblockDevice(deviceId: string) {
    return deviceBlockResponseSchema.parse(
      await this.#request(`/v1/devices/${encodeURIComponent(deviceId)}/block`, {
        method: "DELETE",
      }),
    );
  }

  async setDeviceLoginPolicy(denyNewDeviceLogins: boolean) {
    return deviceLoginPolicySchema.parse(
      await this.#request("/v1/account/device-login-policy", {
        method: "PUT",
        body: JSON.stringify({ denyNewDeviceLogins }),
      }),
    );
  }

  async heartbeat() {
    return deviceHeartbeatResponseSchema.parse(
      await this.#request("/v1/devices/heartbeat", { method: "POST" }),
    );
  }

  createVault(statusKey: Uint8Array): SyncedStatusVault {
    if (!this.#token) {
      throw new Error("A device session token is required to create a vault.");
    }
    return new SyncedStatusVault(this, statusKey);
  }

  async putEncryptedStatus(
    envelope: EncryptedEnvelope,
    baseVersion: number,
    mutationId: string,
    mutationDigest: string,
  ) {
    return statusSnapshotSchema.parse(
      await this.#request("/v1/status", {
        method: "PUT",
        body: JSON.stringify({
          mutationId,
          mutationDigest,
          baseVersion,
          envelope,
        }),
      }),
    );
  }

  #authenticated(token: string): OneStatusClient {
    return new OneStatusClient({
      baseUrl: this.#baseUrl,
      fetch: this.#fetch,
      requestTimeoutMs: this.#requestTimeoutMs,
      token,
    });
  }

  async #request(path: string, init: RequestInit = {}): Promise<unknown> {
    const headers = new Headers(init.headers);
    if (init.body !== undefined && !headers.has("content-type")) {
      headers.set("content-type", "application/json");
    }
    if (this.#token) {
      headers.set("authorization", `Bearer ${this.#token}`);
    }

    const timeoutSignal = AbortSignal.timeout(this.#requestTimeoutMs);
    const signal = init.signal
      ? AbortSignal.any([init.signal, timeoutSignal])
      : timeoutSignal;
    const response = await this.#fetch(`${this.#baseUrl}${path}`, {
      ...init,
      headers,
      signal,
    });
    let body: unknown;
    try {
      body = await response.json();
    } catch (error) {
      throw new OneStatusTransportError(
        `One Status API returned an unreadable JSON response for ${path}.`,
        { cause: error },
      );
    }
    if (!response.ok) {
      const error = readApiError(body);
      if (
        response.status === 409 &&
        error.code === "version_conflict" &&
        typeof error.currentVersion === "number"
      ) {
        throw new StatusVersionConflictError(error.currentVersion, body);
      }
      throw new OneStatusApiError(
        error.message ?? `One Status API returned HTTP ${response.status}.`,
        response.status,
        error.code ?? "unknown_error",
        body,
      );
    }
    return body;
  }
}

export interface DecryptedStatusSnapshot {
  version: number;
  status: StatusDocument;
  updatedAt: string | null;
  deduplicated?: boolean;
}

export class SyncedStatusVault {
  constructor(
    private readonly client: OneStatusClient,
    private readonly statusKey: Uint8Array,
  ) {}

  async read(): Promise<DecryptedStatusSnapshot> {
    const snapshot = await this.client.getStatusSnapshot();
    if (!snapshot.envelope) {
      throw new StatusNotInitializedError();
    }
    return {
      version: snapshot.version,
      status: decryptStatus(snapshot.envelope, this.statusKey, snapshot.version),
      updatedAt: snapshot.updatedAt,
    };
  }

  async mutate(
    mutation: (draft: StatusDocument) => void,
    options: StatusMutationOptions = {},
  ): Promise<DecryptedStatusSnapshot> {
    const mutationId = options.mutationId ?? randomUUID();
    const mutationDigest =
      options.mutationDigest ?? randomBytes(32).toString("base64url");
    const maxConflictAttempts = options.maxConflictAttempts ?? 4;
    const maxDeliveryAttempts = options.maxDeliveryAttempts ?? 2;
    let lastConflict: StatusVersionConflictError | undefined;

    for (
      let conflictAttempt = 1;
      conflictAttempt <= maxConflictAttempts;
      conflictAttempt += 1
    ) {
      const current = await this.read();
      const next = structuredClone(current.status);
      mutation(next);
      const validStatus = parseStatusDocument(next);
      const envelope = encryptStatus(
        validStatus,
        this.statusKey,
        current.version + 1,
      );

      for (
        let deliveryAttempt = 1;
        deliveryAttempt <= maxDeliveryAttempts;
        deliveryAttempt += 1
      ) {
        try {
          const stored = await this.client.putEncryptedStatus(
            envelope,
            current.version,
            mutationId,
            mutationDigest,
          );
          if (stored.deduplicated) {
            return { ...(await this.read()), deduplicated: true };
          }
          return {
            version: stored.version,
            status: validStatus,
            updatedAt: stored.updatedAt,
          };
        } catch (error) {
          if (error instanceof StatusVersionConflictError) {
            lastConflict = error;
            break;
          }
          if (
            isTransportError(error) &&
            deliveryAttempt < maxDeliveryAttempts
          ) {
            continue;
          }
          throw error;
        }
      }
    }

    throw (
      lastConflict ?? new Error("Status mutation conflict attempts were exhausted.")
    );
  }
}

export interface StatusMutationOptions {
  mutationId?: string;
  mutationDigest?: string;
  maxConflictAttempts?: number;
  maxDeliveryAttempts?: number;
}

function validateBaseUrl(value: string): string {
  const url = new URL(value);
  const loopback =
    url.hostname === "127.0.0.1" ||
    url.hostname === "localhost" ||
    url.hostname === "[::1]" ||
    url.hostname.endsWith(".localhost");
  if (url.protocol !== "https:" && !(url.protocol === "http:" && loopback)) {
    throw new Error("One Status requires HTTPS for non-loopback API URLs.");
  }
  return url.toString().replace(/\/$/, "");
}

function readApiError(body: unknown): {
  code?: string;
  message?: string;
  currentVersion?: number;
} {
  if (!body || typeof body !== "object" || !("error" in body)) {
    return {};
  }
  const error = body.error;
  return error && typeof error === "object" ? error : {};
}

function statusKeyMigrationRequiredError(): OneStatusApiError {
  return new OneStatusApiError(
    "This account must migrate its encrypted Status Key. Sign in on a previously connected device with the account password, then retry this device.",
    409,
    "status_key_migration_required",
    null,
  );
}

function invalidOpaqueCredentialsError(): OneStatusApiError {
  return new OneStatusApiError(
    "Invalid email or password.",
    401,
    "invalid_credentials",
    null,
  );
}

function assertOpaqueServerKey(actual: string, expected: string): void {
  if (actual !== expected) {
    throw new Error("OPAQUE server identity verification failed.");
  }
}

function isTransportError(error: unknown): boolean {
  return (
    error instanceof TypeError ||
    error instanceof OneStatusTransportError ||
    (error instanceof OneStatusApiError && error.status === 503) ||
    (error instanceof DOMException &&
      (error.name === "AbortError" || error.name === "TimeoutError"))
  );
}
