import { describe, expect, it } from "vitest";
import { createEmptyStatus, statusDocumentSchema } from "@one-status/protocol";
import {
  deletePersonaEvent,
  recordPersonaEvent,
  setPersonaPolicy,
  updatePersonaEvent,
} from "./persona.js";

describe("Persona status operations", () => {
  it("deduplicates normalized content while retaining every observation", () => {
    const status = createEmptyStatus();
    const first = recordPersonaEvent(
      status,
      {
        category: "language_style",
        content: "Prefer concise Chinese answers",
        confidence: "explicit",
        sourceProject: "one-status",
      },
      "codex",
      "2026-08-09T14:30:00.000Z",
      "persona-event-1",
    );
    const repeated = recordPersonaEvent(
      status,
      {
        category: "language_style",
        content: "  PREFER   CONCISE CHINESE ANSWERS ",
        confidence: "observed",
        sourceProject: "one-status",
      },
      "claude-code",
      "2026-08-09T15:30:00.000Z",
      "unused-event-id",
    );

    expect(first.created).toBe(true);
    expect(repeated).toMatchObject({ created: false, observationAdded: true });
    expect(status.persona.events).toHaveLength(1);
    expect(status.persona.events[0]).toMatchObject({
      id: "persona-event-1",
      observationCount: 2,
      observedAt: "2026-08-09T14:30:00.000Z",
      lastObservedAt: "2026-08-09T15:30:00.000Z",
      sourceAgent: "codex",
    });
    expect(status.persona.events[0]?.observations).toEqual([
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
    ]);
    expect(status.persona.profile.language_style).toMatchObject({
      content: "Prefer concise Chinese answers",
      confidence: "explicit",
      observationCount: 2,
      sourceEventIds: ["persona-event-1"],
    });
    expect(() => statusDocumentSchema.parse(status)).not.toThrow();
  });

  it("does not count an identical retry twice", () => {
    const status = createEmptyStatus();
    const input = {
      category: "technical_habit" as const,
      content: "Use pnpm",
      confidence: "explicit" as const,
      observedAt: "2026-08-09T16:00:00.000Z",
    };
    recordPersonaEvent(status, input, "codex", input.observedAt, "event-1");
    const retry = recordPersonaEvent(
      status,
      input,
      "codex",
      input.observedAt,
      "event-2",
    );

    expect(retry.observationAdded).toBe(false);
    expect(status.persona.events[0]?.observationCount).toBe(1);
  });

  it("updates, merges, deletes, and rebuilds the current profile", () => {
    const status = createEmptyStatus();
    recordPersonaEvent(
      status,
      {
        category: "output_style",
        content: "Detailed answers",
        confidence: "observed",
      },
      "claude-code",
      "2026-08-09T10:00:00.000Z",
      "event-old",
    );
    recordPersonaEvent(
      status,
      {
        category: "output_style",
        content: "Concise answers",
        confidence: "explicit",
      },
      "codex",
      "2026-08-09T11:00:00.000Z",
      "event-new",
    );
    expect(status.persona.profile.output_style?.content).toBe("Concise answers");

    const merged = updatePersonaEvent(
      status,
      { id: "event-old", content: "Concise answers" },
      "2026-08-09T12:00:00.000Z",
    );
    expect(merged.id).toBe("event-new");
    expect(status.persona.events).toHaveLength(1);
    expect(merged.observationCount).toBe(2);

    deletePersonaEvent(status, "event-new", "2026-08-09T13:00:00.000Z");
    expect(status.persona.profile).toEqual({});
  });

  it("enforces global, category, and confidence recording policy", () => {
    const status = createEmptyStatus();
    recordPersonaEvent(
      status,
      {
        category: "language_style",
        content: "Original preference",
        confidence: "explicit",
      },
      "codex",
      "2026-08-09T13:00:00.000Z",
      "editable-event",
    );
    setPersonaPolicy(
      status,
      {
        blockedCategories: ["personal_info"],
        allowedConfidences: ["explicit"],
      },
      "2026-08-09T14:00:00.000Z",
    );

    expect(() =>
      recordPersonaEvent(
        status,
        {
          category: "personal_info",
          content: "Blocked detail",
          confidence: "explicit",
        },
        "codex",
      ),
    ).toThrow(/blocked/);
    expect(() =>
      recordPersonaEvent(
        status,
        {
          category: "language_style",
          content: "Inferred preference",
          confidence: "inferred",
        },
        "codex",
      ),
    ).toThrow(/confidence/);

    setPersonaPolicy(status, { enabled: false });
    expect(
      updatePersonaEvent(status, {
        id: "editable-event",
        content: "Edited while recording is disabled",
      }).content,
    ).toBe("Edited while recording is disabled");
    expect(() =>
      recordPersonaEvent(
        status,
        {
          category: "language_style",
          content: "Explicit preference",
          confidence: "explicit",
        },
        "codex",
      ),
    ).toThrow(/disabled/);
  });
});
