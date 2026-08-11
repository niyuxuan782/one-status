import { chmod, mkdir, mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { wrapStatusKeyWithOpaqueExportKey } from "@one-status/crypto";
import {
  finishOpaqueLogin,
  finishOpaqueRegistration,
  startOpaqueLogin,
  startOpaqueRegistration,
  type OneStatusOpaqueProfile,
} from "@one-status/pake";
import type { EncryptedEnvelope, WrappedStatusKey } from "@one-status/protocol";
import { createApp } from "./app.js";

const initialEnvelope: EncryptedEnvelope = {
  format: "one-status.encrypted-status",
  version: 1,
  algorithm: "AES-256-GCM",
  revision: 1,
  iv: "iv-value",
  ciphertext: "initial-ciphertext-value",
  authTag: "auth-tag-value",
};

const envelope: EncryptedEnvelope = {
  ...initialEnvelope,
  revision: 2,
  ciphertext: "next-ciphertext-value",
};

const statusKey = new Uint8Array(32).fill(7);

describe("sync API", () => {
  let app: FastifyInstance;
  let directory: string;
  let databasePath: string;

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), "one-status-api-"));
    databasePath = join(directory, "test.sqlite");
    app = createApp({ dbPath: databasePath });
    await app.ready();
  });

  afterEach(async () => {
    await app.close();
    await rm(directory, { recursive: true, force: true });
  });

  it("exposes service metadata without authentication", async () => {
    const response = await app.inject({ method: "GET", url: "/" });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      name: "One Status",
      version: "0.9.0",
      health: "/health",
    });
  });

  it("identifies the active production release in health responses", async () => {
    await app.close();
    app = createApp({
      dbPath: join(directory, "release.sqlite"),
      releaseId: "20260809T031700Z",
    });
    await app.ready();

    const response = await app.inject({ method: "GET", url: "/health" });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      status: "ok",
      service: "one-status-api",
      version: "0.9.0",
      release: "20260809T031700Z",
    });
  });

  it("restricts the persistent database to the current OS user", async () => {
    expect((await stat(databasePath)).mode & 0o777).toBe(0o600);
    expect((await stat(directory)).mode & 0o777).toBe(0o700);
  });

  it("does not change permissions on an existing parent directory", async () => {
    const sharedDirectory = join(directory, "shared-parent");
    await mkdir(sharedDirectory, { mode: 0o755 });
    await chmod(sharedDirectory, 0o755);
    const isolated = createApp({
      dbPath: join(sharedDirectory, "isolated.sqlite"),
    });
    await isolated.ready();
    await isolated.close();

    expect((await stat(sharedDirectory)).mode & 0o777).toBe(0o755);
    expect((await stat(join(sharedDirectory, "isolated.sqlite"))).mode & 0o777)
      .toBe(0o600);
  });

  it("registers an account and lists its device", async () => {
    const registration = await register(app);
    const account = await app.inject({
      method: "GET",
      url: "/v1/account",
      headers: { authorization: `Bearer ${registration.token}` },
    });

    expect(account.statusCode).toBe(200);
    expect(account.json()).toMatchObject({
      user: { email: "ryan@example.test" },
      devices: [{ name: "Mac A", online: true, blocked: false }],
      deviceLoginPolicy: { denyNewDeviceLogins: false },
    });
    expect(registration.wrappedStatusKey).toMatchObject({ version: 2 });
  });

  it("does not expose the removed plaintext registration endpoint", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/v1/auth/register",
      payload: {
        email: "legacy-client@example.test",
        password: "legacy client password",
        deviceName: "Legacy client Mac",
        initialEnvelope,
      },
    });

    expect(response.statusCode).toBe(404);
  });

  it("reuses a stable installation ID when the device logs in again", async () => {
    const installationId = "896c1d17-9110-4261-a461-f1472980f976";
    const registration = await register(app, {
      deviceName: "Ryan Mac",
      email: "stable-device@example.test",
      installationId,
      password: "stable installation password",
    });
    expect(registration.deviceId).toBe(installationId);

    const loginSession = await login(app, {
      deviceName: "Ryan Mac renamed",
      email: "stable-device@example.test",
      installationId,
      password: "stable installation password",
    });
    expect(loginSession.deviceId).toBe(installationId);
    expect(loginSession.wrappedStatusKey).toEqual(registration.wrappedStatusKey);

    const account = await app.inject({
      method: "GET",
      url: "/v1/account",
      headers: { authorization: `Bearer ${loginSession.token}` },
    });
    expect(account.json().devices).toEqual([
      expect.objectContaining({
        id: installationId,
        name: "Ryan Mac renamed",
        online: true,
      }),
    ]);
  });

  it("tracks device presence through an authenticated heartbeat", async () => {
    const first = await register(app);
    const second = await login(app, {
      deviceName: "Mac B",
      email: "ryan@example.test",
      installationId: "ef4c0115-2067-40aa-a62e-90d578675585",
      password: "correct horse battery staple",
    });
    const inspection = new DatabaseSync(databasePath);
    inspection
      .prepare("UPDATE devices SET last_seen_at = ? WHERE id = ?")
      .run("2020-01-01T00:00:00.000Z", first.deviceId);
    inspection.close();

    const before = await app.inject({
      method: "GET",
      url: "/v1/account",
      headers: { authorization: `Bearer ${second.token}` },
    });
    expect(
      before.json().devices.find((device: { id: string }) =>
        device.id === first.deviceId),
    ).toMatchObject({ online: false });

    const heartbeat = await app.inject({
      method: "POST",
      url: "/v1/devices/heartbeat",
      headers: { authorization: `Bearer ${first.token}` },
    });
    expect(heartbeat.statusCode).toBe(200);
    expect(heartbeat.json()).toMatchObject({ deviceId: first.deviceId });

    const after = await app.inject({
      method: "GET",
      url: "/v1/account",
      headers: { authorization: `Bearer ${second.token}` },
    });
    expect(
      after.json().devices.find((device: { id: string }) =>
        device.id === first.deviceId),
    ).toMatchObject({ online: true });
  });

  it("stores encrypted envelopes with compare-and-swap versions", async () => {
    const registration = await register(app);
    const headers = { authorization: `Bearer ${registration.token}` };

    const initialized = await app.inject({
      method: "GET",
      url: "/v1/status",
      headers,
    });
    expect(initialized.json()).toMatchObject({
      version: 1,
      envelope: initialEnvelope,
    });

    const stored = await app.inject({
      method: "PUT",
      url: "/v1/status",
      headers,
      payload: {
        mutationId: "3c7527b3-7a3d-4f5d-a148-4dc44708f72d",
        mutationDigest: "a".repeat(43),
        baseVersion: 1,
        envelope,
      },
    });
    expect(stored.statusCode).toBe(200);
    expect(stored.json()).toMatchObject({ version: 2, envelope });

    const conflict = await app.inject({
      method: "PUT",
      url: "/v1/status",
      headers,
      payload: {
        mutationId: "77c23a31-7dfa-44e8-83a1-5da0065ac137",
        mutationDigest: "b".repeat(43),
        baseVersion: 1,
        envelope,
      },
    });
    expect(conflict.statusCode).toBe(409);
    expect(conflict.json()).toMatchObject({
      error: { code: "version_conflict", currentVersion: 2 },
    });

    const duplicate = await app.inject({
      method: "PUT",
      url: "/v1/status",
      headers,
      payload: {
        mutationId: "3c7527b3-7a3d-4f5d-a148-4dc44708f72d",
        mutationDigest: "a".repeat(43),
        baseVersion: 1,
        envelope,
      },
    });
    expect(duplicate.statusCode).toBe(200);
    expect(duplicate.json()).toMatchObject({
      version: 2,
      deduplicated: true,
    });

    const reusedForDifferentMutation = await app.inject({
      method: "PUT",
      url: "/v1/status",
      headers,
      payload: {
        mutationId: "3c7527b3-7a3d-4f5d-a148-4dc44708f72d",
        mutationDigest: "c".repeat(43),
        baseVersion: 2,
        envelope: { ...envelope, revision: 3 },
      },
    });
    expect(reusedForDifferentMutation.statusCode).toBe(409);
    expect(reusedForDifferentMutation.json()).toMatchObject({
      error: { code: "mutation_id_conflict" },
    });

    const inspection = new DatabaseSync(databasePath, { readOnly: true });
    const receiptColumns = inspection
      .prepare("PRAGMA table_info(status_mutation_receipts)")
      .all() as Array<{ name: string }>;
    const receipt = inspection
      .prepare(
        `SELECT mutation_digest, resulting_version
           FROM status_mutation_receipts
          WHERE mutation_id = ?`,
      )
      .get("3c7527b3-7a3d-4f5d-a148-4dc44708f72d") as {
      mutation_digest: string;
      resulting_version: number;
    };
    inspection.close();
    expect(receiptColumns.map((column) => column.name)).not.toContain("envelope");
    expect(receipt).toEqual({
      mutation_digest: "a".repeat(43),
      resulting_version: 2,
    });
  });

  it("rejects invalid device sessions", async () => {
    const response = await app.inject({
      method: "GET",
      url: "/v1/status",
      headers: { authorization: "Bearer invalid" },
    });
    expect(response.statusCode).toBe(401);
  });

  it("logs out the current device session", async () => {
    const registration = await register(app);
    const headers = { authorization: `Bearer ${registration.token}` };

    const logout = await app.inject({
      method: "POST",
      url: "/v1/auth/logout",
      headers,
    });
    expect(logout.statusCode).toBe(200);
    expect(logout.json()).toEqual({ revoked: true });

    const afterLogout = await app.inject({
      method: "GET",
      url: "/v1/status",
      headers,
    });
    expect(afterLogout.statusCode).toBe(401);
  });

  it("revokes another device and all of its sessions", async () => {
    const first = await register(app);
    const second = await login(app, {
      deviceName: "Mac B",
      email: "ryan@example.test",
      password: "correct horse battery staple",
    });

    const revocation = await app.inject({
      method: "DELETE",
      url: `/v1/devices/${second.deviceId}`,
      headers: { authorization: `Bearer ${first.token}` },
    });
    expect(revocation.statusCode).toBe(200);
    expect(revocation.json()).toEqual({
      revoked: true,
      deviceId: second.deviceId,
    });

    const revokedDeviceRead = await app.inject({
      method: "GET",
      url: "/v1/status",
      headers: { authorization: `Bearer ${second.token}` },
    });
    expect(revokedDeviceRead.statusCode).toBe(401);
  });

  it("allows new devices by default and can deny only future devices", async () => {
    const first = await register(app);
    const policy = await app.inject({
      method: "PUT",
      url: "/v1/account/device-login-policy",
      headers: { authorization: `Bearer ${first.token}` },
      payload: { denyNewDeviceLogins: true },
    });
    expect(policy.statusCode).toBe(200);
    expect(policy.json()).toEqual({ denyNewDeviceLogins: true });

    const denied = await loginResponse(app, {
      deviceName: "Unknown Mac",
      email: "ryan@example.test",
      installationId: "4f26176c-2c74-479a-8d03-cb2b6509d406",
      password: "correct horse battery staple",
    });
    expect(denied.statusCode).toBe(403);
    expect(denied.json()).toMatchObject({
      error: { code: "new_device_login_denied" },
    });

    const existing = await loginResponse(app, {
      deviceName: "Mac A",
      email: "ryan@example.test",
      installationId: first.deviceId,
      password: "correct horse battery staple",
    });
    expect(existing.statusCode).toBe(200);
  });

  it("blocks a device until another device removes the block", async () => {
    const first = await register(app);
    const installationId = "a74c1572-7fb5-4ccf-9ca0-6d08314c0d1a";
    const second = await loginResponse(app, {
      deviceName: "Mac B",
      email: "ryan@example.test",
      installationId,
      password: "correct horse battery staple",
    });
    expect(second.statusCode).toBe(200);

    const blocked = await app.inject({
      method: "PUT",
      url: `/v1/devices/${installationId}/block`,
      headers: { authorization: `Bearer ${first.token}` },
    });
    expect(blocked.json()).toEqual({ deviceId: installationId, blocked: true });

    const oldSession = await app.inject({
      method: "GET",
      url: "/v1/status",
      headers: { authorization: `Bearer ${second.json().token}` },
    });
    expect(oldSession.statusCode).toBe(401);

    const deniedLogin = await loginResponse(app, {
      deviceName: "Mac B",
      email: "ryan@example.test",
      installationId,
      password: "correct horse battery staple",
    });
    expect(deniedLogin.statusCode).toBe(403);
    expect(deniedLogin.json()).toMatchObject({
      error: { code: "device_blocked" },
    });

    const unblocked = await app.inject({
      method: "DELETE",
      url: `/v1/devices/${installationId}/block`,
      headers: { authorization: `Bearer ${first.token}` },
    });
    expect(unblocked.json()).toEqual({
      deviceId: installationId,
      blocked: false,
    });

    const restored = await loginResponse(app, {
      deviceName: "Mac B",
      email: "ryan@example.test",
      installationId,
      password: "correct horse battery staple",
    });
    expect(restored.statusCode).toBe(200);
  });

  it("revokes sessions while preserving the known device", async () => {
    const first = await register(app);
    const installationId = "e6b262ec-9fda-4fad-8937-22e01405f3d1";
    const second = await loginResponse(app, {
      deviceName: "Mac B",
      email: "ryan@example.test",
      installationId,
      password: "correct horse battery staple",
    });
    expect(second.statusCode).toBe(200);

    const revoked = await app.inject({
      method: "POST",
      url: `/v1/devices/${installationId}/revoke-sessions`,
      headers: { authorization: `Bearer ${first.token}` },
    });
    expect(revoked.statusCode).toBe(200);
    expect(revoked.json()).toMatchObject({
      deviceId: installationId,
      revokedSessions: 1,
    });

    await app.inject({
      method: "PUT",
      url: "/v1/account/device-login-policy",
      headers: { authorization: `Bearer ${first.token}` },
      payload: { denyNewDeviceLogins: true },
    });
    const relogin = await loginResponse(app, {
      deviceName: "Mac B",
      email: "ryan@example.test",
      installationId,
      password: "correct horse battery staple",
    });
    expect(relogin.statusCode).toBe(200);
  });

  it("rejects an incorrect password without creating a device", async () => {
    const registration = await register(app);
    const started = await startOpaqueLogin("incorrect password value");
    const challenge = await app.inject({
      method: "POST",
      payload: {
        email: "ryan@example.test",
        startLoginRequest: started.startLoginRequest,
      },
      url: "/v1/auth/opaque/login/start",
    });
    expect(challenge.statusCode).toBe(200);
    await expect(
      finishOpaqueLogin({
        clientLoginState: started.clientLoginState,
        loginResponse: challenge.json().loginResponse,
        password: "incorrect password value",
        profile: challenge.json().profile,
      }),
    ).resolves.toBeNull();

    const account = await app.inject({
      method: "GET",
      url: "/v1/account",
      headers: { authorization: `Bearer ${registration.token}` },
    });
    expect(account.json().devices).toHaveLength(1);
  });

  it("re-registers the account password through OPAQUE and rewraps the Status Key", async () => {
    const registration = await register(app, {
      deviceName: "Original Mac",
      email: "password-change@example.test",
      password: "original account password",
    });
    const unprovedRegistration = await startOpaqueRegistration(
      "new account password",
    );
    const unproved = await app.inject({
      headers: { authorization: `Bearer ${registration.token}` },
      method: "POST",
      payload: {
        registrationRequest: unprovedRegistration.registrationRequest,
      },
      url: "/v1/account/opaque/register/start",
    });
    expect(unproved.statusCode).toBe(401);
    const staleProof = await createAccountPasswordProof(
      app,
      "password-change@example.test",
      "original account password",
    );
    const staleRegistration = await startOpaqueRegistration(
      "stale replacement password",
    );
    const staleStart = await app.inject({
      headers: { authorization: `Bearer ${registration.token}` },
      method: "POST",
      payload: {
        accountProof: staleProof,
        registrationRequest: staleRegistration.registrationRequest,
      },
      url: "/v1/account/opaque/register/start",
    });
    expect(staleStart.statusCode).toBe(200);
    const staleChallenge = staleStart.json<OpaqueRegistrationChallenge>();
    const staleFinished = await finishOpaqueRegistration({
      clientRegistrationState: staleRegistration.clientRegistrationState,
      password: "stale replacement password",
      profile: staleChallenge.profile,
      registrationResponse: staleChallenge.registrationResponse,
    });
    const accountProof = await createAccountPasswordProof(
      app,
      "password-change@example.test",
      "original account password",
    );
    const changed = await registerAccountPassword(
      app,
      registration.token,
      registration.userId,
      "new account password",
      accountProof,
    );
    expect(changed).toMatchObject({ migrated: true, wrappedStatusKey: { version: 2 } });
    const staleFinish = await app.inject({
      headers: { authorization: `Bearer ${registration.token}` },
      method: "PUT",
      payload: {
        flowId: staleChallenge.flowId,
        registrationRecord: staleFinished.registrationRecord,
        wrappedStatusKey: wrapStatusKeyWithOpaqueExportKey(
          statusKey,
          staleFinished.exportKey,
          registration.userId,
        ),
      },
      url: "/v1/account/opaque/register/finish",
    });
    expect(staleFinish.statusCode).toBe(401);
    const replayRegistration = await startOpaqueRegistration(
      "another account password",
    );
    const replay = await app.inject({
      headers: { authorization: `Bearer ${registration.token}` },
      method: "POST",
      payload: {
        accountProof,
        registrationRequest: replayRegistration.registrationRequest,
      },
      url: "/v1/account/opaque/register/start",
    });
    expect(replay.statusCode).toBe(401);
    const next = await login(app, {
      deviceName: "New Mac",
      email: "password-change@example.test",
      password: "new account password",
    });
    expect(next.wrappedStatusKey).toEqual(changed.wrappedStatusKey);
  });

  it("binds an account password proof to its authenticated account", async () => {
    const first = await register(app, {
      email: "proof-owner@example.test",
      password: "proof owner password",
    });
    const second = await register(app, {
      email: "proof-target@example.test",
      password: "proof target password",
    });
    const accountProof = await createAccountPasswordProof(
      app,
      "proof-owner@example.test",
      "proof owner password",
    );
    const started = await startOpaqueRegistration("replacement target password");
    const response = await app.inject({
      headers: { authorization: `Bearer ${second.token}` },
      method: "POST",
      payload: {
        accountProof,
        registrationRequest: started.registrationRequest,
      },
      url: "/v1/account/opaque/register/start",
    });
    expect(response.statusCode).toBe(401);
    expect(first.userId).not.toBe(second.userId);
  });

  it("requires an authenticated device for account OPAQUE registration", async () => {
    const started = await startOpaqueRegistration("replacement account password");
    const response = await app.inject({
      method: "POST",
      payload: { registrationRequest: started.registrationRequest },
      url: "/v1/account/opaque/register/start",
    });
    expect(response.statusCode).toBe(401);
  });

  it("rate limits repeated login attempts by IP and identity", async () => {
    await app.close();
    app = createApp({
      dbPath: join(directory, "rate-limit.sqlite"),
      authRateLimit: {
        maxAttemptsPerIdentity: 1,
        maxAttemptsPerIp: 10,
        windowMs: 60_000,
      },
    });
    await app.ready();
    await register(app);
    const firstStart = await startOpaqueLogin("incorrect password value");
    const secondStart = await startOpaqueLogin("incorrect password value");

    const first = await app.inject({
      method: "POST",
      payload: {
        email: "ryan@example.test",
        startLoginRequest: firstStart.startLoginRequest,
      },
      url: "/v1/auth/opaque/login/start",
    });
    expect(first.statusCode).toBe(200);

    const second = await app.inject({
      method: "POST",
      payload: {
        email: "ryan@example.test",
        startLoginRequest: secondStart.startLoginRequest,
      },
      url: "/v1/auth/opaque/login/start",
    });
    expect(second.statusCode).toBe(429);
    expect(second.headers["retry-after"]).toBeDefined();
    expect(second.json()).toMatchObject({ error: { code: "rate_limited" } });
  });

  it("applies identity limits across source IP addresses", async () => {
    await app.close();
    app = createApp({
      dbPath: join(directory, "identity-rate-limit.sqlite"),
      authRateLimit: {
        maxAttemptsPerIdentity: 1,
        maxAttemptsPerIp: 10,
        windowMs: 60_000,
      },
      trustProxy: true,
    });
    await app.ready();
    await register(app);
    const firstStart = await startOpaqueLogin("incorrect password value");
    const secondStart = await startOpaqueLogin("incorrect password value");
    const first = await app.inject({
      headers: { "x-forwarded-for": "198.51.100.10" },
      method: "POST",
      payload: {
        email: "ryan@example.test",
        startLoginRequest: firstStart.startLoginRequest,
      },
      url: "/v1/auth/opaque/login/start",
    });
    expect(first.statusCode).toBe(200);
    const second = await app.inject({
      headers: { "x-forwarded-for": "203.0.113.20" },
      method: "POST",
      payload: {
        email: "ryan@example.test",
        startLoginRequest: secondStart.startLoginRequest,
      },
      url: "/v1/auth/opaque/login/start",
    });
    expect(second.statusCode).toBe(429);
  });
});

