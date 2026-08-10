import { createEmptyStatus, type StatusDocument } from "@one-status/protocol";
import {
  beforeEach,
  describe,
  expect,
  it,
  vi,
  type MockedFunction,
} from "vitest";
import type {
  DashboardBackend,
  DashboardStatusSnapshot,
} from "./dashboard-backend.js";
import {
  DeviceControlService,
  ModelConfigurationApplyError,
  type ModelConfigurationAdapter,
} from "./device-control.js";
import {
  interimLocalModelSourceId,
  localModelSourceId,
  type LocalInventorySnapshot,
} from "./local-inventory.js";
import type { LocalModelUsageSnapshot } from "./device-sidecar.js";
import { readStoredModelUsage } from "./model-usage.js";
import type { ModelGateway } from "./model-gateway.js";
import { PermissionVault } from "./permission-vault.js";

const DEVICE_A = "2e0f24e2-b009-4091-b6d9-5236abe1ff00";
const DEVICE_B = "f541fe2b-9302-4185-b5c1-82b5d2bba96f";
const SOURCE_ID = "third-party-a";
const MODEL_ID = "third-party-a:model:gpt-5-4";
const API_KEY = "private-model-credential-value";

describe("DeviceControlService", () => {
  let backend: MemoryDeviceBackend;
  let inventory: LocalInventorySnapshot;
  let configurator: ModelConfigurationAdapter;
  let apply: MockedFunction<ModelConfigurationAdapter["apply"]>;
  let service: DeviceControlService;

  beforeEach(() => {
    backend = new MemoryDeviceBackend();
    inventory = inventoryFor("gpt-5.4", "third-party-a");
    apply = vi.fn<ModelConfigurationAdapter["apply"]>(async () => ({
      appliedAt: "2026-08-09T15:30:00.000Z",
    }));
    configurator = { apply };
    service = createService(backend, () => inventory, configurator);
    seedCatalog(backend.status);
  });

  it("publishes the current device inventory without exposing credentials", async () => {
    const snapshot = await service.synchronizeCurrentDevice();

    expect(snapshot.status.deviceControl.reports[DEVICE_A]).toMatchObject({
      deviceId: DEVICE_A,
      deviceName: "Ryan's MacBook Pro",
      backgroundVersion: expect.any(String),
      tools: [
        {
          toolId: "codex",
          installed: true,
          currentModelId: "gpt-5.4",
          sourceId: SOURCE_ID,
          endpointHost: "api.example.test",
          health: "healthy",
        },
      ],
    });
    expect(JSON.stringify(snapshot.status)).not.toContain(API_KEY);
  });

  it("publishes redacted usage through a backward-compatible preference", async () => {
    const usage: LocalModelUsageSnapshot = {
      scannedAt: "2026-08-10T02:00:00.000Z",
      scope: "latest-100-session-files-per-tool",
      filesScanned: 4,
      truncated: false,
      entries: [
        {
          tool: "codex",
          modelId: "gpt-5.4",
          dataSource: "codex-session",
          inputTokens: 12_000,
          cachedInputTokens: 10_000,
          cacheCreationInputTokens: 0,
          outputTokens: 800,
          requests: 3,
          latestAt: "2026-08-10T01:59:00.000Z",
        },
      ],
      warnings: ["local-only-warning"],
    };
    service = createService(backend, () => inventory, configurator, {
      async scan() {
        return usage;
      },
    });

    const snapshot = await service.synchronizeCurrentDevice();

    expect(readStoredModelUsage(snapshot.status)).toEqual([
      expect.objectContaining({
        deviceId: DEVICE_A,
        scannedAt: usage.scannedAt,
        filesScanned: 4,
        entries: [
          expect.objectContaining({
            toolId: "codex",
            modelId: "gpt-5.4",
            inputTokens: 12_000,
            cachedInputTokens: 10_000,
            outputTokens: 800,
            requests: 3,
          }),
        ],
      }),
    ]);
    expect(snapshot.status.deviceControl.reports[DEVICE_A]).not.toHaveProperty(
      "modelUsage",
    );
    expect(JSON.stringify(snapshot.status)).not.toContain("local-only-warning");
  });

  it("automatically imports discovered credentials into the encrypted Vault", async () => {
    const fingerprint = "a".repeat(64);
    const discoveredKey = "automatically-discovered-private-key";
    const statusKey = new Uint8Array(32).fill(42);
    const vault = new PermissionVault({
      path: ":memory:",
      key: new Uint8Array(32).fill(41),
    });
    backend.status = createEmptyStatus();
    seedCatalog(backend.status);
    backend.status.deviceControl.sources[SOURCE_ID]!.credentialStatus = "missing";
    inventory.agents[0]!.model!.credentialFingerprint = fingerprint;
    const sourceId = localModelSourceId(
      inventory.agents[0]!.model!,
      statusKey,
    );
    const dormantModel = {
      modelId: "gpt-dormant",
      providerId: "dormant-provider",
      providerLabel: "Dormant provider",
      sourceKind: "compatible-api" as const,
      protocol: "openai" as const,
      endpoint: "https://dormant.example.test/v1",
      endpointHost: "dormant.example.test",
      credentialFingerprint: "b".repeat(64),
      credentialStatus: "available" as const,
      health: "healthy" as const,
    };
    const dormantSourceId = localModelSourceId(dormantModel, statusKey);
    service = new DeviceControlService(
      backend,
      {
        async refresh() {
          return inventory;
        },
        async discoverModelCredentials() {
          return [
            {
              apiKey: discoveredKey,
              credentialFingerprint: fingerprint,
              model: inventory.agents[0]!.model!,
              sourceId: localModelSourceId(inventory.agents[0]!.model!),
              toolId: "codex" as const,
            },
            {
              apiKey: "dormant-provider-private-key",
              credentialFingerprint: "b".repeat(64),
              model: dormantModel,
              sourceId: localModelSourceId(dormantModel),
              toolId: "codex" as const,
            },
          ];
        },
      },
      vault,
      configurator,
      undefined,
      async () => statusKey,
    );

    const snapshot = await service.synchronizeCurrentDevice();
    const firstStatuses = vault.listModelCredentialStatus("user-1");
    await service.synchronizeCurrentDevice();

    expect(vault.getModelCredential("user-1", sourceId)).toBe(discoveredKey);
    expect(vault.listModelCredentialStatus("user-1")).toEqual(firstStatuses);
    expect(snapshot.status.deviceControl.sources[sourceId]).toMatchObject({
      credentialRef: `model-source:${sourceId}`,
      credentialStatus: "available",
      supportedTools: ["codex", "claude-code", "cursor"],
    });
    expect(snapshot.status.deviceControl.sources[SOURCE_ID]).toBeUndefined();
    expect(snapshot.status.deviceControl.models[MODEL_ID]).toBeUndefined();
    expect(
      snapshot.status.deviceControl.reports[DEVICE_A]?.tools[0],
    ).toMatchObject({
      sourceId,
      currentModelId: "gpt-5.4",
    });
    expect(snapshot.status.deviceControl.sources[dormantSourceId]).toMatchObject({
      label: "Dormant provider",
      endpoint: "https://dormant.example.test/v1",
      credentialStatus: "available",
      supportedTools: ["codex", "claude-code", "cursor"],
    });
    expect(
      Object.values(snapshot.status.deviceControl.models).find(
        (entry) => entry.sourceId === dormantSourceId,
      ),
    ).toMatchObject({ modelId: "gpt-dormant" });
    expect(JSON.stringify(snapshot.status)).not.toContain(discoveredKey);
    expect(JSON.stringify(snapshot.status)).not.toContain(
      "dormant-provider-private-key",
    );
    expect(JSON.stringify(snapshot.status)).not.toContain(fingerprint.slice(0, 16));
    vault.ignoreModelCredential("user-1", sourceId);
    await backend.mutateStatus((status) => {
      for (const [modelId, model] of Object.entries(
        status.deviceControl.models,
      )) {
        if (model.sourceId === sourceId) {
          delete status.deviceControl.models[modelId];
        }
      }
      delete status.deviceControl.sources[sourceId];
    });
    const afterDelete = await service.synchronizeCurrentDevice();
    expect(afterDelete.status.deviceControl.sources[sourceId]).toBeUndefined();
    expect(vault.getModelCredential("user-1", sourceId)).toBeUndefined();
    vault.close();
  });

  it("preserves a legacy deletion when source IDs gain keyed identities", async () => {
    const fingerprint = "d".repeat(64);
    const statusKey = new Uint8Array(32).fill(61);
    const model = {
      ...inventory.agents[0]!.model!,
      credentialFingerprint: fingerprint,
    };
    const legacySourceId = interimLocalModelSourceId(model)!;
    const secureSourceId = localModelSourceId(model, statusKey);
    const vault = new PermissionVault({
      path: ":memory:",
      key: new Uint8Array(32).fill(62),
    });
    vault.ignoreModelCredential("user-1", legacySourceId);
    inventory.agents[0]!.model = model;
    service = new DeviceControlService(
      backend,
      {
        async refresh() {
          return inventory;
        },
        async discoverModelCredentials() {
          return [{
            apiKey: "deleted-credential-must-stay-deleted",
            credentialFingerprint: fingerprint,
            model,
            sourceId: legacySourceId,
            toolId: "codex" as const,
          }];
        },
      },
      vault,
      configurator,
      undefined,
      async () => statusKey,
    );

    const snapshot = await service.synchronizeCurrentDevice();

    expect(vault.isModelCredentialIgnored("user-1", legacySourceId)).toBe(true);
    expect(vault.isModelCredentialIgnored("user-1", secureSourceId)).toBe(true);
    expect(vault.getModelCredential("user-1", secureSourceId)).toBeUndefined();
    expect(snapshot.status.deviceControl.sources[secureSourceId]).toBeUndefined();
    expect(JSON.stringify(snapshot.status)).not.toContain(fingerprint.slice(0, 16));
    vault.close();
  });

  it("reports model credentials from Permission Vault availability", async () => {
    service = new DeviceControlService(
      backend,
      { async refresh() { return inventory; } },
      {
        getModelCredential() {
          return undefined;
        },
        hasModelCredential() {
          return false;
        },
      },
      configurator,
    );

    const snapshot = await service.synchronizeCurrentDevice();

    expect(snapshot.status.deviceControl.sources[SOURCE_ID]).toMatchObject({
      credentialRef: `model-source:${SOURCE_ID}`,
      credentialStatus: "missing",
    });
    await expect(
      service.previewConfiguration({
        modelId: MODEL_ID,
        targets: [{ deviceId: DEVICE_A, toolId: "codex" }],
      }),
    ).rejects.toThrow("Add a model source credential");
  });

  it("does not transfer an official account session across AI tools", async () => {
    const now = "2026-08-10T00:00:00.000Z";
    backend.status.deviceControl.sources["openai-account"] = {
      id: "openai-account",
      label: "OpenAI account",
      kind: "official-account",
      protocol: "openai",
      supportedTools: ["codex", "claude-code"],
      credentialStatus: "not-required",
      createdAt: now,
      updatedAt: now,
    };
    backend.status.deviceControl.models["openai-account:model:gpt-5-4"] = {
      id: "openai-account:model:gpt-5-4",
      sourceId: "openai-account",
      name: "GPT-5.4",
      modelId: "gpt-5.4",
      supportedTools: ["codex", "claude-code"],
      createdAt: now,
      updatedAt: now,
    };

    await expect(
      service.previewConfiguration({
        modelId: "openai-account:model:gpt-5-4",
        targets: [{ deviceId: DEVICE_A, toolId: "claude-code" }],
      }),
    ).rejects.toThrow("cannot be transferred");
  });

  it("migrates an official API source to its concealed credential identity", async () => {
    const statusKey = new Uint8Array(32).fill(52);
    const fingerprint = "c".repeat(64);
    const officialKey = "official-api-private-key";
    const model = {
      modelId: "gpt-5.4",
      providerId: "openai",
      providerLabel: "OpenAI",
      sourceKind: "official-api" as const,
      protocol: "openai" as const,
      credentialFingerprint: fingerprint,
      credentialStatus: "available" as const,
      health: "healthy" as const,
    };
    const insecureSourceId = localModelSourceId(model);
    const secureSourceId = localModelSourceId(model, statusKey);
    const now = "2026-08-10T01:00:00.000Z";
    const vault = new PermissionVault({
      path: ":memory:",
      key: new Uint8Array(32).fill(53),
    });
    backend.status = createEmptyStatus();
    backend.status.deviceControl.sources[insecureSourceId] = {
      id: insecureSourceId,
      label: "OpenAI",
      kind: "official-api",
      protocol: "openai",
      supportedTools: ["codex"],
      credentialRef: `model-source:${insecureSourceId}`,
      credentialStatus: "available",
      createdAt: now,
      updatedAt: now,
    };
    backend.status.deviceControl.models[`${insecureSourceId}:legacy-model`] = {
      id: `${insecureSourceId}:legacy-model`,
      sourceId: insecureSourceId,
      name: "GPT-5.4",
      modelId: "gpt-5.4",
      supportedTools: ["codex"],
      createdAt: now,
      updatedAt: now,
    };
    vault.setModelCredential("user-1", insecureSourceId, officialKey);
    inventory.agents[0]!.model = model;
    service = new DeviceControlService(
      backend,
      {
        async refresh() {
          return inventory;
        },
        async discoverModelCredentials() {
          return [{
            apiKey: officialKey,
            credentialFingerprint: fingerprint,
            model,
            sourceId: insecureSourceId,
            toolId: "codex" as const,
          }];
        },
      },
      vault,
      configurator,
      undefined,
      async () => statusKey,
    );

    const snapshot = await service.synchronizeCurrentDevice();

    expect(snapshot.status.deviceControl.sources[insecureSourceId]).toBeUndefined();
    expect(snapshot.status.deviceControl.sources[secureSourceId]).toMatchObject({
      kind: "official-api",
      credentialStatus: "available",
    });
    expect(vault.getModelCredential("user-1", insecureSourceId)).toBeUndefined();
    expect(vault.getModelCredential("user-1", secureSourceId)).toBe(officialKey);
    expect(JSON.stringify(snapshot.status)).not.toContain(fingerprint.slice(0, 16));
    vault.close();
  });

  it("applies a confirmed configuration immediately on the current device", async () => {
    await service.synchronizeCurrentDevice();
    const preview = await service.previewConfiguration({
      modelId: MODEL_ID,
      targets: [{ deviceId: DEVICE_A, toolId: "codex" }],
    });
    expect(preview.changes[0]).toMatchObject({
      execution: "immediate",
      online: true,
      nextModelId: "gpt-5.4",
    });

    const snapshot = await service.queueConfiguration({
      approvalId: preview.approvalId,
      digest: preview.digest,
      confirm: true,
    });

    expect(apply).toHaveBeenCalledWith(
      expect.objectContaining({
        apiKey: API_KEY,
        toolId: "codex",
        model: expect.objectContaining({ id: MODEL_ID }),
        source: expect.objectContaining({ id: SOURCE_ID }),
      }),
    );
    expect(Object.values(snapshot.status.deviceControl.intents)).toEqual([
      expect.objectContaining({
        deviceId: DEVICE_A,
        status: "applied",
        attempts: 1,
      }),
    ]);
    expect(JSON.stringify(snapshot.status)).not.toContain(API_KEY);

    inventory = inventoryFor("gpt-5.4", "one-status-source-opaque");
    const rescanned = await service.synchronizeCurrentDevice();
    expect(Object.keys(rescanned.status.deviceControl.sources)).toEqual([
      SOURCE_ID,
    ]);
    expect(Object.keys(rescanned.status.deviceControl.models)).toEqual([
      MODEL_ID,
    ]);
    expect(
      rescanned.status.deviceControl.reports[DEVICE_A]?.tools[0],
    ).toMatchObject({
      currentModelRef: MODEL_ID,
      sourceId: SOURCE_ID,
      lastConfiguredAt: "2026-08-09T15:30:00.000Z",
    });
  });

  it("issues a source-bound local Gateway projection for model switches", async () => {
    const configuration = vi.fn<
      Pick<ModelGateway, "configuration">["configuration"]
    >(() => ({
      endpoint:
        "http://127.0.0.1:8787/v1/model-gateway/third-party-a",
      protocol: "openai-responses",
      token: "agent-scoped-gateway-token",
    }));
    service = createService(
      backend,
      () => inventory,
      configurator,
      undefined,
      { configuration },
    );
    await service.synchronizeCurrentDevice();
    const preview = await service.previewConfiguration({
      modelId: MODEL_ID,
      targets: [{ deviceId: DEVICE_A, toolId: "codex" }],
    });

    await service.queueConfiguration({
      approvalId: preview.approvalId,
      digest: preview.digest,
      confirm: true,
    });

    expect(configuration).toHaveBeenCalledWith({
      sourceId: SOURCE_ID,
      targetProtocol: "openai-responses",
      userId: "user-1",
    });
    expect(apply).toHaveBeenCalledWith(
      expect.objectContaining({
        gateway: {
          endpoint:
            "http://127.0.0.1:8787/v1/model-gateway/third-party-a",
          protocol: "openai-responses",
          token: "agent-scoped-gateway-token",
        },
      }),
    );
  });

  it("keeps an offline-device intent pending and applies it after that device starts", async () => {
    await service.synchronizeCurrentDevice();
    const preview = await service.previewConfiguration({
      modelId: MODEL_ID,
      targets: [{ deviceId: DEVICE_B, toolId: "codex" }],
    });
    expect(preview.changes[0]).toMatchObject({
      execution: "pending",
      online: false,
    });

    const pending = await service.queueConfiguration({
      approvalId: preview.approvalId,
      digest: preview.digest,
      confirm: true,
    });
    expect(Object.values(pending.status.deviceControl.intents)[0]).toMatchObject({
      deviceId: DEVICE_B,
      status: "pending",
      attempts: 0,
    });
    expect(apply).not.toHaveBeenCalled();

    backend.currentDeviceId = DEVICE_B;
    backend.devices[1]!.online = true;
    const resumedService = createService(backend, () => inventory, configurator);
    const applied = await resumedService.synchronizeCurrentDevice();

    expect(apply).toHaveBeenCalledOnce();
    expect(Object.values(applied.status.deviceControl.intents)[0]).toMatchObject({
      deviceId: DEVICE_B,
      status: "applied",
      attempts: 1,
    });
  });

  it("applies the immutable approved snapshot after the catalog changes", async () => {
    await service.synchronizeCurrentDevice();
    const preview = await service.previewConfiguration({
      modelId: MODEL_ID,
      targets: [{ deviceId: DEVICE_B, toolId: "codex" }],
    });
    const pending = await service.queueConfiguration({
      approvalId: preview.approvalId,
      digest: preview.digest,
      confirm: true,
    });
    expect(Object.values(pending.status.deviceControl.intents)[0]).toMatchObject({
      configuration: {
        model: { modelId: "gpt-5.4" },
        source: { endpoint: "https://api.example.test/v1" },
      },
    });

    await backend.mutateStatus((status) => {
      status.deviceControl.models[MODEL_ID]!.modelId = "gpt-5.5";
      status.deviceControl.sources[SOURCE_ID]!.endpoint =
        "https://changed.example.test/v1";
    });
    inventory = inventoryFor("gpt-5.5", SOURCE_ID);
    inventory.agents[0]!.model!.endpoint = "https://changed.example.test/v1";
    inventory.agents[0]!.model!.endpointHost = "changed.example.test";
    backend.currentDeviceId = DEVICE_B;
    backend.devices[1]!.online = true;

    const resumedService = createService(backend, () => inventory, configurator);
    await resumedService.synchronizeCurrentDevice();

    expect(apply).toHaveBeenCalledWith(
      expect.objectContaining({
        model: expect.objectContaining({ modelId: "gpt-5.4" }),
        source: expect.objectContaining({
          endpoint: "https://api.example.test/v1",
        }),
      }),
    );
  });

  it("reclaims an expired applying intent and clears its lease", async () => {
    await service.synchronizeCurrentDevice();
    const preview = await service.previewConfiguration({
      modelId: MODEL_ID,
      targets: [{ deviceId: DEVICE_B, toolId: "codex" }],
    });
    await service.queueConfiguration({
      approvalId: preview.approvalId,
      digest: preview.digest,
      confirm: true,
    });
    const intent = Object.values(backend.status.deviceControl.intents)[0]!;
    intent.status = "applying";
    intent.claimId = "18dcff69-741d-4ea2-9123-b86d02e8d6da";
    intent.claimedAt = "2026-08-09T12:00:00.000Z";
    intent.claimExpiresAt = "2026-08-09T12:02:00.000Z";
    intent.updatedAt = intent.claimedAt;
    intent.attempts = 1;
    backend.currentDeviceId = DEVICE_B;
    backend.devices[1]!.online = true;

    const resumedService = createService(backend, () => inventory, configurator);
    const applied = await resumedService.synchronizeCurrentDevice();
    const completed = Object.values(applied.status.deviceControl.intents)[0]!;

    expect(apply).toHaveBeenCalledOnce();
    expect(completed).toMatchObject({ status: "applied", attempts: 2 });
    expect(completed).not.toHaveProperty("claimId");
    expect(completed).not.toHaveProperty("claimedAt");
    expect(completed).not.toHaveProperty("claimExpiresAt");
  });

  it("allows only one service instance to execute an active claim", async () => {
    await service.synchronizeCurrentDevice();
    const preview = await service.previewConfiguration({
      modelId: MODEL_ID,
      targets: [{ deviceId: DEVICE_B, toolId: "codex" }],
    });
    await service.queueConfiguration({
      approvalId: preview.approvalId,
      digest: preview.digest,
      confirm: true,
    });
    backend.currentDeviceId = DEVICE_B;
    backend.devices[1]!.online = true;

    let signalStarted!: () => void;
    let releaseApply!: () => void;
    const started = new Promise<void>((resolve) => {
      signalStarted = resolve;
    });
    const held = new Promise<void>((resolve) => {
      releaseApply = resolve;
    });
    apply.mockImplementation(async () => {
      signalStarted();
      await held;
      return { appliedAt: "2026-08-09T15:30:00.000Z" };
    });
    const firstService = createService(backend, () => inventory, configurator);
    const secondService = createService(backend, () => inventory, configurator);

    const firstRun = firstService.synchronizeCurrentDevice();
    await started;
    const secondSnapshot = await secondService.synchronizeCurrentDevice();
    expect(apply).toHaveBeenCalledOnce();
    expect(Object.values(secondSnapshot.status.deviceControl.intents)[0])
      .toMatchObject({
        status: "applying",
        attempts: 1,
        claimId: expect.any(String),
      });

    releaseApply();
    const completed = await firstRun;
    expect(apply).toHaveBeenCalledOnce();
    expect(Object.values(completed.status.deviceControl.intents)[0])
      .toMatchObject({ status: "applied", attempts: 1 });
  });

  it("fails a legacy pending intent without an approved snapshot", async () => {
    await service.synchronizeCurrentDevice();
    const preview = await service.previewConfiguration({
      modelId: MODEL_ID,
      targets: [{ deviceId: DEVICE_B, toolId: "codex" }],
    });
    await service.queueConfiguration({
      approvalId: preview.approvalId,
      digest: preview.digest,
      confirm: true,
    });
    const intent = Object.values(backend.status.deviceControl.intents)[0]!;
    delete intent.configuration;
    backend.currentDeviceId = DEVICE_B;
    backend.devices[1]!.online = true;

    const resumedService = createService(backend, () => inventory, configurator);
    const failed = await resumedService.synchronizeCurrentDevice();
    const completed = Object.values(failed.status.deviceControl.intents)[0]!;

    expect(apply).not.toHaveBeenCalled();
    expect(completed).toMatchObject({
      status: "failed",
      error: "The approved model configuration snapshot is unavailable.",
    });
    expect(completed).not.toHaveProperty("claimId");
  });

  it("binds the current-device intent to the redacted local file preview", async () => {
    const expectedPlanId = `plan_${"d".repeat(64)}`;
    const preview = vi.fn(async () => ({
      planId: expectedPlanId,
      targets: [
        {
          purpose: "tool-configuration",
          path: "/tmp/config.toml",
          existed: true,
          beforeSha256: "a".repeat(64),
          afterSha256: "b".repeat(64),
          beforeMode: 0o640,
          afterMode: 0o600,
        },
      ],
      changes: [
        {
          path: "model",
          operation: "update",
          before: "old",
          after: "gpt-5.4",
        },
      ],
      warnings: [],
      requiresRestart: true,
    }));
    configurator = { apply, preview };
    service = createService(backend, () => inventory, configurator);
    await service.synchronizeCurrentDevice();
    const configuration = await service.previewConfiguration({
      modelId: MODEL_ID,
      targets: [{ deviceId: DEVICE_A, toolId: "codex" }],
    });
    expect(configuration.changes[0]?.localPlan).toMatchObject({
      planId: expectedPlanId,
      requiresRestart: true,
      targets: [expect.objectContaining({ afterMode: 0o600 })],
    });

    const applied = await service.queueConfiguration({
      approvalId: configuration.approvalId,
      digest: configuration.digest,
      confirm: true,
    });
    expect(apply).toHaveBeenCalledWith(
      expect.objectContaining({ expectedPlanId }),
    );
    expect(Object.values(applied.status.deviceControl.intents)[0]).toMatchObject({
      expectedPlanId,
      status: "applied",
    });
  });

  it("reports a restored configuration as rollback and redacts its credential", async () => {
    apply.mockRejectedValueOnce(
      new ModelConfigurationApplyError(
        `Sidecar rejected credential ${API_KEY} and token-secret-value`,
        true,
      ),
    );
    await service.synchronizeCurrentDevice();
    const preview = await service.previewConfiguration({
      modelId: MODEL_ID,
      targets: [{ deviceId: DEVICE_A, toolId: "codex" }],
    });
    const snapshot = await service.queueConfiguration({
      approvalId: preview.approvalId,
      digest: preview.digest,
      confirm: true,
    });

    const intent = Object.values(snapshot.status.deviceControl.intents)[0]!;
    expect(intent).toMatchObject({ status: "rollback", attempts: 1 });
    expect(intent.error).toContain("[redacted]");
    expect(intent.error).not.toContain(API_KEY);
    expect(intent.error).not.toContain("token-secret-value");
    expect(JSON.stringify(snapshot.status)).not.toContain(API_KEY);
  });

  it("invalidates approval when the model configuration changes after preview", async () => {
    await service.synchronizeCurrentDevice();
    const preview = await service.previewConfiguration({
      modelId: MODEL_ID,
      targets: [{ deviceId: DEVICE_A, toolId: "codex" }],
    });
    await backend.mutateStatus((status) => {
      status.deviceControl.models[MODEL_ID]!.modelId = "gpt-5.5";
    });

    await expect(
      service.queueConfiguration({
        approvalId: preview.approvalId,
        digest: preview.digest,
        confirm: true,
      }),
    ).rejects.toThrow("Configuration state changed");
    expect(apply).not.toHaveBeenCalled();
    expect(Object.keys(backend.status.deviceControl.intents)).toHaveLength(0);
  });
});

