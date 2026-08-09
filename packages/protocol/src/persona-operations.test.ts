import { describe, expect, it } from "vitest";
import { createEmptyStatus, statusDocumentSchema } from "./index.js";
import {
  assertPersonaContentIsSafe,
  recordPersonaEvent,
  updatePersonaEvent,
} from "./persona-operations.js";

describe("Persona secret boundary", () => {
  it.each([
    "api_key=private-value-123456",
    "password: correct-horse-battery-staple",
    "token is sk-example1234567890",
    "github_pat_example123456789012345",
    "-----BEGIN PRIVATE KEY----- secret -----END PRIVATE KEY-----",
    "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTYifQ.signature123456",
  ])("rejects credential-like content without echoing it: %s", (content) => {
    expect(() => assertPersonaContentIsSafe(content)).toThrow(
      "Persona content looks like a credential or private key and was rejected.",
    );
    const status = createEmptyStatus();
    expect(() =>
      recordPersonaEvent(
        status,
        {
          category: "personal_info",
          content,
          confidence: "explicit",
        },
        "codex",
      ),
    ).toThrow("Persona content looks like a credential or private key");
    expect(JSON.stringify(status.persona)).not.toContain(content);
  });

  it("allows ordinary preferences that mention security concepts", () => {
    expect(() =>
      assertPersonaContentIsSafe(
        "偏好使用密码管理器，并在技术回答中避免展示任何 API key。",
      ),
    ).not.toThrow();
  });

  it("rejects credential-like content when an existing event is edited", () => {
    const status = createEmptyStatus();
    const recorded = recordPersonaEvent(
      status,
      {
        category: "technical_habit",
        content: "Prefer environment variables for local configuration.",
        confidence: "explicit",
      },
      "codex",
      "2026-08-10T09:00:00.000Z",
      "editable-event",
    );

    expect(() =>
      updatePersonaEvent(status, {
        id: recorded.event.id,
        content: "api_key=private-value-123456",
      }),
    ).toThrow("Persona content looks like a credential or private key");
    expect(status.persona.events[0]?.content).toBe(
      "Prefer environment variables for local configuration.",
    );
    expect(JSON.stringify(status.persona)).not.toContain(
      "private-value-123456",
    );
  });

  it("orders mixed-offset observations and profiles by absolute time", () => {
    const status = createEmptyStatus();
    recordPersonaEvent(
      status,
      {
        category: "language_style",
        content: "Prefer concise Chinese answers",
        observedAt: "2026-08-09T23:30:00+08:00",
        confidence: "explicit",
      },
      "codex",
      "2026-08-09T15:30:00.000Z",
      "language-event",
    );
    const repeated = recordPersonaEvent(
      status,
      {
        category: "language_style",
        content: "Prefer concise Chinese answers",
        observedAt: "2026-08-09T16:00:00.000Z",
        confidence: "observed",
      },
      "claude-code",
      "2026-08-09T16:00:00.000Z",
    );
    recordPersonaEvent(
      status,
      {
        category: "technical_habit",
        content: "Prefer pnpm",
        observedAt: "2026-08-10T00:30:00+08:00",
        confidence: "explicit",
      },
      "codex",
      "2026-08-09T16:30:00.000Z",
      "technical-earlier",
    );
    recordPersonaEvent(
      status,
      {
        category: "technical_habit",
        content: "Prefer pnpm with a frozen lockfile",
        observedAt: "2026-08-09T17:00:00.000Z",
        confidence: "explicit",
      },
      "claude-code",
      "2026-08-09T17:00:00.000Z",
      "technical-later",
    );

    expect(repeated.event.observedAt).toBe("2026-08-09T23:30:00+08:00");
    expect(repeated.event.lastObservedAt).toBe("2026-08-09T16:00:00.000Z");
    expect(status.persona.profile.technical_habit?.content).toBe(
      "Prefer pnpm with a frozen lockfile",
    );
    expect(() => statusDocumentSchema.parse(status)).not.toThrow();
  });
});
