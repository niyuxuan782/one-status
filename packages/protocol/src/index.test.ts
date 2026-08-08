import { describe, expect, it } from "vitest";
import { createEmptyStatus, memoryEntrySchema, statusDocumentSchema } from "./index.js";

describe("status protocol", () => {
  it("creates a future-ready empty status document", () => {
    expect(statusDocumentSchema.parse(createEmptyStatus())).toMatchObject({
      schemaVersion: 1,
      memory: [],
      projects: {},
      permissions: { grants: [] },
    });
  });

  it("requires a project id for project memory", () => {
    expect(() =>
      memoryEntrySchema.parse({
        id: "memory-1",
        scope: "project",
        content: "Use pnpm",
        tags: [],
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
