import { createEmptyStatus, type StatusDocument } from "@one-status/protocol";
import { describe, expect, it } from "vitest";
import type {
  DashboardBackend,
  DashboardStatusSnapshot,
} from "./dashboard-backend.js";
import { PermissionSyncService } from "./permission-sync.js";
import { PermissionVault } from "./permission-vault.js";

describe("Permission Vault encrypted sync", () => {
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
    await firstSync.run(() => undefined);

    const persisted = JSON.stringify(backend.status.permissions.vault);
    expect(persisted).not.toContain("google-client-secret");
    expect(persisted).not.toContain("google-access-token");
    expect(persisted).not.toContain("google-refresh-token");

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
