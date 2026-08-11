import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  encryptStatus,
  exportStatusKey,
  generateStatusKey,
} from "@one-status/crypto";
import { saveLocalProfile } from "@one-status/local-config";
import {
  finishOpaqueLogin,
  finishOpaqueRegistration,
  startOpaqueLogin,
  startOpaqueRegistration,
} from "@one-status/pake";
import { createEmptyStatus, type EncryptedEnvelope } from "@one-status/protocol";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createApp } from "./app.js";
import { OneStatusDatabase } from "./database.js";
import {
  LocalOnboardingService,
  type OnboardingRegistrationStartInput,
} from "./onboarding.js";

const nodeRequire = createRequire(import.meta.url);

describe("local graphical onboarding", () => {
  const directories: string[] = [];

  afterEach(async () => {
    vi.unstubAllEnvs();
    await Promise.all(
      directories.splice(0).map((directory) =>
        rm(directory, { force: true, recursive: true }),
      ),
    );
  });

  it("persists OPAQUE registration and login sessions without receiving a password", async () => {
    const directory = await mkdtemp(join(tmpdir(), "one-status-onboarding-"));
    directories.push(directory);
    const app = createApp({ dbPath: join(directory, "sync.sqlite") });
    const requestBodies: unknown[] = [];
    app.addHook("preHandler", async (request) => {
      if (request.url.includes("/opaque/")) requestBodies.push(request.body);
    });
    await app.listen({ host: "127.0.0.1", port: 0 });
    const serverUrl = listeningUrl(app.server.address());
    const accountSecret = "correct horse battery staple";

    const firstHome = join(directory, "device-a");
    vi.stubEnv("ONE_STATUS_HOME", firstHome);
    const first = new LocalOnboardingService(serverUrl);
    await expect(first.status()).resolves.toMatchObject({ authenticated: false });
    const registered = await completeRegistration(first, {
      accountSecret,
      deviceName: "Mac A",
      email: "ryan@example.test",
      serverUrl,
    });
    await expect(first.status()).resolves.toMatchObject({
      authenticated: true,
      profile: { deviceName: "Mac A", serverUrl },
    });
    const firstProfile = await readFile(join(firstHome, "profile.json"), "utf8");
    expect(firstProfile).not.toContain(accountSecret);
    expect((await stat(join(firstHome, "profile.json"))).mode & 0o777).toBe(0o600);

    const secondHome = join(directory, "device-b");
    vi.stubEnv("ONE_STATUS_HOME", secondHome);
    const second = new LocalOnboardingService(serverUrl);
    await expect(
      completeLogin(second, {
        accountSecret,
        deviceName: "Mac B",
        email: "ryan@example.test",
        serverUrl,
      }),
    ).resolves.toMatchObject({ userId: registered.userId });
    await expect(second.status()).resolves.toMatchObject({
      authenticated: true,
      profile: { deviceName: "Mac B", serverUrl },
    });

    expect(requestBodies).not.toHaveLength(0);
    expect(requestBodies.some(hasPasswordField)).toBe(false);
    expect(JSON.stringify(requestBodies)).not.toContain(accountSecret);
    first.close();
    second.close();
    await app.close();
  });

  it("rejects password-shaped fields before forwarding an onboarding message", async () => {
    const directory = await mkdtemp(join(tmpdir(), "one-status-onboarding-"));
    directories.push(directory);
    vi.stubEnv("ONE_STATUS_HOME", directory);
    const onboarding = new LocalOnboardingService("http://127.0.0.1:1");
    const input = {
      deviceName: "Mac",
      email: "ryan@example.test",
      password: "must remain in the renderer",
      registrationRequest: "opaque_message",
      serverUrl: "http://127.0.0.1:1",
    } as unknown as OnboardingRegistrationStartInput;

    await expect(onboarding.startRegistration(input)).rejects.toMatchObject({
      name: "ZodError",
    });
    onboarding.close();
  });

  it("migrates a legacy account through OPAQUE messages from its connected device", async () => {
    const directory = await mkdtemp(join(tmpdir(), "one-status-migration-"));
    directories.push(directory);
    const databasePath = join(directory, "sync.sqlite");
    const statusKey = generateStatusKey();
    const installationId = "ad266e46-4538-46c5-b98d-03a419829c0c";
    const accountSecret = "legacy onboarding password";
    const legacy = createLegacyAccountFixture({
      databasePath,
      deviceId: installationId,
      deviceName: "Legacy Mac",
      email: "legacy-onboarding@example.test",
      envelope: encryptStatus(createEmptyStatus(), statusKey, 1),
    });

    const app = createApp({ dbPath: databasePath });
    const requestBodies: unknown[] = [];
    app.addHook("preHandler", async (request) => {
      if (request.url.includes("/opaque/")) requestBodies.push(request.body);
    });
    await app.listen({ host: "127.0.0.1", port: 0 });
    const serverUrl = listeningUrl(app.server.address());

    const firstHome = join(directory, "device-a");
    vi.stubEnv("ONE_STATUS_HOME", firstHome);
    await saveLocalProfile({
      baseUrl: serverUrl,
      deviceId: legacy.deviceId,
      deviceName: "Legacy Mac",
      statusKey: exportStatusKey(statusKey),
      token: legacy.token,
      tokenExpiresAt: legacy.expiresAt,
      userId: legacy.userId,
      version: 1,
    });
    const first = new LocalOnboardingService(serverUrl);
    await expect(
      completeMigration(first, accountSecret),
    ).resolves.toMatchObject({ migrated: true, userId: legacy.userId });

    const secondHome = join(directory, "device-b");
    vi.stubEnv("ONE_STATUS_HOME", secondHome);
    const second = new LocalOnboardingService(serverUrl);
    await expect(
      completeLogin(second, {
        accountSecret,
        deviceName: "New Mac",
        email: "legacy-onboarding@example.test",
        serverUrl,
      }),
    ).resolves.toMatchObject({ userId: legacy.userId });

    expect(requestBodies.some(hasPasswordField)).toBe(false);
    expect(JSON.stringify(requestBodies)).not.toContain(accountSecret);
    first.close();
    second.close();
    await app.close();
  });
});

