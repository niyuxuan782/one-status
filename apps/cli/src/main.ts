#!/usr/bin/env node
import { spawn, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
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
import {
  ONE_STATUS_VERSION,
  removeDeviceControlState,
  type CapabilityTarget,
  type MemoryScope,
  type StatusDocument,
} from "@one-status/protocol";
import { booleanFlag, parseArguments } from "./arguments.js";
import { runHandoffCommand } from "./handoff-command.js";
import { runReviewRelay } from "./review-relay.js";

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
    case "vault-server":
      await runVaultServer(arguments_.flags);
      break;
    case "review-relay": {
      const relay = await runReviewRelay(arguments_.flags.get("relay-url"));
      installGracefulShutdown(async () => relay.close());
      break;
    }
    case "app":
      await openDesktopApp();
      break;
    case "handoff":
      await handoff(arguments_.flags);
      break;
    case "capability":
      await capability(arguments_.subcommand ?? "list", arguments_.flags);
      break;
    case "version":
    case "--version":
    case "-v":
      console.log(ONE_STATUS_VERSION);
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
  const anonymous = new OneStatusClient({ baseUrl });
  const migrationCandidate = await loadStatusKeyMigrationCandidate(baseUrl);
  const session = await anonymous.login(
    {
      email,
      password,
      deviceName,
      installationId: await resolveInstallationId(baseUrl, flags),
    },
    migrationCandidate,
  );
  const client = new OneStatusClient({ baseUrl, token: session.token });
  if (migrationCandidate && migrationCandidate.userId !== session.userId) {
    await client.logout().catch(() => undefined);
    throw new Error(
      "The existing local profile belongs to another One Status account.",
    );
  }
  await client.createVault(session.statusKey).read();

  await saveSession({
    baseUrl,
    deviceName,
    exportedKey: exportStatusKey(session.statusKey),
    session,
  });
  console.log("Device connected and status decrypted successfully.");
  console.log(`Profile: ${resolveProfilePath()}`);
}

async function loadStatusKeyMigrationCandidate(baseUrl: string): Promise<
  | { statusKey: Uint8Array; userId: string }
  | undefined
> {
  if (!existsSync(resolveProfilePath())) return undefined;
  const profile = await loadLocalProfile();
  if (normalizedBaseUrl(profile.baseUrl) !== normalizedBaseUrl(baseUrl)) {
    return undefined;
  }
  return {
    statusKey: importStatusKey(profile.statusKey),
    userId: profile.userId,
  };
}

