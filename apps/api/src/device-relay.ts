import { randomUUID } from "node:crypto";
import type { IncomingMessage, Server as NodeServer } from "node:http";
import type { Duplex } from "node:stream";
import { WebSocket, WebSocketServer } from "ws";

const DEFAULT_RELAY_PATH = "/v1/relay";
const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;
const MAX_RELAY_MESSAGE_BYTES = 1024 * 1024;

export type DeviceRelayOperation =
  | "credentials.create"
  | "credentials.delete"
  | "credentials.get"
  | "credentials.list"
  | "credentials.resolve"
  | "credentials.update"
  | "status.read"
  | "tools.list"
  | "tools.request_approval"
  | "tools.execute";

export interface DeviceRelaySession {
  deviceId: string;
  userId: string;
}

export interface DeviceRelayRequest {
  agentId: string;
  deviceId?: string;
  operation: DeviceRelayOperation;
  payload?: Record<string, unknown>;
  timeoutMs?: number;
  userId: string;
}

export interface DeviceRelayResult {
  deviceId: string;
  result: unknown;
}

export interface OnlineRelayDevice {
  capabilities: string[];
  connectedAt: string;
  deviceId: string;
}

export interface DeviceRelayHubOptions {
  authenticate(authorization?: string): DeviceRelaySession | undefined;
  path?: string;
}

interface RelayConnection {
  authorization: string;
  capabilities: string[];
  connectedAt: string;
  pending: Map<string, PendingRelayRequest>;
  session: DeviceRelaySession;
  socket: WebSocket;
}

interface PendingRelayRequest {
  reject(error: Error): void;
  resolve(result: unknown): void;
  timer: NodeJS.Timeout;
}

export class DeviceRelayError extends Error {
  constructor(
    readonly code:
      | "device_offline"
      | "device_capability_unavailable"
      | "relay_timeout"
      | "relay_disconnected"
      | "relay_protocol_error",
    message: string,
    readonly remoteCode?: string,
  ) {
    super(message);
    this.name = "DeviceRelayError";
  }
}

export class DeviceRelayHub {
  readonly #authenticate: DeviceRelayHubOptions["authenticate"];
  readonly #connections = new Map<string, Map<string, RelayConnection>>();
  readonly #path: string;
  readonly #server: WebSocketServer;
  #attachedServer?: NodeServer;
  #upgradeHandler?: (
    request: IncomingMessage,
    socket: Duplex,
    head: Buffer,
  ) => void;

  constructor(options: DeviceRelayHubOptions) {
    this.#authenticate = options.authenticate;
    this.#path = normalizeRelayPath(options.path ?? DEFAULT_RELAY_PATH);
    this.#server = new WebSocketServer({
      clientTracking: false,
      maxPayload: MAX_RELAY_MESSAGE_BYTES,
      noServer: true,
    });
  }

  attach(server: NodeServer): void {
    if (this.#attachedServer) throw new Error("Device Relay is already attached.");
    this.#attachedServer = server;
    this.#upgradeHandler = (request, socket, head) => {
      let pathname: string;
      try {
        pathname = new URL(request.url ?? "/", "http://relay.local").pathname;
      } catch {
        rejectUpgrade(socket, 400, "Bad Request");
        return;
      }
      if (pathname !== this.#path) {
        rejectUpgrade(socket, 404, "Not Found");
        return;
      }
      const session = this.#authenticate(readAuthorization(request));
      if (!session) {
        rejectUpgrade(socket, 401, "Unauthorized");
        return;
      }
      this.#server.handleUpgrade(request, socket, head, (webSocket) => {
        this.#accept(webSocket, session, readAuthorization(request)!);
      });
    };
    server.on("upgrade", this.#upgradeHandler);
  }

  listOnlineDevices(userId: string): OnlineRelayDevice[] {
    return [...(this.#connections.get(userId)?.values() ?? [])]
      .map((connection) => ({
        capabilities: [...connection.capabilities],
        connectedAt: connection.connectedAt,
        deviceId: connection.session.deviceId,
      }))
      .sort((left, right) => left.deviceId.localeCompare(right.deviceId));
  }

  async execute(request: DeviceRelayRequest): Promise<DeviceRelayResult> {
    if (!/^[a-zA-Z0-9._:-]{1,120}$/u.test(request.agentId)) {
      throw new Error("Relay Agent identity is invalid.");
    }
    const selection = this.#selectConnection(
      request.userId,
      request.operation,
      request.deviceId,
    );
    const connection = selection.connection;
    if (!connection) {
      throw new DeviceRelayError(
        selection.online
          ? "device_capability_unavailable"
          : "device_offline",
        selection.online
          ? "No online One Status device advertises the requested capability."
          : request.deviceId
            ? "The selected One Status device is offline."
            : "No authorized One Status device is online.",
      );
    }

    const requestId = randomUUID();
    const timeoutMs = normalizeTimeout(request.timeoutMs);
    const result = await new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        connection.pending.delete(requestId);
        reject(
          new DeviceRelayError(
            "relay_timeout",
            "The One Status device did not answer before the request expired.",
          ),
        );
      }, timeoutMs);
      timer.unref();
      connection.pending.set(requestId, { reject, resolve, timer });
      try {
        connection.socket.send(
          JSON.stringify({
            type: "request",
            requestId,
            agentId: request.agentId,
            operation: request.operation,
            payload: request.payload ?? {},
          }),
        );
      } catch {
        clearTimeout(timer);
        connection.pending.delete(requestId);
        reject(
          new DeviceRelayError(
            "relay_disconnected",
            "The One Status device disconnected before receiving the request.",
          ),
        );
      }
    });
    return { deviceId: connection.session.deviceId, result };
  }

  async close(): Promise<void> {
    if (this.#attachedServer && this.#upgradeHandler) {
      this.#attachedServer.off("upgrade", this.#upgradeHandler);
    }
    for (const connections of this.#connections.values()) {
      for (const connection of connections.values()) {
        connection.socket.close(1001, "Relay shutting down");
        rejectPending(connection, "relay_disconnected");
      }
    }
    this.#connections.clear();
    await new Promise<void>((resolve) => this.#server.close(() => resolve()));
  }

  #accept(
    socket: WebSocket,
    session: DeviceRelaySession,
    authorization: string,
  ): void {
    const userConnections = this.#connections.get(session.userId) ?? new Map();
    this.#connections.set(session.userId, userConnections);
    const previous = userConnections.get(session.deviceId);
    if (previous) {
      previous.socket.close(4001, "Replaced by a newer device connection");
      rejectPending(previous, "relay_disconnected");
    }
    const connection: RelayConnection = {
      authorization,
      capabilities: [],
      connectedAt: new Date().toISOString(),
      pending: new Map(),
      session,
      socket,
    };
    userConnections.set(session.deviceId, connection);
    socket.on("message", (data, isBinary) => {
      if (isBinary) {
        socket.close(1003, "Text messages required");
        return;
      }
      this.#handleMessage(connection, data.toString());
    });
    socket.on("close", () => {
      if (userConnections.get(session.deviceId) !== connection) return;
      userConnections.delete(session.deviceId);
      if (userConnections.size === 0) this.#connections.delete(session.userId);
      rejectPending(connection, "relay_disconnected");
    });
    socket.on("error", () => {
      socket.close();
    });
    socket.send(JSON.stringify({ type: "ready", deviceId: session.deviceId }));
  }

  #handleMessage(connection: RelayConnection, serialized: string): void {
    let message: unknown;
    try {
      message = JSON.parse(serialized);
    } catch {
      connection.socket.close(1007, "Invalid JSON");
      return;
    }
    if (!isRecord(message) || typeof message.type !== "string") return;
    if (message.type === "hello") {
      connection.capabilities = parseCapabilities(message.capabilities);
      return;
    }
    if (message.type !== "response" || typeof message.requestId !== "string") {
      return;
    }
    const pending = connection.pending.get(message.requestId);
    if (!pending) return;
    connection.pending.delete(message.requestId);
    clearTimeout(pending.timer);
    if (message.ok === true) {
      pending.resolve(message.result);
      return;
    }
    const remoteCode = readSafeErrorCode(message.error);
    pending.reject(
      new DeviceRelayError(
        "relay_protocol_error",
        readSafeErrorMessage(message.error),
        remoteCode,
      ),
    );
  }

  #selectConnection(
    userId: string,
    operation: DeviceRelayOperation,
    deviceId?: string,
  ): { connection?: RelayConnection; online: boolean } {
    const connections = this.#connections.get(userId);
    if (!connections) return { online: false };
    const candidates = deviceId
      ? [connections.get(deviceId)].filter(
          (entry): entry is RelayConnection => entry !== undefined,
        )
      : [...connections.values()].sort(
          (left, right) =>
            left.pending.size - right.pending.size ||
            left.session.deviceId.localeCompare(right.session.deviceId),
        );
    let online = false;
    for (const connection of candidates) {
      const current = this.#authenticate(connection.authorization);
      if (
        current?.userId === connection.session.userId &&
        current.deviceId === connection.session.deviceId
      ) {
        online = true;
        if (connection.capabilities.includes(operation)) {
          return { connection, online: true };
        }
        continue;
      }
      connection.socket.close(4003, "Device session expired");
    }
    return { online };
  }
}

