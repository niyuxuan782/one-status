import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import {
  access,
  lstat,
  readFile,
  readdir,
  realpath,
  stat,
} from "node:fs/promises";
import { constants } from "node:fs";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import {
  basename,
  delimiter,
  dirname,
  join,
  resolve,
} from "node:path";
import { parse as parseToml } from "smol-toml";
import { parse as parseYaml } from "yaml";
import type { DatabaseSync as DatabaseSyncType } from "node:sqlite";

const nodeRequire = createRequire(import.meta.url);

const MAX_CONFIG_BYTES = 2 * 1024 * 1024;
const MAX_SKILL_BYTES = 128 * 1024;
const MAX_PROJECTS = 200;
const MAX_SKILLS = 200;
const COMMAND_TIMEOUT_MS = 10_000;
const FILESYSTEM_TIMEOUT_MS = 1_000;

export interface LocalAgentAsset {
  id: "claude-code" | "codex" | "cursor";
  installed: boolean;
  name: string;
  path?: string;
  version?: string;
  model?: LocalAgentModelConfiguration;
}

export interface LocalAgentModelConfiguration {
  credentialFingerprint?: string;
  modelId?: string;
  providerId: string;
  providerLabel: string;
  sourceKind:
    | "official-account"
    | "official-api"
    | "compatible-api"
    | "local-service"
    | "custom-endpoint";
  protocol: "openai" | "anthropic" | "ollama" | "azure-openai" | "custom";
  endpoint?: string;
  endpointHost?: string;
  credentialStatus: "available" | "missing" | "not-required" | "unverified";
  health: "healthy" | "unconfigured" | "error" | "unknown";
}

export interface LocalModelCredentialDiscovery {
  apiKey: string;
  credentialFingerprint: string;
  model: LocalAgentModelConfiguration;
  sourceId: string;
  toolId: "claude-code" | "codex";
}

export interface LocalProjectAsset {
  agents: string[];
  branch?: string;
  git: boolean;
  id: string;
  markers: string[];
  name: string;
  path: string;
}

export interface LocalMcpAsset {
  agent: string;
  command?: string;
  enabled: boolean;
  endpoint?: string;
  envNames: string[];
  name: string;
  transport: string;
}

export interface LocalSkillAsset {
  agent: string;
  description?: string;
  name: string;
  path: string;
}

export interface LocalPluginAsset {
  agent: string;
  enabled: boolean;
  name: string;
  version?: string;
}

export interface LocalRuleAsset {
  agent: string;
  modifiedAt: string;
  path: string;
  scope: "global" | "project";
  size: number;
  type: string;
}

export interface LocalInventorySnapshot {
  agents: LocalAgentAsset[];
  mcpServers: LocalMcpAsset[];
  plugins: LocalPluginAsset[];
  projects: LocalProjectAsset[];
  rules: LocalRuleAsset[];
  scannedAt: string;
  schemaVersion: 1;
  skills: LocalSkillAsset[];
  warnings: string[];
}

export interface LocalInventoryOptions {
  ccSwitchDbPath?: string;
  environment?: NodeJS.ProcessEnv;
  homeDir?: string;
  runCommand?: (
    executable: string,
    arguments_: string[],
  ) => Promise<string>;
}

export class LocalInventoryService {
  #current?: LocalInventorySnapshot;
  #refreshing?: Promise<LocalInventorySnapshot>;

  constructor(private readonly options: LocalInventoryOptions = {}) {}

  async get(): Promise<LocalInventorySnapshot> {
    return this.#current ?? this.refresh();
  }

  async refresh(): Promise<LocalInventorySnapshot> {
    if (this.#refreshing) return this.#refreshing;
    this.#refreshing = scanLocalInventory(this.options).then((snapshot) => {
      this.#current = snapshot;
      return snapshot;
    });
    try {
      return await this.#refreshing;
    } finally {
      this.#refreshing = undefined;
    }
  }

  async discoverModelCredentials(): Promise<LocalModelCredentialDiscovery[]> {
    return discoverLocalModelCredentials(this.options);
  }
}

