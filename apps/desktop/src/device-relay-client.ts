import {
  OneStatusClient,
  type DecryptedStatusSnapshot,
} from "@one-status/client";
import { importStatusKey } from "@one-status/crypto";
import {
  loadLocalProfile,
  type LocalProfile,
} from "@one-status/local-config";
import { WebSocket } from "ws";

const RELAY_CAPABILITIES = [
  "credentials.create",
  "credentials.delete",
  "credentials.get",
  "credentials.list",
  "credentials.resolve",
  "credentials.update",
  "status.read",
  "tools.list",
  "tools.request_approval",
  "tools.execute",
] as const;
const MAX_CONCURRENT_REQUESTS = 8;

export interface DeviceRelayClientOptions {
  createSocket?: (url: string, token: string) => WebSocket;
  execute?: (
    operation: string,
    agentId: string,
    payload: Record<string, unknown>,
  ) => Promise<unknown>;
  loadProfile?: () => Promise<LocalProfile>;
  localBaseUrl: string;
  reconnectDelayMs?: number;
  relayUrl?: string;
}

export interface RunningDeviceRelayClient {
  close(): void;
}

export function startDeviceRelayClient(
  options: DeviceRelayClientOptions,
): RunningDeviceRelayClient {
  const loadProfile = options.loadProfile ?? loadLocalProfile;
  const createSocket = options.createSocket ?? defaultSocket;
  const reconnectDelayMs = options.reconnectDelayMs ?? 5_000;
  let closed = false;
  let socket: WebSocket | undefined;
  let reconnectTimer: NodeJS.Timeout | undefined;
  let activeRequests = 0;

  const scheduleReconnect = () => {
    if (closed || reconnectTimer) return;
    reconnectTimer = setTimeout(() => {
      reconnectTimer = undefined;
      void connect();
    }, reconnectDelayMs);
    reconnectTimer.unref();
  };

  const connect = async () => {
    if (closed || socket) return;
    let profile: LocalProfile;
    let relayUrl: string;
    try {
      profile = await loadProfile();
      relayUrl = resolveRelayUrl(options.relayUrl, profile.baseUrl);
    } catch {
      scheduleReconnect();
      return;
    }
    let candidate: WebSocket;
    try {
      candidate = createSocket(relayUrl, profile.token);
    } catch {
      scheduleReconnect();
      return;
    }
    socket = candidate;
    candidate.once("open", () => {
      candidate.send(
        JSON.stringify({
          type: "hello",
          capabilities: RELAY_CAPABILITIES,
        }),
      );
    });
    candidate.on("message", (data, isBinary) => {
      if (isBinary || closed) return;
      let message: unknown;
      try {
        message = JSON.parse(data.toString());
      } catch {
        candidate.close(1007, "Invalid JSON");
        return;
      }
      if (!isRelayRequest(message)) return;
      if (activeRequests >= MAX_CONCURRENT_REQUESTS) {
        sendError(candidate, message.requestId, "device_busy");
        return;
      }
      activeRequests += 1;
      const operation = () =>
        options.execute
          ? options.execute(message.operation, message.agentId, message.payload)
          : executeDesktopRelayOperation(
              options.localBaseUrl,
              message.operation,
              message.agentId,
              message.payload,
              loadProfile,
            );
      void Promise.resolve()
        .then(operation)
        .then((result) => {
          if (candidate.readyState !== WebSocket.OPEN) return;
          candidate.send(
            JSON.stringify({
              type: "response",
              requestId: message.requestId,
              ok: true,
              result,
            }),
          );
        })
        .catch((error: unknown) =>
          sendError(candidate, message.requestId, desktopRelayErrorCode(error)),
        )
        .finally(() => {
          activeRequests -= 1;
        });
    });
    candidate.once("close", () => {
      if (socket === candidate) socket = undefined;
      scheduleReconnect();
    });
    candidate.once("error", () => {
      candidate.close();
    });
  };

  void connect();
  return {
    close() {
      closed = true;
      if (reconnectTimer) clearTimeout(reconnectTimer);
      reconnectTimer = undefined;
      socket?.close(1000, "Desktop service shutting down");
      socket = undefined;
    },
  };
}

