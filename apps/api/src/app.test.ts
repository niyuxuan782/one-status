import { chmod, mkdir, mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type {
  EncryptedEnvelope,
  WrappedStatusKey,
} from "@one-status/protocol";
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

const wrappedStatusKey: WrappedStatusKey = {
  format: "one-status.wrapped-status-key",
  version: 1,
  algorithm: "AES-256-GCM",
  kdf: {
    algorithm: "scrypt",
    salt: "s".repeat(22),
    cost: 16_384,
    blockSize: 8,
    parallelization: 1,
    keyLength: 32,
  },
  iv: "i".repeat(16),
  ciphertext: "c".repeat(43),
  authTag: "a".repeat(22),
};

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
      version: "0.8.0",
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
      version: "0.8.0",
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
    expect(registration.wrappedStatusKey).toEqual(wrappedStatusKey);
  });

  it("accepts an older client registration without a wrapped Status Key", async () => {
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

    expect(response.statusCode).toBe(201);
    expect(response.json()).toMatchObject({ wrappedStatusKey: null });
  });

  it("reuses a stable installation ID when the device logs in again", async () => {
    const installationId = "896c1d17-9110-4261-a461-f1472980f976";
    const registration = await app.inject({
      method: "POST",
      url: "/v1/auth/register",
      payload: {
        email: "stable-device@example.test",
        password: "stable installation password",
        deviceName: "Ryan Mac",
        installationId,
        initialEnvelope,
        wrappedStatusKey,
      },
    });
    expect(registration.statusCode).toBe(201);
    expect(registration.json().deviceId).toBe(installationId);

    const login = await app.inject({
      method: "POST",
      url: "/v1/auth/login",
      payload: {
        email: "stable-device@example.test",
        password: "stable installation password",
        deviceName: "Ryan Mac renamed",
        installationId,
      },
    });
    expect(login.statusCode).toBe(200);
    expect(login.json().deviceId).toBe(installationId);
    expect(login.json().wrappedStatusKey).toEqual(wrappedStatusKey);

    const account = await app.inject({
      method: "GET",
      url: "/v1/account",
      headers: { authorization: `Bearer ${login.json().token}` },
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
    const secondLogin = await app.inject({
      method: "POST",
      url: "/v1/auth/login",
      payload: {
        email: "ryan@example.test",
        password: "correct horse battery staple",
        deviceName: "Mac B",
        installationId: "ef4c0115-2067-40aa-a62e-90d578675585",
      },
    });
    const second = secondLogin.json();
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
    const secondLogin = await app.inject({
      method: "POST",
      url: "/v1/auth/login",
      payload: {
        email: "ryan@example.test",
        password: "correct horse battery staple",
        deviceName: "Mac B",
      },
    });
    const second = secondLogin.json();

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

    const denied = await app.inject({
      method: "POST",
      url: "/v1/auth/login",
      payload: {
        email: "ryan@example.test",
        password: "correct horse battery staple",
        deviceName: "Unknown Mac",
        installationId: "4f26176c-2c74-479a-8d03-cb2b6509d406",
      },
    });
    expect(denied.statusCode).toBe(403);
    expect(denied.json()).toMatchObject({
      error: { code: "new_device_login_denied" },
    });

    const existing = await app.inject({
      method: "POST",
      url: "/v1/auth/login",
      payload: {
        email: "ryan@example.test",
        password: "correct horse battery staple",
        deviceName: "Mac A",
        installationId: first.deviceId,
      },
    });
    expect(existing.statusCode).toBe(200);
  });

  it("blocks a device until another device removes the block", async () => {
    const first = await register(app);
    const installationId = "a74c1572-7fb5-4ccf-9ca0-6d08314c0d1a";
    const second = await app.inject({
      method: "POST",
      url: "/v1/auth/login",
      payload: {
        email: "ryan@example.test",
        password: "correct horse battery staple",
        deviceName: "Mac B",
        installationId,
      },
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

    const deniedLogin = await app.inject({
      method: "POST",
      url: "/v1/auth/login",
      payload: {
        email: "ryan@example.test",
        password: "correct horse battery staple",
        deviceName: "Mac B",
        installationId,
      },
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

    const restored = await app.inject({
      method: "POST",
      url: "/v1/auth/login",
      payload: {
        email: "ryan@example.test",
        password: "correct horse battery staple",
        deviceName: "Mac B",
        installationId,
      },
    });
    expect(restored.statusCode).toBe(200);
  });

  it("revokes sessions while preserving the known device", async () => {
    const first = await register(app);
    const installationId = "e6b262ec-9fda-4fad-8937-22e01405f3d1";
    const second = await app.inject({
      method: "POST",
      url: "/v1/auth/login",
      payload: {
        email: "ryan@example.test",
        password: "correct horse battery staple",
        deviceName: "Mac B",
        installationId,
      },
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
    const relogin = await app.inject({
      method: "POST",
      url: "/v1/auth/login",
      payload: {
        email: "ryan@example.test",
        password: "correct horse battery staple",
        deviceName: "Mac B",
        installationId,
      },
    });
    expect(relogin.statusCode).toBe(200);
  });

  it("rejects an incorrect password without creating a device", async () => {
    const registration = await register(app);
    const login = await app.inject({
      method: "POST",
      url: "/v1/auth/login",
      payload: {
        email: "ryan@example.test",
        password: "incorrect password value",
        deviceName: "Untrusted device",
      },
    });
    expect(login.statusCode).toBe(401);

    const account = await app.inject({
      method: "GET",
      url: "/v1/account",
      headers: { authorization: `Bearer ${registration.token}` },
    });
    expect(account.json().devices).toHaveLength(1);
  });

  it("migrates a wrapped Status Key from a legacy account device", async () => {
    const registration = await app.inject({
      method: "POST",
      url: "/v1/auth/register",
      payload: {
        email: "legacy-migration@example.test",
        password: "legacy migration password",
        deviceName: "Legacy Mac",
        initialEnvelope,
      },
    });
    const rejected = await app.inject({
      method: "PUT",
      url: "/v1/account/wrapped-status-key",
      headers: { authorization: `Bearer ${registration.json().token}` },
      payload: {
        password: "incorrect migration password",
        wrappedStatusKey,
      },
    });
    expect(rejected.statusCode).toBe(401);
    const migrated = await app.inject({
      method: "PUT",
      url: "/v1/account/wrapped-status-key",
      headers: { authorization: `Bearer ${registration.json().token}` },
      payload: {
        password: "legacy migration password",
        wrappedStatusKey,
      },
    });
    expect(migrated.statusCode).toBe(200);
    expect(migrated.json()).toEqual({
      migrated: true,
      wrappedStatusKey,
    });
    const replacement = { ...wrappedStatusKey, authTag: "b".repeat(22) };
    const repeated = await app.inject({
      method: "PUT",
      url: "/v1/account/wrapped-status-key",
      headers: { authorization: `Bearer ${registration.json().token}` },
      payload: {
        password: "legacy migration password",
        wrappedStatusKey: replacement,
      },
    });
    expect(repeated.json()).toEqual({
      migrated: false,
      wrappedStatusKey,
    });

    const login = await app.inject({
      method: "POST",
      url: "/v1/auth/login",
      payload: {
        email: "legacy-migration@example.test",
        password: "legacy migration password",
        deviceName: "New Mac",
      },
    });
    expect(login.statusCode).toBe(200);
    expect(login.json()).toMatchObject({ wrappedStatusKey });
  });

  it("rejects legacy migration from a newly created device session", async () => {
    await app.inject({
      method: "POST",
      url: "/v1/auth/register",
      payload: {
        email: "legacy-new-device@example.test",
        password: "legacy migration password",
        deviceName: "Legacy Mac",
        initialEnvelope,
      },
    });
    const login = await app.inject({
      method: "POST",
      url: "/v1/auth/login",
      payload: {
        email: "legacy-new-device@example.test",
        password: "legacy migration password",
        deviceName: "Unknown Mac",
      },
    });
    const migration = await app.inject({
      method: "PUT",
      url: "/v1/account/wrapped-status-key",
      headers: { authorization: `Bearer ${login.json().token}` },
      payload: {
        password: "legacy migration password",
        wrappedStatusKey,
      },
    });
    expect(migration.statusCode).toBe(403);
    expect(migration.json()).toMatchObject({
      error: { code: "status_key_migration_forbidden" },
    });
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
    const payload = {
      email: "ryan@example.test",
      password: "incorrect password value",
      deviceName: "Untrusted device",
    };

    const first = await app.inject({
      method: "POST",
      url: "/v1/auth/login",
      payload,
    });
    expect(first.statusCode).toBe(401);

    const second = await app.inject({
      method: "POST",
      url: "/v1/auth/login",
      payload,
    });
    expect(second.statusCode).toBe(429);
    expect(second.headers["retry-after"]).toBeDefined();
    expect(second.json()).toMatchObject({ error: { code: "rate_limited" } });
  });
});

async function register(
  app: FastifyInstance,
): Promise<{
  token: string;
  deviceId: string;
  wrappedStatusKey: WrappedStatusKey;
}> {
  const response = await app.inject({
    method: "POST",
    url: "/v1/auth/register",
    payload: {
      email: "ryan@example.test",
      password: "correct horse battery staple",
      deviceName: "Mac A",
      initialEnvelope,
      wrappedStatusKey,
    },
  });
  expect(response.statusCode).toBe(201);
  return response.json();
}