export async function scanLocalInventory(
  options: LocalInventoryOptions = {},
): Promise<LocalInventorySnapshot> {
  const environment = options.environment ?? process.env;
  const home = options.homeDir ?? homedir();
  const runCommand = options.runCommand ?? runLocalCommand;
  const runAgentCommands =
    environment.ONE_STATUS_INVENTORY_RUN_AGENT_COMMANDS === "true";
  const warnings: string[] = [];
  const executables = {
    codex: await findExecutable("codex", environment, home),
    claude: await findExecutable("claude", environment, home),
    cursor: await findExecutable("cursor", environment, home),
  };
  const codexConfig = await readStructuredFile(
    join(environment.CODEX_HOME ?? join(home, ".codex"), "config.toml"),
    "toml",
    warnings,
  );
  const codexAuth = await readStructuredFile(
    join(environment.CODEX_HOME ?? join(home, ".codex"), "auth.json"),
    "json",
    warnings,
  );
  const claudeConfig = await readStructuredFile(
    join(home, ".claude.json"),
    "json",
    warnings,
  );
  const claudeSettings = await readStructuredFile(
    join(home, ".claude", "settings.json"),
    "json",
    warnings,
  );
  const agents = await Promise.all([
    inspectAgent(
      "codex",
      "Codex",
      executables.codex,
      runCommand,
      runAgentCommands,
      readCodexModelConfiguration(codexConfig, codexAuth, environment),
    ),
    inspectAgent(
      "claude-code",
      "Claude Code",
      executables.claude,
      runCommand,
      runAgentCommands,
      readClaudeModelConfiguration(claudeSettings, environment),
    ),
    inspectAgent("cursor", "Cursor", executables.cursor, runCommand, false),
  ]);
  const projectSources = new Map<string, Set<string>>();
  collectProjectKeys(codexConfig, "codex", projectSources);
  collectProjectKeys(claudeConfig, "claude-code", projectSources);
  for (const root of splitScanRoots(environment.ONE_STATUS_SCAN_ROOTS)) {
    addProjectSource(projectSources, root, "explicit");
  }

  const projects: LocalProjectAsset[] = [];
  for (const [path, sources] of [...projectSources].slice(0, MAX_PROJECTS)) {
    const project = await inspectProject(
      path,
      [...sources],
      warnings,
      sources.has("explicit"),
    );
    if (project) projects.push(project);
  }
  projects.sort((left, right) => left.name.localeCompare(right.name));

  const configuredCodexMcp = readCodexMcpConfig(codexConfig);
  const commandCodexMcp = runAgentCommands && executables.codex
    ? await readCodexMcp(executables.codex, runCommand, warnings)
    : [];
  const configuredCodexPlugins = readCodexPluginsConfig(codexConfig);
  const commandCodexPlugins = runAgentCommands && executables.codex
    ? await readCodexPlugins(executables.codex, runCommand, warnings)
    : [];
  const codexMcp = mergeNamedAssets(configuredCodexMcp, commandCodexMcp);
  const codexPlugins = mergeNamedAssets(
    configuredCodexPlugins,
    commandCodexPlugins,
  );
  const claudeMcp = readClaudeMcp(claudeConfig);
  const claudePlugins = await readClaudePlugins(home, warnings);
  const skills = [
    ...(await scanSkillRoot(
      join(environment.CODEX_HOME ?? join(home, ".codex"), "skills"),
      "codex",
      warnings,
    )),
    ...(await scanSkillRoot(
      join(home, ".claude", "skills"),
      "claude-code",
      warnings,
    )),
  ].slice(0, MAX_SKILLS);
  const rules = await scanRules(home, environment, projects, warnings);

  return {
    schemaVersion: 1,
    scannedAt: new Date().toISOString(),
    agents,
    projects,
    mcpServers: [...codexMcp, ...claudeMcp].sort(assetSort),
    plugins: [...codexPlugins, ...claudePlugins].sort(assetSort),
    skills: skills.sort(assetSort),
    rules: rules.sort((left, right) => left.path.localeCompare(right.path)),
    warnings,
  };
}

export async function discoverLocalModelCredentials(
  options: LocalInventoryOptions = {},
): Promise<LocalModelCredentialDiscovery[]> {
  const environment = options.environment ?? process.env;
  const home = options.homeDir ?? homedir();
  const warnings: string[] = [];
  const codexHome = environment.CODEX_HOME ?? join(home, ".codex");
  const [codexConfig, codexAuth, claudeSettings] = await Promise.all([
    readStructuredFile(join(codexHome, "config.toml"), "toml", warnings),
    readStructuredFile(join(codexHome, "auth.json"), "json", warnings),
    readStructuredFile(
      join(home, ".claude", "settings.json"),
      "json",
      warnings,
    ),
  ]);
  const candidates: Array<{
    apiKey?: string;
    model: LocalAgentModelConfiguration;
    toolId: LocalModelCredentialDiscovery["toolId"];
  }> = [
    ...readCodexCredentialCandidates(codexConfig, codexAuth, environment),
    {
      apiKey: readClaudeApiKey(claudeSettings, environment),
      model: readClaudeModelConfiguration(claudeSettings, environment),
      toolId: "claude-code",
    },
    ...readCcSwitchCredentialCandidates(
      options.ccSwitchDbPath ?? join(home, ".cc-switch", "cc-switch.db"),
      environment,
    ),
  ];
  const discoveries = new Map<string, LocalModelCredentialDiscovery>();
  for (const candidate of candidates) {
    if (!candidate.apiKey || !candidate.model.credentialFingerprint) continue;
    const sourceId = localModelSourceId(candidate.model);
    discoveries.set(sourceId, {
      apiKey: candidate.apiKey,
      credentialFingerprint: candidate.model.credentialFingerprint,
      model: candidate.model,
      sourceId,
      toolId: candidate.toolId,
    });
  }
  return [...discoveries.values()];
}

