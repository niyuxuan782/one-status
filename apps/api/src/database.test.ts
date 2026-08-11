import { afterEach, describe, expect, it } from "vitest";
import { OneStatusDatabase } from "./database.js";

describe("Agent credentials", () => {
  let database: OneStatusDatabase | undefined;

  afterEach(() => {
    database?.close();
    database = undefined;
  });

  it("binds an opaque credential to one Agent and rejects tampering or expiry", () => {
    database = new OneStatusDatabase(":memory:");
    const now = new Date("2026-08-09T10:00:00.000Z");
    const issued = database.issueAgentCredential(
      {
        deviceId: "device-1",
        expiresAt: "2026-08-09T11:00:00.000Z",
        userId: "user-1",
      },
      "codex",
      { now, ttlMs: 1_000 },
    );

    expect(issued).toMatchObject({
      agentId: "codex",
      deviceId: "device-1",
      expiresAt: "2026-08-09T10:00:01.000Z",
      token: expect.stringMatching(/^osa1_[A-Za-z0-9_-]{43}$/),
    });
    expect(database.listAgentIds("user-1", now)).toEqual(["codex"]);
    expect(database.authenticateAgent(issued.token, now)).toMatchObject({
      authentication: "agent",
      agentId: "codex",
      credentialId: issued.credentialId,
      deviceId: "device-1",
      userId: "user-1",
    });
    expect(
      database.authenticateAgent(`${issued.token.slice(0, -1)}x`, now),
    ).toBeNull();
    expect(
      database.authenticateAgent(
        issued.token,
        new Date("2026-08-09T10:00:01.000Z"),
      ),
    ).toBeNull();
    expect(
      database.listAgentIds(
        "user-1",
        new Date("2026-08-09T10:00:01.000Z"),
      ),
    ).toEqual([]);
  });

  it("revokes only the credential owned by the authenticated device", () => {
    database = new OneStatusDatabase(":memory:");
    const issued = database.issueAgentCredential(
      { deviceId: "device-1", userId: "user-1" },
      "claude-code",
    );

    expect(
      database.revokeAgentCredential(
        "user-2",
        "device-1",
        issued.credentialId,
      ),
    ).toBe(false);
    expect(database.authenticateAgent(issued.token)).not.toBeNull();
    expect(
      database.revokeAgentCredential(
        "user-1",
        "device-1",
        issued.credentialId,
      ),
    ).toBe(true);
    expect(database.authenticateAgent(issued.token)).toBeNull();
    expect(database.listAgentIds("user-1")).toEqual([]);
  });
});