function rejectPending(
  connection: RelayConnection,
  code: "relay_disconnected",
): void {
  for (const pending of connection.pending.values()) {
    clearTimeout(pending.timer);
    pending.reject(
      new DeviceRelayError(code, "The One Status device disconnected."),
    );
  }
  connection.pending.clear();
}

function readAuthorization(request: IncomingMessage): string | undefined {
  const value = request.headers.authorization;
  return Array.isArray(value) ? value[0] : value;
}

function rejectUpgrade(socket: Duplex, status: number, label: string): void {
  socket.write(
    `HTTP/1.1 ${status} ${label}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`,
  );
  socket.destroy();
}

function normalizeRelayPath(value: string): string {
  if (!value.startsWith("/") || value.includes("?") || value.includes("#")) {
    throw new Error("Device Relay path must be an absolute URL path.");
  }
  return value.replace(/\/$/u, "") || "/";
}

function normalizeTimeout(value?: number): number {
  if (value === undefined) return DEFAULT_REQUEST_TIMEOUT_MS;
  if (!Number.isInteger(value) || value < 100 || value > 120_000) {
    throw new Error("Relay timeout must be between 100 and 120000 milliseconds.");
  }
  return value;
}

function parseCapabilities(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const allowed = new Set<DeviceRelayOperation>([
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
  ]);
  return [...new Set(value)]
    .filter((entry): entry is DeviceRelayOperation =>
      typeof entry === "string" && allowed.has(entry as DeviceRelayOperation),
    )
    .slice(0, 32);
}

function readSafeErrorMessage(value: unknown): string {
  if (
    isRecord(value) &&
    typeof value.message === "string" &&
    value.message.length <= 500
  ) {
    return value.message;
  }
  return "The One Status device could not complete the request.";
}

function readSafeErrorCode(value: unknown): string | undefined {
  if (!isRecord(value) || typeof value.code !== "string") return undefined;
  const allowed = new Set([
    "device_busy",
    "device_operation_failed",
    "provider_authorization_invalid",
    "tool_approval_required",
    "tool_connection_expired",
    "tool_permission_denied",
  ]);
  return allowed.has(value.code) ? value.code : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
