import type { McpRuntimeConfig, McpRuntimeConfigLoader } from "./config.js";

export interface RuntimeToolGateway {
  execute(input: {
    action: string;
    approvalId?: string;
    arguments?: Record<string, unknown>;
    connectionId: string;
  }): Promise<unknown>;
  list(): Promise<{ connections: unknown[] }>;
  requestApproval(input: {
    action: string;
    arguments?: Record<string, unknown>;
    connectionId: string;
  }): Promise<unknown>;
}

export function createRuntimeToolGateway(
  config: McpRuntimeConfig,
): RuntimeToolGateway {
  return createGateway(async () => config);
}

export function createReloadingRuntimeToolGateway(
  loadConfig: McpRuntimeConfigLoader,
): RuntimeToolGateway {
  return createGateway(loadConfig);
}

function createGateway(
  loadConfig: McpRuntimeConfigLoader,
): RuntimeToolGateway {
  let cachedCredential:
    | { key: string; token: string }
    | undefined;
  let pendingCredential:
    | { key: string; promise: Promise<string> }
    | undefined;

  const resolveCredential = async (
    config: McpRuntimeConfig,
  ): Promise<{ renewable: boolean; token: string }> => {
    if (config.agentToken) {
      return { renewable: false, token: config.agentToken };
    }
    const key = credentialCacheKey(config);
    if (cachedCredential?.key === key) {
      return { renewable: true, token: cachedCredential.token };
    }
    if (pendingCredential?.key !== key) {
      const promise = issueAgentCredential(config).then((token) => {
        cachedCredential = { key, token };
        return token;
      });
      pendingCredential = { key, promise };
    }
    const pending = pendingCredential;
    try {
      return {
        renewable: true,
        token: await pending.promise,
      };
    } finally {
      if (pendingCredential === pending) pendingCredential = undefined;
    }
  };

  const toolRequest = async (
    path: string,
    init: RequestInit = {},
  ): Promise<unknown> => {
    const config = await loadConfig();
    const credential = await resolveCredential(config);
    try {
      return await request(config, path, init, credential.token);
    } catch (error) {
      if (
        !credential.renewable ||
        !(error instanceof ToolGatewayRequestError) ||
        error.status !== 401
      ) {
        throw error;
      }
      if (cachedCredential?.token === credential.token) {
        cachedCredential = undefined;
      }
      const refreshed = await resolveCredential(config);
      return request(config, path, init, refreshed.token);
    }
  };

  return {
    async list() {
      return toolRequest("/v1/tools") as Promise<{ connections: unknown[] }>;
    },
    async execute(input) {
      const response = (await toolRequest("/v1/tools/execute", {
        method: "POST",
        body: JSON.stringify(input),
      })) as { result?: unknown };
      return response.result;
    },
    async requestApproval(input) {
      return toolRequest("/v1/tools/approval-requests", {
        method: "POST",
        body: JSON.stringify(input),
      });
    },
  };
}

async function issueAgentCredential(config: McpRuntimeConfig): Promise<string> {
  if (!isLoopbackToolGateway(config.toolGatewayUrl)) {
    throw new Error(
      "Automatic Agent credential exchange requires a loopback Tool Gateway. " +
        "Set ONE_STATUS_AGENT_TOKEN for a remote Gateway.",
    );
  }
  let response: unknown;
  try {
    response = await request(
      config,
      "/v1/tools/credentials",
      {
        method: "POST",
        body: JSON.stringify({ agentId: config.agentId }),
      },
      config.token,
    );
  } catch (error) {
    if (error instanceof ToolGatewayRequestError && error.status === 404) {
      throw new Error(
        "The local Tool Gateway cannot issue Agent credentials. Upgrade and restart One Status.",
      );
    }
    throw error;
  }
  const credential =
    response && typeof response === "object" && "credential" in response
      ? response.credential
      : undefined;
  if (
    !credential ||
    typeof credential !== "object" ||
    !("token" in credential) ||
    typeof credential.token !== "string" ||
    !credential.token.startsWith("osa1_") ||
    !("agentId" in credential) ||
    credential.agentId !== config.agentId
  ) {
    throw new Error("The Tool Gateway returned an invalid Agent credential.");
  }
  return credential.token;
}

function credentialCacheKey(config: McpRuntimeConfig): string {
  return `${config.toolGatewayUrl}\u0000${config.agentId}\u0000${config.token}`;
}

function isLoopbackToolGateway(value: string): boolean {
  const hostname = new URL(value).hostname.toLowerCase();
  return (
    hostname === "127.0.0.1" ||
    hostname === "[::1]" ||
    hostname === "localhost" ||
    hostname.endsWith(".localhost")
  );
}

async function request(
  config: McpRuntimeConfig,
  path: string,
  init: RequestInit = {},
  authorizationToken: string,
): Promise<unknown> {
  const headers = new Headers(init.headers);
  headers.set("accept", "application/json");
  headers.set("authorization", `Bearer ${authorizationToken}`);
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
    throw new ToolGatewayRequestError(
      response.status,
      message ?? `Tool Gateway returned HTTP ${response.status}.`,
    );
  }
  return body;
}

class ToolGatewayRequestError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

function readErrorMessage(value: unknown): string | undefined {
  if (typeof value === "string") return value;
  if (value && typeof value === "object" && "message" in value) {
    return typeof value.message === "string" ? value.message : undefined;
  }
  return undefined;
}