function createService(
  backend: MemoryDeviceBackend,
  refresh: () => LocalInventorySnapshot,
  configurator: ModelConfigurationAdapter,
  modelUsage?: { scan(): Promise<LocalModelUsageSnapshot> },
  modelGateway?: Pick<ModelGateway, "configuration">,
): DeviceControlService {
  return new DeviceControlService(
    backend,
    { async refresh() { return refresh(); } },
    {
      getModelCredential(_userId, sourceId) {
        return sourceId === SOURCE_ID ? API_KEY : undefined;
      },
      hasModelCredential(_userId, sourceId) {
        return sourceId === SOURCE_ID;
      },
    },
    configurator,
    modelUsage,
    undefined,
    modelGateway,
  );
}

function seedCatalog(status: StatusDocument): void {
  const now = "2026-08-09T15:00:00.000Z";
  status.deviceControl.sources[SOURCE_ID] = {
    id: SOURCE_ID,
    label: "Third-party A",
    kind: "compatible-api",
    protocol: "openai",
    endpoint: "https://api.example.test/v1",
    supportedTools: ["codex"],
    credentialRef: `model-source:${SOURCE_ID}`,
    credentialStatus: "available",
    createdAt: now,
    updatedAt: now,
  };
  status.deviceControl.models[MODEL_ID] = {
    id: MODEL_ID,
    sourceId: SOURCE_ID,
    name: "GPT-5.4",
    modelId: "gpt-5.4",
    supportedTools: ["codex"],
    createdAt: now,
    updatedAt: now,
  };
}

