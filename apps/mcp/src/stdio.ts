import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import type { McpRuntimeConfig } from "./config.js";
import { loadMcpRuntimeConfig } from "./config.js";
import { createMcpServer } from "./server.js";
import {
  createReloadingRuntimeToolGateway,
  createRuntimeToolGateway,
} from "./tool-gateway.js";
import {
  createReloadingRuntimeVault,
  createRuntimeVault,
} from "./vault.js";

export async function startStdioMcp(
  config?: McpRuntimeConfig,
): Promise<void> {
  const loadConfig = config
    ? async () => config
    : async () => loadMcpRuntimeConfig();
  const resolvedConfig = await loadConfig();
  const vault = config
    ? await createRuntimeVault(resolvedConfig)
    : createReloadingRuntimeVault(loadConfig);
  if (!config) await vault.read();
  const server = createMcpServer(
    vault,
    resolvedConfig.agentId,
    config
      ? createRuntimeToolGateway(resolvedConfig)
      : createReloadingRuntimeToolGateway(loadConfig),
  );
  await server.connect(new StdioServerTransport());
  console.error("One Status MCP connected over stdio.");
}
