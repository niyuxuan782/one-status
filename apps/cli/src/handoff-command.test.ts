import { describe, expect, it, vi } from "vitest";
import { runHandoffCommand } from "./handoff-command.js";

const sourceCommit = "a".repeat(40);
const publishedCommit = "b".repeat(40);

describe("handoff command", () => {
  it("uses the dashboard session and CSRF token for a read-only preview", async () => {
    const request = createDashboardFetch({ dirty: false });

    const result = await runHandoffCommand(
      {
        agentId: "claude-code",
        projectId: "one-status",
        publish: false,
      },
      { fetch: request },
    );

    expect(result).toEqual({
      agentId: "claude-code",
      checks: {
        canWrite: true,
        existingFiles: ["HANDOFF.md", ".one-status/handoff.json"],
        secretFindingCount: 0,
        secretScan: "passed",
        worktreeClean: true,
      },
      mode: "preview",
      projectId: "one-status",
      publishedCommit: null,
      sourceCommit,
      statusVersion: 41,
    });
    expect(request).toHaveBeenCalledTimes(2);
    expect(request.mock.calls[0]?.[0].toString()).toBe(
      "http://127.0.0.1:8787/handoffs",
    );
    const previewRequest = request.mock.calls[1]?.[1] as RequestInit;
    expect(previewRequest.headers).toMatchObject({
      cookie: "one_status_dashboard=session-token",
      origin: "http://127.0.0.1:8787",
      "x-one-status-csrf": "csrf-token",
    });
  });

  it("publishes with the exact preview revision and returns both commits", async () => {
    const request = createDashboardFetch({ dirty: true, publish: true });

    const result = await runHandoffCommand(
      {
        agentId: "codex",
        projectId: "one-status",
        publish: true,
      },
      { fetch: request },
    );

    expect(result).toMatchObject({
      agentId: "codex",
      checks: { worktreeClean: false },
      mode: "published",
      publishedCommit,
      sourceCommit,
      statusVersion: 42,
    });
    const publishRequest = request.mock.calls[2]?.[1] as RequestInit;
    expect(JSON.parse(publishRequest.body as string)).toEqual({
      confirmCommit: true,
      confirmPush: true,
      expectedCommit: sourceCommit,
      expectedStatusVersion: 41,
      overwrite: true,
    });
  });

  it("stops before publication when Secret findings exist", async () => {
    const request = createDashboardFetch({
      canWrite: false,
      dirty: true,
      findings: [
        {
          file: "config.env",
          line: 2,
          ruleId: "@secretlint/example",
        },
      ],
      publish: true,
      secretScan: "blocked",
    });

    await expect(
      runHandoffCommand(
        {
          agentId: "codex",
          projectId: "one-status",
          publish: true,
        },
        { fetch: request },
      ),
    ).rejects.toThrow(
      "Handoff blocked by 1 Secret finding(s): config.env:2 (@secretlint/example)",
    );
    expect(request).toHaveBeenCalledTimes(2);
  });

  it("rejects non-loopback dashboards before making a request", async () => {
    const request = vi.fn<typeof fetch>();
    await expect(
      runHandoffCommand(
        {
          agentId: "codex",
          dashboardUrl: "https://os.furesta.top",
          projectId: "one-status",
          publish: false,
        },
        { fetch: request },
      ),
    ).rejects.toThrow("credential-free loopback dashboard URL");
    expect(request).not.toHaveBeenCalled();
  });

  it("validates the agent and project identifiers", async () => {
    await expect(
      runHandoffCommand({
        agentId: "cursor",
        projectId: "one-status",
        publish: false,
      }),
    ).rejects.toThrow("--agent must be claude-code or codex.");
    await expect(
      runHandoffCommand({
        agentId: "codex",
        projectId: "../one-status",
        publish: false,
      }),
    ).rejects.toThrow("--project must contain only");
  });
});

function createDashboardFetch(options: {
  canWrite?: boolean;
  dirty: boolean;
  findings?: Array<{ file: string; line: number; ruleId: string }>;
  publish?: boolean;
  secretScan?: "blocked" | "error" | "passed";
}) {
  const responses: Response[] = [
    new Response('<meta name="one-status-csrf" content="csrf-token">', {
      headers: {
        "content-type": "text/html",
        "set-cookie":
          "one_status_dashboard=session-token; HttpOnly; SameSite=Lax; Path=/",
      },
    }),
    Response.json({
      canWrite: options.canWrite ?? true,
      existingFiles: ["HANDOFF.md", ".one-status/handoff.json"],
      findings: options.findings ?? [],
      manifest: {
        projectId: "one-status",
        repository: { commit: sourceCommit, dirty: options.dirty },
        statusVersion: 41,
        validation: { secretScan: options.secretScan ?? "passed" },
      },
    }),
    ...(options.publish
      ? [
          Response.json({
            committed: true,
            pushed: true,
            repository: { commit: publishedCommit },
            statusVersion: 42,
            written: true,
          }),
        ]
      : []),
  ];
  return vi.fn<typeof fetch>(async () => responses.shift()!);
}