function readCodexModelConfiguration(
  config: Record<string, unknown>,
  auth: Record<string, unknown>,
  environment: NodeJS.ProcessEnv,
): LocalAgentModelConfiguration {
  const providerId = stringProperty(config, "model_provider") ?? "openai";
  return readCodexProviderModelConfiguration(
    providerId,
    config,
    auth,
    environment,
    true,
  );
}

function readCodexProviderModelConfiguration(
  providerId: string,
  config: Record<string, unknown>,
  auth: Record<string, unknown>,
  environment: NodeJS.ProcessEnv,
  active: boolean,
): LocalAgentModelConfiguration {
  const modelId = active ? stringProperty(config, "model") : undefined;
  const providers = isRecord(config.model_providers)
    ? config.model_providers
    : {};
  const provider = isRecord(providers[providerId]) ? providers[providerId] : {};
  const endpoint = safeModelEndpoint(stringProperty(provider, "base_url"));
  const embeddedBearerAvailable = Boolean(
    stringProperty(provider, "experimental_bearer_token"),
  );
  const apiKey = readCodexProviderApiKey(
    providerId,
    provider,
    auth,
    environment,
    active,
  );
  const credentialAvailable = Boolean(apiKey);
  const sourceKind = sourceKindForEndpoint(
    endpoint,
    credentialAvailable,
    providerId === "openai",
  );
  const credentialStatus = credentialStatusForSource(
    sourceKind,
    credentialAvailable,
    embeddedBearerAvailable,
  );
  return {
    ...(modelId ? { modelId } : {}),
    ...(apiKey
      ? { credentialFingerprint: modelCredentialFingerprint(apiKey) }
      : {}),
    providerId,
    providerLabel:
      stringProperty(provider, "name") ??
      (providerId === "openai" ? "OpenAI" : providerId),
    sourceKind,
    protocol: "openai",
    ...(endpoint
      ? { endpoint, endpointHost: new URL(endpoint).host }
      : {}),
    credentialStatus,
    health: !modelId
      ? "unconfigured"
      : credentialStatus === "missing"
        ? "error"
        : credentialStatus === "unverified"
          ? "unknown"
        : "healthy",
  };
}

function readClaudeModelConfiguration(
  settings: Record<string, unknown>,
  environment: NodeJS.ProcessEnv,
): LocalAgentModelConfiguration {
  const settingsEnvironment = isRecord(settings.env) ? settings.env : {};
  const modelId =
    stringProperty(settings, "model") ??
    stringProperty(settingsEnvironment, "ANTHROPIC_MODEL") ??
    environment.ANTHROPIC_MODEL ??
    "default";
  const endpoint = safeModelEndpoint(
    stringProperty(settingsEnvironment, "ANTHROPIC_BASE_URL") ??
      environment.ANTHROPIC_BASE_URL,
  );
  const apiKey = readClaudeApiKey(settings, environment);
  const credentialAvailable = Boolean(apiKey);
  const sourceKind = sourceKindForEndpoint(
    endpoint,
    credentialAvailable,
    true,
  );
  const providerId = endpoint ? `anthropic-${shortHash(endpoint)}` : "anthropic";
  return {
    modelId,
    ...(apiKey
      ? { credentialFingerprint: modelCredentialFingerprint(apiKey) }
      : {}),
    providerId,
    providerLabel: endpoint ? "Anthropic compatible" : "Anthropic",
    sourceKind,
    protocol: "anthropic",
    ...(endpoint
      ? { endpoint, endpointHost: new URL(endpoint).host }
      : {}),
    credentialStatus: credentialStatusForSource(
      sourceKind,
      credentialAvailable,
      false,
    ),
    health: "healthy",
  };
}