async function register(
  app: FastifyInstance,
  options: {
    deviceName?: string;
    email?: string;
    installationId?: string;
    password?: string;
  } = {},
): Promise<{
  token: string;
  deviceId: string;
  userId: string;
  wrappedStatusKey: WrappedStatusKey;
}> {
  const email = options.email ?? "ryan@example.test";
  const password = options.password ?? "correct horse battery staple";
  const started = await startOpaqueRegistration(password);
  const startResponse = await app.inject({
    method: "POST",
    payload: {
      email,
      registrationRequest: started.registrationRequest,
    },
    url: "/v1/auth/opaque/register/start",
  });
  expect(startResponse.statusCode).toBe(200);
  const challenge = startResponse.json<OpaqueRegistrationChallenge>();
  const finished = await finishOpaqueRegistration({
    clientRegistrationState: started.clientRegistrationState,
    password,
    profile: challenge.profile,
    registrationResponse: challenge.registrationResponse,
  });
  expect(finished.serverStaticPublicKey).toBe(challenge.serverPublicKey);
  const wrappedStatusKey = wrapStatusKeyWithOpaqueExportKey(
    statusKey,
    finished.exportKey,
    challenge.accountBinding,
  );
  const response = await app.inject({
    method: "POST",
    payload: {
      deviceName: options.deviceName ?? "Mac A",
      flowId: challenge.flowId,
      initialEnvelope,
      ...(options.installationId
        ? { installationId: options.installationId }
        : {}),
      registrationRecord: finished.registrationRecord,
      wrappedStatusKey,
    },
    url: "/v1/auth/opaque/register/finish",
  });
  expect(response.statusCode).toBe(201);
  return response.json();
}

