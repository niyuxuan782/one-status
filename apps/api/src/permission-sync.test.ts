import { createEmptyStatus, type StatusDocument } from "@one-status/protocol";
import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  DashboardBackend,
  DashboardStatusSnapshot,
} from "./dashboard-backend.js";
import { PermissionSyncService } from "./permission-sync.js";
import { PermissionVault } from "./permission-vault.js";
import { ToolConnectionExpiredError } from "./tool-gateway.js";

describe("Permission Vault encrypted sync", () => {
  afterEach(() => vi.useRealTimers());
  it("moves credentials and grants between device-local vaults as ciphertext", async () => {
    const backend = new MemoryBackend();
    const first = createVault(1);
    const second = createVault(2);
    const context = async () => ({
      statusKey: new Uint8Array(32).fill(8),
      userId: "user-1",
    });
    const firstSync = new PermissionSyncService(backend, first, context);
    const secondSync = new PermissionSyncService(backend, second, context);

    first.configureProvider("user-1", "google", {
      clientId: "google-client",
      clientSecret: "google-client-secret",
    });
    const connection = first.upsertConnection({
      accountId: "google-account",
      credential: {
        accessToken: "google-access-token",
        refreshToken: "google-refresh-token",
      },
      expiresAt: "2026-09-08T10:00:00.000Z",
      label: "ryan@example.test",
      provider: "google",
      scopes: ["calendar.readonly"],
      userId: "user-1",
    });
    first.setGrant("user-1", connection.id, "codex", [
      "calendar.events.list",
    ]);
    first.setModelCredential(
      "user-1",
      "third-party-a",
      "third-party-model-secret",
    );
    const [firstModelCredential] = first.listPrivateCredentials("user-1", {
      kinds: ["model"],
    });
    await firstSync.run(() => undefined);

    const persisted = JSON.stringify(backend.status.permissions.vault);
    expect(persisted).not.toContain("google-client-secret");
    expect(persisted).not.toContain("google-access-token");
    expect(persisted).not.toContain("google-refresh-token");
    expect(persisted).not.toContain("third-party-model-secret");

    await secondSync.run(() => undefined);
    expect(second.getProviderConfig("user-1", "google")).toMatchObject({
      clientId: "google-client",
      clientSecret: "google-client-secret",
    });
    expect(
      second.getConnectionWithCredential("user-1", connection.id)?.credential,
    ).toMatchObject({ refreshToken: "google-refresh-token" });
    expect(second.getAllowedActions("user-1", connection.id, "codex")).toEqual(
      ["calendar.events.list"],
    );
    expect(second.getModelCredential("user-1", "third-party-a")).toBe(
      "third-party-model-secret",
    );
    const [secondModelCredential] = second.listPrivateCredentials("user-1", {
      kinds: ["model"],
    });
    expect(secondModelCredential?.id).toBe(firstModelCredential?.id);
    expect(
      second.readPrivateCredentialForAgent({
        agentId: "claude-code",
        credentialId: secondModelCredential!.id,
        purpose: "model.api",
        userId: "user-1",
      })?.secrets,
    ).toEqual({ apiKey: "third-party-model-secret" });
    await secondSync.run(() => {
      second.ignoreModelCredential("user-1", "third-party-a");
    });
    await firstSync.run(() => undefined);
    expect(first.getModelCredential("user-1", "third-party-a")).toBeUndefined();
    expect(first.isModelCredentialIgnored("user-1", "third-party-a")).toBe(true);

    await secondSync.run(() => {
      second.deleteConnection("user-1", connection.id);
    });
    await firstSync.run(() => undefined);
    expect(first.listConnections("user-1")).toEqual([]);
    expect(first.listGrants("user-1")).toEqual([]);
    first.close();
    second.close();
  });

  it("repairs credential extensions omitted by a legacy client", async () => {
    const backend = new MemoryBackend();
    const legacy = createVault(21);
    const current = createVault(22);
    const nextDevice = createVault(23);
    const context = async () => ({
      statusKey: new Uint8Array(32).fill(24),
      userId: "user-1",
    });
    const legacyExport = legacy.exportBundle.bind(legacy);
    vi.spyOn(legacy, "exportBundle").mockImplementation((userId) => {
      const bundle = legacyExport(userId);
      delete bundle.modelCredentialIgnores;
      delete bundle.privateCredentialTombstones;
      delete bundle.privateCredentials;
      return bundle;
    });
    legacy.configureProvider("user-1", "slack", {
      clientId: "legacy-slack-client",
    });
    await new PermissionSyncService(backend, legacy, context).run(
      () => undefined,
    );

    current.ignoreModelCredential("user-1", "deleted-source");
    const privateCredential = current.upsertPrivateCredential({
      fields: { host: "server.internal", username: "ubuntu" },
      kind: "ssh",
      label: "Production SSH",
      purposes: ["deployment.ssh"],
      secrets: { password: "private-sync-secret" },
      userId: "user-1",
    });
    expect(current.exportBundle("user-1").modelCredentialIgnores).toEqual([
      expect.objectContaining({ sourceId: "deleted-source" }),
    ]);
    await new PermissionSyncService(backend, current, context).run(
      () => undefined,
    );
    expect(current.listPrivateCredentials("user-1")).toEqual([
      expect.objectContaining({ id: privateCredential.id }),
    ]);
    expect(current.exportBundle("user-1").modelCredentialIgnores).toEqual([
      expect.objectContaining({ sourceId: "deleted-source" }),
    ]);
    await new PermissionSyncService(backend, nextDevice, context).run(
      () => undefined,
    );
    expect(nextDevice.exportBundle("user-1").modelCredentialIgnores).toEqual([
      expect.objectContaining({ sourceId: "deleted-source" }),
    ]);
    expect(nextDevice.listPrivateCredentials("user-1")).toEqual([
      expect.objectContaining({ id: privateCredential.id }),
    ]);
    expect(
      nextDevice.revealPrivateCredentialAuthorized(
        "user-1",
        privateCredential.id,
      )?.secrets,
    ).toEqual({ password: "private-sync-secret" });
    expect(
      nextDevice.isModelCredentialIgnored("user-1", "deleted-source"),
    ).toBe(true);
    legacy.close();
    current.close();
    nextDevice.close();
  });

  it("keeps a modern deletion when a legacy client re-uploads the credential", async () => {
    const backend = new MemoryBackend();
    const modern = createVault(25);
    const legacy = createVault(26);
    const nextDevice = createVault(27);
    const context = async () => ({
      statusKey: new Uint8Array(32).fill(28),
      userId: "user-1",
    });
    const modernSync = new PermissionSyncService(backend, modern, context);
    const legacySync = new PermissionSyncService(backend, legacy, context);
    const legacyExport = legacy.exportBundle.bind(legacy);
    vi.spyOn(legacy, "exportBundle").mockImplementation((userId) => {
      const bundle = legacyExport(userId);
      delete bundle.modelCredentialIgnores;
      delete bundle.privateCredentialTombstones;
      delete bundle.privateCredentials;
      return bundle;
    });

    modern.setModelCredential("user-1", "removed-source", "initial-secret");
    await modernSync.run(() => undefined);
    await legacySync.run(() => undefined);
    await modernSync.run(() => {
      modern.ignoreModelCredential("user-1", "removed-source");
    });

    await legacySync.run(() => {
      legacy.setModelCredential(
        "user-1",
        "removed-source",
        "legacy-reuploaded-secret",
      );
    });

    expect(legacy.getModelCredential("user-1", "removed-source")).toBeUndefined();
    expect(legacy.isModelCredentialIgnored("user-1", "removed-source")).toBe(
      true,
    );
    await new PermissionSyncService(backend, nextDevice, context).run(
      () => undefined,
    );
    expect(nextDevice.getModelCredential("user-1", "removed-source"))
      .toBeUndefined();
    expect(nextDevice.isModelCredentialIgnored("user-1", "removed-source"))
      .toBe(true);
    modern.close();
    legacy.close();
    nextDevice.close();
  });

  it("resolves concurrent private credential updates, deletion, and recreation", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-10T10:00:00.000Z"));
    const backend = new MemoryBackend();
    const first = createVault(34);
    const second = createVault(35);
    const third = createVault(36);
    const context = async () => ({
      statusKey: new Uint8Array(32).fill(37),
      userId: "user-1",
    });
    const firstSync = new PermissionSyncService(backend, first, context);
    const secondSync = new PermissionSyncService(backend, second, context);
    const credential = first.upsertPrivateCredential({
      fields: { host: "server.internal", username: "ubuntu" },
      kind: "ssh",
      label: "Production SSH",
      purposes: ["deployment.ssh"],
      secrets: { password: "initial-secret" },
      userId: "user-1",
    });
    await firstSync.run(() => undefined);
    await secondSync.run(() => undefined);

    await secondSync.run(async () => {
      vi.setSystemTime(new Date("2026-08-10T10:01:00.000Z"));
      second.upsertPrivateCredential({
        fields: { host: "server.internal", username: "ubuntu" },
        id: credential.id,
        kind: "ssh",
        label: "Production SSH",
        purposes: ["deployment.ssh"],
        secrets: { password: "concurrent-update" },
        userId: "user-1",
      });
      vi.setSystemTime(new Date("2026-08-10T10:02:00.000Z"));
      await firstSync.run(() => {
        expect(
          first.deletePrivateCredential("user-1", credential.id),
        ).toBe(true);
      });
    });

    expect(second.listPrivateCredentials("user-1")).toEqual([]);
    expect(second.exportBundle("user-1").privateCredentialTombstones).toEqual([
      expect.objectContaining({ credentialId: credential.id }),
    ]);
    await new PermissionSyncService(backend, third, context).run(
      () => undefined,
    );
    expect(third.listPrivateCredentials("user-1")).toEqual([]);

    vi.setSystemTime(new Date("2026-08-10T10:03:00.000Z"));
    await firstSync.run(() => {
      first.upsertPrivateCredential({
        fields: { host: "server.internal", username: "ubuntu" },
        id: credential.id,
        kind: "ssh",
        label: "Production SSH",
        purposes: ["deployment.ssh"],
        secrets: { password: "recreated-secret" },
        userId: "user-1",
      });
    });
    await secondSync.run(() => undefined);
    expect(
      second.revealPrivateCredentialAuthorized("user-1", credential.id)?.secrets,
    ).toEqual({ password: "recreated-secret" });
    expect(
      JSON.stringify(backend.status.permissions.vault),
    ).not.toContain("recreated-secret");
    first.close();
    second.close();
    third.close();
  });

  it("fails closed when another Status Key is used", async () => {
    const backend = new MemoryBackend();
    const first = createVault(3);
    const second = createVault(4);
    first.configureProvider("user-1", "slack", { clientId: "slack-client" });
    await new PermissionSyncService(backend, first, async () => ({
      statusKey: new Uint8Array(32).fill(5),
      userId: "user-1",
    })).run(() => undefined);

    await expect(
      new PermissionSyncService(backend, second, async () => ({
        statusKey: new Uint8Array(32).fill(6),
        userId: "user-1",
      })).run(() => undefined),
    ).rejects.toThrow("Unable to decrypt the synced Permission Vault");
    first.close();
    second.close();
  });

  it("recovers a single-use refresh race from another device", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-09T12:00:00.000Z"));
    const backend = new MemoryBackend();
    const first = createVault(7);
    const second = createVault(8);
    const context = async () => ({
      statusKey: new Uint8Array(32).fill(9),
      userId: "user-1",
    });
    const firstSync = new PermissionSyncService(backend, first, context);
    first.configureProvider("user-1", "slack", { clientId: "slack-client" });
    const connection = first.upsertConnection({
      accountId: "T1",
      credential: {
        accessToken: "old-access",
        refreshToken: "single-use-refresh",
      },
      expiresAt: "2026-08-09T00:00:00.000Z",
      label: "Workspace",
      provider: "slack",
      scopes: ["channels:read", "groups:read"],
      userId: "user-1",
    });
    await firstSync.run(() => undefined);
    let publishedRotation = false;
    const secondSync = new PermissionSyncService(backend, second, context, {
      refreshRetryDelaysMs: [0],
      sleep: async () => {
        if (publishedRotation) return;
        publishedRotation = true;
        await firstSync.run(() => {
          first.updateCredential(
            "user-1",
            connection.id,
            {
              accessToken: "rotated-access",
              refreshToken: "rotated-refresh",
            },
            "2026-08-10T00:00:00.000Z",
          );
        });
      },
    });
    let attempts = 0;

    const credential = await secondSync.run(() => {
      attempts += 1;
      const current = second.getConnectionWithCredential(
        "user-1",
        connection.id,
      );
      if (current?.credential.refreshToken === "single-use-refresh") {
        throw new ToolConnectionExpiredError(true);
      }
      return current?.credential;
    });

    expect(attempts).toBe(2);
    expect(credential).toMatchObject({
      accessToken: "rotated-access",
      refreshToken: "rotated-refresh",
    });
    expect(second.getConnection("user-1", connection.id)?.status).toBe(
      "connected",
    );
    first.close();
    second.close();
  });

  it("keeps the cloud baseline authoritative over a stale future device clock", async () => {
    const backend = new MemoryBackend();
    const first = createVault(11);
    const second = createVault(12);
    const context = async () => ({
      statusKey: new Uint8Array(32).fill(13),
      userId: "user-1",
    });
    const firstSync = new PermissionSyncService(backend, first, context);
    const secondSync = new PermissionSyncService(backend, second, context);
    first.configureProvider("user-1", "slack", { clientId: "slack-client" });
    const connection = first.upsertConnection({
      accountId: "T1",
      credential: { accessToken: "initial", refreshToken: "initial-refresh" },
      expiresAt: "2026-08-10T00:00:00.000Z",
      label: "Workspace",
      provider: "slack",
      scopes: ["channels:read"],
      userId: "user-1",
    });
    await firstSync.run(() => undefined);
    await secondSync.run(() => undefined);

    vi.useFakeTimers();
    vi.setSystemTime(new Date("2030-01-01T00:00:00.000Z"));
    second.updateCredential(
      "user-1",
      connection.id,
      { accessToken: "stale-future", refreshToken: "stale-future-refresh" },
      "2030-01-01T01:00:00.000Z",
    );
    vi.setSystemTime(new Date("2026-08-09T12:00:00.000Z"));
    await firstSync.run(() => {
      first.updateCredential(
        "user-1",
        connection.id,
        { accessToken: "rotated", refreshToken: "rotated-refresh" },
        "2026-08-10T12:00:00.000Z",
      );
    });

    await secondSync.run(() => undefined);
    expect(
      second.getConnectionWithCredential("user-1", connection.id)?.credential,
    ).toMatchObject({
      accessToken: "rotated",
      refreshToken: "rotated-refresh",
    });
    first.close();
    second.close();
  });

});

