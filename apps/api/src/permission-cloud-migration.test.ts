import { describe, expect, it, vi } from "vitest";
import { PermissionCloudMigration } from "./permission-cloud-migration.js";

describe("PermissionCloudMigration", () => {
  it("backfills credentials with keyed verification and skips unchanged state", async () => {
    const requests: Array<{
      authorization: string | null;
      body: Record<string, unknown>;
      url: string;
    }> = [];
    const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as {
        credentials: Array<Record<string, unknown>>;
        digest: string;
      };
      requests.push({
        authorization: new Headers(init?.headers).get("authorization"),
        body,
        url: String(input),
      });
      return Response.json({
        count: body.credentials.length,
        digest: body.digest,
        verified: true,
      });
    });
    const migration = new PermissionCloudMigration({
      fetch: fetchMock as typeof fetch,
      loadProfile: async () => ({
        baseUrl: "https://os.example.test",
        deviceId: "device-1",
        deviceName: "Mac",
        statusKey: `os1_${"a".repeat(43)}`,
        token: "device-session-token",
        tokenExpiresAt: "2026-09-01T00:00:00.000Z",
        userId: "user-1",
        version: 1,
      }),
      local: {
        async listCredentials() {
          return [credential];
        },
      },
    });

    await expect(migration.run()).resolves.toEqual({
      count: 1,
      state: "verified",
    });
    await expect(migration.run()).resolves.toEqual({
      count: 1,
      state: "skipped",
    });
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(requests[0]).toMatchObject({
      authorization: "Bearer device-session-token",
      url: "https://os.example.test/v1/vault/migrations/backfill",
    });
    const uploaded = requests[0]!.body.credentials as Array<
      Record<string, unknown>
    >;
    expect(uploaded[0]).not.toHaveProperty("userId");
    expect(String(requests[0]!.body.validationKey)).toMatch(
      /^[A-Za-z0-9_-]{43}$/u,
    );
  });

  it("rejects an unverified server response", async () => {
    const migration = new PermissionCloudMigration({
      fetch: async () => Response.json({ count: 1, digest: "wrong", verified: true }),
      loadProfile: async () => ({
        baseUrl: "https://os.example.test",
        deviceId: "device-1",
        deviceName: "Mac",
        statusKey: `os1_${"a".repeat(43)}`,
        token: "device-session-token",
        tokenExpiresAt: "2026-09-01T00:00:00.000Z",
        userId: "user-1",
        version: 1,
      }),
      local: { async listCredentials() { return [credential]; } },
    });
    await expect(migration.run()).rejects.toThrow(
      "cloud_vault_migration_verification_failed",
    );
  });
});

const credential = {
  accessPolicy: {
    allowAgentRead: true,
    allowedAgentIds: [],
    allowedProjectIds: [],
    deniedAgentIds: [],
    deniedProjectIds: [],
    requireApproval: false,
  },
  createdAt: "2026-08-11T05:00:00.000Z",
  expiresAt: null,
  fields: { host: "server.example", username: "ubuntu" },
  id: "33333333-3333-4333-8333-333333333333",
  kind: "ssh" as const,
  label: "Server SSH",
  purposes: ["ssh.connect"],
  secrets: { password: "private-password" },
  source: { type: "import" as const },
  tags: ["production"],
  updatedAt: "2026-08-11T05:00:00.000Z",
  userId: "user-1",
};
