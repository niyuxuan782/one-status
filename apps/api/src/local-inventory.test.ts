import {
  chmod,
  mkdir,
  mkdtemp,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { scanLocalInventory } from "./local-inventory.js";

describe("local inventory", () => {
  let directory: string | undefined;

  afterEach(async () => {
    if (directory) await rm(directory, { recursive: true, force: true });
  });

  it("discovers local assets while removing MCP secret values", async () => {
    directory = await mkdtemp(join(tmpdir(), "one-status-inventory-"));
    const home = join(directory, "home");
    const bin = join(directory, "bin");
    const project = join(directory, "project");
    const linkedProject = join(directory, "linked-project");
    await mkdir(join(home, ".codex", "skills", "sample"), {
      recursive: true,
    });
    await mkdir(join(home, ".claude", "plugins"), { recursive: true });
    await mkdir(join(project, ".git"), { recursive: true });
    await mkdir(bin, { recursive: true });
    await writeFile(join(bin, "codex"), "#!/bin/sh\nexit 0\n");
    await chmod(join(bin, "codex"), 0o755);
    await writeFile(join(project, "package.json"), "{}\n");
    await writeFile(join(project, "AGENTS.md"), "project rules\n");
    await writeFile(join(project, ".git", "HEAD"), "ref: refs/heads/main\n");
    await symlink(project, linkedProject);
    await writeFile(
      join(home, ".codex", "config.toml"),
      `[projects.${JSON.stringify(project)}]\ntrust_level = "trusted"\n[projects.${JSON.stringify(linkedProject)}]\ntrust_level = "trusted"\n`,
    );
    await writeFile(
      join(home, ".claude.json"),
      JSON.stringify({
        projects: { [project]: {} },
        mcpServers: {
          remote: {
            type: "http",
            url: "https://mcp.example.test/path?token=CLAUDE_QUERY_SECRET",
            env: { ACCESS_TOKEN: "CLAUDE_ENV_SECRET" },
          },
        },
      }),
    );
    await writeFile(
      join(home, ".codex", "skills", "sample", "SKILL.md"),
      "---\nname: sample-skill\ndescription: Safe description\n---\nTOP_SECRET_SKILL_BODY\n",
    );
    await writeFile(
      join(home, ".claude", "plugins", "installed_plugins.json"),
      JSON.stringify({ version: 1, plugins: {} }),
    );

    const snapshot = await scanLocalInventory({
      homeDir: home,
      environment: {
        HOME: home,
        PATH: [bin].join(delimiter),
        CODEX_HOME: join(home, ".codex"),
        ONE_STATUS_INVENTORY_RUN_AGENT_COMMANDS: "true",
        ONE_STATUS_SCAN_ROOTS: [project, linkedProject].join(delimiter),
      },
      async runCommand(_executable, arguments_) {
        if (arguments_.join(" ") === "--version") return "codex 1.2.3";
        if (arguments_.join(" ") === "mcp list --json") {
          return JSON.stringify([
            {
              name: "local-memory",
              enabled: true,
              transport: {
                type: "stdio",
                command: "/secret/path/memory-server",
                env: { API_TOKEN: "CODEX_ENV_SECRET" },
              },
            },
          ]);
        }
        if (arguments_.join(" ") === "plugin list --json") {
          return JSON.stringify({
            installed: [
              { name: "documents", enabled: true, version: "1.0.0" },
            ],
          });
        }
        throw new Error("Unexpected command");
      },
    });

    expect(snapshot.projects).toHaveLength(1);
    expect(snapshot.projects[0]).toMatchObject({
      path: await realpath(project),
      git: true,
      branch: "main",
      agents: ["claude-code", "codex"],
    });
    expect(snapshot.skills).toEqual([
      expect.objectContaining({ name: "sample-skill", agent: "codex" }),
    ]);
    expect(snapshot.mcpServers).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: "remote",
          endpoint: "https://mcp.example.test/path",
          envNames: ["ACCESS_TOKEN"],
        }),
        expect.objectContaining({
          name: "local-memory",
          command: "memory-server",
          envNames: ["API_TOKEN"],
        }),
      ]),
    );
    const serialized = JSON.stringify(snapshot);
    expect(serialized).not.toContain("CLAUDE_QUERY_SECRET");
    expect(serialized).not.toContain("CLAUDE_ENV_SECRET");
    expect(serialized).not.toContain("CODEX_ENV_SECRET");
    expect(serialized).not.toContain("TOP_SECRET_SKILL_BODY");
  });
});