function readCodexApiKey(
  config: Record<string, unknown>,
  auth: Record<string, unknown>,
  environment: NodeJS.ProcessEnv,
): string | undefined {
  const providerId = stringProperty(config, "model_provider") ?? "openai";
  const providers = isRecord(config.model_providers)
    ? config.model_providers
    : {};
  const provider = isRecord(providers[providerId]) ? providers[providerId] : {};
  return readCodexProviderApiKey(
    providerId,
    provider,
    auth,
    environment,
    true,
  );
}

function readCodexProviderApiKey(
  providerId: string,
  provider: Record<string, unknown>,
  auth: Record<string, unknown>,
  environment: NodeJS.ProcessEnv,
  allowDefaultCredential: boolean,
): string | undefined {
  const embedded = stringProperty(provider, "experimental_bearer_token");
  if (embedded) return embedded;
  const environmentKey = stringProperty(provider, "env_key");
  if (environmentKey) return normalizedSecret(environment[environmentKey]);
  if (!allowDefaultCredential && providerId !== "openai") return undefined;
  return (
    normalizedSecret(stringProperty(auth, "OPENAI_API_KEY")) ??
    normalizedSecret(environment.OPENAI_API_KEY)
  );
}

function readCodexCredentialCandidates(
  config: Record<string, unknown>,
  auth: Record<string, unknown>,
  environment: NodeJS.ProcessEnv,
): Array<{
  apiKey?: string;
  model: LocalAgentModelConfiguration;
  toolId: "codex";
}> {
  const activeProviderId = stringProperty(config, "model_provider") ?? "openai";
  const providers = isRecord(config.model_providers)
    ? config.model_providers
    : {};
  const providerIds = new Set([
    activeProviderId,
    ...Object.keys(providers).slice(0, 500),
  ]);
  return [...providerIds].map((providerId) => {
    const provider = isRecord(providers[providerId]) ? providers[providerId] : {};
    return {
      apiKey: readCodexProviderApiKey(
        providerId,
        provider,
        auth,
        environment,
        providerId === activeProviderId,
      ),
      model: readCodexProviderModelConfiguration(
        providerId,
        config,
        auth,
        environment,
        providerId === activeProviderId,
      ),
      toolId: "codex" as const,
    };
  });
}

function readCcSwitchCredentialCandidates(
  databasePath: string,
  environment: NodeJS.ProcessEnv,
): Array<{
  apiKey?: string;
  model: LocalAgentModelConfiguration;
  toolId: LocalModelCredentialDiscovery["toolId"];
}> {
  let database: DatabaseSyncType | undefined;
  try {
    const { DatabaseSync } = nodeRequire("node:sqlite") as typeof import("node:sqlite");
    database = new DatabaseSync(databasePath, { readOnly: true });
    const table = database
      .prepare(
        "SELECT 1 AS present FROM sqlite_master WHERE type = 'table' AND name = 'providers'",
      )
      .get() as { present?: number } | undefined;
    if (!table?.present) return [];
    const rows = database
      .prepare(
        `SELECT id, app_type, name, settings_config
          FROM providers
          WHERE app_type IN ('codex', 'claude')
          ORDER BY app_type, id
          LIMIT 1000`,
      )
      .all() as Array<{
        app_type: "claude" | "codex";
        id: string;
        name: string;
        settings_config: string;
      }>;
    const candidates: ReturnType<typeof readCcSwitchCredentialCandidates> = [];
    for (const row of rows) {
      if (row.settings_config.length > MAX_CONFIG_BYTES) continue;
      let settings: Record<string, unknown>;
      try {
        const parsed = JSON.parse(row.settings_config) as unknown;
        if (!isRecord(parsed)) continue;
        settings = parsed;
      } catch {
        continue;
      }
      if (row.app_type === "claude") {
        const model = readClaudeModelConfiguration(settings, environment);
        model.providerLabel = row.name || model.providerLabel;
        candidates.push({
          apiKey: readClaudeApiKey(settings, environment),
          model,
          toolId: "claude-code",
        });
        continue;
      }
      const auth = isRecord(settings.auth) ? settings.auth : {};
      const configText = stringProperty(settings, "config") ?? "";
      let config: Record<string, unknown> = {};
      try {
        const parsed = parseToml(configText) as unknown;
        if (isRecord(parsed)) config = parsed;
      } catch {
        // A saved credential can still be imported when its optional TOML is invalid.
      }
      const fallbackProviderId = `cc-switch-${normalizeControlId(row.id)}`;
      const providerId = stringProperty(config, "model_provider") ?? fallbackProviderId;
      const providers = isRecord(config.model_providers)
        ? config.model_providers
        : {};
      const provider = isRecord(providers[providerId]) ? providers[providerId] : {};
      const apiKey = readCodexProviderApiKey(
        providerId,
        provider,
        auth,
        environment,
        true,
      );
      const model = readCodexProviderModelConfiguration(
        providerId,
        config,
        auth,
        environment,
        true,
      );
      model.providerLabel = row.name || model.providerLabel;
      if (apiKey && !model.credentialFingerprint) {
        model.credentialFingerprint = modelCredentialFingerprint(apiKey);
        model.credentialStatus = "available";
      }
      candidates.push({ apiKey, model, toolId: "codex" });
    }
    return candidates;
  } catch {
    return [];
  } finally {
    database?.close();
  }
}

