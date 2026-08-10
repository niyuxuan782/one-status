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
    expect(first.verifyModelWalletPassword("user-1", "123456")).toBe(true);
    expect(
      first.changeModelWalletPassword("user-1", "123456", "654321"),
    ).toBe(true);
    const walletPassword = first.exportBundle("user-1").walletPassword;
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
    expect(second.exportBundle("user-1").walletPassword).toEqual(
      walletPassword,
    );
    expect(second.verifyModelWalletPassword("user-1", "123456")).toBe(false);
    expect(second.verifyModelWalletPassword("user-1", "654321")).toBe(true);

    await secondSync.run(() => {
      second.deleteConnection("user-1", connection.id);
    });
    await firstSync.run(() => undefined);
    expect(first.listConnections("user-1")).toEqual([]);
    expect(first.listGrants("user-1")).toEqual([]);
    first.close();
    second.close();
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