export async function executeDesktopRelayOperation(
  localBaseUrl: string,
  operation: string,
  agentId: string,
  payload: Record<string, unknown>,
  loadProfile: () => Promise<LocalProfile> = loadLocalProfile,
): Promise<unknown> {
  const profile = await loadProfile();
  if (operation === "status.read") {
    const client = new OneStatusClient({
      baseUrl: profile.baseUrl,
      token: profile.token,
    });
    const snapshot = await client
      .createVault(importStatusKey(profile.statusKey))
      .read();
    return projectStatusView(snapshot, payload);
  }
  if (operation.startsWith("credentials.")) {
    const agentToken = await issueLocalAgentToken(
      localBaseUrl,
      profile.token,
      agentId,
    );
    const request = credentialRelayRequest(operation, payload);
    return localGatewayRequest(
      localBaseUrl,
      request.path,
      agentToken,
      request.init,
    );
  }
  if (
    operation !== "tools.list" &&
    operation !== "tools.request_approval" &&
    operation !== "tools.execute"
  ) {
    throw new Error("Unsupported Desktop Relay operation.");
  }
  const agentToken = await issueLocalAgentToken(
    localBaseUrl,
    profile.token,
    agentId,
  );
  return localGatewayRequest(
    localBaseUrl,
    operation === "tools.list"
      ? "/v1/tools"
      : operation === "tools.request_approval"
        ? "/v1/tools/approval-requests"
        : "/v1/tools/execute",
    agentToken,
    operation === "tools.list"
      ? { method: "GET" }
      : { method: "POST", body: JSON.stringify(payload) },
  );
}

function projectStatusView(
  snapshot: DecryptedStatusSnapshot,
  payload: Record<string, unknown>,
): Record<string, unknown> {
  if (payload.view === "profile") {
    const blocked = new Set(snapshot.status.persona.policy.blockedCategories);
    return {
      version: snapshot.version,
      identity: snapshot.status.identity,
      preferences: Object.fromEntries(
        Object.entries(snapshot.status.preferences).filter(
          ([key]) => !key.startsWith("__one_status_internal:"),
        ),
      ),
      personaProfile: Object.fromEntries(
        Object.entries(snapshot.status.persona.profile).filter(
          ([category]) => !blocked.has(category),
        ),
      ),
    };
  }
  if (payload.view === "context") {
    const projectId = snapshot.status.workspace.activeProjectId;
    return {
      version: snapshot.version,
      workspace: snapshot.status.workspace,
      project: projectId ? snapshot.status.projects[projectId] ?? null : null,
      openTasks: Object.values(snapshot.status.tasks).filter(
        (task) => task.status !== "done",
      ),
      sessionMemory: snapshot.status.memory.filter(
        (entry) => entry.state === "confirmed" && entry.scope === "session",
      ),
    };
  }
  if (payload.view === "memory") {
    const scope = readMemoryScope(payload.scope);
    const projectId = optionalMetadata(payload.projectId, "Project ID");
    const limit = readMemoryLimit(payload.limit);
    return {
      version: snapshot.version,
      memory: snapshot.status.memory
        .filter(
          (entry) =>
            entry.state === "confirmed" &&
            (!scope || entry.scope === scope) &&
            (!projectId || entry.projectId === projectId),
        )
        .slice(0, limit),
    };
  }
  throw new Error("Remote status request has an invalid view.");
}

function readMemoryScope(
  value: unknown,
): "user" | "project" | "session" | undefined {
  if (value === undefined) return undefined;
  if (value === "user" || value === "project" || value === "session") {
    return value;
  }
  throw new Error("Remote memory request has an invalid scope.");
}

function readMemoryLimit(value: unknown): number {
  if (!Number.isInteger(value) || (value as number) < 1 || (value as number) > 200) {
    throw new Error("Remote memory request has an invalid limit.");
  }
  return value as number;
}

function optionalMetadata(value: unknown, label: string): string | undefined {
  if (value === undefined) return undefined;
  if (
    typeof value !== "string" ||
    !value.trim() ||
    value.length > 500 ||
    /[\u0000-\u001f\u007f]/u.test(value)
  ) {
    throw new Error(`${label} is invalid.`);
  }
  return value.trim();
}

function credentialRelayRequest(
  operation: string,
  payload: Record<string, unknown>,
): { init: RequestInit; path: string } {
  if (operation === "credentials.create") {
    return jsonRequest("/v1/tools/private-credentials", "POST", payload);
  }
  if (operation === "credentials.list") {
    return jsonRequest("/v1/tools/private-credentials/list", "POST", payload);
  }
  if (operation === "credentials.resolve") {
    return jsonRequest("/v1/tools/private-credentials/resolve", "POST", payload);
  }
  const credentialId = readCredentialId(payload.credentialId);
  const body = { ...payload };
  delete body.credentialId;
  if (operation === "credentials.get") {
    return jsonRequest(
      `/v1/tools/private-credentials/${credentialId}/read`,
      "POST",
      body,
    );
  }
  if (operation === "credentials.update") {
    return jsonRequest(
      `/v1/tools/private-credentials/${credentialId}`,
      "PATCH",
      body,
    );
  }
  if (operation === "credentials.delete") {
    return {
      path: `/v1/tools/private-credentials/${credentialId}`,
      init: { method: "DELETE" },
    };
  }
  throw new Error("Unsupported credential Relay operation.");
}

