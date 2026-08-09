#!/usr/bin/env node
import { randomUUID } from "node:crypto";
import { OneStatusClient } from "@one-status/client";
import {
  exportStatusKey,
  generateStatusKey,
  importStatusKey,
} from "@one-status/crypto";
import {
  deleteLocalProfile,
  loadOrCreateInstallationId,
  loadLocalProfile,
  prepareLocalProfileStorage,
  readSecretEnvironment,
  resolveProfilePath,
  saveLocalProfile,
  type LocalProfile,
} from "@one-status/local-config";
import type { MemoryScope, StatusDocument } from "@one-status/protocol";

const VERSION = "0.2.0";

interface ParsedArguments {
  command: string;
  flags: Map<string, string>;
}

async function main(): Promise<void> {
  const arguments_ = parseArguments(process.argv.slice(2));

  switch (arguments_.command) {
    case "register":
      await register(arguments_.flags);
      break;
    case "login":
      await login(arguments_.flags);
      break;
    case "show":
      await showStatus();
      break;
    case "remember":
      await remember(arguments_.flags);
      break;
    case "set-preference":
      await setPreference(arguments_.flags);
      break;
    case "set-project":
      await setProject(arguments_.flags);
      break;
    case "set-context":
      await setContext(arguments_.flags);
      break;
    case "doctor":
      await doctor();
      break;
    case "devices":
      await listDevices();
      break;
    case "heartbeat":
      await heartbeat();
      break;
    case "use-server":
      await useServer(arguments_.flags);
      break;
    case "revoke-device":
      await revokeDevice(arguments_.flags);
      break;
    case "logout":
      await logout();
      break;
    case "mcp":
      await runMcp(arguments_.flags);
      break;
    case "server":
      await runServer(arguments_.flags);
      break;
    case "version":
    case "--version":
    case "-v":
      console.log(VERSION);
      break;
    case "help":
    case "--help":
    case "-h":
    case "":
      printHelp();
      break;
    default:
      throw new Error(`Unknown command: ${arguments_.command}`);
  }
}

async function register(flags: Map<string, string>): Promise<void> {
  const baseUrl = flags.get("server") ?? process.env.ONE_STATUS_URL ?? "http://127.0.0.1:8787";
  const email = requiredFlag(flags, "email");
  const deviceName = requiredFlag(flags, "device");
  const password = await requiredSecret("ONE_STATUS_PASSWORD");
  await prepareLocalProfileStorage(resolveProfilePath(), true);
  const statusKey = generateStatusKey();
  const exportedKey = exportStatusKey(statusKey);
  console.log(`Status Key: ${exportedKey}`);
  console.log("Keep the Status Key offline. A new device needs it to decrypt your status.");
  const anonymous = new OneStatusClient({ baseUrl });
  const session = await anonymous.register(
    {
      email,
      password,
      deviceName,
      installationId: await resolveInstallationId(baseUrl, flags),
    },
    statusKey,
  );
  await saveSession({ baseUrl, deviceName, exportedKey, session });
  console.log("One Status account created.");
  console.log(`Profile: ${resolveProfilePath()}`);
}

async function login(flags: Map<string, string>): Promise<void> {
  const baseUrl = flags.get("server") ?? process.env.ONE_STATUS_URL ?? "http://127.0.0.1:8787";
  const email = requiredFlag(flags, "email");
  const deviceName = requiredFlag(flags, "device");
  const password = await requiredSecret("ONE_STATUS_PASSWORD");
  const exportedKey = await requiredSecret("ONE_STATUS_STATUS_KEY");
  const statusKey = importStatusKey(exportedKey);
  const anonymous = new OneStatusClient({ baseUrl });
  const session = await anonymous.login({
    email,
    password,
    deviceName,
    installationId: await resolveInstallationId(baseUrl, flags),
  });
  const client = new OneStatusClient({ baseUrl, token: session.token });
  await client.createVault(statusKey).read();

  await saveSession({ baseUrl, deviceName, exportedKey, session });
  console.log("Device connected and status decrypted successfully.");
  console.log(`Profile: ${resolveProfilePath()}`);
}

async function showStatus(): Promise<void> {
  const { vault } = await openVault();
  const snapshot = await vault.read();
  console.log(JSON.stringify(snapshot, null, 2));
}

async function remember(flags: Map<string, string>): Promise<void> {
  const content = requiredFlag(flags, "content");
  const scope = (flags.get("scope") ?? "user") as MemoryScope;
  if (!(["user", "project", "session"] as const).includes(scope)) {
    throw new Error("--scope must be user, project, or session.");
  }
  const projectId = flags.get("project");
  if (scope === "project" && !projectId) {
    throw new Error("--project is required when --scope is project.");
  }
  const now = new Date().toISOString();
  const { vault } = await openVault();
  const result = await vault.mutate((status) => {
    status.memory.push({
      id: randomUUID(),
      scope,
      ...(projectId ? { projectId } : {}),
      content,
      tags: splitCsv(flags.get("tags")),
      state: "confirmed",
      origin: { type: "manual", label: "One Status CLI" },
      createdAt: now,
      updatedAt: now,
    });
  });
  console.log(`Memory saved at status version ${result.version}.`);
}