async function login(
  app: FastifyInstance,
  options: LoginOptions,
): Promise<{
  deviceId: string;
  token: string;
  userId: string;
  wrappedStatusKey: WrappedStatusKey;
}> {
  const response = await loginResponse(app, options);
  expect(response.statusCode).toBe(200);
  return response.json();
}

async function loginResponse(app: FastifyInstance, options: LoginOptions) {
  const started = await startOpaqueLogin(options.password);
  const startResponse = await app.inject({
    method: "POST",
    payload: {
      email: options.email,
      startLoginRequest: started.startLoginRequest,
    },
    url: "/v1/auth/opaque/login/start",
  });
  expect(startResponse.statusCode).toBe(200);
  const challenge = startResponse.json<OpaqueLoginChallenge>();
  const finished = await finishOpaqueLogin({
    clientLoginState: started.clientLoginState,
    loginResponse: challenge.loginResponse,
    password: options.password,
    profile: challenge.profile,
  });
  if (!finished) throw new Error("Test OPAQUE login unexpectedly failed locally.");
  expect(finished.serverStaticPublicKey).toBe(challenge.serverPublicKey);
  return app.inject({
    method: "POST",
    payload: {
      deviceName: options.deviceName,
      finishLoginRequest: finished.finishLoginRequest,
      flowId: challenge.flowId,
      ...(options.installationId
        ? { installationId: options.installationId }
        : {}),
    },
    url: "/v1/auth/opaque/login/finish",
  });
}

