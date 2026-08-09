import { describe, expect, it } from "vitest";
import { githubWorkflowCapabilityPack } from "@one-status/capability-pack/fixtures/github-workflow";
import { personaCapabilityPack } from "@one-status/capability-pack/fixtures/persona";
import {
  compileCapabilityPack,
  createCapabilityInstallPreview,
  normalizeCapabilityRelativePath,
  portableCapabilityName,
  stableJson,
  type CapabilityCompilation,
  type CapabilitySourceFiles,
} from "./adapter-engine.js";

const sourceFiles: CapabilitySourceFiles = {
  "instructions/manage-issues.md": [
    "Ask for explicit confirmation before creating the issue.",
    "Use the title and body supplied by the user.",
  ].join("\n"),
  "instructions/review-pull-request.md":
    "Read the repository and pull request before writing the review.",
  "skills/github-workflow/SKILL.md": [
    "---",
    "name: github-workflow",
    'description: "Use GitHub through One Status."',
    "---",
    "",
    "Call `tools_list` before using a GitHub action.",
  ].join("\n"),
};

describe("Capability Pack Adapter Engine", () => {
  it("maps dotted and long pack IDs to collision-resistant platform names", () => {
    expect(portableCapabilityName("github-workflow")).toBe("github-workflow");
    expect(portableCapabilityName("github.workflow")).toMatch(
      /^github-workflow-[a-f0-9]{10}$/,
    );
    expect(portableCapabilityName("github.workflow")).not.toBe(
      portableCapabilityName("github-workflow"),
    );
    expect(
      portableCapabilityName(`${"a".repeat(63)}.${"b".repeat(63)}`),
    ).toHaveLength(64);
  });

  it("compiles a deterministic Codex plugin without embedding credentials", () => {
    const options = {
      target: "codex" as const,
      gateway: {
        transport: "http" as const,
        url: "https://os.example.test/mcp",
        bearerTokenEnvVar: "ONE_STATUS_MCP_TOKEN",
      },
      sourceFiles,
    };
    const first = compileCapabilityPack(githubWorkflowCapabilityPack, options);
    const second = compileCapabilityPack(githubWorkflowCapabilityPack, options);

    expect(first).toEqual(second);
    expect(first.planId).toMatch(/^[0-9a-f]{64}$/);
    expect(first.files.map((file) => file.relativePath)).toEqual(
      [...first.files.map((file) => file.relativePath)].sort(),
    );
    expect(first.files.map((file) => file.relativePath)).toEqual([
      ".codex-plugin/plugin.json",
      ".mcp.json",
      ".one-status/capabilities/github-workflow/manifest.json",
      "AGENTS.md",
      "skills/github-workflow/SKILL.md",
    ]);

    const plugin = readJsonFile(first, ".codex-plugin/plugin.json");
    expect(plugin).toMatchObject({
      name: "github-workflow",
      mcpServers: "./.mcp.json",
      skills: "./skills/",
    });
    const mcp = readJsonFile(first, ".mcp.json");
    expect(mcp).toEqual({
      mcpServers: {
        "one-status": {
          bearer_token_env_var: "ONE_STATUS_MCP_TOKEN",
          type: "http",
          url: "https://os.example.test/mcp",
        },
      },
    });
    const serialized = JSON.stringify(first);
    expect(serialized).not.toContain("access_token");
    expect(serialized).not.toContain("refresh_token");
    expect(fileContent(first, "AGENTS.md")).toContain("`tools_list`");
    expect(fileContent(first, "AGENTS.md")).toContain("`tools_execute`");
    expect(fileContent(first, "AGENTS.md")).toContain(
      "Ask for explicit confirmation",
    );
    expect(first.warnings).toEqual([]);
  });

  it.each([
    [
      "claude-code",
      [
        ".claude/skills/github-workflow/SKILL.md",
        ".mcp.json",
        ".one-status/capabilities/github-workflow/manifest.json",
        "CLAUDE.md",
      ],
    ],
    [
      "markdown",
      [
        ".one-status/capabilities/github-workflow/manifest.json",
        "github-workflow.md",
      ],
    ],
    [
      "local-mcp",
      [
        ".mcp.json",
        ".one-status/capabilities/github-workflow/manifest.json",
        "github-workflow.md",
      ],
    ],
  ] as const)("compiles the %s adapter layout", (target, expectedPaths) => {
    const result = compileCapabilityPack(githubWorkflowCapabilityPack, {
      target,
      gateway: { transport: "stdio", command: "one-status" },
      sourceFiles,
    });
    expect(result.files.map((file) => file.relativePath)).toEqual(expectedPaths);
    const mcpFile = result.files.find((file) => file.relativePath.endsWith("mcp.json"));
    if (mcpFile) {
      expect(JSON.parse(mcpFile.content)).toEqual({
        mcpServers: {
          "one-status": {
            args: ["mcp", "--transport", "stdio"],
            command: "one-status",
          },
        },
      });
    }
  });

  it("compiles a Cursor rule when the pack declares cursor-rules", () => {
    const result = compileCapabilityPack(githubWorkflowCapabilityPack, {
      target: "cursor",
      gateway: {
        transport: "http",
        url: "http://127.0.0.1:8787/mcp",
        bearerTokenEnvVar: "ONE_STATUS_MCP_TOKEN",
      },
      sourceFiles,
    });
    expect(result.files.map((file) => file.relativePath)).toEqual([
      ".cursor/mcp.json",
      ".cursor/rules/github-workflow.mdc",
      ".one-status/capabilities/github-workflow/manifest.json",
    ]);
    expect(fileContent(result, ".cursor/rules/github-workflow.mdc")).toContain(
      "alwaysApply: true",
    );
    expect(fileContent(result, ".cursor/mcp.json")).toContain(
      '"Authorization": "Bearer ${ONE_STATUS_MCP_TOKEN}"',
    );
  });

  it.each(["codex", "claude-code"] as const)(
    "generates the unified Persona Skill and instructions for %s",
    (target) => {
      const result = compileCapabilityPack(personaCapabilityPack, {
        target,
        gateway: { transport: "stdio", command: "one-status" },
      });
      const skillPath = target === "codex"
        ? "skills/persona/SKILL.md"
        : ".claude/skills/persona/SKILL.md";
      const instructionPath = target === "codex" ? "AGENTS.md" : "CLAUDE.md";
      for (const path of [skillPath, instructionPath]) {
        const content = fileContent(result, path);
        expect(content).toContain("`persona.record`");
        expect(content).toContain("`persona.get_policy`");
        expect(content).toContain("long-term goal");
        expect(content).toContain("full transcripts");
        expect(content).not.toContain("Call `tools_list` first");
      }
      expect(fileContent(result, skillPath)).toContain("name: persona");
      expect(result.warnings).toEqual([]);
    },
  );

  it("only copies skill files declared by the manifest", () => {
    const manifest = {
      ...githubWorkflowCapabilityPack,
      skills: {
        source: "skills/",
        files: ["github-workflow/SKILL.md"],
      },
    };
    const result = compileCapabilityPack(manifest, {
      target: "codex",
      gateway: { transport: "stdio", command: "/opt/homebrew/bin/one-status" },
      sourceFiles: {
        ...sourceFiles,
        "skills/undeclared/secret.txt": "must not be copied",
      },
    });
    expect(JSON.stringify(result)).not.toContain("must not be copied");

    const withoutSkill = compileCapabilityPack(manifest, {
      target: "codex",
      gateway: { transport: "stdio", command: "one-status" },
      sourceFiles: {
        "instructions/manage-issues.md": "Create safely.",
        "instructions/review-pull-request.md": "Review safely.",
      },
    });
    expect(withoutSkill.warnings).toContain(
      "Declared skill file was not supplied: skills/github-workflow/SKILL.md",
    );
    expect(fileContent(withoutSkill, "skills/github-workflow/SKILL.md")).toContain(
      "name: github-workflow",
    );
  });

  it("requires the target adapter declaration", () => {
    const manifest = {
      ...githubWorkflowCapabilityPack,
      adapters: githubWorkflowCapabilityPack.adapters.filter(
        (adapter) => adapter !== "cursor-rules",
      ),
    };
    expect(() =>
      compileCapabilityPack(manifest, {
        target: "cursor",
        gateway: { transport: "stdio", command: "one-status" },
        sourceFiles,
      }),
    ).toThrow("does not declare an adapter for cursor");
  });

  it.each([
    "../secret",
    "/etc/passwd",
    "C:/Windows/System32",
    "skills\\secret",
    "skills//secret",
    "~/secret",
    "folder/CON",
    "folder/trailing. ",
  ])("rejects an unsafe output path: %s", (path) => {
    expect(() => normalizeCapabilityRelativePath(path)).toThrow(/path|Unsafe|Absolute/);
  });

  it("normalizes Unicode paths and rejects case-insensitive source collisions", () => {
    expect(normalizeCapabilityRelativePath("skills/cafe\u0301.md")).toBe(
      "skills/café.md",
    );
    expect(() =>
      compileCapabilityPack(githubWorkflowCapabilityPack, {
        target: "codex",
        gateway: { transport: "stdio", command: "one-status" },
        sourceFiles: {
          "Skills/FILE.md": "first",
          "skills/file.md": "second",
        },
      }),
    ).toThrow("Duplicate normalized capability source path");
  });

  it("rejects source traversal and unsafe Gateway configuration", () => {
    expect(() =>
      compileCapabilityPack(githubWorkflowCapabilityPack, {
        target: "codex",
        gateway: { transport: "stdio", command: "one-status" },
        sourceFiles: { "skills/../secret": "secret" },
      }),
    ).toThrow("Unsafe capability output path");

    expect(() =>
      compileCapabilityPack(githubWorkflowCapabilityPack, {
        target: "codex",
        gateway: { transport: "stdio", command: "sh", args: ["mcp"] },
      }),
    ).toThrow("One Status executable");
    expect(() =>
      compileCapabilityPack(githubWorkflowCapabilityPack, {
        target: "codex",
        gateway: {
          transport: "stdio",
          command: "one-status",
          args: ["mcp", "--transport", "stdio", "--token", "secret"],
        },
      }),
    ).toThrow("stdio MCP transport");
    expect(() =>
      compileCapabilityPack(githubWorkflowCapabilityPack, {
        target: "codex",
        gateway: {
          transport: "http",
          url: "http://gateway.example.test/mcp",
        },
      }),
    ).toThrow("must use HTTPS");
    expect(() =>
      compileCapabilityPack(githubWorkflowCapabilityPack, {
        target: "codex",
        gateway: {
          transport: "http",
          url: "https://user:secret@gateway.example.test/mcp",
        },
      }),
    ).toThrow("cannot contain credentials");
    expect(() =>
      compileCapabilityPack(githubWorkflowCapabilityPack, {
        target: "codex",
        gateway: {
          transport: "http",
          url: "https://gateway.example.test/mcp",
          bearerTokenEnvVar: "actual-token-value",
        },
      }),
    ).toThrow("environment variable");
    expect(() =>
      compileCapabilityPack(githubWorkflowCapabilityPack, {
        target: "codex",
        gateway: {
          transport: "http",
          url: "https://gateway.example.test/mcp",
          token: "secret",
        } as never,
      }),
    ).toThrow("Unknown Gateway configuration field: token");
  });

  it("creates an auditable dry-run with atomic write preconditions", () => {
    const compilation = compileCodex();
    const preview = createCapabilityInstallPreview(compilation);

    expect(preview).toMatchObject({
      dryRun: true,
      installable: true,
      creates: compilation.files.length,
      updates: 0,
      unchanged: 0,
      blocked: 0,
    });
    for (const file of preview.files) {
      expect(file).toMatchObject({
        disposition: "create",
        currentSha256: null,
        requiresApproval: true,
        write: {
          strategy: "atomic-rename",
          expectedPreviousSha256: null,
          createParents: true,
          rejectSymlinks: true,
          fsync: true,
        },
        audit: {
          eventType: "capability.file.install",
          planId: compilation.planId,
        },
      });
      expect(file.write?.stagingRelativePath).toMatch(
        /^\.one-status\/staging\/[0-9a-f]{64}\/[0-9]{4}\.tmp$/,
      );
    }
  });

  it("previews unchanged, updated, and unsafe existing entries", () => {
    const compilation = compileCodex();
    const [unchanged, update, blocked] = compilation.files;
    expect(unchanged && update && blocked).toBeTruthy();
    const preview = createCapabilityInstallPreview(compilation, [
      { relativePath: unchanged!.relativePath, content: unchanged!.content },
      { relativePath: update!.relativePath, content: "old content\n" },
      {
        relativePath: blocked!.relativePath,
        kind: "symlink",
        content: blocked!.content,
      },
    ]);

    expect(preview.unchanged).toBe(1);
    expect(preview.updates).toBe(1);
    expect(preview.blocked).toBe(1);
    expect(preview.installable).toBe(false);
    expect(preview.files.find((file) => file.relativePath === unchanged!.relativePath)).toMatchObject({
      disposition: "unchanged",
      requiresApproval: false,
    });
    expect(preview.files.find((file) => file.relativePath === update!.relativePath)).toMatchObject({
      disposition: "update",
      requiresApproval: true,
      write: { expectedPreviousSha256: expect.stringMatching(/^[0-9a-f]{64}$/) },
    });
    expect(preview.files.find((file) => file.relativePath === blocked!.relativePath)).toMatchObject({
      disposition: "blocked",
      requiresApproval: false,
      blockedReason: expect.stringContaining("symlink"),
    });
  });

  it("blocks a blind overwrite when the current digest is unavailable", () => {
    const compilation = compileCodex();
    const target = compilation.files[0]!;
    const preview = createCapabilityInstallPreview(compilation, [
      { relativePath: target.relativePath, kind: "file" },
    ]);
    expect(preview.files[0]).toMatchObject({
      disposition: "blocked",
      blockedReason: expect.stringContaining("content or SHA-256"),
    });
  });

  it("recognizes an existing file through a case-insensitive path alias", () => {
    const compilation = compileCodex();
    const target = compilation.files.find(
      (file) => file.relativePath === "AGENTS.md",
    )!;
    const preview = createCapabilityInstallPreview(compilation, [
      { relativePath: "agents.md", content: target.content },
    ]);
    expect(
      preview.files.find((file) => file.relativePath === "AGENTS.md"),
    ).toMatchObject({ disposition: "unchanged", requiresApproval: false });
  });

  it("rejects mismatched snapshots and tampered compilations", () => {
    const compilation = compileCodex();
    expect(() =>
      createCapabilityInstallPreview(compilation, [
        {
          relativePath: compilation.files[0]!.relativePath,
          content: "different",
          sha256: "0".repeat(64),
        },
      ]),
    ).toThrow("digest does not match content");

    const tampered = structuredClone(compilation) as CapabilityCompilation;
    tampered.files[0]!.content += "tampered";
    expect(() => createCapabilityInstallPreview(tampered)).toThrow(
      "digest does not match content",
    );
  });

  it("serializes objects with stable key order while preserving arrays", () => {
    expect(stableJson({ z: 1, a: { d: 2, b: 1 }, list: ["z", "a"] })).toBe(
      [
        "{",
        '  "a": {',
        '    "b": 1,',
        '    "d": 2',
        "  },",
        '  "list": [',
        '    "z",',
        '    "a"',
        "  ],",
        '  "z": 1',
        "}",
        "",
      ].join("\n"),
    );
    expect(() => stableJson(undefined)).toThrow("cannot be represented as JSON");
  });
});

function compileCodex(): CapabilityCompilation {
  return compileCapabilityPack(githubWorkflowCapabilityPack, {
    target: "codex",
    gateway: { transport: "stdio", command: "one-status" },
    sourceFiles,
  });
}

function fileContent(
  compilation: CapabilityCompilation,
  relativePath: string,
): string {
  const file = compilation.files.find((entry) => entry.relativePath === relativePath);
  if (!file) throw new Error(`Missing compiled file: ${relativePath}`);
  return file.content;
}

function readJsonFile(
  compilation: CapabilityCompilation,
  relativePath: string,
): Record<string, unknown> {
  return JSON.parse(fileContent(compilation, relativePath)) as Record<string, unknown>;
}