async function setPreference(flags: Map<string, string>): Promise<void> {
  const key = requiredFlag(flags, "key");
  const value = parsePreferenceValue(requiredFlag(flags, "value"));
  const { vault } = await openVault();
  const result = await vault.mutate((status) => {
    status.preferences[key] = value;
  });
  console.log(`Preference saved at status version ${result.version}.`);
}

async function setProject(flags: Map<string, string>): Promise<void> {
  const id = requiredFlag(flags, "id");
  const name = requiredFlag(flags, "name");
  const now = new Date().toISOString();
  const { vault } = await openVault();
  const result = await vault.mutate((status) => {
    const previous = status.projects[id];
    status.projects[id] = {
      id,
      name,
      summary: flags.get("summary") ?? previous?.summary ?? "",
      techStack: flags.has("tech-stack")
        ? splitCsv(flags.get("tech-stack"))
        : previous?.techStack ?? [],
      currentGoal: flags.get("goal") ?? previous?.currentGoal ?? "",
      decisions: flags.has("decisions")
        ? splitCsv(flags.get("decisions"))
        : previous?.decisions ?? [],
      ...(previous?.handoff ? { handoff: previous.handoff } : {}),
      updatedAt: now,
    };
    status.workspace.activeProjectId = id;
  });
  console.log(`Project saved at status version ${result.version}.`);
}

async function setContext(flags: Map<string, string>): Promise<void> {
  const context = requiredFlag(flags, "text");
  const { vault } = await openVault();
  const result = await vault.mutate((status) => {
    status.workspace.currentContext = context;
    if (flags.get("project")) {
      status.workspace.activeProjectId = flags.get("project");
    }
    if (flags.get("agent")) {
      status.workspace.lastAgentId = flags.get("agent");
    }
  });
  console.log(`Context saved at status version ${result.version}.`);
}

async function doctor(): Promise<void> {
  const { profile, vault } = await openVault();
  const health = await fetch(`${profile.baseUrl}/health`);
  if (!health.ok) {
    throw new Error(`API health check failed with HTTP ${health.status}.`);
  }
  const snapshot = await vault.read();
  console.log(`API: ok (${profile.baseUrl})`);
  console.log(`Device: ${profile.deviceName} (${profile.deviceId})`);
  console.log(`Vault: decrypted (version ${snapshot.version})`);
}

async function listDevices(): Promise<void> {
  const profile = await loadLocalProfile();
  const client = new OneStatusClient({
    baseUrl: profile.baseUrl,
    token: profile.token,
  });
  const account = await client.getAccount();
  console.log(JSON.stringify(account.devices, null, 2));
}

async function heartbeat(): Promise<void> {
  const profile = await loadLocalProfile();
  const client = new OneStatusClient({
    baseUrl: profile.baseUrl,
    token: profile.token,
  });
  const presence = await client.heartbeat();
  console.log(JSON.stringify(presence, null, 2));
}

async function useServer(flags: Map<string, string>): Promise<void> {
  const baseUrl = requiredFlag(flags, "url").replace(/\/$/, "");
  const profile = await loadLocalProfile();
  const client = new OneStatusClient({ baseUrl, token: profile.token });
  const snapshot = await client
    .createVault(importStatusKey(profile.statusKey))
    .read();
  await saveLocalProfile({ ...profile, baseUrl });
  console.log(
    `Sync server updated to ${baseUrl} (status version ${snapshot.version}).`,
  );
}

async function revokeDevice(flags: Map<string, string>): Promise<void> {
  const deviceId = requiredFlag(flags, "id");
  const profile = await loadLocalProfile();
  const client = new OneStatusClient({
    baseUrl: profile.baseUrl,
    token: profile.token,
  });
  await client.revokeDevice(deviceId);
  if (deviceId === profile.deviceId) {
    await deleteLocalProfile();
  }
  console.log(`Device revoked: ${deviceId}`);
}

async function logout(): Promise<void> {
  const profile = await loadLocalProfile();
  const client = new OneStatusClient({
    baseUrl: profile.baseUrl,
    token: profile.token,
  });
  await client.logout();
  await deleteLocalProfile();
  console.log("Device session revoked and local profile deleted.");
}

