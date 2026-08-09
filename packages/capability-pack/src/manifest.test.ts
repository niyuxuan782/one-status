import { describe, expect, it } from "vitest";
import { githubWorkflowCapabilityPack } from "./fixtures/github-workflow.js";
import {
  canonicalCapabilityPackJson,
  computeCapabilityPackDigest,
  parseCapabilityPackDocument,
} from "./document.js";
import {
  capabilityPackManifestSchema,
  parseCapabilityPackManifest,
} from "./manifest.js";

describe("Capability Pack manifest", () => {
  it("parses the GitHub workflow fixture as a platform-independent pack", () => {
    expect(parseCapabilityPackManifest(githubWorkflowCapabilityPack)).toMatchObject({
      format: "one-status.capability-pack",
      schemaVersion: 1,
      name: "github-workflow",
      version: "1.0.0",
      authorization: { provider: "github" },
    });
    expect(githubWorkflowCapabilityPack.adapters).toContain("remote-mcp");
    expect(githubWorkflowCapabilityPack.tools).toHaveLength(6);
  });

  it("normalizes concise string tools and instructions", () => {
    const manifest = capabilityPackManifestSchema.parse({
      ...githubWorkflowCapabilityPack,
      tools: ["github.contents.get", "github.issues.create"],
      instructions: ["review-pull-request"],
      ui: { settings: [], actions: [] },
      hooks: [],
    });

    expect(manifest.tools).toEqual([
      { id: "github.contents.get", requiredScopes: [] },
      { id: "github.issues.create", requiredScopes: [] },
    ]);
    expect(manifest.instructions).toEqual([
      {
        id: "review-pull-request",
        source: "instructions/review-pull-request.md",
        tools: [],
        memoryScopes: [],
      },
    ]);
  });

  it("parses strict YAML and JSON documents", () => {
    const concise = {
      ...githubWorkflowCapabilityPack,
      tools: ["github.contents.get"],
      instructions: ["review-pull-request"],
      ui: { settings: [], actions: [] },
      hooks: [],
    };
    const json = JSON.stringify(concise);
    const yaml = `
format: one-status.capability-pack
schemaVersion: 1
name: sample-pack
version: 1.0.0
displayName: Sample Pack
description: A concise YAML capability pack.
instructions:
  - sample-instruction
tools:
  - sample.read
memory:
  scopes: []
adapters:
  - remote-mcp
`;

    expect(parseCapabilityPackDocument(json).tools[0]).toMatchObject({
      id: "github.contents.get",
    });
    expect(parseCapabilityPackDocument(yaml).tools[0]).toEqual({
      id: "sample.read",
      requiredScopes: [],
    });
  });

  it("creates a stable digest across object key order and input syntax", () => {
    const source = canonicalCapabilityPackJson(githubWorkflowCapabilityPack);
    const reordered = Object.fromEntries(
      Object.entries(JSON.parse(source) as Record<string, unknown>).reverse(),
    );

    expect(computeCapabilityPackDigest(reordered)).toBe(
      computeCapabilityPackDigest(githubWorkflowCapabilityPack),
    );
    expect(computeCapabilityPackDigest(reordered)).toMatch(
      /^sha256:[0-9a-f]{64}$/,
    );
    expect(computeCapabilityPackDigest({ ...reordered, version: "1.0.1" })).not
      .toBe(computeCapabilityPackDigest(githubWorkflowCapabilityPack));
  });

  it("rejects duplicate YAML keys", () => {
    expect(() =>
      parseCapabilityPackDocument(
        "format: one-status.capability-pack\nformat: duplicate\n",
        "yaml",
      ),
    ).toThrow(/YAML is invalid/);
  });

  it("limits untrusted manifest document size", () => {
    expect(() =>
      parseCapabilityPackDocument(`description: ${"x".repeat(1024 * 1024)}`),
    ).toThrow(/1 MB limit/);
  });

  it.each([
    ["uppercase pack name", { name: "GitHub-Workflow" }, /capability pack ID/],
    ["leading zero version", { version: "01.0.0" }, /SemVer/],
    ["unknown field", { experimental: true }, /Unrecognized key/],
  ])("rejects %s", (_label, replacement, message) => {
    expect(() =>
      capabilityPackManifestSchema.parse({
        ...githubWorkflowCapabilityPack,
        ...replacement,
      }),
    ).toThrow(message);
  });

  it("rejects duplicate component IDs and adapter targets", () => {
    const duplicateTool = githubWorkflowCapabilityPack.tools[0]!;
    expect(() =>
      capabilityPackManifestSchema.parse({
        ...githubWorkflowCapabilityPack,
        tools: [...githubWorkflowCapabilityPack.tools, duplicateTool],
        adapters: [...githubWorkflowCapabilityPack.adapters, "remote-mcp"],
      }),
    ).toThrow(/duplicate/);
  });

  it("requires instruction, UI, event, and hook references to resolve", () => {
    expect(() =>
      capabilityPackManifestSchema.parse({
        ...githubWorkflowCapabilityPack,
        instructions: [
          {
            ...githubWorkflowCapabilityPack.instructions[0],
            tools: ["missing.tool"],
            memoryScopes: ["missing.memory"],
          },
        ],
        ui: {
          ...githubWorkflowCapabilityPack.ui,
          actions: [
            { id: "missing-action", label: "Missing", tool: "missing.tool" },
          ],
        },
        hooks: [
          {
            id: "missing-hook",
            event: "missing.event",
            mode: "automatic",
            handler: { type: "instruction", instruction: "missing-instruction" },
          },
        ],
      }),
    ).toThrow(/unknown tool|undeclared memory scope|unknown event|unknown instruction/);
  });

  it("keeps OAuth scopes inside the declared provider grant", () => {
    expect(() =>
      capabilityPackManifestSchema.parse({
        ...githubWorkflowCapabilityPack,
        tools: [
          {
            ...githubWorkflowCapabilityPack.tools[0],
            requiredScopes: ["admin.write"],
          },
        ],
      }),
    ).toThrow(/not declared by authorization\.requiredScopes/);
  });

  it("allows explicit One Status MCP writes without Gateway approval", () => {
    expect(() =>
      capabilityPackManifestSchema.parse({
        ...githubWorkflowCapabilityPack,
        authorization: undefined,
        tools: [
          {
            id: "persona.record",
            readOnly: false,
            requiresConfirmation: false,
            requiredScopes: [],
            metadata: { execution: "one-status-mcp" },
          },
        ],
        instructions: [],
        memory: { scopes: ["user.persona"] },
        ui: { settings: [], actions: [] },
      }),
    ).not.toThrow();
    expect(() =>
      capabilityPackManifestSchema.parse({
        ...githubWorkflowCapabilityPack,
        tools: [
          {
            id: "github.issues.create",
            readOnly: false,
            requiresConfirmation: false,
            requiredScopes: [],
            metadata: { execution: "one-status-mcp" },
          },
        ],
        instructions: [],
        authorization: undefined,
        ui: { settings: [], actions: [] },
      }),
    ).toThrow(/direct One Status MCP execution is not available/);
  });

  it("accepts native Google and Slack OAuth scope formats", () => {
    expect(() =>
      capabilityPackManifestSchema.parse({
        ...githubWorkflowCapabilityPack,
        authorization: {
          provider: "google",
          requiredScopes: [
            "https://www.googleapis.com/auth/gmail.readonly",
            "channels:history",
          ],
        },
        tools: githubWorkflowCapabilityPack.tools.map((tool, index) => ({
          ...tool,
          requiredScopes:
            index === 0
              ? ["https://www.googleapis.com/auth/gmail.readonly"]
              : ["channels:history"],
        })),
      }),
    ).not.toThrow();
  });

  it("requires confirmation for every write tool", () => {
    const writeTool = githubWorkflowCapabilityPack.tools.find(
      (tool) => tool.id === "github.issues.create",
    )!;
    expect(() =>
      capabilityPackManifestSchema.parse({
        ...githubWorkflowCapabilityPack,
        tools: [{ ...writeTool, requiresConfirmation: false }],
      }),
    ).toThrow(/write tools must require confirmation/);
  });

  it("prevents an automatic hook from bypassing tool confirmation", () => {
    expect(() =>
      capabilityPackManifestSchema.parse({
        ...githubWorkflowCapabilityPack,
        hooks: [
          {
            id: "auto-create-issue",
            event: "pull_request.opened",
            mode: "automatic",
            handler: { type: "tool", tool: "github.issues.create" },
          },
        ],
      }),
    ).toThrow(/automatic hook cannot invoke confirmation-gated tool/);
  });

  it.each(["../secrets", "/etc/passwd", "skills\\secret", "skills//file"])(
    "rejects unsafe pack path %s",
    (source) => {
      expect(() =>
        capabilityPackManifestSchema.parse({
          ...githubWorkflowCapabilityPack,
          skills: { source, files: [] },
        }),
      ).toThrow(/normalized relative POSIX path/);
    },
  );

  it("rejects self-dependencies and invalid dependency ranges", () => {
    expect(() =>
      capabilityPackManifestSchema.parse({
        ...githubWorkflowCapabilityPack,
        dependencies: {
          packs: [
            { name: "github-workflow", version: "latest", optional: false },
          ],
          runtimes: [],
        },
      }),
    ).toThrow(/version|depend on itself/);
  });

  it("requires object-shaped tool inputs", () => {
    expect(() =>
      capabilityPackManifestSchema.parse({
        ...githubWorkflowCapabilityPack,
        tools: [
          {
            ...githubWorkflowCapabilityPack.tools[0],
            inputSchema: { type: "string" },
          },
        ],
      }),
    ).toThrow(/inputSchema must describe an object/);
  });

  it("validates typed UI defaults and secret settings", () => {
    expect(() =>
      capabilityPackManifestSchema.parse({
        ...githubWorkflowCapabilityPack,
        ui: {
          settings: [
            {
              id: "delivery-mode",
              label: "Delivery mode",
              type: "select",
              required: true,
              secret: false,
              options: ["draft", "publish"],
              default: "invalid",
            },
          ],
          actions: [],
        },
      }),
    ).toThrow(/select default must be one of the declared options/);

    expect(() =>
      capabilityPackManifestSchema.parse({
        ...githubWorkflowCapabilityPack,
        ui: {
          settings: [
            {
              id: "secret-count",
              label: "Secret count",
              type: "number",
              required: false,
              secret: true,
            },
          ],
          actions: [],
        },
      }),
    ).toThrow(/secret settings must use the string type/);
  });
});
