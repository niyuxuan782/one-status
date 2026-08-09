import type { McpRuntimeConfig, McpRuntimeConfigLoader } from "./config.js";

export interface RuntimeToolGateway {
  execute(input: {
    action: string;
    arguments?: Record<string, unknown>;
    confirmed?: boolean;
    connectionId: string;
  }): Promise<unknown>;
  list(): Promise<{ connections: unknown[] }>;
}

export function createRuntimeToolGateway(
  config: McpRuntimeConfig,
): RuntimeToolGateway {
  return {
    list: () =>
      request(
        config,
        `/v1/tools?agentId=${encodeURIComponent(config.agentId)}`,
      ) as Promise<{ connections: unknown[] }>,
    async execute(input) {
      const response = (await request(config, "/v1/tools/execute", {
        method: "POST",
        body: JSON.stringify({ ...input, agentId: config.agentId }),
      })) as { result?: unknown };
      return response.result;
    },
  };
}

export function createReloadingRuntimeToolGateway(
  loadConfig: McpRuntimeConfigLoader,
): RuntimeToolGateway {
  return {
    async list() {
      return createRuntimeToolGateway(await loadConfig()).list();
    },
    async execute(input) {
      return createRuntimeToolGateway(await loadConfig()).execute(input);
    },
  };
}

async function request(
  config: McpRuntimeConfig,
  path: string,
  init: RequestInit = {},
): Promise<unknown> {
  const headers = new Headers(init.headers);
  headers.set("accept", "application/json");
  headers.set("authorization", `Bearer ${config.token}`);
  if (init.body !== undefined) headers.set("content-type", "application/json");
  const response = await fetch(`${config.toolGatewayUrl}${path}`, {
    ...init,
    headers,
    signal: AbortSignal.timeout(config.requestTimeoutMs),
  });
  const body = (await response.json().catch(() => null)) as unknown;
  if (!response.ok) {
    const message =
      body && typeof body === "object" && "error" in body
        ? readErrorMessage(body.error)
        : undefined;
    throw new Error(message ?? `Tool Gateway returned HTTP ${response.status}.`);
  }
  return body;
}

function readErrorMessage(value: unknown): string | undefined {
  if (typeof value === "string") return value;
  if (value && typeof value === "object" && "message" in value) {
    return typeof value.message === "string" ? value.message : undefined;
  }
  return undefined;
}
