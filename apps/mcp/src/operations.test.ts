import { describe, expect, it } from "vitest";
import { createEmptyStatus } from "@one-status/protocol";
import { applyStatusMutation, digestStatusMutation } from "./operations.js";

describe("MCP status mutations", () => {
  it("adds project memory with stable metadata", () => {
    const status = createEmptyStatus();
    applyStatusMutation(
      status,
      {
        type: "append_memory",
        scope: "project",
        projectId: "one-status",
        content: "Use pnpm",
        tags: ["tooling"],
      },
      "codex",
      "2026-08-08T10:00:00.000Z",
      "memory-1",
    );

    expect(status.memory).toEqual([
      {
        id: "memory-1",
        scope: "project",
        projectId: "one-status",
        content: "Use pnpm",
        tags: ["tooling"],
        state: "candidate",
        origin: { type: "agent", label: "codex" },
        createdByAgentId: "codex",
        createdAt: "2026-08-08T10:00:00.000Z",
        updatedAt: "2026-08-08T10:00:00.000Z",
      },
    ]);
  });

  it("records the agent that changed current context", () => {
    const status = createEmptyStatus();
    applyStatusMutation(
      status,
      {
        type: "update_context",
        currentContext: "Implement OAuth Gateway",
        projectId: "one-status",
      },
      "claude-code",
    );

    expect(status.workspace).toEqual({
      activeProjectId: "one-status",
      currentContext: "Implement OAuth Gateway",
      lastAgentId: "claude-code",
    });
  });

  it("rejects writes to the internal preference namespace", () => {
    const status = createEmptyStatus();

    expect(() =>
      applyStatusMutation(
        status,
        {
          type: "set_preference",
          key: "__one_status_internal:model-usage:v1:fake-device",
          value: JSON.stringify({ entries: [] }),
        },
        "codex",
      ),
    ).toThrow("internal preferences");
    expect(status.preferences).toEqual({});
  });

  it("preserves a published Handoff when an Agent updates project metadata", () => {
    const status = createEmptyStatus();
    const handoff = {
      provider: "github" as const,
      repositoryUrl: "https://github.com/acme/one-status.git",
      branch: "main",
      commit: "a".repeat(40),
      publishedAt: "2026-08-08T10:00:00.000Z",
      sourceDeviceId: "device-a",
      statusVersion: 7,
    };
    status.projects["one-status"] = {
      id: "one-status",
      name: "One Status",
      summary: "",
      techStack: [],
      currentGoal: "Publish",
      decisions: [],
      handoff,
      updatedAt: "2026-08-08T10:00:00.000Z",
    };

    applyStatusMutation(
      status,
      {
        type: "upsert_project",
        id: "one-status",
        name: "One Status",
        currentGoal: "Continue",
      },
      "codex",
    );

    expect(status.projects["one-status"]?.handoff).toEqual(handoff);
  });

  it("produces a stable digest for the same logical mutation", () => {
    const mutation = {
      type: "append_memory" as const,
      scope: "user" as const,
      content: "Use pnpm",
      tags: ["preference"],
    };
    expect(digestStatusMutation(mutation)).toBe(
      digestStatusMutation(structuredClone(mutation)),
    );
    expect(digestStatusMutation(mutation)).toHaveLength(43);
  });
});