async function registerAccountPassword(
  app: FastifyInstance,
  token: string,
  userId: string,
  password: string,
  accountProof: string,
): Promise<{ migrated: boolean; wrappedStatusKey: WrappedStatusKey }> {
  const started = await startOpaqueRegistration(password);
  const startResponse = await app.inject({
    headers: { authorization: `Bearer ${token}` },
    method: "POST",
    payload: { accountProof, registrationRequest: started.registrationRequest },
    url: "/v1/account/opaque/register/start",
  });
  expect(startResponse.statusCode).toBe(200);
  const challenge = startResponse.json<OpaqueRegistrationChallenge>();
  expect(challenge.accountBinding).toBe(userId);
  const finished = await finishOpaqueRegistration({
    clientRegistrationState: started.clientRegistrationState,
    password,
    profile: challenge.profile,
    registrationResponse: challenge.registrationResponse,
  });
  const wrappedStatusKey = wrapStatusKeyWithOpaqueExportKey(
    statusKey,
    finished.exportKey,
    userId,
  );
  const response = await app.inject({
    headers: { authorization: `Bearer ${token}` },
    method: "PUT",
    payload: {
      flowId: challenge.flowId,
      registrationRecord: finished.registrationRecord,
      wrappedStatusKey,
    },
    url: "/v1/account/opaque/register/finish",
  });
  expect(response.statusCode).toBe(200);
  return response.json();
}

