import { readSecretEnvironment } from "@one-status/local-config";
import { WebSocket } from "ws";

const DEFAULT_RECONNECT_DELAY_MS = 5_000;

export interface ReviewRelayOptions {
  createSocket?: (url: string, token: string) => WebSocket;
  reconnectDelayMs?: number;
  relayUrl: string;
  token: string;
}

export interface RunningReviewRelay {
  close(): void;
}

export async function runReviewRelay(
  relayUrl = process.env.ONE_STATUS_REVIEW_RELAY_URL ??
    "wss://os.furesta.top/v1/relay",
): Promise<RunningReviewRelay> {
  const token = await readSecretEnvironment("ONE_STATUS_REVIEW_DEVICE_TOKEN");
  if (!token || !/^[A-Za-z0-9_-]{43}$/u.test(token)) {
    throw new Error(
      "ONE_STATUS_REVIEW_DEVICE_TOKEN or ONE_STATUS_REVIEW_DEVICE_TOKEN_FILE is required.",
    );
  }
  const running = startReviewRelay({ relayUrl, token });
  console.error("One Status OpenAI review fixture Relay started.");
  return running;
}

export function startReviewRelay(
  options: ReviewRelayOptions,
): RunningReviewRelay {
  const relayUrl = normalizeRelayUrl(options.relayUrl);
  const reconnectDelayMs = options.reconnectDelayMs ??
    DEFAULT_RECONNECT_DELAY_MS;
  const createSocket = options.createSocket ?? defaultSocket;
  let closed = false;
  let socket: WebSocket | undefined;
  let reconnectTimer: NodeJS.Timeout | undefined;

  const scheduleReconnect = () => {
    if (closed || reconnectTimer) return;
    reconnectTimer = setTimeout(() => {
      reconnectTimer = undefined;
      connect();
    }, reconnectDelayMs);
  };

  const connect = () => {
    if (closed || socket) return;
    let candidate: WebSocket;
    try {
      candidate = createSocket(relayUrl, options.token);
    } catch {
      scheduleReconnect();
      return;
    }
    socket = candidate;
    candidate.once("open", () => {
      candidate.send(
        JSON.stringify({ type: "hello", capabilities: ["status.read"] }),
      );
    });
    candidate.on("message", (data, isBinary) => {
      if (closed || isBinary) return;
      let message: unknown;
      try {
        message = JSON.parse(data.toString());
      } catch {
        candidate.close(1007, "Invalid JSON");
        return;
      }
      if (!isReviewRequest(message)) return;
      try {
        const result = reviewStatusView(message.payload);
        candidate.send(
          JSON.stringify({
            type: "response",
            requestId: message.requestId,
            ok: true,
            result,
          }),
        );
      } catch {
        candidate.send(
          JSON.stringify({
            type: "response",
            requestId: message.requestId,
            ok: false,
            error: {
              code: "device_operation_failed",
              message: "The requested review fixture view is unavailable.",
            },
          }),
        );
      }
    });
    candidate.once("close", () => {
      if (socket === candidate) socket = undefined;
      scheduleReconnect();
    });
    candidate.once("error", () => candidate.close());
  };

  connect();
  return {
    close() {
      closed = true;
      if (reconnectTimer) clearTimeout(reconnectTimer);
      reconnectTimer = undefined;
      socket?.close(1000, "Review fixture shutting down");
      socket = undefined;
    },
  };
}