function normalizedBaseUrl(value: string): string {
  return new URL(value).toString().replace(/\/$/, "");
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

async function capability(
  operation: string,
  flags: Map<string, string>,
): Promise<void> {
  if (operation === "list") {
    const { listBuiltInCapabilityPacks } = await import(
      "@one-status/capability-pack"
    );
    console.log(
      JSON.stringify(
        listBuiltInCapabilityPacks().map(({ manifest, digest }) => ({
          name: manifest.name,
          displayName: manifest.displayName,
          version: manifest.version,
          actions: manifest.tools.length,
          adapters: manifest.adapters,
          authorizationProvider: manifest.authorization?.provider ?? null,
          digest,
        })),
        null,
        2,
      ),
    );
    return;
  }
  if (operation !== "preview" && operation !== "install") {
    throw new Error("Capability command must be list, preview, or install.");
  }

  const packName = requiredFlag(flags, "pack");
  const target = requiredFlag(flags, "target");
  const { LocalCapabilityManager, localCapabilityTargets } = await import(
    "@one-status/api/local-capability-manager"
  );
  if (!(localCapabilityTargets as readonly string[]).includes(target)) {
    throw new Error(
      `--target must be one of: ${localCapabilityTargets.join(", ")}.`,
    );
  }
  const typedTarget = target as (typeof localCapabilityTargets)[number];
  const manager = new LocalCapabilityManager();

  if (operation === "preview") {
    const plan = await manager.prepareInstallation({
      packName,
      target: typedTarget,
    });
    console.log(
      JSON.stringify(
        capabilityInstallSummary(plan),
        null,
        2,
      ),
    );
    return;
  }

  if (!booleanFlag(flags, "confirm")) {
    throw new Error("--confirm is required to install a Capability Pack.");
  }
  const approvalId = requiredFlag(flags, "approval");
  const result = await manager.install({
    packName,
    target: typedTarget,
    confirmed: true,
    approvalId,
  });
  const statusSync = await syncCapabilityInstallationIntent(
    packName,
    typedTarget,
  );
  console.log(
    JSON.stringify(
      {
        ...capabilityInstallSummary(result),
        applied: result.applied,
        statusSync,
      },
      null,
      2,
    ),
  );
}

async function syncCapabilityInstallationIntent(
  packName: string,
  target: "codex" | "claude-code" | "markdown" | "local-mcp",
): Promise<
  | { synced: true; statusVersion: number }
  | { synced: false; reason: "status_sync_failed" }
> {
  const { listBuiltInCapabilityPacks } = await import(
    "@one-status/capability-pack"
  );
  const entry = listBuiltInCapabilityPacks().find(
    ({ manifest }) => manifest.name === packName,
  );
  if (!entry) throw new Error(`Unknown built-in Capability Pack: ${packName}`);
  const statusTarget: CapabilityTarget =
    target === "local-mcp" ? "ide" : target;
  try {
    const { vault } = await openVault();
    const now = new Date().toISOString();
    const result = await vault.mutate((status) => {
      const previous = status.capabilities.installations[packName];
      status.capabilities.installations[packName] = {
        packId: packName,
        version: entry.manifest.version,
        manifestDigest: entry.digest,
        source: { type: "builtin" },
        targets: [...new Set([...(previous?.targets ?? []), statusTarget])],
        enabled: true,
        installedAt: previous?.installedAt ?? now,
        updatedAt: now,
      };
    });
    return { synced: true, statusVersion: result.version };
  } catch {
    return { synced: false, reason: "status_sync_failed" };
  }
}

function capabilityInstallSummary(plan: {
  approvalId: string;
  commands: Array<{ command: string; args: string[] }>;
  pack: { name: string; version: string };
  preview: {
    blocked: number;
    creates: number;
    installable: boolean;
    unchanged: number;
    updates: number;
    files: Array<{
      disposition: string;
      relativePath: string;
      targetSha256: string;
    }>;
  };
  removals: Array<{
    currentSha256: string;
    relativePath: string;
  }>;
  root: string;
  target: string;
}) {
  return {
    pack: plan.pack,
    target: plan.target,
    root: plan.root,
    approvalId: plan.approvalId,
    preview: {
      installable: plan.preview.installable,
      creates: plan.preview.creates,
      updates: plan.preview.updates,
      unchanged: plan.preview.unchanged,
      blocked: plan.preview.blocked,
      files: plan.preview.files.map((file) => ({
        relativePath: file.relativePath,
        disposition: file.disposition,
        targetSha256: file.targetSha256,
      })),
    },
    removals: plan.removals,
    commands: plan.commands.map((command) => ({
      command: command.command,
      args: command.args,
    })),
  };
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
  const { profile, vault } = await openVault();
  const client = new OneStatusClient({
    baseUrl: profile.baseUrl,
    token: profile.token,
  });
  const account = await client.getAccount();
  if (!account.devices.some((device) => device.id === deviceId)) {
    throw new Error(`Device was not found: ${deviceId}`);
  }
  await vault.mutate((status) => {
    removeDeviceControlState(status, deviceId);
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
  const agentId = flags.get("agent");
  if (agentId) {
    if (!/^[a-zA-Z0-9._:-]{1,120}$/.test(agentId)) {
      throw new Error("--agent contains an invalid Agent ID.");
    }
    process.env.ONE_STATUS_AGENT_ID = agentId;
  }
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
    maxSessionsPerPrincipal: parsePositiveInteger(
      flags.get("max-sessions-per-principal") ??
        process.env.ONE_STATUS_MCP_MAX_SESSIONS_PER_PRINCIPAL ??
        "5",
      "max-sessions-per-principal",
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
    deviceRelay:
      (flags.get("device-relay") ?? process.env.ONE_STATUS_DEVICE_RELAY) ===
      "true",
    host,
    logger: true,
    oauthDbPath:
      flags.get("oauth-db") ?? process.env.ONE_STATUS_OAUTH_DB,
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
    remoteMcp:
      (flags.get("remote-mcp") ?? process.env.ONE_STATUS_REMOTE_MCP) ===
      "true",
    remoteMcpIssuer:
      flags.get("oauth-issuer") ?? process.env.ONE_STATUS_OAUTH_ISSUER,
    remoteMcpResource:
      flags.get("mcp-resource") ??
      process.env.ONE_STATUS_REMOTE_MCP_RESOURCE,
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

async function runVaultServer(flags: Map<string, string>): Promise<void> {
  const { startVaultServerFromEnv } = await import("@one-status/vault/runtime");
  const runtime = await startVaultServerFromEnv({
    host: flags.get("host"),
    logger: true,
    migrate: flags.get("migrate") !== "false",
    port: flags.has("port")
      ? parsePort(flags.get("port")!, "port")
      : undefined,
  });
  console.error(`One Status Vault listening at ${runtime.url}`);
  installGracefulShutdown(runtime.close);
}

async function openDesktopApp(): Promise<void> {
  if (launchInstalledDesktop()) return;

  const dashboardUrl = "http://127.0.0.1:8787/";
  await ensureDefaultLocalService(dashboardUrl);

  if (!openExternalApplicationUrl(dashboardUrl)) {
    console.log(`One Status is running at ${dashboardUrl}`);
  }
}

async function handoff(flags: Map<string, string>): Promise<void> {
  const dashboardUrl = flags.get("dashboard-url");
  if (!dashboardUrl && !process.env.ONE_STATUS_DASHBOARD_URL) {
    await ensureDefaultLocalService("http://127.0.0.1:8787/");
  }
  const result = await runHandoffCommand({
    agentId: requiredFlag(flags, "agent"),
    dashboardUrl,
    projectId: requiredFlag(flags, "project"),
    publish: booleanFlag(flags, "publish"),
  });
  console.log(JSON.stringify(result, null, 2));
}

async function ensureDefaultLocalService(dashboardUrl: string): Promise<void> {
  if (await isHealthyLocalService(dashboardUrl)) return;
  const scriptPath = process.argv[1];
  if (!scriptPath) throw new Error("Unable to locate the One Status CLI entrypoint.");
  const child = spawn(process.execPath, [scriptPath, "server"], {
    detached: true,
    env: process.env,
    stdio: "ignore",
  });
  child.unref();

  for (let attempt = 0; attempt < 80; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 125));
    if (await isHealthyLocalService(dashboardUrl)) return;
  }
  throw new Error(
    "The local dashboard did not start. Run `one-status server` to inspect the startup error.",
  );
}

function launchInstalledDesktop(): boolean {
  if (process.platform === "darwin") {
    const candidates = [
      "/Applications/One Status.app",
      join(homedir(), "Applications", "One Status.app"),
    ];
    const installed = candidates.find((candidate) => existsSync(candidate));
    const result = installed
      ? spawnSync("open", [installed], { stdio: "ignore" })
      : spawnSync("open", ["-a", "One Status"], { stdio: "ignore" });
    return result.status === 0;
  }

  if (process.platform === "win32") {
    const candidates = [
      process.env.LOCALAPPDATA
        ? join(process.env.LOCALAPPDATA, "Programs", "One Status", "One Status.exe")
        : "",
      process.env.ProgramFiles
        ? join(process.env.ProgramFiles, "One Status", "One Status.exe")
        : "",
      process.env["ProgramFiles(x86)"]
        ? join(process.env["ProgramFiles(x86)"]!, "One Status", "One Status.exe")
        : "",
    ].filter(Boolean);
    const installed = candidates.find((candidate) => existsSync(candidate));
    if (!installed) return false;
    spawn(installed, [], { detached: true, stdio: "ignore" }).unref();
    return true;
  }

  const candidates = [
    join(homedir(), ".local", "bin", "one-status-app"),
    join(homedir(), ".local", "bin", "one-status-desktop"),
    "/usr/local/bin/one-status-desktop",
  ];
  const installed = candidates.find((candidate) => existsSync(candidate));
  if (!installed) return false;
  spawn(installed, [], { detached: true, stdio: "ignore" }).unref();
  return true;
}

async function isHealthyLocalService(baseUrl: string): Promise<boolean> {
  try {
    const response = await fetch(new URL("/health", baseUrl), {
      signal: AbortSignal.timeout(1_000),
    });
    if (!response.ok) return false;
    const body = (await response.json()) as Record<string, unknown>;
    return body.status === "ok" && body.service === "one-status-api";
  } catch {
    return false;
  }
}

function openExternalApplicationUrl(url: string): boolean {
  if (process.platform === "darwin") {
    return spawnSync("open", [url], { stdio: "ignore" }).status === 0;
  }
  if (process.platform === "win32") {
    return (
      spawnSync("cmd", ["/d", "/s", "/c", "start", "", url], {
        stdio: "ignore",
      }).status === 0
    );
  }
  return spawnSync("xdg-open", [url], { stdio: "ignore" }).status === 0;
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
  ONE_STATUS_PASSWORD=... one-status login --email <email> --device <name>
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
  one-status mcp --transport stdio [--agent <agent-id>]
  one-status mcp --transport http [--agent <agent-id>] [--host <host>] [--port <port>] [--endpoint </mcp>] [--max-sessions-per-principal <count>]
  one-status server [--host <host>] [--port <port>] [--db <path>] [--workspace-db <path>] [--public-url <url>] [--trust-proxy true] [--device-relay true] [--remote-mcp true] [--oauth-issuer <url>] [--mcp-resource <url>]
  one-status vault-server [--host <host>] [--port <port>] [--migrate true|false]
  one-status review-relay [--relay-url <wss-url>]
  one-status app
  one-status handoff --project <id> --agent claude-code|codex [--publish]
  one-status capability list
  one-status capability preview --pack <name> --target codex|claude-code|markdown|local-mcp
  one-status capability install --pack <name> --target <target> --approval <sha256> --confirm
  one-status version

Environment:
  ONE_STATUS_URL         Sync API URL (default: http://127.0.0.1:8787)
  ONE_STATUS_DEFAULT_SYNC_URL  Default server shown by graphical onboarding
  ONE_STATUS_HOME        Local profile directory
  ONE_STATUS_PASSWORD    Account password for register/login
  ONE_STATUS_PASSWORD_FILE  File containing the account password
  ONE_STATUS_TOOL_GATEWAY_URL  Local or HTTPS Permission Vault API base URL
  ONE_STATUS_AGENT_ID    Identity bound into the short-lived Gateway credential
  ONE_STATUS_AGENT_TOKEN Optional pre-issued Agent credential (osa1_...)
  ONE_STATUS_AGENT_TOKEN_FILE  File containing a pre-issued Agent credential
  ONE_STATUS_MCP_BEARER_TOKEN  Required for non-loopback HTTP MCP
  ONE_STATUS_MCP_BEARER_TOKEN_FILE  File containing the HTTP MCP bearer
  ONE_STATUS_PERMISSION_DB  Permission Vault SQLite path
  ONE_STATUS_PERMISSION_KEY_FILE  Permission Vault encryption key path
  ONE_STATUS_WORKSPACE_DB  Device-local project mapping SQLite path
  ONE_STATUS_DASHBOARD_URL  Local dashboard URL used by handoff (default: http://127.0.0.1:8787)
  ONE_STATUS_PUBLIC_URL  Public HTTPS base URL for OAuth callbacks
  ONE_STATUS_TRUST_PROXY  Trust reverse-proxy forwarding headers (true/false)
  ONE_STATUS_DEVICE_RELAY  Enable the authenticated outbound-device WSS relay (true/false)
  ONE_STATUS_REMOTE_MCP  Enable OAuth, Remote MCP, and Device Relay (true/false)
  ONE_STATUS_OAUTH_ISSUER  Public OAuth Authorization Server URL
  ONE_STATUS_REMOTE_MCP_RESOURCE  Public Remote MCP resource URL
  ONE_STATUS_REVIEW_DEVICE_TOKEN  Dedicated review-fixture device token
  ONE_STATUS_REVIEW_DEVICE_TOKEN_FILE  File containing the review device token
  ONE_STATUS_REVIEW_RELAY_URL  Public WSS Device Relay URL
  ONE_STATUS_OAUTH_DB  OAuth state database path (defaults to ONE_STATUS_DB)
  ONE_STATUS_VAULT_DATABASE_URL  PostgreSQL URL for the internal Vault Service
  ONE_STATUS_VAULT_DATABASE_SSL  disable, require, or verify-full (default: verify-full)
  ONE_STATUS_VAULT_SERVICE_TOKEN  Internal service Bearer token (required)
  ONE_STATUS_VAULT_KMS_KEY_ID  Tencent Cloud KMS CMK ID (required)
  ONE_STATUS_VAULT_KMS_REGION  Tencent Cloud KMS region
  TENCENTCLOUD_SECRET_ID / TENCENTCLOUD_SECRET_KEY  Tencent Cloud KMS credentials
`);
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});

export type { StatusDocument };