async function runMcp(flags: Map<string, string>): Promise<void> {
  const transport = flags.get("transport") ?? "stdio";
  if (transport === "stdio") {
    const { startStdioMcp } = await import("@one-status/mcp/stdio");
    await startStdioMcp();
    return;
  }
  if (transport !== "http") {
    throw new Error("--transport must be stdio or http.");
  }

  const { startHttpMcp } = await import("@one-status/mcp/http");
  const started = await startHttpMcp(undefined, {
    bearerToken: await readSecretEnvironment(
      "ONE_STATUS_MCP_BEARER_TOKEN",
    ),
    endpoint:
      flags.get("endpoint") ?? process.env.ONE_STATUS_MCP_ENDPOINT ?? "/mcp",
    host:
      flags.get("host") ?? process.env.ONE_STATUS_MCP_HOST ?? "127.0.0.1",
    idleTimeoutMs: parsePositiveInteger(
      flags.get("idle-timeout-ms") ??
        process.env.ONE_STATUS_MCP_IDLE_TIMEOUT_MS ??
        "1800000",
      "idle-timeout-ms",
    ),
    maxSessions: parsePositiveInteger(
      flags.get("max-sessions") ??
        process.env.ONE_STATUS_MCP_MAX_SESSIONS ??
        "100",
      "max-sessions",
    ),
    port: parsePort(
      flags.get("port") ?? process.env.ONE_STATUS_MCP_PORT ?? "3000",
      "port",
    ),
    publicUrl:
      flags.get("public-url") ?? process.env.ONE_STATUS_MCP_PUBLIC_URL,
  });
  console.error(`One Status MCP listening at ${started.url}`);
  installGracefulShutdown(started.close);
}

async function runServer(flags: Map<string, string>): Promise<void> {
  const { startApiServer } = await import("@one-status/api/runtime");
  const host = flags.get("host") ?? process.env.ONE_STATUS_HOST ?? "127.0.0.1";
  const dashboardEnabled =
    flags.get("dashboard") !== "false" &&
    ["127.0.0.1", "localhost", "::1"].includes(host);
  const app = await startApiServer({
    dashboard: dashboardEnabled,
    dbPath: flags.get("db") ?? process.env.ONE_STATUS_DB,
    host,
    logger: true,
    permissionDbPath:
      flags.get("permission-db") ?? process.env.ONE_STATUS_PERMISSION_DB,
    permissionKeyPath:
      flags.get("permission-key") ??
      process.env.ONE_STATUS_PERMISSION_KEY_FILE,
    port: parsePort(
      flags.get("port") ?? process.env.ONE_STATUS_PORT ?? "8787",
      "port",
    ),
    publicBaseUrl:
      flags.get("public-url") ?? process.env.ONE_STATUS_PUBLIC_URL,
    trustProxy:
      (flags.get("trust-proxy") ?? process.env.ONE_STATUS_TRUST_PROXY) ===
      "true",
    workspaceDbPath:
      flags.get("workspace-db") ?? process.env.ONE_STATUS_WORKSPACE_DB,
  });
  const stopHeartbeat = dashboardEnabled ? startHeartbeatLoop() : () => {};
  installGracefulShutdown(async () => {
    stopHeartbeat();
    await app.close();
  });
}

function startHeartbeatLoop(): () => void {
  const heartbeat = async () => {
    try {
      const profile = await loadLocalProfile();
      await new OneStatusClient({
        baseUrl: profile.baseUrl,
        token: profile.token,
      }).heartbeat();
    } catch {
      // Registration may not be complete yet, or the sync service may be offline.
    }
  };
  void heartbeat();
  const timer = setInterval(() => void heartbeat(), 30_000);
  timer.unref();
  return () => clearInterval(timer);
}

async function openVault() {
  const profile = await loadLocalProfile();
  const client = new OneStatusClient({
    baseUrl: profile.baseUrl,
    token: profile.token,
  });
  return {
    profile,
    vault: client.createVault(importStatusKey(profile.statusKey)),
  };
}

async function saveSession(input: {
  baseUrl: string;
  deviceName: string;
  exportedKey: string;
  session: {
    userId: string;
    deviceId: string;
    token: string;
    expiresAt: string;
  };
}): Promise<void> {
  const profile: LocalProfile = {
    version: 1,
    baseUrl: input.baseUrl,
    userId: input.session.userId,
    deviceId: input.session.deviceId,
    deviceName: input.deviceName,
    token: input.session.token,
    tokenExpiresAt: input.session.expiresAt,
    statusKey: input.exportedKey,
  };
  await saveLocalProfile(profile);
}

async function resolveInstallationId(
  baseUrl: string,
  flags: Map<string, string>,
): Promise<string> {
  const explicit = flags.get("installation-id");
  if (explicit) return explicit;
  let legacyDeviceId: string | undefined;
  try {
    const profile = await loadLocalProfile();
    if (profile.baseUrl.replace(/\/$/, "") === baseUrl.replace(/\/$/, "")) {
      legacyDeviceId = profile.deviceId;
    }
  } catch {
    // A new installation has no local profile yet.
  }
  return loadOrCreateInstallationId(legacyDeviceId);
}

