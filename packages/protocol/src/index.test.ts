import { describe, expect, it } from "vitest";
import {
  createEmptyStatus,
  memoryEntrySchema,
  parseStatusDocument,
  statusDocumentSchema,
} from "./index.js";

describe("status protocol", () => {
  it("creates a future-ready empty status document", () => {
    expect(statusDocumentSchema.parse(createEmptyStatus())).toMatchObject({
      schemaVersion: 3,
      memory: [],
      projects: {},
      permissions: { grants: [] },
      capabilities: { installations: {} },
    });
  });

  it("migrates schema v1 memory into confirmed schema v3 memory", () => {
    const { capabilities: _capabilities, ...emptyV1 } = createEmptyStatus();
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
      schemaVersion: 3,
      capabilities: { installations: {} },
      memory: [{ id: "legacy-memory", state: "confirmed" }],
    });
  });

  it("migrates schema v2 documents without capability installation state", () => {
    const { capabilities: _capabilities, ...emptyV2 } = createEmptyStatus();
    const previous = {
      ...emptyV2,
      schemaVersion: 2,
    };

    expect(parseStatusDocument(previous)).toMatchObject({
      schemaVersion: 3,
      capabilities: { installations: {} },
    });
  });

  it("requires schema v3 writers to choose a memory state", () => {
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
