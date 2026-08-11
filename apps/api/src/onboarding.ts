import { randomUUID } from "node:crypto";
import { stat } from "node:fs/promises";
import { hostname } from "node:os";
import {
  OneStatusApiError,
  OneStatusClient,
  OneStatusTransportError,
} from "@one-status/client";
import {
  encryptStatus,
  exportStatusKey,
  generateStatusKey,
  importStatusKey,
  unwrapStatusKeyWithOpaqueExportKey,
  wrapStatusKeyWithOpaqueExportKey,
} from "@one-status/crypto";
import {
  loadLocalProfile,
  loadOrCreateInstallationId,
  prepareLocalProfileStorage,
  resolveProfilePath,
  saveLocalProfile,
  type LocalProfile,
} from "@one-status/local-config";
import {
  authResponseSchema,
  createEmptyStatus,
  opaqueLoginStartRequestSchema,
  opaqueLoginStartResponseSchema,
  opaqueRegistrationStartRequestSchema,
  opaqueRegistrationStartResponseSchema,
  statusKeyMigrationResponseSchema,
} from "@one-status/protocol";
import { z } from "zod";

const FLOW_TTL_MS = 5 * 60_000;
const MAX_PENDING_FLOWS = 100;
const REQUEST_TIMEOUT_MS = 10_000;

const deviceNameSchema = z.string().trim().min(1).max(120);
const serverUrlSchema = z.string().trim().min(1).max(2_048);
const opaqueValueSchema = z.string().regex(/^[A-Za-z0-9_-]{1,16384}$/u);

export const onboardingRegistrationStartInputSchema =
  opaqueRegistrationStartRequestSchema
    .extend({
      deviceName: deviceNameSchema,
      serverUrl: serverUrlSchema,
    })
    .strict();

export const onboardingRegistrationFinishInputSchema = z
  .object({
    exportKey: opaqueValueSchema,
    flowId: z.uuid(),
    registrationRecord: opaqueValueSchema,
    serverStaticPublicKey: opaqueValueSchema,
  })
  .strict();

export const onboardingLoginStartInputSchema = opaqueLoginStartRequestSchema
  .extend({
    deviceName: deviceNameSchema,
    serverUrl: serverUrlSchema,
  })
  .strict();

export const onboardingLoginFinishInputSchema = z
  .object({
    exportKey: opaqueValueSchema,
    finishLoginRequest: opaqueValueSchema,
    flowId: z.uuid(),
    serverStaticPublicKey: opaqueValueSchema,
  })
  .strict();

export const onboardingMigrationStartInputSchema = z
  .object({ registrationRequest: opaqueValueSchema })
  .strict();

export const onboardingMigrationFinishInputSchema = z
  .object({
    exportKey: opaqueValueSchema,
    flowId: z.uuid(),
    registrationRecord: opaqueValueSchema,
    serverStaticPublicKey: opaqueValueSchema,
  })
  .strict();

export type OnboardingRegistrationStartInput = z.infer<
  typeof onboardingRegistrationStartInputSchema
>;
export type OnboardingRegistrationFinishInput = z.infer<
  typeof onboardingRegistrationFinishInputSchema
>;
export type OnboardingLoginStartInput = z.infer<
  typeof onboardingLoginStartInputSchema
>;
export type OnboardingLoginFinishInput = z.infer<
  typeof onboardingLoginFinishInputSchema
>;
export type OnboardingMigrationStartInput = z.infer<
  typeof onboardingMigrationStartInputSchema
>;
export type OnboardingMigrationFinishInput = z.infer<
  typeof onboardingMigrationFinishInputSchema
>;

interface PendingRegistration {
  accountBinding: string;
  baseUrl: string;
  deviceName: string;
  expiresAt: number;
  installationId: string;
  remoteFlowId: string;
  serverPublicKey: string;
  statusKey: Uint8Array;
}

interface PendingLogin {
  baseUrl: string;
  deviceName: string;
  existingUserId?: string;
  expiresAt: number;
  installationId: string;
  remoteFlowId: string;
  serverPublicKey: string;
}

interface PendingMigration {
  expiresAt: number;
  profile: LocalProfile;
  remoteFlowId: string;
  serverPublicKey: string;
  statusKey: Uint8Array;
}

export class LocalOnboardingService {
  readonly #logins = new Map<string, PendingLogin>();
  readonly #migrations = new Map<string, PendingMigration>();
  readonly #registrations = new Map<string, PendingRegistration>();