function jsonRequest(
  path: string,
  method: "PATCH" | "POST",
  body: Record<string, unknown>,
): { init: RequestInit; path: string } {
  return { path, init: { method, body: JSON.stringify(body) } };
}

function readCredentialId(value: unknown): string {
  if (
    typeof value !== "string" ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(
      value,
    )
  ) {
    throw new Error("Credential Relay operation requires a valid credential ID.");
  }
  return value;
}

async function issueLocalAgentToken(
  localBaseUrl: string,
  deviceToken: string,
  agentId: string,
): Promise<string> {
  const response = await localGatewayRequest(
    localBaseUrl,
    "/v1/tools/credentials",
    deviceToken,
    { method: "POST", body: JSON.stringify({ agentId }) },
  );
  const token =
    isRecord(response) &&
    isRecord(response.credential) &&
    typeof response.credential.token === "string"
      ? response.credential.token
      : undefined;
  if (!token?.startsWith("osa1_")) {
    throw new Error("The local Gateway returned an invalid Agent credential.");
  }
  return token;
}

async function localGatewayRequest(
  baseUrl: string,
  path: string,
  token: string,
  init: RequestInit,
): Promise<unknown> {
  const headers = new Headers(init.headers);
  headers.set("accept", "application/json");
  headers.set("authorization", `Bearer ${token}`);
  if (init.body !== undefined) headers.set("content-type", "application/json");
  const response = await fetch(`${normalizeLoopbackBaseUrl(baseUrl)}${path}`, {
    ...init,
    headers,
    signal: AbortSignal.timeout(30_000),
  });
  const body = (await response.json().catch(() => null)) as unknown;
  if (!response.ok) {
    throw new DesktopRelayOperationError(readLocalGatewayErrorCode(body));
  }
  return body;
}

class DesktopRelayOperationError extends Error {
  constructor(readonly relayCode: string) {
    super("The local One Status Gateway rejected the request.");
    this.name = "DesktopRelayOperationError";
  }
}

function readLocalGatewayErrorCode(value: unknown): string {
  const code =
    isRecord(value) &&
    isRecord(value.error) &&
    typeof value.error.code === "string"
      ? value.error.code
      : undefined;
  const allowed = new Set([
    "provider_authorization_invalid",
    "tool_approval_required",
    "tool_connection_expired",
    "tool_permission_denied",
  ]);
  return code && allowed.has(code) ? code : "device_operation_failed";
}

function desktopRelayErrorCode(error: unknown): string {
  return error instanceof DesktopRelayOperationError
    ? error.relayCode
    : "device_operation_failed";
}

function resolveRelayUrl(explicit: string | undefined, baseUrl: string): string {
  const source = new URL(explicit ?? baseUrl);
  if (explicit && source.pathname !== "/" && source.pathname !== "/v1/relay") {
    throw new Error("ONE_STATUS_RELAY_URL must target /v1/relay.");
  }
  const loopback = ["127.0.0.1", "[::1]", "localhost"].includes(
    source.hostname.toLowerCase(),
  );
  if (source.protocol === "https:") source.protocol = "wss:";
  else if (source.protocol === "http:" && loopback) source.protocol = "ws:";
  else if (source.protocol !== "wss:" && !(source.protocol === "ws:" && loopback)) {
    throw new Error("Device Relay requires WSS outside loopback.");
  }
  source.pathname = "/v1/relay";
  source.search = "";
  source.hash = "";
  return source.toString();
}

function normalizeLoopbackBaseUrl(value: string): string {
  const url = new URL(value);
  if (
    url.protocol !== "http:" ||
    !["127.0.0.1", "[::1]", "localhost"].includes(url.hostname.toLowerCase())
  ) {
    throw new Error("Desktop Relay local Gateway must use loopback HTTP.");
  }
  return url.toString().replace(/\/$/u, "");
}

function defaultSocket(url: string, token: string): WebSocket {
  return new WebSocket(url, {
    headers: { authorization: `Bearer ${token}` },
    maxPayload: 1024 * 1024,
  });
}

function sendError(socket: WebSocket, requestId: string, code: string): void {
  if (socket.readyState !== WebSocket.OPEN) return;
  socket.send(
    JSON.stringify({
      type: "response",
      requestId,
      ok: false,
      error: { code, message: "The Desktop App could not complete the request." },
    }),
  );
}

function isRelayRequest(value: unknown): value is {
  agentId: string;
  operation: string;
  payload: Record<string, unknown>;
  requestId: string;
  type: "request";
} {
  return (
    isRecord(value) &&
    value.type === "request" &&
    typeof value.requestId === "string" &&
    /^[0-9a-f-]{36}$/iu.test(value.requestId) &&
    typeof value.agentId === "string" &&
    /^[a-zA-Z0-9._:-]{1,120}$/u.test(value.agentId) &&
    typeof value.operation === "string" &&
    isRecord(value.payload)
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