function parseArguments(arguments_: string[]): ParsedArguments {
  const [command = "", ...rest] = arguments_;
  const flags = new Map<string, string>();
  for (let index = 0; index < rest.length; index += 2) {
    const flag = rest[index];
    const value = rest[index + 1];
    if (!flag?.startsWith("--") || value === undefined || value.startsWith("--")) {
      throw new Error(`Expected --flag value near ${flag ?? "end of command"}.`);
    }
    flags.set(flag.slice(2), value);
  }
  return { command, flags };
}

function requiredFlag(flags: Map<string, string>, name: string): string {
  const value = flags.get(name);
  if (!value) {
    throw new Error(`--${name} is required.`);
  }
  return value;
}

async function requiredSecret(name: string): Promise<string> {
  const value = await readSecretEnvironment(name);
  if (!value) {
    throw new Error(`${name} or ${name}_FILE must be set.`);
  }
  return value;
}

function splitCsv(value: string | undefined): string[] {
  return value
    ? value
        .split(",")
        .map((item) => item.trim())
        .filter(Boolean)
    : [];
}

function parsePreferenceValue(value: string): string | number | boolean | string[] {
  if (value === "true") return true;
  if (value === "false") return false;
  if (/^-?\d+(\.\d+)?$/.test(value)) return Number(value);
  if (value.includes(",")) return splitCsv(value);
  return value;
}

function parsePort(value: string, name: string): number {
  const port = parsePositiveInteger(value, name);
  if (port > 65_535) throw new Error(`--${name} must be at most 65535.`);
  return port;
}

function parsePositiveInteger(value: string, name: string): number {
  if (!/^\d+$/.test(value)) {
    throw new Error(`--${name} must be a positive integer.`);
  }
  const parsed = Number.parseInt(value, 10);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new Error(`--${name} must be a positive integer.`);
  }
  return parsed;
}

function installGracefulShutdown(close: () => Promise<void>): void {
  let closing = false;
  const shutdown = async () => {
    if (closing) return;
    closing = true;
    await close().catch((error: unknown) => console.error(error));
  };
  process.once("SIGINT", () => void shutdown());
  process.once("SIGTERM", () => void shutdown());
}

function printHelp(): void {
  console.log(`One Status CLI

Usage:
  ONE_STATUS_PASSWORD=... one-status register --email <email> --device <name>
  ONE_STATUS_PASSWORD=... ONE_STATUS_STATUS_KEY=... one-status login --email <email> --device <name>
  one-status show
  one-status remember --content <text> [--scope user|project|session] [--project <id>]
  one-status set-preference --key <key> --value <value>
  one-status set-project --id <id> --name <name> [--tech-stack <csv>] [--goal <text>]
  one-status set-context --text <text> [--project <id>] [--agent <id>]
  one-status doctor
  one-status devices
  one-status heartbeat
  one-status use-server --url <https-url>
  one-status revoke-device --id <device-id>
  one-status logout
  one-status mcp --transport stdio
  one-status mcp --transport http [--host <host>] [--port <port>] [--endpoint </mcp>]
  one-status server [--host <host>] [--port <port>] [--db <path>] [--workspace-db <path>] [--public-url <url>] [--trust-proxy true]
  one-status version

Environment:
  ONE_STATUS_URL         Sync API URL (default: http://127.0.0.1:8787)
  ONE_STATUS_DEFAULT_SYNC_URL  Default server shown by graphical onboarding
  ONE_STATUS_HOME        Local profile directory
  ONE_STATUS_PASSWORD    Account password for register/login
  ONE_STATUS_PASSWORD_FILE  File containing the account password
  ONE_STATUS_STATUS_KEY  Recovery key for a new device
  ONE_STATUS_STATUS_KEY_FILE  File containing the recovery key
  ONE_STATUS_TOOL_GATEWAY_URL  Local or HTTPS Permission Vault API base URL
  ONE_STATUS_MCP_BEARER_TOKEN  Required for non-loopback HTTP MCP
  ONE_STATUS_MCP_BEARER_TOKEN_FILE  File containing the HTTP MCP bearer
  ONE_STATUS_PERMISSION_DB  Permission Vault SQLite path
  ONE_STATUS_PERMISSION_KEY_FILE  Permission Vault encryption key path
  ONE_STATUS_WORKSPACE_DB  Device-local project mapping SQLite path
  ONE_STATUS_PUBLIC_URL  Public HTTPS base URL for OAuth callbacks
  ONE_STATUS_TRUST_PROXY  Trust reverse-proxy forwarding headers (true/false)
`);
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});

export type { StatusDocument };
