import {
  loadLocalProfile,
  readSecretEnvironment,
  type LocalProfile,
} from "@one-status/local-config";

export interface McpRuntimeConfig {
  baseUrl: string;
  token: string;
  exportedKey: string;
  agentId: string;
  requestTimeoutMs: number;
  toolGatewayUrl: string;
}

export type McpRuntimeConfigLoader = () => Promise<McpRuntimeConfig>;

export async function loadMcpRuntimeConfig(
  environment: NodeJS.ProcessEnv = process.env,
  loadProfile: () => Promise<LocalProfile> = loadLocalProfile,
): Promise<McpRuntimeConfig> {
  const token = await readSecretEnvironment("ONE_STATUS_TOKEN", environment);
  const exportedKey = await readSecretEnvironment(
    "ONE_STATUS_STATUS_KEY",
    environment,
  );
  const credentialValues = [
    environment.ONE_STATUS_URL,
    token,
    exportedKey,
  ];
  const suppliedCredentials = credentialValues.filter(Boolean).length;
  if (suppliedCredentials > 0 && suppliedCredentials < credentialValues.length) {
    throw new Error(
      "ONE_STATUS_URL, ONE_STATUS_TOKEN, and ONE_STATUS_STATUS_KEY must be supplied together.",
    );
  }

  const profile = suppliedCredentials === 0 ? await loadProfile() : null;
  const timeoutValue = environment.ONE_STATUS_TIMEOUT_MS ?? "10000";
  const requestTimeoutMs = Number.parseInt(timeoutValue, 10);
  if (!/^\d+$/.test(timeoutValue) || requestTimeoutMs <= 0) {
    throw new Error("ONE_STATUS_TIMEOUT_MS must be a positive integer.");
  }

  const baseUrl = environment.ONE_STATUS_URL ?? profile!.baseUrl;
  return {
    baseUrl,
    token: token ?? profile!.token,
    exportedKey: exportedKey ?? profile!.statusKey,
    agentId: environment.ONE_STATUS_AGENT_ID ?? "connected-agent",
    requestTimeoutMs,
    toolGatewayUrl: normalizeToolGatewayUrl(
      environment.ONE_STATUS_TOOL_GATEWAY_URL ??
        defaultToolGatewayUrl(baseUrl),
    ),
  };
}

function defaultToolGatewayUrl(statusUrl: string): string {
  const url = new URL(statusUrl);
  return isLoopbackHostname(url.hostname)
    ? statusUrl
    : "http://127.0.0.1:8787";
}

function normalizeToolGatewayUrl(value: string): string {
  const url = new URL(value);
  if (
    url.protocol !== "https:" &&
    !(url.protocol === "http:" && isLoopbackHostname(url.hostname))
  ) {
    throw new Error(
      "ONE_STATUS_TOOL_GATEWAY_URL requires HTTPS outside loopback.",
    );
  }
  if (url.username || url.password || url.search || url.hash) {
    throw new Error("ONE_STATUS_TOOL_GATEWAY_URL must be a plain base URL.");
  }
  return url.toString().replace(/\/$/, "");
}

function isLoopbackHostname(hostname: string): boolean {
  const normalized = hostname.toLowerCase();
  return (
    ["127.0.0.1", "[::1]", "localhost"].includes(normalized) ||
    normalized.endsWith(".localhost")
  );
}
