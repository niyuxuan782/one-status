import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createEmptyStatus, type StatusDocument } from "@one-status/protocol";
import type { FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createApp } from "./app.js";
import type {
  DashboardBackend,
  DashboardStatusSnapshot,
} from "./dashboard-backend.js";
import type { DashboardRuntime } from "./dashboard.js";
import { DeviceControlService } from "./device-control.js";
import type { LocalInventorySnapshot } from "./local-inventory.js";
import { PermissionVault } from "./permission-vault.js";
import { ToolGateway } from "./tool-gateway.js";

const DEVICE_ID = "ce8967bc-a70f-421f-a7b7-c8a9a251b284";
const SOURCE_ID = "third-party-a";
const MODEL_ID = "third-party-a:model:gpt-5-4";
const API_KEY = "route-only-private-model-key";

describe("dashboard device control routes", () => {
  let app: FastifyInstance;
  let backend: MemoryBackend;
  let directory: string;
  let permissionVault: PermissionVault;
  const apply = vi.fn(async () => ({
    appliedAt: "2026-08-09T16:00:00.000Z",
  }));

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), "one-status-model-routes-"));
    backend = new MemoryBackend();
    permissionVault = new PermissionVault({
      path: ":memory:",
      key: new Uint8Array(32).fill(18),
    });
    const inventory = {
      async get() {
        return inventorySnapshot;
      },
      async refresh() {
        return inventorySnapshot;
      },
    };
    const deviceControl = new DeviceControlService(
      backend,
      inventory,
      permissionVault,
      { apply },
    );
    app = createApp({
      dbPath: join(directory, "sync.sqlite"),
      dashboard: {
        backend,
        deviceControl,
        handoffs: {} as DashboardRuntime["handoffs"],
        inventory,
        permissionVault,
        toolGateway: new ToolGateway(permissionVault),
      },
    });
    await app.ready();
  });

  afterEach(async () => {
    await app.close();
    await rm(directory, { recursive: true, force: true });
    apply.mockClear();
  });

  it("stores a model credential in Vault and applies a confirmed preview", async () => {
    const headers = await dashboardHeaders(app);
    const incompatibleSource = await app.inject({
      method: "PUT",
      url: "/v1/dashboard/model-sources/incompatible-source",
      headers,
      payload: {
        label: "Incompatible source",
        kind: "compatible-api",
        protocol: "openai",
        endpoint: "https://api.example.test/v1",
        supportedTools: ["claude-code"],
      },
    });
    expect(incompatibleSource.statusCode).toBe(400);

    const source = await app.inject({
      method: "PUT",
      url: `/v1/dashboard/model-sources/${SOURCE_ID}`,
      headers,
      payload: {
        label: "Third-party A",
        kind: "compatible-api",
        protocol: "openai",
        endpoint: "https://api.example.test/v1",
        supportedTools: ["codex"],
        apiKey: API_KEY,
      },
    });
    expect(source.statusCode).toBe(200);
    expect(source.body).not.toContain(API_KEY);
    expect(permissionVault.getModelCredential("user-1", SOURCE_ID)).toBe(API_KEY);

    const deniedReveal = await app.inject({
      method: "POST",
      url: `/v1/dashboard/model-wallet/${SOURCE_ID}/reveal`,
      headers,
      payload: { password: "wrong-password" },
    });
    expect(deniedReveal.statusCode).toBe(403);
    expect(deniedReveal.headers["cache-control"]).toContain("no-store");
    expect(deniedReveal.body).not.toContain(API_KEY);

    const revealed = await app.inject({
      method: "POST",
      url: `/v1/dashboard/model-wallet/${SOURCE_ID}/reveal`,
      headers,
      payload: { password: "123456" },
    });
    expect(revealed.statusCode).toBe(200);
    expect(revealed.headers["cache-control"]).toContain("no-store");
    expect(revealed.headers.pragma).toBe("no-cache");
    expect(revealed.json()).toEqual({ apiKey: API_KEY, sourceId: SOURCE_ID });

    const changedPassword = await app.inject({
      method: "POST",
      url: "/v1/dashboard/model-wallet/password",
      headers,
      payload: { currentPassword: "123456", newPassword: "654321" },
    });
    expect(changedPassword.statusCode).toBe(200);
    expect(changedPassword.headers["cache-control"]).toContain("no-store");
    expect(changedPassword.json()).toEqual({ changed: true });
    const oldPasswordReveal = await app.inject({
      method: "POST",
      url: `/v1/dashboard/model-wallet/${SOURCE_ID}/reveal`,
      headers,
      payload: { password: "123456" },
    });
    expect(oldPasswordReveal.statusCode).toBe(403);
    const newPasswordReveal = await app.inject({
      method: "POST",
      url: `/v1/dashboard/model-wallet/${SOURCE_ID}/reveal`,
      headers,
      payload: { password: "654321" },
    });
    expect(newPasswordReveal.statusCode).toBe(200);
    expect(newPasswordReveal.json()).toEqual({
      apiKey: API_KEY,
      sourceId: SOURCE_ID,
    });

    const model = await app.inject({
      method: "PUT",
      url: `/v1/dashboard/models/${MODEL_ID}`,
      headers,
      payload: {
        sourceId: SOURCE_ID,
        name: "GPT-5.4",
        modelId: "gpt-5.4",
        supportedTools: ["codex"],
      },
    });
    expect(model.statusCode).toBe(200);

    const synchronized = await app.inject({
      method: "POST",
      url: "/v1/dashboard/device-control/sync",
      headers,
      payload: {},
    });
    expect(synchronized.statusCode).toBe(200);

    const previewResponse = await app.inject({
      method: "POST",
      url: "/v1/dashboard/model-configurations/preview",
      headers,
      payload: {
        modelId: MODEL_ID,
        targets: [{ deviceId: DEVICE_ID, toolId: "codex" }],
      },
    });
    expect(previewResponse.statusCode).toBe(200);
    const preview = previewResponse.json();
    expect(preview).toMatchObject({
      approvalId: expect.any(String),
      digest: expect.stringMatching(/^[a-f0-9]{64}$/),
      changes: [
        {
          deviceId: DEVICE_ID,
          toolId: "codex",
          execution: "immediate",
        },
      ],
    });

    const applied = await app.inject({
      method: "POST",
      url: "/v1/dashboard/model-configurations/apply",
      headers,
      payload: {
        approvalId: preview.approvalId,
        digest: preview.digest,
        confirm: true,
      },
    });
    expect(applied.statusCode).toBe(200);
    expect(applied.body).not.toContain(API_KEY);
    expect(apply).toHaveBeenCalledWith(
      expect.objectContaining({ apiKey: API_KEY, toolId: "codex" }),
    );

    const snapshot = await app.inject({
      method: "GET",
      url: "/v1/dashboard/snapshot",
      headers: { cookie: headers.cookie, host: headers.host },
    });
    expect(snapshot.statusCode).toBe(200);
    expect(snapshot.body).not.toContain(API_KEY);
    expect(snapshot.json()).toMatchObject({
      modelCredentialSources: [
        {
          sourceId: SOURCE_ID,
          updatedAt: expect.any(String),
        },
      ],
      status: {
        deviceControl: {
          reports: {
            [DEVICE_ID]: {
              tools: [
                {
                  toolId: "codex",
                  currentModelId: "gpt-5.4",
                  health: "healthy",
                },
              ],
            },
          },
        },
      },
    });
  });
});

