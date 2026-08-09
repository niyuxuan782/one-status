import { capabilityPackManifestSchema } from "../manifest.js";

const directMcpMetadata = { execution: "one-status-mcp" } as const;

export const personaCapabilityPack = capabilityPackManifestSchema.parse({
  format: "one-status.capability-pack",
  schemaVersion: 1,
  name: "persona",
  version: "1.0.0",
  displayName: "Persona",
  description:
    "Use when the user states durable personality or behavior preferences, language or output style, project or technical habits, long-term goals, future plans, or explicitly asks you to remember personal information.",
  instructions: [],
  tools: [
    directWriteTool(
      "persona.record",
      "Record one concise structured Persona observation without uploading raw conversation text.",
      {
        type: "object",
        additionalProperties: false,
        properties: {
          category: { type: "string" },
          content: { type: "string" },
          observedAt: { type: "string", format: "date-time" },
          sourceProject: { type: "string" },
          confidence: {
            type: "string",
            enum: ["explicit", "observed", "inferred"],
          },
        },
        required: ["category", "content", "confidence"],
      },
    ),
    directReadTool(
      "persona.list",
      "List Persona events with observation provenance and timestamps.",
    ),
    directReadTool(
      "persona.profile",
      "Read the current effective Persona profile.",
    ),
    directWriteTool(
      "persona.update",
      "Edit one Persona event while retaining its provenance.",
    ),
    directWriteTool(
      "persona.delete",
      "Delete one Persona event after an explicit user request.",
    ),
    directReadTool(
      "persona.get_policy",
      "Read the user's Persona recording policy.",
    ),
    directWriteTool(
      "persona.set_policy",
      "Update the user's Persona recording policy after an explicit request.",
    ),
  ],
  memory: { scopes: ["user.persona"] },
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
  ui: { settings: [], actions: [] },
});

function directReadTool(id: string, description: string) {
  return {
    id,
    description,
    readOnly: true,
    requiresConfirmation: false,
    requiredScopes: [],
    metadata: directMcpMetadata,
  };
}

function directWriteTool(
  id: string,
  description: string,
  inputSchema?: Record<string, unknown>,
) {
  return {
    id,
    description,
    ...(inputSchema ? { inputSchema } : {}),
    readOnly: false,
    requiresConfirmation: false,
    requiredScopes: [],
    metadata: directMcpMetadata,
  };
}
