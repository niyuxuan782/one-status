import { describe, expect, it, vi } from "vitest";
import { LocalAgentLauncher } from "./agent-adapter.js";

describe("local Agent adapter", () => {
  it("opens Codex in macOS Terminal with quoted Handoff context", async () => {
    const runCommand = vi.fn<
      (executable: string, arguments_: string[]) => Promise<void>
    >(async () => undefined);
    const launcher = new LocalAgentLauncher({
      platform: "darwin",
      resolveExecutable: async () => "/Applications/Codex CLI/codex",
      runCommand,
    });

    await expect(
      launcher.launch({
        agentId: "codex",
        commit: "a".repeat(40),
        cwd: "/tmp/Project's checkout",
        projectName: "One Status",
      }),
    ).resolves.toMatchObject({
      agentId: "codex",
      command: "codex",
      launched: true,
      mode: "terminal",
    });

    expect(runCommand).toHaveBeenCalledOnce();
    const [executable, arguments_] = runCommand.mock.calls[0]!;
    expect(executable).toBe("/usr/bin/osascript");
    expect(arguments_[0]).toBe("-e");
    expect(arguments_[1]).toContain("status_get_context");
    expect(arguments_[1]).toContain("Project'\\\"'\\\"'s checkout");
    expect(arguments_[1]).toContain("a".repeat(40));
  });

  it("selects Claude Code and reports missing or unsupported runtimes", async () => {
    const runCommand = vi.fn<
      (executable: string, arguments_: string[]) => Promise<void>
    >(async () => undefined);
    const launcher = new LocalAgentLauncher({
      platform: "darwin",
      resolveExecutable: async (name) =>
        name === "claude" ? "/usr/local/bin/claude" : undefined,
      runCommand,
    });
    await expect(
      launcher.launch({
        agentId: "claude-code",
        commit: "b".repeat(40),
        cwd: "/tmp/project",
        projectName: "One Status",
      }),
    ).resolves.toMatchObject({ command: "claude" });

    await expect(
      new LocalAgentLauncher({
        platform: "darwin",
        resolveExecutable: async () => undefined,
      }).launch({
        agentId: "codex",
        commit: "c".repeat(40),
        cwd: "/tmp/project",
        projectName: "One Status",
      }),
    ).rejects.toThrow("Codex CLI was not found");

    await expect(
      new LocalAgentLauncher({ platform: "linux" }).launch({
        agentId: "codex",
        commit: "d".repeat(40),
        cwd: "/tmp/project",
        projectName: "One Status",
      }),
    ).rejects.toThrow("macOS desktop runtime");
  });
});