  constructor(
    private readonly defaultServerUrl = "https://os.furesta.top",
  ) {
    new OneStatusClient({ baseUrl: defaultServerUrl });
  }

  async status(): Promise<{
    authenticated: boolean;
    defaultServerUrl: string;
    deviceName: string;
    profile?: { deviceName: string; serverUrl: string; userId: string };
  }> {
    try {
      await stat(resolveProfilePath());
    } catch (error) {
      if (isMissingFile(error)) {
        return {
          authenticated: false,
          defaultServerUrl: this.defaultServerUrl,
          deviceName: hostname(),
        };
      }
      throw error;
    }
    const profile = await loadLocalProfile();
    return {
      authenticated: true,
      defaultServerUrl: this.defaultServerUrl,
      deviceName: profile.deviceName,
      profile: {
        deviceName: profile.deviceName,
        serverUrl: profile.baseUrl,
        userId: profile.userId,
      },
    };
  }

  async startRegistration(input: OnboardingRegistrationStartInput) {
    const parsed = onboardingRegistrationStartInputSchema.parse(input);
    this.#prune();
    this.#reserveCapacity();
    await prepareLocalProfileStorage(resolveProfilePath(), true);
    const baseUrl = normalizeServerUrl(parsed.serverUrl);
    const installationId = await loadOrCreateInstallationId();
    const challenge = opaqueRegistrationStartResponseSchema.parse(
      await requestJson(baseUrl, "/v1/auth/opaque/register/start", {
        email: parsed.email,
        registrationRequest: parsed.registrationRequest,
      }),
    );
    const flowId = randomUUID();
    this.#registrations.set(flowId, {
      accountBinding: challenge.accountBinding,
      baseUrl,
      deviceName: parsed.deviceName,
      expiresAt: Date.now() + FLOW_TTL_MS,
      installationId,
      remoteFlowId: challenge.flowId,
      serverPublicKey: challenge.serverPublicKey,
      statusKey: generateStatusKey(),
    });
    return { ...challenge, flowId };
  }

  async finishRegistration(input: OnboardingRegistrationFinishInput): Promise<{
    deviceId: string;
    userId: string;
  }> {
    const parsed = onboardingRegistrationFinishInputSchema.parse(input);
    const flow = this.#consumeRegistration(parsed.flowId);
    try {
      assertServerKey(parsed.serverStaticPublicKey, flow.serverPublicKey);
      const wrappedStatusKey = wrapStatusKeyWithOpaqueExportKey(
        flow.statusKey,
        parsed.exportKey,
        flow.accountBinding,
      );
      const session = authResponseSchema.parse(
        await requestJson(flow.baseUrl, "/v1/auth/opaque/register/finish", {
          deviceName: flow.deviceName,
          flowId: flow.remoteFlowId,
          initialEnvelope: encryptStatus(
            createEmptyStatus(),
            flow.statusKey,
            1,
          ),
          installationId: flow.installationId,
          registrationRecord: parsed.registrationRecord,
          wrappedStatusKey,
        }),
      );
      if (session.userId !== flow.accountBinding) {
        throw new Error("OPAQUE registration account binding changed.");
      }
      await saveSession(
        flow.baseUrl,
        flow.deviceName,
        exportStatusKey(flow.statusKey),
        session,
      );
      return { deviceId: session.deviceId, userId: session.userId };
    } finally {
      flow.statusKey.fill(0);
    }
  }

  async startLogin(input: OnboardingLoginStartInput) {
    const parsed = onboardingLoginStartInputSchema.parse(input);
    this.#prune();
    this.#reserveCapacity();
    const baseUrl = normalizeServerUrl(parsed.serverUrl);
    const existingProfile = await loadMatchingProfile(baseUrl);
    await prepareLocalProfileStorage(
      resolveProfilePath(),
      existingProfile === undefined,
    );
    const installationId = await loadOrCreateInstallationId(
      existingProfile?.deviceId,
    );
    const challenge = opaqueLoginStartResponseSchema.parse(
      await requestJson(baseUrl, "/v1/auth/opaque/login/start", {
        email: parsed.email,
        startLoginRequest: parsed.startLoginRequest,
      }),
    );
    const flowId = randomUUID();
    this.#logins.set(flowId, {
      baseUrl,
      deviceName: parsed.deviceName,
      ...(existingProfile ? { existingUserId: existingProfile.userId } : {}),
      expiresAt: Date.now() + FLOW_TTL_MS,
      installationId,
      remoteFlowId: challenge.flowId,
      serverPublicKey: challenge.serverPublicKey,
    });
    return { ...challenge, flowId };
  }

  async finishLogin(input: OnboardingLoginFinishInput): Promise<{
    deviceId: string;
    userId: string;
  }> {
    const parsed = onboardingLoginFinishInputSchema.parse(input);
    const flow = this.#consumeLogin(parsed.flowId);
    assertServerKey(parsed.serverStaticPublicKey, flow.serverPublicKey);
    const session = authResponseSchema.parse(
      await requestJson(flow.baseUrl, "/v1/auth/opaque/login/finish", {
        deviceName: flow.deviceName,
        finishLoginRequest: parsed.finishLoginRequest,
        flowId: flow.remoteFlowId,
        installationId: flow.installationId,
      }),
    );
    const authenticated = new OneStatusClient({
      baseUrl: flow.baseUrl,
      token: session.token,
    });
    let statusKey: Uint8Array | undefined;
    try {
      if (!session.wrappedStatusKey || session.wrappedStatusKey.version !== 2) {
        throw statusKeyMigrationRequiredError();
      }
      statusKey = unwrapStatusKeyWithOpaqueExportKey(
        session.wrappedStatusKey,
        parsed.exportKey,
        session.userId,
      );
      if (flow.existingUserId && flow.existingUserId !== session.userId) {
        throw new Error(
          "The existing local profile belongs to another One Status account.",
        );
      }
      await authenticated.createVault(statusKey).read();
      await saveSession(
        flow.baseUrl,
        flow.deviceName,
        exportStatusKey(statusKey),
        session,
      );
      return { deviceId: session.deviceId, userId: session.userId };
    } catch (error) {
      await authenticated.logout().catch(() => undefined);
      throw error;
    } finally {
      statusKey?.fill(0);
    }
  }

  async startMigration(input: OnboardingMigrationStartInput) {
    const parsed = onboardingMigrationStartInputSchema.parse(input);
    this.#prune();
    this.#reserveCapacity();
    const profile = await loadLocalProfile();
    const baseUrl = normalizeServerUrl(profile.baseUrl);
    const challenge = opaqueRegistrationStartResponseSchema.parse(
      await requestJson(
        baseUrl,
        "/v1/account/opaque/register/start",
        { registrationRequest: parsed.registrationRequest },
        profile.token,
      ),
    );
    if (challenge.accountBinding !== profile.userId) {
      throw new Error("OPAQUE migration account binding changed.");
    }
    const flowId = randomUUID();
    this.#migrations.set(flowId, {
      expiresAt: Date.now() + FLOW_TTL_MS,
      profile,
      remoteFlowId: challenge.flowId,
      serverPublicKey: challenge.serverPublicKey,
      statusKey: importStatusKey(profile.statusKey),
    });
    return { ...challenge, flowId };
  }

  async finishMigration(input: OnboardingMigrationFinishInput): Promise<{
    deviceId: string;
    migrated: true;
    userId: string;
  }> {
    const parsed = onboardingMigrationFinishInputSchema.parse(input);
    const flow = this.#consumeMigration(parsed.flowId);
    try {
      assertServerKey(parsed.serverStaticPublicKey, flow.serverPublicKey);
      const response = statusKeyMigrationResponseSchema.parse(
        await requestJson(
          normalizeServerUrl(flow.profile.baseUrl),
          "/v1/account/opaque/register/finish",
          {
            flowId: flow.remoteFlowId,
            registrationRecord: parsed.registrationRecord,
            wrappedStatusKey: wrapStatusKeyWithOpaqueExportKey(
              flow.statusKey,
              parsed.exportKey,
              flow.profile.userId,
            ),
          },
          flow.profile.token,
          "PUT",
        ),
      );
      if (!response.migrated) {
        throw new Error("OPAQUE account migration was not applied.");
      }
      return {
        deviceId: flow.profile.deviceId,
        migrated: true,
        userId: flow.profile.userId,
      };
    } finally {
      flow.statusKey.fill(0);
    }
  }

  close(): void {
    for (const flow of this.#registrations.values()) flow.statusKey.fill(0);
    for (const flow of this.#migrations.values()) flow.statusKey.fill(0);
    this.#registrations.clear();
    this.#logins.clear();
    this.#migrations.clear();
  }

  #consumeRegistration(flowId: string): PendingRegistration {
    this.#prune();
    const flow = this.#registrations.get(flowId);
    this.#registrations.delete(flowId);
    if (!flow || flow.expiresAt <= Date.now()) {
      throw new Error("OPAQUE registration flow expired.");
    }
    return flow;
  }

  #consumeLogin(flowId: string): PendingLogin {
    this.#prune();
    const flow = this.#logins.get(flowId);
    this.#logins.delete(flowId);
    if (!flow || flow.expiresAt <= Date.now()) {
      throw new Error("OPAQUE login flow expired.");
    }
    return flow;
  }

  #consumeMigration(flowId: string): PendingMigration {
    this.#prune();
    const flow = this.#migrations.get(flowId);
    this.#migrations.delete(flowId);
    if (!flow || flow.expiresAt <= Date.now()) {
      throw new Error("OPAQUE migration flow expired.");
    }
    return flow;
  }

  #prune(): void {
    const now = Date.now();
    for (const [flowId, flow] of this.#registrations) {
      if (flow.expiresAt > now) continue;
      flow.statusKey.fill(0);
      this.#registrations.delete(flowId);
    }
    for (const [flowId, flow] of this.#logins) {
      if (flow.expiresAt <= now) this.#logins.delete(flowId);
    }
    for (const [flowId, flow] of this.#migrations) {
      if (flow.expiresAt > now) continue;
      flow.statusKey.fill(0);
      this.#migrations.delete(flowId);
    }
  }

  #reserveCapacity(): void {
    if (
      this.#registrations.size + this.#logins.size + this.#migrations.size >=
      MAX_PENDING_FLOWS
    ) {
      throw new Error("OPAQUE onboarding flow capacity has been reached.");
    }
  }
}