async function dashboardHeaders(target: FastifyInstance): Promise<{
  cookie: string;
  host: string;
  origin: string;
  "x-one-status-csrf": string;
}> {
  const page = await target.inject({
    method: "GET",
    url: "/",
    headers: { accept: "text/html", host: "127.0.0.1:8787" },
  });
  const setCookie = page.headers["set-cookie"]!;
  const cookie = (Array.isArray(setCookie) ? setCookie[0]! : setCookie).split(
    ";",
  )[0]!;
  const csrf = page.body.match(/name="one-status-csrf" content="([^"]+)"/)?.[1];
  if (!csrf) throw new Error("Dashboard CSRF token was not rendered.");
  return {
    cookie,
    host: "127.0.0.1:8787",
    origin: "http://127.0.0.1:8787",
    "x-one-status-csrf": csrf,
  };
}

const inventorySnapshot: LocalInventorySnapshot = {
  schemaVersion: 1,
  scannedAt: "2026-08-09T15:00:00.000Z",
  agents: [{ id: "codex", name: "Codex", installed: true }],
  projects: [],
  mcpServers: [],
  plugins: [],
  skills: [],
  rules: [],
  warnings: [],
};

class MemoryBackend implements DashboardBackend {
  status = createEmptyStatus();
  version = 1;

  async getSnapshot(): Promise<DashboardStatusSnapshot> {
    return this.snapshot();
  }

  async mutateStatus(
    mutator: (status: StatusDocument) => void,
  ): Promise<DashboardStatusSnapshot> {
    const next = structuredClone(this.status);
    mutator(next);
    this.status = next;
    this.version += 1;
    return this.snapshot();
  }

  async revokeDevice(): Promise<void> {}

  async userId(): Promise<string> {
    return "user-1";
  }

  private snapshot(): DashboardStatusSnapshot {
    return {
      account: {
        user: {
          id: "user-1",
          email: "ryan@example.test",
          createdAt: "2026-08-09T14:00:00.000Z",
        },
        devices: [
          {
            id: DEVICE_ID,
            name: "Ryan's MacBook Pro",
            createdAt: "2026-08-09T14:00:00.000Z",
            lastSeenAt: "2026-08-09T16:00:00.000Z",
            online: true,
          },
        ],
      },
      profile: {
        baseUrl: "https://os.example.test",
        deviceId: DEVICE_ID,
        deviceName: "Ryan's MacBook Pro",
        tokenExpiresAt: "2026-08-10T14:00:00.000Z",
        userId: "user-1",
      },
      status: structuredClone(this.status),
      updatedAt: "2026-08-09T16:00:00.000Z",
      version: this.version,
    };
  }
}