function readClaudeApiKey(
  settings: Record<string, unknown>,
  environment: NodeJS.ProcessEnv,
): string | undefined {
  const settingsEnvironment = isRecord(settings.env) ? settings.env : {};
  return (
    normalizedSecret(stringProperty(settingsEnvironment, "ANTHROPIC_API_KEY")) ??
    normalizedSecret(environment.ANTHROPIC_API_KEY) ??
    normalizedSecret(
      stringProperty(settingsEnvironment, "ANTHROPIC_AUTH_TOKEN"),
    ) ??
    normalizedSecret(environment.ANTHROPIC_AUTH_TOKEN)
  );
}

export function localModelSourceId(
  model: Pick<
    LocalAgentModelConfiguration,
    "credentialFingerprint" | "providerId"
  >,
): string {
  const base = normalizeControlId(model.providerId);
  return model.credentialFingerprint
    ? `${base}-${model.credentialFingerprint.slice(0, 16)}`
    : base;
}

function modelCredentialFingerprint(apiKey: string): string {
  return createHash("sha256")
    .update("one-status/model-credential/v1\0", "utf8")
    .update(apiKey, "utf8")
    .digest("hex");
}

function normalizedSecret(value?: string): string | undefined {
  const normalized = value?.trim();
  return normalized && normalized.length <= 32_000 ? normalized : undefined;
}

function normalizeControlId(value: string): string {
  const normalized = value
    .trim()
    .replace(/[^A-Za-z0-9._:-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 160);
  return normalized || `source-${shortHash(value)}`;
}

function sourceKindForEndpoint(
  endpoint: string | undefined,
  credentialAvailable: boolean,
  official: boolean,
): LocalAgentModelConfiguration["sourceKind"] {
  if (endpoint) {
    const hostname = new URL(endpoint).hostname;
    return isLoopbackHostname(hostname) ? "local-service" : "compatible-api";
  }
  return official && !credentialAvailable ? "official-account" : "official-api";
}

function credentialStatusForSource(
  sourceKind: LocalAgentModelConfiguration["sourceKind"],
  available: boolean,
  explicitlyConfigured: boolean,
): LocalAgentModelConfiguration["credentialStatus"] {
  if (sourceKind === "official-account" || sourceKind === "local-service") {
    return "not-required";
  }
  if (available) return "available";
  return explicitlyConfigured ? "missing" : "unverified";
}

function safeModelEndpoint(value?: string): string | undefined {
  if (!value) return undefined;
  try {
    const url = new URL(value);
    if (url.protocol !== "http:" && url.protocol !== "https:") return undefined;
    url.username = "";
    url.password = "";
    url.search = "";
    url.hash = "";
    return url.toString().replace(/\/$/, "");
  } catch {
    return undefined;
  }
}

function isLoopbackHostname(hostname: string): boolean {
  return (
    hostname === "127.0.0.1" ||
    hostname === "localhost" ||
    hostname === "::1" ||
    hostname === "0.0.0.0"
  );
}

function stringProperty(
  value: Record<string, unknown>,
  key: string,
): string | undefined {
  const candidate = value[key];
  return typeof candidate === "string" && candidate.trim()
    ? candidate.trim()
    : undefined;
}

function shortHash(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 12);
}

async function inspectAgent(
  id: LocalAgentAsset["id"],
  name: string,
  path: string | undefined,
  runCommand: LocalInventoryOptions["runCommand"] extends infer _T
    ? (executable: string, arguments_: string[]) => Promise<string>
    : never,
  readVersion = true,
  model?: LocalAgentModelConfiguration,
): Promise<LocalAgentAsset> {
  if (!path) return { id, name, installed: false };
  let version: string | undefined;
  if (readVersion) {
    try {
      version = (await runCommand(path, ["--version"])).trim().slice(0, 120);
    } catch {
      version = undefined;
    }
  }
  return {
    id,
    name,
    installed: true,
    path,
    ...(version ? { version } : {}),
    ...(model ? { model } : {}),
  };
}