class MemoryBackend implements DashboardBackend {
  status: StatusDocument = createEmptyStatus();
  version = 1;

  async getSnapshot(): Promise<DashboardStatusSnapshot> {
    return {
      account: {
        user: {
          id: "user-1",
          email: "ryan@example.test",
          createdAt: "2026-08-08T10:00:00.000Z",
        },
        devices: [],
        deviceLoginPolicy: { denyNewDeviceLogins: false },
      },
      profile: {
        baseUrl: "https://os.example.test",
        deviceId: "device-1",
        deviceName: "Mac",
        tokenExpiresAt: "2026-09-08T10:00:00.000Z",
        userId: "user-1",
      },
      status: structuredClone(this.status),
      updatedAt: "2026-08-08T10:00:00.000Z",
      version: this.version,
    };
  }

  async mutateStatus(
    mutator: (status: StatusDocument) => void,
  ): Promise<DashboardStatusSnapshot> {
    mutator(this.status);
    this.version += 1;
    return this.getSnapshot();
  }

  async revokeDevice(): Promise<void> {}

  async userId(): Promise<string> {
    return "user-1";
  }
}

function createVault(fill: number): PermissionVault {
  return new PermissionVault({
    key: new Uint8Array(32).fill(fill),
    path: ":memory:",
  });
}
