export const DEFAULT_DESKTOP_PORT = 8787;

export interface EmbeddedServer {
  close(): Promise<void>;
}

export interface LocalService {
  baseUrl: string;
  close(): Promise<void>;
  ownership: "embedded" | "existing";
}

export interface LocalServiceOptions {
  inspect?: (baseUrl: string) => Promise<ServiceInspection>;
  port?: number;
  start: (port: number) => Promise<EmbeddedServer>;
}

export type ServiceInspection = "one-status" | "occupied" | "unreachable";

export class LocalServicePortError extends Error {
  constructor(
    readonly port: number,
    options?: ErrorOptions,
  ) {
    super(
      `Port ${port} is already in use by another application. Close that application or set ONE_STATUS_PORT to an available port.`,
      options,
    );
    this.name = "LocalServicePortError";
  }
}

export function resolveDesktopPort(
  value = process.env.ONE_STATUS_PORT,
): number {
  if (value === undefined || value === "") return DEFAULT_DESKTOP_PORT;
  if (!/^\d+$/.test(value)) {
    throw new Error("ONE_STATUS_PORT must be an integer between 1 and 65535.");
  }
  const port = Number.parseInt(value, 10);
  if (port < 1 || port > 65_535) {
    throw new Error("ONE_STATUS_PORT must be an integer between 1 and 65535.");
  }
  return port;
}

export async function inspectLocalService(
  baseUrl: string,
  fetchImplementation: typeof fetch = fetch,
): Promise<ServiceInspection> {
  const abortController = new AbortController();
  const timeout = setTimeout(() => abortController.abort(), 1_500);
  timeout.unref?.();
  let response: Response;
  try {
    response = await fetchImplementation(`${baseUrl}/health`, {
      cache: "no-store",
      redirect: "error",
      signal: abortController.signal,
    });
  } catch {
    return "unreachable";
  } finally {
    clearTimeout(timeout);
  }

  if (!response.ok) return "occupied";
  try {
    const body = (await response.json()) as Record<string, unknown>;
    return body.status === "ok" && body.service === "one-status-api"
      ? "one-status"
      : "occupied";
  } catch {
    return "occupied";
  }
}

export async function ensureLocalService(
  options: LocalServiceOptions,
): Promise<LocalService> {
  const port = options.port ?? DEFAULT_DESKTOP_PORT;
  const baseUrl = `http://127.0.0.1:${port}`;
  const inspect = options.inspect ?? inspectLocalService;
  const initialInspection = await inspect(baseUrl);

  if (initialInspection === "one-status") {
    return {
      baseUrl,
      close: async () => undefined,
      ownership: "existing",
    };
  }
  if (initialInspection === "occupied") {
    throw new LocalServicePortError(port);
  }

  let server: EmbeddedServer;
  try {
    server = await options.start(port);
  } catch (error) {
    if (isAddressInUseError(error)) {
      const racedInspection = await inspect(baseUrl);
      if (racedInspection === "one-status") {
        return {
          baseUrl,
          close: async () => undefined,
          ownership: "existing",
        };
      }
      throw new LocalServicePortError(port, { cause: error });
    }
    throw error;
  }

  let closed = false;
  return {
    baseUrl,
    ownership: "embedded",
    close: async () => {
      if (closed) return;
      closed = true;
      await server.close();
    },
  };
}

function isAddressInUseError(error: unknown): boolean {
  let current: unknown = error;
  for (let depth = 0; depth < 4 && current; depth += 1) {
    if (
      typeof current === "object" &&
      "code" in current &&
      current.code === "EADDRINUSE"
    ) {
      return true;
    }
    current =
      typeof current === "object" && "cause" in current
        ? current.cause
        : undefined;
  }
  return false;
}