export function reviewStatusView(
  payload: Record<string, unknown>,
): Record<string, unknown> {
  if (payload.view === "profile") {
    return {
      version: 1,
      identity: { displayName: "Alex Chen" },
      preferences: {
        language: "English",
        packageManager: "pnpm",
        responseStyle: "Concise technical answers with explicit next steps",
      },
      personaProfile: {
        language_style: {
          content: "Prefers concise technical answers with explicit next steps",
          confidence: "explicit",
        },
        technical_habit: {
          content: "Uses pnpm for JavaScript and TypeScript projects",
          confidence: "explicit",
        },
      },
    };
  }
  if (payload.view === "context") {
    return {
      version: 1,
      workspace: {
        activeProjectId: "atlas-notes",
        currentContext: "Finish the searchable notes API and prepare handoff.",
      },
      project: {
        id: "atlas-notes",
        name: "Atlas Notes",
        summary: "A searchable workspace for durable research notes.",
        techStack: ["TypeScript", "PostgreSQL"],
        currentGoal: "Complete the searchable notes API",
        decisions: ["Use cursor-based pagination for note search"],
      },
      openTasks: [
        {
          id: "add-search-pagination",
          projectId: "atlas-notes",
          title: "Add pagination to note search",
          status: "in_progress",
          completed: ["Define the response schema"],
          next: ["Implement and test the cursor"],
        },
        {
          id: "document-import-endpoint",
          projectId: "atlas-notes",
          title: "Document the import endpoint",
          status: "todo",
          completed: [],
          next: ["Add request and response examples"],
        },
      ],
      sessionMemory: [
        {
          scope: "session",
          content: "Search endpoint tests pass; pagination remains open.",
          tags: ["atlas-notes", "handoff"],
        },
      ],
    };
  }
  if (payload.view === "memory") {
    const requestedScope = readScope(payload.scope);
    const requestedProject = readOptionalString(payload.projectId);
    const limit = readLimit(payload.limit);
    return {
      version: 1,
      memory: reviewMemories
        .filter(
          (entry) =>
            (!requestedScope || entry.scope === requestedScope) &&
            (!requestedProject ||
              ("projectId" in entry && entry.projectId === requestedProject)),
        )
        .slice(0, limit),
    };
  }
  throw new Error("Unsupported review fixture view.");
}

const reviewMemories = [
  {
    scope: "user",
    content: "Use pnpm for JavaScript and TypeScript projects.",
    tags: ["package-manager", "explicit"],
  },
  {
    scope: "project",
    projectId: "atlas-notes",
    content: "Atlas Notes uses TypeScript and PostgreSQL.",
    tags: ["architecture", "confirmed"],
  },
  {
    scope: "session",
    projectId: "atlas-notes",
    content: "Search endpoint tests pass; pagination remains open.",
    tags: ["handoff", "confirmed"],
  },
] as const;

function isReviewRequest(value: unknown): value is {
  operation: "status.read";
  payload: Record<string, unknown>;
  requestId: string;
} {
  if (!isRecord(value)) return false;
  return (
    value.type === "request" &&
    value.operation === "status.read" &&
    typeof value.requestId === "string" &&
    value.requestId.length > 0 &&
    isRecord(value.payload)
  );
}

function readScope(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  if (value === "user" || value === "project" || value === "session") {
    return value;
  }
  throw new Error("Invalid memory scope.");
}

function readLimit(value: unknown): number {
  if (value === undefined) return 100;
  if (!Number.isInteger(value) || (value as number) < 1 || (value as number) > 200) {
    throw new Error("Invalid memory limit.");
  }
  return value as number;
}

function readOptionalString(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || value.length < 1 || value.length > 500) {
    throw new Error("Invalid project ID.");
  }
  return value;
}

function normalizeRelayUrl(value: string): string {
  const url = new URL(value);
  const loopback = ["127.0.0.1", "[::1]", "localhost"].includes(
    url.hostname.toLowerCase(),
  );
  if (url.protocol !== "wss:" && !(url.protocol === "ws:" && loopback)) {
    throw new Error("Review Relay requires WSS outside loopback.");
  }
  if (url.username || url.password || url.search || url.hash) {
    throw new Error("Review Relay URL cannot contain credentials, query, or hash.");
  }
  return url.toString();
}

function defaultSocket(url: string, token: string): WebSocket {
  return new WebSocket(url, {
    headers: { authorization: `Bearer ${token}` },
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