async function findExecutable(
  name: string,
  environment: NodeJS.ProcessEnv,
  home: string,
): Promise<string | undefined> {
  const candidates = [
    ...(environment.PATH ?? "")
      .split(delimiter)
      .filter(Boolean)
      .map((directory) => join(directory, name)),
    join(home, ".local", "bin", name),
    join(home, ".volta", "bin", name),
    join("/opt/homebrew/bin", name),
    join("/usr/local/bin", name),
    ...(name === "codex"
      ? ["/Applications/ChatGPT.app/Contents/Resources/codex"]
      : []),
    ...(name === "cursor"
      ? ["/Applications/Cursor.app/Contents/MacOS/Cursor"]
      : []),
  ];
  for (const candidate of [...new Set(candidates)]) {
    try {
      await withTimeout(access(candidate, constants.X_OK));
      return candidate;
    } catch {
      continue;
    }
  }
  return undefined;
}

async function runLocalCommand(
  executable: string,
  arguments_: string[],
): Promise<string> {
  return new Promise((resolvePromise, reject) => {
    execFile(
      executable,
      arguments_,
      {
        encoding: "utf8",
        maxBuffer: MAX_CONFIG_BYTES,
        timeout: COMMAND_TIMEOUT_MS,
      },
      (error, stdout) => {
        if (error) reject(error);
        else resolvePromise(stdout);
      },
    );
  });
}

async function readStructuredFile(
  path: string,
  format: "json" | "toml",
  warnings: string[],
): Promise<Record<string, unknown>> {
  try {
    const text = await readLimitedText(path, MAX_CONFIG_BYTES);
    const parsed = format === "json" ? JSON.parse(text) : parseToml(text);
    return isRecord(parsed) ? parsed : {};
  } catch (error) {
    if (!isMissing(error)) warnings.push(`无法读取配置：${path}`);
    return {};
  }
}

function collectProjectKeys(
  config: Record<string, unknown>,
  agent: string,
  projects: Map<string, Set<string>>,
): void {
  if (!isRecord(config.projects)) return;
  for (const path of Object.keys(config.projects)) {
    if (path.startsWith("/")) addProjectSource(projects, path, agent);
  }
}

function addProjectSource(
  projects: Map<string, Set<string>>,
  path: string,
  source: string,
): void {
  const normalized = resolve(path);
  const sources = projects.get(normalized) ?? new Set<string>();
  sources.add(source);
  projects.set(normalized, sources);
}

function splitScanRoots(value?: string): string[] {
  return value
    ? value
        .split(delimiter)
        .map((entry) => entry.trim())
        .filter(Boolean)
    : [];
}

async function inspectProject(
  path: string,
  agents: string[],
  warnings: string[],
  inspectFiles: boolean,
): Promise<LocalProjectAsset | undefined> {
  if (!inspectFiles) {
    const normalized = resolve(path);
    return {
      id: createHash("sha256").update(normalized).digest("base64url"),
      name: basename(normalized),
      path: normalized,
      agents: agents.filter((agent) => agent !== "explicit").sort(),
      markers: [],
      git: false,
    };
  }
  try {
    const entry = await withTimeout(lstat(path));
    if (!entry.isDirectory() || entry.isSymbolicLink()) return undefined;
    const canonical = await withTimeout(realpath(path));
    const markerNames = [
      "AGENTS.md",
      "CLAUDE.md",
      "Cargo.toml",
      "README.md",
      "go.mod",
      "package.json",
      "pyproject.toml",
    ];
    const markers: string[] = [];
    for (const marker of markerNames) {
      if (await pathExists(join(canonical, marker))) markers.push(marker);
    }
    const gitPath = join(canonical, ".git");
    const git = await pathExists(gitPath);
    const branch = git ? await readGitBranch(gitPath) : undefined;
    return {
      id: createHash("sha256").update(canonical).digest("base64url"),
      name: basename(canonical),
      path: canonical,
      agents: agents.filter((agent) => agent !== "explicit").sort(),
      markers,
      git,
      ...(branch ? { branch } : {}),
    };
  } catch (error) {
    if (!isMissing(error)) warnings.push(`无法检查项目：${path}`);
    return undefined;
  }
}

function readCodexMcpConfig(
  config: Record<string, unknown>,
): LocalMcpAsset[] {
  if (!isRecord(config.mcp_servers)) return [];
  return Object.entries(config.mcp_servers).flatMap(([name, value]) =>
    isRecord(value) ? [sanitizeMcp("codex", name, value)] : [],
  );
}