async function loadMatchingProfile(
  baseUrl: string,
): Promise<LocalProfile | undefined> {
  try {
    await stat(resolveProfilePath());
  } catch (error) {
    if (isMissingFile(error)) return undefined;
    throw error;
  }
  const profile = await loadLocalProfile();
  if (normalizeServerUrl(profile.baseUrl) !== baseUrl) return undefined;
  return profile;
}

async function saveSession(
  baseUrl: string,
  deviceName: string,
  statusKey: string,
  session: {
    deviceId: string;
    expiresAt: string;
    token: string;
    userId: string;
  },
): Promise<void> {
  await saveLocalProfile({
    baseUrl,
    deviceId: session.deviceId,
    deviceName,
    statusKey,
    token: session.token,
    tokenExpiresAt: session.expiresAt,
    userId: session.userId,
    version: 1,
  });
}

async function requestJson(
  baseUrl: string,
  path: string,
  body: Record<string, unknown>,
  token?: string,
  method = "POST",
): Promise<unknown> {
  const headers = new Headers({ "content-type": "application/json" });
  if (token) headers.set("authorization", `Bearer ${token}`);
  let response: Response;
  try {
    response = await fetch(`${baseUrl}${path}`, {
      body: JSON.stringify(body),
      headers,
      method,
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch (error) {
    throw new OneStatusTransportError(
      `One Status API request failed for ${path}.`,
      { cause: error },
    );
  }
  let responseBody: unknown;
  try {
    responseBody = await response.json();
  } catch (error) {
    throw new OneStatusTransportError(
      `One Status API returned an unreadable JSON response for ${path}.`,
      { cause: error },
    );
  }
  if (!response.ok) {
    const apiError = readApiError(responseBody);
    throw new OneStatusApiError(
      apiError.message ?? `One Status API returned HTTP ${response.status}.`,
      response.status,
      apiError.code ?? "unknown_error",
      responseBody,
    );
  }
  return responseBody;
}

function normalizeServerUrl(value: string): string {
  const normalized = value.trim().replace(/\/$/u, "");
  new OneStatusClient({ baseUrl: normalized });
  return normalized;
}

function readApiError(body: unknown): { code?: string; message?: string } {
  if (!body || typeof body !== "object" || !("error" in body)) return {};
  const error = body.error;
  return error && typeof error === "object" ? error : {};
}

function assertServerKey(actual: string, expected: string): void {
  if (actual !== expected) {
    throw new Error("OPAQUE server identity verification failed.");
  }
}

function statusKeyMigrationRequiredError(): OneStatusApiError {
  return new OneStatusApiError(
    "This account must migrate its encrypted Status Key on a previously connected device.",
    409,
    "status_key_migration_required",
    null,
  );
}

function isMissingFile(error: unknown): boolean {
  return (
    error instanceof Error &&
    "code" in error &&
    (error as NodeJS.ErrnoException).code === "ENOENT"
  );
}
