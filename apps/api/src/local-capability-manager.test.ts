import {
  access,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  LocalCapabilityManager,
  type LocalCapabilityCommand,
  type LocalCapabilityCommandResult,
  type LocalCapabilityCommandRunner,
} from "./local-capability-manager.js";

describe("LocalCapabilityManager", () => {
  let directory: string;
  let codexMarketplaceRoot: string;
  let claudeSkillsRoot: string;
  let exportRoot: string;
  let runCommand: ReturnType<typeof vi.fn<
    (command: LocalCapabilityCommand) => Promise<LocalCapabilityCommandResult>
  >>;
  let manager: LocalCapabilityManager;

  beforeEach(async () => {
    directory = await realpath(
      await mkdtemp(join(tmpdir(), "one-status-capability-manager-")),
    );
    codexMarketplaceRoot = join(directory, "codex-marketplace");
    claudeSkillsRoot = join(directory, "claude-skills");
    exportRoot = join(directory, "exports");
    runCommand = vi.fn(async (command: LocalCapabilityCommand) => ({
      command: command.command,
      args: [...command.args],
      stdout: "{}",
      stderr: "",
    }));
    manager = createManager();
  });

  afterEach(async () => {
    await rm(directory, { recursive: true, force: true });
  });

  it("defaults to a Codex dry-run without touching disk or commands", async () => {
    const result = await manager.install({
      packName: "github-workflow",
      target: "codex",
    });

    expect(result).toMatchObject({
      applied: false,
      target: "codex",
      root: codexMarketplaceRoot,
      preview: { dryRun: true, installable: true, updates: 0 },
    });
    expect(result.approvalId).toMatch(/^[0-9a-f]{64}$/);
    expect(result.preview.creates).toBeGreaterThan(3);
    expect(result.preview.files.map((file) => file.relativePath)).toContain(
      ".agents/plugins/marketplace.json",
    );
    expect(result.preview.files.map((file) => file.relativePath)).toContain(
      "plugins/github-workflow/.codex-plugin/plugin.json",
    );
    expect(result.commands).toEqual([
      {
        command: "codex-mock",
        args: [
          "plugin",
          "marketplace",
          "add",
          codexMarketplaceRoot,
          "--json",
        ],
        cwd: codexMarketplaceRoot,
      },
      {
        command: "codex-mock",
        args: [
          "plugin",
          "add",
          "github-workflow@one-status",
          "--json",
        ],
        cwd: codexMarketplaceRoot,
      },
    ]);
    await expect(access(codexMarketplaceRoot)).rejects.toMatchObject({
      code: "ENOENT",
    });
    expect(runCommand).not.toHaveBeenCalled();
  });

  it("requires the approved preview before writing", async () => {
    await expect(
      manager.install({
        packName: "github-workflow",
        target: "codex",
        confirmed: true,
      }),
    ).rejects.toThrow("approvalId is required");
    await expect(
      manager.install({
        packName: "github-workflow",
        target: "codex",
        confirmed: true,
        approvalId: "0".repeat(64),
      }),
    ).rejects.toThrow("changed after preview");
    await expect(access(codexMarketplaceRoot)).rejects.toMatchObject({
      code: "ENOENT",
    });
    expect(runCommand).not.toHaveBeenCalled();
  });

  it("atomically installs and registers a managed Codex marketplace bundle", async () => {
    const preview = await manager.install({
      packName: "github-workflow",
      target: "codex",
    });
    const installed = await manager.install({
      packName: "github-workflow",
      target: "codex",
      confirmed: true,
      approvalId: preview.approvalId,
    });

    expect(installed.applied).toBe(true);
    expect(installed.commandResults).toHaveLength(2);
    const marketplace = JSON.parse(
      await readFile(
        join(codexMarketplaceRoot, ".agents/plugins/marketplace.json"),
        "utf8",
      ),
    ) as {
      name: string;
      plugins: Array<{
        name: string;
        source: { source: string; path: string };
      }>;
    };
    expect(marketplace).toMatchObject({
      name: "one-status",
      plugins: [
        {
          name: "github-workflow",
          source: {
            source: "local",
            path: "./plugins/github-workflow",
          },
        },
      ],
    });
    const pluginManifest = JSON.parse(
      await readFile(
        join(
          codexMarketplaceRoot,
          "plugins/github-workflow/.codex-plugin/plugin.json",
        ),
        "utf8",
      ),
    ) as Record<string, unknown>;
    expect(pluginManifest).toMatchObject({
      name: "github-workflow",
      version: expect.stringMatching(/^1\.0\.0\+codex\.[a-f0-9]{16}$/),
    });
    expect(pluginManifest).not.toHaveProperty("mcpServers");
    expect(
      await readFile(
        join(
          codexMarketplaceRoot,
          "plugins/github-workflow/skills/github-workflow/SKILL.md",
        ),
        "utf8",
      ),
    ).toContain("tools_list");
    await expect(
      access(
        join(
          codexMarketplaceRoot,
          "plugins/github-workflow/.mcp.json",
        ),
      ),
    ).rejects.toMatchObject({ code: "ENOENT" });
    await expect(
      access(
        join(
          codexMarketplaceRoot,
          "plugins/github-workflow/AGENTS.md",
        ),
      ),
    ).rejects.toMatchObject({ code: "ENOENT" });
    expect(
      (await stat(
        join(
          codexMarketplaceRoot,
          "plugins/github-workflow/.codex-plugin/plugin.json",
        ),
      )).mode & 0o777,
    ).toBe(0o644);
    expect(runCommand).toHaveBeenCalledTimes(2);
    await expect(
      access(
        join(
          codexMarketplaceRoot,
          ".one-status/staging",
          preview.preview.planId,
        ),
      ),
    ).rejects.toMatchObject({ code: "ENOENT" });

    const repeated = await manager.install({
      packName: "github-workflow",
      target: "codex",
    });
    expect(repeated.preview.creates).toBe(0);
    expect(repeated.preview.updates).toBe(0);
    expect(repeated.preview.unchanged).toBe(repeated.preview.files.length);
  });

  it("previews and removes legacy per-plugin MCP and instruction files", async () => {
    const pluginRoot = join(
      codexMarketplaceRoot,
      "plugins/github-workflow",
    );
    await mkdir(pluginRoot, { recursive: true });
    await writeFile(join(pluginRoot, ".mcp.json"), "{\"mcpServers\":{}}\n");
    await writeFile(join(pluginRoot, "AGENTS.md"), "# Legacy instructions\n");

    const preview = await manager.install({
      packName: "github-workflow",
      target: "codex",
    });
    expect(preview.removals).toEqual([
      {
        relativePath: "plugins/github-workflow/.mcp.json",
        currentSha256: expect.stringMatching(/^[a-f0-9]{64}$/),
      },
      {
        relativePath: "plugins/github-workflow/AGENTS.md",
        currentSha256: expect.stringMatching(/^[a-f0-9]{64}$/),
      },
    ]);

    await manager.install({
      packName: "github-workflow",
      target: "codex",
      confirmed: true,
      approvalId: preview.approvalId,
    });
    await expect(access(join(pluginRoot, ".mcp.json"))).rejects.toMatchObject({
      code: "ENOENT",
    });
    await expect(access(join(pluginRoot, "AGENTS.md"))).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("refuses cleanup when a legacy managed file changes after preview", async () => {
    const legacyPath = join(
      codexMarketplaceRoot,
      "plugins/github-workflow/.mcp.json",
    );
    await mkdir(dirname(legacyPath), { recursive: true });
    await writeFile(legacyPath, "old\n");
    const plan = await manager.prepareInstallation({
      packName: "github-workflow",
      target: "codex",
    });
    await writeFile(legacyPath, "changed\n");

    await expect(
      manager.applyPreparedInstallation(plan, { confirmed: true }),
    ).rejects.toThrow("files changed after preview");
    expect(await readFile(legacyPath, "utf8")).toBe("changed\n");
  });

  it("preserves and sorts entries when adding another managed Codex pack", async () => {
    await confirmInstall("github-workflow", "codex");
    await confirmInstall("slack-workspace", "codex");

    const marketplace = JSON.parse(
      await readFile(
        join(codexMarketplaceRoot, ".agents/plugins/marketplace.json"),
        "utf8",
      ),
    ) as { plugins: Array<{ name: string }> };
    expect(marketplace.plugins.map((plugin) => plugin.name)).toEqual([
      "github-workflow",
      "slack-workspace",
    ]);
    await expect(
      access(
        join(
          codexMarketplaceRoot,
          "plugins/github-workflow/.codex-plugin/plugin.json",
        ),
      ),
    ).resolves.toBeUndefined();
    expect(runCommand).toHaveBeenCalledTimes(4);
  });

  it("installs only the generated Claude Code Skill", async () => {
    const installed = await confirmInstall(
      "google-workspace",
      "claude-code",
    );

    expect(installed.root).toBe(claudeSkillsRoot);
    expect(installed.compilation.files.map((file) => file.relativePath)).toEqual([
      "google-workspace/SKILL.md",
    ]);
    const skill = await readFile(
      join(claudeSkillsRoot, "google-workspace/SKILL.md"),
      "utf8",
    );
    expect(skill).toContain("calendar.events.list");
    expect(skill.match(/^#### calendar-assistant$/gm)).toHaveLength(1);
    expect(skill).not.toMatch(/^# calendar-assistant$/m);
    await expect(access(join(claudeSkillsRoot, ".mcp.json"))).rejects.toMatchObject({
      code: "ENOENT",
    });
    expect(runCommand).not.toHaveBeenCalled();
  });

  it("installs the same Persona workflow for Codex and Claude Code", async () => {
    await confirmInstall("persona", "codex");
    await confirmInstall("persona", "claude-code");

    const codexSkill = await readFile(
      join(
        codexMarketplaceRoot,
        "plugins/persona/skills/persona/SKILL.md",
      ),
      "utf8",
    );
    const claudeSkill = await readFile(
      join(claudeSkillsRoot, "persona/SKILL.md"),
      "utf8",
    );
    for (const skill of [codexSkill, claudeSkill]) {
      expect(skill).toContain("name: persona");
      expect(skill).toContain("`persona.record`");
      expect(skill).toContain("`persona.get_policy`");
      expect(skill).toContain("full transcripts");
      expect(skill).not.toContain("Call `tools_list` first");
    }
  });

  it.each([
    ["markdown", [".one-status/capabilities/github-workflow/manifest.json", "github-workflow.md"]],
    ["local-mcp", [".mcp.json", ".one-status/capabilities/github-workflow/manifest.json", "github-workflow.md"]],
  ] as const)("exports the %s layout under the managed export root", async (
    target,
    expectedFiles,
  ) => {
    const installed = await confirmInstall("github-workflow", target);

    expect(installed.root).toBe(
      join(exportRoot, target, "github-workflow"),
    );
    expect(installed.compilation.files.map((file) => file.relativePath)).toEqual(
      expectedFiles,
    );
    for (const relativePath of expectedFiles) {
      await expect(access(join(installed.root, relativePath))).resolves.toBeUndefined();
    }
    expect(runCommand).not.toHaveBeenCalled();
  });

  it("refuses a prepared install after a target changes", async () => {
    const plan = await manager.prepareInstallation({
      packName: "github-workflow",
      target: "markdown",
    });
    const changed = plan.preview.files.find(
      (file) => file.relativePath === "github-workflow.md",
    )!;
    await mkdir(dirname(join(plan.root, changed.relativePath)), {
      recursive: true,
    });
    await writeFile(join(plan.root, changed.relativePath), "interloper\n");

    await expect(
      manager.applyPreparedInstallation(plan, { confirmed: true }),
    ).rejects.toThrow("files changed after preview");
    expect(
      await readFile(join(plan.root, changed.relativePath), "utf8"),
    ).toBe("interloper\n");
    const untouched = plan.preview.files.find(
      (file) => file.relativePath !== changed.relativePath,
    )!;
    await expect(access(join(plan.root, untouched.relativePath))).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("blocks a symlink target without changing its destination", async () => {
    const initial = await manager.prepareInstallation({
      packName: "github-workflow",
      target: "markdown",
    });
    const target = initial.preview.files.find(
      (file) => file.relativePath === "github-workflow.md",
    )!;
    const outside = join(directory, "outside.md");
    await writeFile(outside, "outside\n");
    await mkdir(dirname(join(initial.root, target.relativePath)), {
      recursive: true,
    });
    await symlink(outside, join(initial.root, target.relativePath));

    const blocked = await manager.prepareInstallation({
      packName: "github-workflow",
      target: "markdown",
    });
    expect(blocked.preview.installable).toBe(false);
    expect(
      blocked.preview.files.find(
        (file) => file.relativePath === target.relativePath,
      ),
    ).toMatchObject({ disposition: "blocked" });
    await expect(
      manager.applyPreparedInstallation(blocked, { confirmed: true }),
    ).rejects.toThrow("blocked files");
    expect(await readFile(outside, "utf8")).toBe("outside\n");
  });

  it("refuses a symlinked atomic staging directory", async () => {
    const plan = await manager.prepareInstallation({
      packName: "github-workflow",
      target: "markdown",
    });
    const outside = join(directory, "outside-staging");
    await mkdir(outside);
    await mkdir(join(plan.root, ".one-status/staging"), { recursive: true });
    await symlink(
      outside,
      join(plan.root, ".one-status/staging", plan.preview.planId),
    );

    await expect(
      manager.applyPreparedInstallation(plan, { confirmed: true }),
    ).rejects.toThrow("directory is unsafe");
    expect(await readFileOrEmpty(join(outside, "0000.tmp"))).toBe("");
  });

  it("rejects a prepared plan whose command intent was modified", async () => {
    const plan = await manager.prepareInstallation({
      packName: "github-workflow",
      target: "codex",
    });
    const tampered = structuredClone(plan);
    tampered.commands[0]!.command = "/bin/sh";

    await expect(
      manager.applyPreparedInstallation(tampered, { confirmed: true }),
    ).rejects.toThrow(/approvalId|not prepared/);
    await expect(access(codexMarketplaceRoot)).rejects.toMatchObject({
      code: "ENOENT",
    });
    expect(runCommand).not.toHaveBeenCalled();
  });

  it("rejects a symlink inside an export directory chain", async () => {
    const outside = join(directory, "outside-directory");
    await mkdir(outside);
    await mkdir(exportRoot);
    await symlink(outside, join(exportRoot, "markdown"));

    await expect(
      manager.prepareInstallation({
        packName: "github-workflow",
        target: "markdown",
      }),
    ).rejects.toThrow("directory is unsafe");
    expect((await lstat(join(exportRoot, "markdown"))).isSymbolicLink()).toBe(true);
  });

  it("rejects an invalid pre-existing managed marketplace", async () => {
    const marketplacePath = join(
      codexMarketplaceRoot,
      ".agents/plugins/marketplace.json",
    );
    await mkdir(dirname(marketplacePath), { recursive: true });
    await writeFile(
      marketplacePath,
      JSON.stringify({ name: "foreign", interface: {}, plugins: [] }),
    );
    await expect(
      manager.prepareInstallation({
        packName: "github-workflow",
        target: "codex",
      }),
    ).rejects.toThrow();
    expect(runCommand).not.toHaveBeenCalled();
  });

  function createManager(): LocalCapabilityManager {
    const commandRunner: LocalCapabilityCommandRunner = { run: runCommand };
    return new LocalCapabilityManager({
      codexMarketplaceRoot,
      claudeSkillsRoot,
      exportRoot,
      codexExecutable: "codex-mock",
      homeDir: directory,
      environment: {},
      commandRunner,
    });
  }

  async function confirmInstall(
    packName: string,
    target: "codex" | "claude-code" | "markdown" | "local-mcp",
  ) {
    const preview = await manager.install({ packName, target });
    return manager.install({
      packName,
      target,
      confirmed: true,
      approvalId: preview.approvalId,
    });
  }

  async function readFileOrEmpty(path: string): Promise<string> {
    try {
      return await readFile(path, "utf8");
    } catch (error) {
      if (
        error instanceof Error &&
        "code" in error &&
        (error as Error & { code?: string }).code === "ENOENT"
      ) {
        return "";
      }
      throw error;
    }
  }
});