async function readGitBranch(gitPath: string): Promise<string | undefined> {
  try {
    const gitStat = await withTimeout(lstat(gitPath));
    if (!gitStat.isDirectory() || gitStat.isSymbolicLink()) return undefined;
    const head = (await readLimitedText(join(gitPath, "HEAD"), 4_096)).trim();
    return head.startsWith("ref: refs/heads/")
      ? head.slice("ref: refs/heads/".length)
      : head.slice(0, 12);
  } catch {
    return undefined;
  }
}

async function readCodexMcp(
  executable: string,
  runCommand: (executable: string, arguments_: string[]) => Promise<string>,
  warnings: string[],
): Promise<LocalMcpAsset[]> {
  try {
    const parsed = JSON.parse(await runCommand(executable, ["mcp", "list", "--json"]));
    if (!Array.isArray(parsed)) return [];
    return parsed.flatMap((value) => {
      if (!isRecord(value) || typeof value.name !== "string") return [];
      return [sanitizeMcp("codex", value.name, value)];
    });
  } catch {
    warnings.push("Codex MCP 清单读取失败");
    return [];
  }
}

function readClaudeMcp(config: Record<string, unknown>): LocalMcpAsset[] {
  if (!isRecord(config.mcpServers)) return [];
  return Object.entries(config.mcpServers).flatMap(([name, value]) =>
    isRecord(value) ? [sanitizeMcp("claude-code", name, value)] : [],
  );
}

function sanitizeMcp(
  agent: string,
  name: string,
  source: Record<string, unknown>,
): LocalMcpAsset {
  const transport = isRecord(source.transport) ? source.transport : source;
  const envNames = new Set<string>();
  if (isRecord(transport.env)) {
    for (const key of Object.keys(transport.env)) envNames.add(key);
  }
  if (Array.isArray(transport.env_vars)) {
    for (const key of transport.env_vars) {
      if (typeof key === "string") envNames.add(key);
    }
  }
  if (typeof transport.bearer_token_env_var === "string") {
    envNames.add(transport.bearer_token_env_var);
  }
  return {
    agent,
    name,
    enabled: source.enabled !== false,
    transport:
      typeof transport.type === "string"
        ? transport.type
        : typeof transport.command === "string"
          ? "stdio"
          : "http",
    ...(typeof transport.command === "string"
      ? { command: basename(transport.command) }
      : {}),
    ...(typeof transport.url === "string"
      ? { endpoint: sanitizeEndpoint(transport.url) }
      : {}),
    envNames: [...envNames].sort(),
  };
}

function sanitizeEndpoint(value: string): string | undefined {
  try {
    const url = new URL(value);
    return `${url.origin}${url.pathname}`;
  } catch {
    return undefined;
  }
}

async function readCodexPlugins(
  executable: string,
  runCommand: (executable: string, arguments_: string[]) => Promise<string>,
  warnings: string[],
): Promise<LocalPluginAsset[]> {
  try {
    const parsed = JSON.parse(
      await runCommand(executable, ["plugin", "list", "--json"]),
    );
    if (!isRecord(parsed) || !Array.isArray(parsed.installed)) return [];
    return parsed.installed.flatMap((value) => {
      if (!isRecord(value)) return [];
      const name =
        typeof value.name === "string"
          ? value.name
          : typeof value.pluginId === "string"
            ? value.pluginId
            : undefined;
      if (!name) return [];
      return [
        {
          agent: "codex",
          name,
          enabled: value.enabled !== false,
          ...(typeof value.version === "string" ? { version: value.version } : {}),
        },
      ];
    });
  } catch {
    warnings.push("Codex Plugin 清单读取失败");
    return [];
  }
}

function readCodexPluginsConfig(
  config: Record<string, unknown>,
): LocalPluginAsset[] {
  if (!isRecord(config.plugins)) return [];
  return Object.entries(config.plugins).flatMap(([name, value]) =>
    isRecord(value)
      ? [
          {
            agent: "codex",
            name,
            enabled: value.enabled !== false,
          },
        ]
      : [],
  );
}

async function readClaudePlugins(
  home: string,
  warnings: string[],
): Promise<LocalPluginAsset[]> {
  const config = await readStructuredFile(
    join(home, ".claude", "plugins", "installed_plugins.json"),
    "json",
    warnings,
  );
  if (!isRecord(config.plugins)) return [];
  return Object.entries(config.plugins).flatMap(([name, installations]) => {
    if (!Array.isArray(installations) || !isRecord(installations[0])) return [];
    const installation = installations[0];
    return [
      {
        agent: "claude-code",
        name,
        enabled: true,
        ...(typeof installation.version === "string"
          ? { version: installation.version }
          : {}),
      },
    ];
  });
}