async function createAccountPasswordProof(
  app: FastifyInstance,
  email: string,
  password: string,
): Promise<string> {
  const started = await startOpaqueLogin(password);
  const startResponse = await app.inject({
    method: "POST",
    payload: {
      email,
      purpose: "account-password-change",
      startLoginRequest: started.startLoginRequest,
    },
    url: "/v1/auth/opaque/proof/start",
  });
  expect(startResponse.statusCode).toBe(200);
  const challenge = startResponse.json<OpaqueLoginChallenge>();
  const finished = await finishOpaqueLogin({
    clientLoginState: started.clientLoginState,
    loginResponse: challenge.loginResponse,
    password,
    profile: challenge.profile,
  });
  if (!finished) throw new Error("Test OPAQUE proof unexpectedly failed locally.");
  const finishResponse = await app.inject({
    method: "POST",
    payload: {
      finishLoginRequest: finished.finishLoginRequest,
      flowId: challenge.flowId,
    },
    url: "/v1/auth/opaque/proof/finish",
  });
  expect(finishResponse.statusCode).toBe(200);
  return finishResponse.json<{ proofToken: string }>().proofToken;
}

interface LoginOptions {
  deviceName: string;
  email: string;
  installationId?: string;
  password: string;
}

interface OpaqueRegistrationChallenge {
  accountBinding: string;
  flowId: string;
  profile: OneStatusOpaqueProfile;
  registrationResponse: string;
  serverPublicKey: string;
}

interface OpaqueLoginChallenge {
  flowId: string;
  loginResponse: string;
  profile: OneStatusOpaqueProfile;
  serverPublicKey: string;
}
