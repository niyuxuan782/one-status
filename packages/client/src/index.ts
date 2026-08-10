import { randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import {
  decryptStatus,
  encryptStatus,
  unwrapStatusKey,
  wrapStatusKey,
} from "@one-status/crypto";
import {
  accountResponseSchema,
  authResponseSchema,
  createEmptyStatus,
  deviceBlockResponseSchema,
  deviceHeartbeatResponseSchema,
  deviceLoginPolicySchema,
  deviceRevocationResponseSchema,
  deviceSessionRevocationResponseSchema,
  parseStatusDocument,
  sessionRevocationResponseSchema,
  statusKeyMigrationResponseSchema,
  statusSnapshotSchema,
  type AuthRequest,
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
    input: AuthRequest,
    statusKey: Uint8Array,
  ): Promise<AuthenticatedDeviceSession> {
    const wrappedStatusKey = await wrapStatusKey(statusKey, input.password);
    const initialEnvelope = encryptStatus(createEmptyStatus(), statusKey, 1);
    const session = authResponseSchema.parse(
      await this.#request("/v1/auth/register", {
        method: "POST",
        body: JSON.stringify({
          ...input,
          initialEnvelope,
          wrappedStatusKey,
        }),
      }),
    );
    return { ...session, statusKey };
  }

  async login(
    input: AuthRequest,
    migrationCandidate?: StatusKeyMigrationCandidate,
  ): Promise<AuthenticatedDeviceSession> {
    const session = authResponseSchema.parse(
      await this.#request("/v1/auth/login", {
        method: "POST",
        body: JSON.stringify(input),
      }),
    );
    const authenticated = this.#authenticated(session.token);
    if (!session.wrappedStatusKey) {
      try {
        if (
          !migrationCandidate ||
          migrationCandidate.userId !== session.userId
        ) {
          throw statusKeyMigrationRequiredError();
        }
        await authenticated.createVault(migrationCandidate.statusKey).read();
        const migration = await authenticated.migrateStatusKey(
          input.password,
          migrationCandidate.statusKey,
        );
        const storedStatusKey = await unwrapStatusKey(
          migration.wrappedStatusKey,
          input.password,
        );
        if (!sameStatusKey(storedStatusKey, migrationCandidate.statusKey)) {
          throw new Error(
            "The migrated Status Key does not match this device's local key.",
          );
        }
        return {
          ...session,
          wrappedStatusKey: migration.wrappedStatusKey,
          statusKey: migrationCandidate.statusKey,
        };
      } catch (error) {
        await authenticated.logout().catch(() => undefined);
        throw error;
      }
    }
    try {
      return {
        ...session,
        statusKey: await unwrapStatusKey(
          session.wrappedStatusKey,
          input.password,
        ),
      };
    } catch (error) {
      await authenticated.logout().catch(() => undefined);
      throw error;
    }
  }

  async migrateStatusKey(password: string, statusKey: Uint8Array) {
    if (!this.#token) {
      throw new Error("A device session token is required to migrate a Status Key.");
    }
    const wrappedStatusKey = await wrapStatusKey(statusKey, password);
    return statusKeyMigrationResponseSchema.parse(
      await this.#request("/v1/account/wrapped-status-key", {
        method: "PUT",
        body: JSON.stringify({ password, wrappedStatusKey }),
      }),
    );
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

function sameStatusKey(left: Uint8Array, right: Uint8Array): boolean {
  return (
    left.byteLength === right.byteLength &&
    timingSafeEqual(Buffer.from(left), Buffer.from(right))
  );
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