async function scanSkillRoot(
  root: string,
  agent: string,
  warnings: string[],
): Promise<LocalSkillAsset[]> {
  const skills: LocalSkillAsset[] = [];
  async function visit(directory: string, depth: number): Promise<void> {
    if (depth > 4 || skills.length >= MAX_SKILLS) return;
    let entries;
    try {
      entries = await withTimeout(readdir(directory, { withFileTypes: true }));
    } catch (error) {
      if (depth === 0 && !isMissing(error)) {
        warnings.push(`无法读取 Skills：${root}`);
      }
      return;
    }
    for (const entry of entries) {
      if (entry.isSymbolicLink()) continue;
      const path = join(directory, entry.name);
      if (entry.isDirectory()) {
        await visit(path, depth + 1);
      } else if (entry.isFile() && entry.name === "SKILL.md") {
        const metadata = await readSkillMetadata(path);
        skills.push({
          agent,
          name: metadata.name ?? basename(dirname(path)),
          path,
          ...(metadata.description
            ? { description: metadata.description.slice(0, 240) }
            : {}),
        });
      }
      if (skills.length >= MAX_SKILLS) break;
    }
  }
  await visit(root, 0);
  return skills;
}

async function readSkillMetadata(
  path: string,
): Promise<{ description?: string; name?: string }> {
  try {
    const text = await readLimitedText(path, MAX_SKILL_BYTES);
    if (!text.startsWith("---")) return {};
    const end = text.indexOf("\n---", 3);
    if (end < 0) return {};
    const metadata = parseYaml(text.slice(3, end));
    if (!isRecord(metadata)) return {};
    return {
      ...(typeof metadata.name === "string" ? { name: metadata.name } : {}),
      ...(typeof metadata.description === "string"
        ? { description: metadata.description }
        : {}),
    };
  } catch {
    return {};
  }
}

async function scanRules(
  home: string,
  environment: NodeJS.ProcessEnv,
  projects: LocalProjectAsset[],
  warnings: string[],
): Promise<LocalRuleAsset[]> {
  const candidates: Array<{
    agent: string;
    path: string;
    scope: LocalRuleAsset["scope"];
    type: string;
  }> = [
    {
      agent: "codex",
      path: join(environment.CODEX_HOME ?? join(home, ".codex"), "AGENTS.md"),
      scope: "global",
      type: "AGENTS.md",
    },
    {
      agent: "claude-code",
      path: join(home, ".claude", "CLAUDE.md"),
      scope: "global",
      type: "CLAUDE.md",
    },
  ];
  for (const project of projects) {
    if (!project.markers.length) continue;
    candidates.push(
      {
        agent: "codex",
        path: join(project.path, "AGENTS.md"),
        scope: "project",
        type: "AGENTS.md",
      },
      {
        agent: "claude-code",
        path: join(project.path, "CLAUDE.md"),
        scope: "project",
        type: "CLAUDE.md",
      },
    );
  }
  const rules: LocalRuleAsset[] = [];
  for (const candidate of candidates) {
    try {
      const entry = await withTimeout(lstat(candidate.path));
      if (!entry.isFile() || entry.isSymbolicLink()) continue;
      rules.push({
        ...candidate,
        size: entry.size,
        modifiedAt: entry.mtime.toISOString(),
      });
    } catch (error) {
      if (!isMissing(error)) warnings.push(`无法检查规则：${candidate.path}`);
    }
  }
  return rules;
}

function mergeNamedAssets<T extends { agent: string; name: string }>(
  configured: T[],
  discovered: T[],
): T[] {
  const merged = new Map<string, T>();
  for (const asset of [...configured, ...discovered]) {
    merged.set(`${asset.agent}:${asset.name}`, asset);
  }
  return [...merged.values()];
}

async function readLimitedText(path: string, limit: number): Promise<string> {
  const metadata = await withTimeout(stat(path));
  if (metadata.size > limit) throw new Error("File exceeds inventory limit.");
  return withTimeout(readFile(path, "utf8"));
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await withTimeout(lstat(path));
    return true;
  } catch {
    return false;
  }
}

async function withTimeout<T>(promise: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(
      () => reject(new Error("Local inventory filesystem timeout.")),
      FILESYSTEM_TIMEOUT_MS,
    );
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function isMissing(error: unknown): boolean {
  return (
    error instanceof Error &&
    "code" in error &&
    (error as Error & { code?: string }).code === "ENOENT"
  );
}

function assetSort(
  left: { agent: string; name: string },
  right: { agent: string; name: string },
): number {
  return (
    left.agent.localeCompare(right.agent) || left.name.localeCompare(right.name)
  );
}