async function completeRegistration(
  onboarding: LocalOnboardingService,
  input: {
    accountSecret: string;
    deviceName: string;
    email: string;
    serverUrl: string;
  },
) {
  const started = await startOpaqueRegistration(input.accountSecret);
  const challenge = await onboarding.startRegistration({
    deviceName: input.deviceName,
    email: input.email,
    registrationRequest: started.registrationRequest,
    serverUrl: input.serverUrl,
  });
  const finished = await finishOpaqueRegistration({
    clientRegistrationState: started.clientRegistrationState,
    password: input.accountSecret,
    profile: challenge.profile,
    registrationResponse: challenge.registrationResponse,
  });
  expect(finished.serverStaticPublicKey).toBe(challenge.serverPublicKey);
  return onboarding.finishRegistration({
    exportKey: finished.exportKey,
    flowId: challenge.flowId,
    registrationRecord: finished.registrationRecord,
    serverStaticPublicKey: finished.serverStaticPublicKey,
  });
}

async function completeLogin(
  onboarding: LocalOnboardingService,
  input: {
    accountSecret: string;
    deviceName: string;
    email: string;
    serverUrl: string;
  },
) {
  const started = await startOpaqueLogin(input.accountSecret);
  const challenge = await onboarding.startLogin({
    deviceName: input.deviceName,
    email: input.email,
    serverUrl: input.serverUrl,
    startLoginRequest: started.startLoginRequest,
  });
  const finished = await finishOpaqueLogin({
    clientLoginState: started.clientLoginState,
    loginResponse: challenge.loginResponse,
    password: input.accountSecret,
    profile: challenge.profile,
  });
  if (!finished) throw new Error("OPAQUE login did not authenticate.");
  expect(finished.serverStaticPublicKey).toBe(challenge.serverPublicKey);
  return onboarding.finishLogin({
    exportKey: finished.exportKey,
    finishLoginRequest: finished.finishLoginRequest,
    flowId: challenge.flowId,
    serverStaticPublicKey: finished.serverStaticPublicKey,
  });
}