function inventoryFor(modelId: string, providerId: string): LocalInventorySnapshot {
  return {
    schemaVersion: 1,
    scannedAt: "2026-08-09T15:00:00.000Z",
    agents: [
      {
        id: "codex",
        name: "Codex",
        installed: true,
        model: {
          modelId,
          providerId,
          providerLabel: "Third-party A",
          sourceKind: "compatible-api",
          protocol: "openai",
          endpoint: "https://api.example.test/v1",
          endpointHost: "api.example.test",
          credentialStatus: "available",
          health: "healthy",
        },
      },
    ],
    projects: [],
    mcpServers: [],
    plugins: [],
    skills: [],
    rules: [],
    warnings: [],
  };
}

class MemoryDeviceBackend implements DashboardBackend {
  status = createEmptyStatus();
  version = 1;
  currentDeviceId = DEVICE_A;
  devices = [
    {
      id: DEVICE_A,
      name: "Ryan's MacBook Pro",
      createdAt: "2026-08-09T14:00:00.000Z",
      lastSeenAt: "2026-08-09T15:00:00.000Z",
      online: true,
      blocked: false,
    },
    {
      id: DEVICE_B,
      name: "Office Mac mini",
      createdAt: "2026-08-09T14:00:00.000Z",
      lastSeenAt: "2026-08-09T14:30:00.000Z",
      online: false,
      blocked: false,
    },
  ];

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
    const current = this.devices.find((device) => device.id === this.currentDeviceId)!;
    return {
      account: {
        user: {
          id: "user-1",
          email: "ryan@example.test",
          createdAt: "2026-08-09T14:00:00.000Z",
        },
        devices: structuredClone(this.devices),
        deviceLoginPolicy: { denyNewDeviceLogins: false },
      },
      profile: {
        baseUrl: "https://os.example.test",
        deviceId: current.id,
        deviceName: current.name,
        tokenExpiresAt: "2026-08-10T14:00:00.000Z",
        userId: "user-1",
      },
      status: structuredClone(this.status),
      updatedAt: "2026-08-09T15:00:00.000Z",
      version: this.version,
    };
  }
}
