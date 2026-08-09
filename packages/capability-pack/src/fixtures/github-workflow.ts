import { capabilityPackManifestSchema } from "../manifest.js";

export const githubWorkflowCapabilityPack = capabilityPackManifestSchema.parse({
  format: "one-status.capability-pack",
  schemaVersion: 1,
  name: "github-workflow",
  version: "1.0.0",
  displayName: "GitHub Workflow",
  description:
    "Read repositories, pull requests, and issues through One Status, with confirmed issue creation.",
  instructions: [
    {
      id: "review-pull-request",
      description: "Review repository and pull request state against project context.",
      source: "instructions/review-pull-request.md",
      tools: ["github.contents.get", "github.pull_requests.list"],
      memoryScopes: ["user.preferences", "project.context"],
    },
    {
      id: "manage-issues",
      description: "Read issues and create one after explicit user confirmation.",
      source: "instructions/manage-issues.md",
      tools: ["github.issues.list", "github.issues.create"],
      memoryScopes: ["project.context"],
    },
  ],
  tools: [
    {
      id: "github.viewer.get",
      description: "Read the connected GitHub account profile.",
      readOnly: true,
      requiresConfirmation: false,
      requiredScopes: ["read:user"],
    },
    {
      id: "github.repositories.list",
      description: "List repositories visible to the connected account.",
      readOnly: true,
      requiresConfirmation: false,
      requiredScopes: [],
    },
    {
      id: "github.issues.list",
      description: "List issues for a repository.",
      readOnly: true,
      requiresConfirmation: false,
      requiredScopes: [],
    },
    {
      id: "github.issues.create",
      description: "Create an issue after explicit user confirmation.",
      readOnly: false,
      requiresConfirmation: true,
      requiredScopes: ["repo"],
    },
    {
      id: "github.pull_requests.list",
      description: "List pull requests for a repository.",
      readOnly: true,
      requiresConfirmation: false,
      requiredScopes: [],
    },
    {
      id: "github.contents.get",
      description: "Read a repository file or directory.",
      readOnly: true,
      requiresConfirmation: false,
      requiredScopes: [],
    },
  ],
  skills: {
    source: "skills/",
    files: ["github-workflow/SKILL.md"],
  },
  memory: { scopes: ["user.preferences", "project.context"] },
  authorization: {
    provider: "github",
    requiredScopes: ["read:user", "repo"],
  },
  adapters: [
    "chatgpt-plugin",
    "remote-mcp",
    "local-mcp",
    "claude-skill",
    "codex-plugin",
    "cursor-rules",
    "one-status-sdk",
    "markdown",
  ],
  ui: {
    settings: [],
    actions: [
      {
        id: "create-issue",
        label: "Create issue",
        tool: "github.issues.create",
      },
    ],
  },
});