async function completeMigration(
  onboarding: LocalOnboardingService,
  accountSecret: string,
) {
  const started = await startOpaqueRegistration(accountSecret);
  const challenge = await onboarding.startMigration({
    registrationRequest: started.registrationRequest,
  });
  const finished = await finishOpaqueRegistration({
    clientRegistrationState: started.clientRegistrationState,
    password: accountSecret,
    profile: challenge.profile,
    registrationResponse: challenge.registrationResponse,
  });
  expect(finished.serverStaticPublicKey).toBe(challenge.serverPublicKey);
  return onboarding.finishMigration({
    exportKey: finished.exportKey,
    flowId: challenge.flowId,
    registrationRecord: finished.registrationRecord,
    serverStaticPublicKey: finished.serverStaticPublicKey,
  });
}

function createLegacyAccountFixture(input: {
  databasePath: string;
  deviceId: string;
  deviceName: string;
  email: string;
  envelope: EncryptedEnvelope;
}) {
  const initializer = new OneStatusDatabase(input.databasePath);
  initializer.close();
  const { DatabaseSync } = nodeRequire("node:sqlite") as typeof import("node:sqlite");
  const database = new DatabaseSync(input.databasePath);
  const userId = "5b650f25-0c4f-4266-994f-2b26ec186c22";
  const token = "legacy-fixture-device-session";
  const now = new Date().toISOString();
  const expiresAt = new Date(Date.now() + 30 * 24 * 60 * 60_000).toISOString();
  database.exec("BEGIN IMMEDIATE");
  try {
    database
      .prepare(
        `INSERT INTO users
           (id, email, password_salt, password_hash, password_auth_scheme,
            wrapped_status_key, created_at)
         VALUES (?, ?, ?, ?, 'legacy-scrypt', NULL, ?)`,
      )
      .run(userId, input.email, "retired", "retired", now);
    database
      .prepare(
        `INSERT INTO devices
           (id, user_id, name, created_at, last_seen_at, blocked)
         VALUES (?, ?, ?, ?, ?, 0)`,
      )
      .run(input.deviceId, userId, input.deviceName, now, now);
    database
      .prepare(
        `INSERT INTO sessions
           (token_hash, user_id, device_id, expires_at,
            status_key_migration_eligible, created_at)
         VALUES (?, ?, ?, ?, 1, ?)`,
      )
      .run(hashFixtureToken(token), userId, input.deviceId, expiresAt, now);
    database
      .prepare(
        `INSERT INTO status_vaults (user_id, version, envelope, updated_at)
         VALUES (?, 1, ?, ?)`,
      )
      .run(userId, JSON.stringify(input.envelope), now);
    database.exec("COMMIT");
  } catch (error) {
    database.exec("ROLLBACK");
    throw error;
  } finally {
    database.close();
  }
  return {
    deviceId: input.deviceId,
    expiresAt,
    token,
    userId,
  };
}

function hashFixtureToken(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("base64url");
}

function listeningUrl(address: ReturnType<typeof import("node:net").Server.prototype.address>): string {
  if (!address || typeof address === "string") throw new Error("Missing port");
  return `http://127.0.0.1:${address.port}`;
}

function hasPasswordField(value: unknown): boolean {
  if (!value || typeof value !== "object") return false;
  if (Array.isArray(value)) return value.some(hasPasswordField);
  return Object.entries(value).some(
    ([key, nested]) => key.toLowerCase().includes("password") || hasPasswordField(nested),
  );
}
