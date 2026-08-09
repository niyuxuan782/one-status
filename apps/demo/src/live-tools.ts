import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const agents = ["codex", "claude-code"] as const;
const action = process.argv[2] ?? "slack.channels.list";

for (const agentId of agents) {
  const transport = new StdioClientTransport({
    command: "one-status",
    args: ["mcp", "--transport", "stdio"],
    env: {
      ...process.env,
      ONE_STATUS_AGENT_ID: agentId,
    },
    stderr: "pipe",
  });
  const client = new Client({
    name: `one-status-${agentId}-live-smoke`,
    version: "1.0.0",
  });

  try {
    await client.connect(transport);
    const available = await client.callTool({
      name: "tools_list",
      arguments: {},
    });
    const connections = readConnections(available.structuredContent);
    const selected = connections.find((entry) =>
      entry.actions.some((candidate) => candidate.id === action),
    );
    if (available.isError || !selected) {
      throw new Error(`${agentId} cannot access ${action}`);
    }

    const executed = await client.callTool({
      name: "tools_execute",
      arguments: {
        connectionId: selected.connection.id,
        action,
        arguments: {},
      },
    });
    if (executed.isError) {
      throw new Error(`${agentId} failed to execute ${action}`);
    }
    process.stdout.write(
      `${JSON.stringify({ agentId, action, result: executed.structuredContent })}\n`,
    );
  } finally {
    await client.close();
  }
}

function readConnections(value: unknown): Array<{
  actions: Array<{ id: string }>;
  connection: { id: string };
}> {
  if (!value || typeof value !== "object" || !("connections" in value)) {
    return [];
  }
  const connections = value.connections;
  if (!Array.isArray(connections)) return [];
  return connections.filter(
    (entry): entry is {
      actions: Array<{ id: string }>;
      connection: { id: string };
    } =>
      Boolean(entry) &&
      typeof entry === "object" &&
      "actions" in entry &&
      Array.isArray(entry.actions) &&
      "connection" in entry &&
      Boolean(entry.connection) &&
      typeof entry.connection === "object" &&
      "id" in entry.connection &&
      typeof entry.connection.id === "string",
  );
}
