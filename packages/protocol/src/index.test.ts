import { describe, expect, it } from "vitest";
import {
  configurationIntentSchema,
  createEmptyStatus,
  memoryEntrySchema,
  modelSourceSchema,
  parseStatusDocument,
  personaEventSchema,
  removeDeviceControlState,
  statusDocumentSchema,
} from "./index.js";

describe("status protocol", () => {
  it("creates a future-ready empty status document", () => {
    expect(statusDocumentSchema.parse(createEmptyStatus())).toMatchObject({
      schemaVersion: 4,
      memory: [],
      projects: {},
      permissions: { grants: [] },
      capabilities: { installations: {} },
      persona: {
        events: [],
        profile: {},
        policy: {
          enabled: true,
          blockedCategories: [],
          allowedConfidences: ["explicit", "observed", "inferred"],
        },
      },
      deviceControl: {
        sources: {},
        models: {},
        reports: {},
        intents: {},
      },
    });
  });

  it("removes the transient v0.8 usage field for v0.7 compatibility", () => {
    const status = createEmptyStatus() as unknown as Record<string, any>;
    status.deviceControl.reports["device-a"] = {
      deviceId: "device-a",
      deviceName: "Ryan's MacBook Pro",
      operatingSystem: "macos",
      osVersion: "25.0",
      architecture: "arm64",
      backgroundVersion: "0.8.0",
      tools: [],
      modelUsage: {
        scannedAt: "2026-08-10T02:00:00.000Z",
        scope: "latest-100-session-files-per-tool",
        filesScanned: 4,
        truncated: false,
        entries: [],
      },
      reportedAt: "2026-08-10T02:00:00.000Z",
    };

    const parsed = parseStatusDocument(status);
    expect(parsed.deviceControl.reports["device-a"]).not.toHaveProperty(
      "modelUsage",
    );
    expect(status.deviceControl.reports["device-a"]).toHaveProperty(
      "modelUsage",
    );
  });

  it("removes every device-owned control record after revocation", () => {
    const status = createEmptyStatus();
    status.deviceControl.reports["device-a"] = {
      deviceId: "device-a",
      deviceName: "Mac A",
      operatingSystem: "macos",
      osVersion: "25.0",
      architecture: "arm64",
      backgroundVersion: "0.8.0",
      tools: [],
      reportedAt: "2026-08-10T02:00:00.000Z",
    };
    status.deviceControl.intents["intent-a"] = {
      id: "intent-a",
      deviceId: "device-a",
      toolId: "codex",
      modelId: "model-a",
      sourceId: "source-a",
      status: "pending",
      requestedAt: "2026-08-10T02:00:00.000Z",
      requestedByDeviceId: "device-b",
      updatedAt: "2026-08-10T02:00:00.000Z",
      attempts: 0,
    };
    status.preferences["__one_status_internal:model-usage:v1:device-a"] =
      "encrypted-device-usage";

    removeDeviceControlState(status, "device-a");

    expect(status.deviceControl.reports["device-a"]).toBeUndefined();
    expect(status.deviceControl.intents["intent-a"]).toBeUndefined();
    expect(
      status.preferences["__one_status_internal:model-usage:v1:device-a"],
    ).toBeUndefined();
  });

  it("migrates schema v1 memory into confirmed schema v4 memory", () => {
    const {
      capabilities: _capabilities,
      persona: _persona,
      deviceControl: _deviceControl,
      ...emptyV1
    } = createEmptyStatus();
    const legacy = {
      ...emptyV1,
      schemaVersion: 1,
      memory: [
        {
          id: "legacy-memory",
          scope: "user",
          content: "Use pnpm",
          tags: ["preference"],
          createdAt: "2026-08-08T10:00:00.000Z",
          updatedAt: "2026-08-08T10:00:00.000Z",
        },
      ],
    };

    expect(parseStatusDocument(legacy)).toMatchObject({
      schemaVersion: 4,
      capabilities: { installations: {} },
      persona: { events: [], profile: {} },
      memory: [{ id: "legacy-memory", state: "confirmed" }],
    });
  });

  it("migrates schema v2 documents without capability installation state", () => {
    const {
      capabilities: _capabilities,
      persona: _persona,
      deviceControl: _deviceControl,
      ...emptyV2
    } = createEmptyStatus();
    const previous = {
      ...emptyV2,
      schemaVersion: 2,
    };

    expect(parseStatusDocument(previous)).toMatchObject({
      schemaVersion: 4,
      capabilities: { installations: {} },
      persona: { events: [], profile: {} },
    });
  });

  it("migrates schema v3 documents without Persona state", () => {
    const {
      persona: _persona,
      deviceControl: _deviceControl,
      ...emptyV3
    } = createEmptyStatus();
    const previous = { ...emptyV3, schemaVersion: 3 };

    expect(parseStatusDocument(previous)).toMatchObject({
      schemaVersion: 4,
      persona: {
        events: [],
        profile: {},
        policy: { enabled: true, blockedCategories: [] },
      },
      deviceControl: { sources: {}, models: {}, reports: {}, intents: {} },
    });
  });

  it("migrates early schema v4 documents without device control state", () => {
    const { deviceControl: _deviceControl, ...earlyV4 } = createEmptyStatus();

    expect(parseStatusDocument(earlyV4)).toMatchObject({
      schemaVersion: 4,
      deviceControl: { sources: {}, models: {}, reports: {}, intents: {} },
    });
  });

  it("requires schema v4 writers to choose a memory state", () => {
    expect(() =>
      statusDocumentSchema.parse({
        ...createEmptyStatus(),
        memory: [
          {
            id: "missing-state",
            scope: "user",
            content: "Unreviewed inference",
            tags: [],
            createdAt: "2026-08-08T10:00:00.000Z",
            updatedAt: "2026-08-08T10:00:00.000Z",
          },
        ],
      }),
    ).toThrow(/state/);
  });

  it("validates Persona event observation provenance and counts", () => {
    const event = {
      id: "persona-event-1",
      category: "language_style",
      content: "Prefer concise Chinese technical answers",
      observedAt: "2026-08-09T14:30:00.000Z",
      lastObservedAt: "2026-08-09T15:30:00.000Z",
      observationCount: 2,
      observations: [
        {
          observedAt: "2026-08-09T14:30:00.000Z",
          sourceAgent: "codex",
          sourceProject: "one-status",
          confidence: "explicit",
        },
        {
          observedAt: "2026-08-09T15:30:00.000Z",
          sourceAgent: "claude-code",
          sourceProject: "one-status",
          confidence: "observed",
        },
      ],
      sourceAgent: "codex",
      sourceProject: "one-status",
      confidence: "explicit",
      updatedAt: "2026-08-09T15:30:00.000Z",
    } as const;

    expect(personaEventSchema.parse(event)).toMatchObject({
      observationCount: 2,
      lastObservedAt: "2026-08-09T15:30:00.000Z",
    });
    expect(() =>
      personaEventSchema.parse({ ...event, observationCount: 1 }),
    ).toThrow(/observationCount/);
  });

  it.each([
    "https://alice:secret@example.test/v1",
    "https://example.test/v1?api_key=private",
    "https://example.test/v1#credential",
  ])("rejects credential-bearing model source endpoints: %s", (endpoint) => {
    expect(() =>
      modelSourceSchema.parse({
        id: "third-party-a",
        label: "Third-party A",
        kind: "compatible-api",
        protocol: "openai",
        endpoint,
        supportedTools: ["codex"],
        credentialRef: "model-source:third-party-a",
        credentialStatus: "available",
        createdAt: "2026-08-09T00:00:00.000Z",
        updatedAt: "2026-08-09T00:00:00.000Z",
      }),
    ).toThrow(/user info, query, or fragment/);
  });

  it("validates an immutable configuration snapshot and complete claim lease", () => {
    const source = modelSourceSchema.parse({
      id: "third-party-a",
      label: "Third-party A",
      kind: "compatible-api",
      protocol: "openai",
      endpoint: "https://example.test/v1",
      supportedTools: ["codex"],
      credentialRef: "model-source:third-party-a",
      credentialStatus: "available",
      createdAt: "2026-08-09T00:00:00.000Z",
      updatedAt: "2026-08-09T00:00:00.000Z",
    });
    const model = {
      id: "third-party-a:model:gpt-5-4",
      sourceId: source.id,
      name: "GPT-5.4",
      modelId: "gpt-5.4",
      supportedTools: ["codex"],
      createdAt: "2026-08-09T00:00:00.000Z",
      updatedAt: "2026-08-09T00:00:00.000Z",
    } as const;
    const intent = {
      id: "95fc096d-6adc-45ec-b1d5-cc3a35d6acde",
      deviceId: "device-a",
      toolId: "codex",
      modelId: model.id,
      sourceId: source.id,
      status: "applying",
      requestedAt: "2026-08-09T00:00:00.000Z",
      requestedByDeviceId: "device-b",
      updatedAt: "2026-08-09T00:01:00.000Z",
      attempts: 1,
      configuration: { model, source },
      claimId: "cf54563a-45d8-48d2-b819-a4e846578a4d",
      claimedAt: "2026-08-09T00:01:00.000Z",
      claimExpiresAt: "2026-08-09T00:03:00.000Z",
    } as const;

    expect(configurationIntentSchema.parse(intent)).toMatchObject({
      configuration: { model: { modelId: "gpt-5.4" } },
      claimId: intent.claimId,
    });
    expect(() =>
      configurationIntentSchema.parse({ ...intent, claimExpiresAt: undefined }),
    ).toThrow(/claim fields/);
    expect(() =>
      configurationIntentSchema.parse({
        ...intent,
        configuration: {
          ...intent.configuration,
          model: { ...model, id: "different-model" },
        },
      }),
    ).toThrow(/snapshot IDs/);
  });

  it("validates portable capability installation intent", () => {
    const status = createEmptyStatus();
    status.capabilities.installations["github-workflow"] = {
      packId: "github-workflow",
      version: "1.0.0",
      manifestDigest: `sha256:${"a".repeat(64)}`,
      source: { type: "builtin" },
      targets: ["codex", "claude-code"],
      enabled: true,
      installedAt: "2026-08-09T10:00:00.000Z",
      updatedAt: "2026-08-09T10:00:00.000Z",
    };

    expect(statusDocumentSchema.parse(status).capabilities.installations)
      .toHaveProperty("github-workflow");
  });

  it("rejects mismatched installation keys and duplicate targets", () => {
    const status = createEmptyStatus();
    status.capabilities.installations["different-pack"] = {
      packId: "github-workflow",
      version: "1.0.0",
      manifestDigest: `sha256:${"0".repeat(64)}`,
      source: { type: "builtin" },
      targets: ["codex", "codex"],
      enabled: true,
      installedAt: "2026-08-09T00:00:00.000Z",
      updatedAt: "2026-08-09T00:00:00.000Z",
    } as never;

    expect(() => statusDocumentSchema.parse(status)).toThrow(
      /targets must be unique|key must match packId/,
    );
  });

  it("accepts DNS-style Capability Pack IDs in installation state", () => {
    const status = createEmptyStatus();
    status.capabilities.installations["com.example.github"] = {
      packId: "com.example.github",
      version: "1.0.0",
      manifestDigest: `sha256:${"1".repeat(64)}`,
      source: { type: "url", reference: "https://example.test/pack.yaml" },
      targets: ["codex"],
      enabled: true,
      installedAt: "2026-08-09T00:00:00.000Z",
      updatedAt: "2026-08-09T00:00:00.000Z",
    };

    expect(statusDocumentSchema.parse(status).capabilities.installations)
      .toHaveProperty("com.example.github");
  });

  it("requires a project id for project memory", () => {
    expect(() =>
      memoryEntrySchema.parse({
        id: "memory-1",
        scope: "project",
        content: "Use pnpm",
        tags: [],
        state: "confirmed",
        createdAt: "2026-08-08T10:00:00.000Z",
        updatedAt: "2026-08-08T10:00:00.000Z",
      }),
    ).toThrow(/projectId/);
  });

  it("keeps synced Permission Vault data in a strict encrypted envelope", () => {
    const status = createEmptyStatus();
    status.permissions.vault = {
      format: "one-status.encrypted-permission-vault",
      version: 1,
      algorithm: "AES-256-GCM",
      updatedAt: "2026-08-08T10:00:00.000Z",
      iv: "iv",
      ciphertext: "ciphertext",
      authTag: "tag",
    };

    expect(statusDocumentSchema.parse(status).permissions.vault).toMatchObject({
      format: "one-status.encrypted-permission-vault",
      algorithm: "AES-256-GCM",
    });
  });

  it("validates an exact portable GitHub Handoff reference", () => {
    const status = createEmptyStatus();
    status.projects["one-status"] = {
      id: "one-status",
      name: "One Status",
      summary: "",
      techStack: [],
      currentGoal: "Continue on Mac B",
      decisions: [],
      handoff: {
        provider: "github",
        repositoryUrl: "https://github.com/acme/one-status.git",
        branch: "main",
        commit: "a".repeat(40),
        publishedAt: "2026-08-08T10:00:00.000Z",
        sourceDeviceId: "device-a",
        statusVersion: 8,
      },
      updatedAt: "2026-08-08T10:00:00.000Z",
    };

    expect(statusDocumentSchema.parse(status).projects["one-status"]?.handoff)
      .toMatchObject({ commit: "a".repeat(40), branch: "main" });

    status.projects["one-status"]!.handoff!.repositoryUrl =
      "file:///tmp/repository.git";
    expect(() => statusDocumentSchema.parse(status)).toThrow(/github\.com/);
  });
});
