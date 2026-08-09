import { createHash } from "node:crypto";
import {
  parseCapabilityPackManifest,
  type CapabilityPackManifest,
} from "@one-status/capability-pack/manifest";

const MAX_SOURCE_FILES = 256;
const MAX_SOURCE_BYTES = 5 * 1024 * 1024;
const MAX_RELATIVE_PATH_BYTES = 1_024;
const MAX_PATH_SEGMENT_BYTES = 255;
const MAX_PORTABLE_NAME_LENGTH = 64;
const GENERATED_FILE_MODE = 0o644;

export const adapterTargets = [
  "codex",
  "claude-code",
  "cursor",
  "markdown",
  "local-mcp",
] as const;

export type AdapterTarget = (typeof adapterTargets)[number];

export interface StdioCapabilityGateway {
  transport: "stdio";
  command: string;
  args?: readonly string[];
}

export interface HttpCapabilityGateway {
  transport: "http";
  url: string;
  bearerTokenEnvVar?: string;
}

export type CapabilityGateway =
  | StdioCapabilityGateway
  | HttpCapabilityGateway;

export type CapabilitySourceFiles = Readonly<Record<string, string>>;

export interface CapabilityCompileOptions {
  target: AdapterTarget;
  gateway: CapabilityGateway;
  sourceFiles?: CapabilitySourceFiles;
}

export interface CompiledCapabilityFile {
  relativePath: string;
  content: string;
  mediaType: "application/json" | "text/markdown" | "text/plain";
  mode: typeof GENERATED_FILE_MODE;
  sha256: string;
  purpose: "adapter-config" | "instructions" | "manifest" | "skill-resource";
}

export interface CapabilityCompilation {
  format: "one-status.capability-compilation";
  formatVersion: 1;
  planId: string;
  pack: {
    name: string;
    version: string;
  };
  target: AdapterTarget;
  files: CompiledCapabilityFile[];
  warnings: string[];
}

export interface ExistingInstallEntry {
  relativePath: string;
  kind?: "file" | "directory" | "symlink" | "other";
  content?: string;
  sha256?: string;
}

export interface AtomicWriteIntent {
  strategy: "atomic-rename";
  relativePath: string;
  stagingRelativePath: string;
  content: string;
  mode: typeof GENERATED_FILE_MODE;
  expectedPreviousSha256: string | null;
  sha256: string;
  createParents: true;
  rejectSymlinks: true;
  fsync: true;
}

export interface FileInstallPreview {
  relativePath: string;
  disposition: "create" | "update" | "unchanged" | "blocked";
  currentSha256: string | null;
  targetSha256: string;
  requiresApproval: boolean;
  blockedReason?: string;
  write?: AtomicWriteIntent;
  audit: {
    eventType: "capability.file.install";
    planId: string;
    packName: string;
    packVersion: string;
    target: AdapterTarget;
    relativePath: string;
    previousSha256: string | null;
    nextSha256: string;
  };
}

export interface CapabilityInstallPreview {
  format: "one-status.capability-install-preview";
  formatVersion: 1;
  planId: string;
  pack: CapabilityCompilation["pack"];
  target: AdapterTarget;
  dryRun: true;
  installable: boolean;
  creates: number;
  updates: number;
  unchanged: number;
  blocked: number;
  files: FileInstallPreview[];
}

interface MutableCompiledFile {
  relativePath: string;
  content: string;
  mediaType: CompiledCapabilityFile["mediaType"];
  purpose: CompiledCapabilityFile["purpose"];
}

/**
 * Compile a platform-neutral Capability Pack into target-owned relative files.
 * This function performs no filesystem access and never receives provider tokens.
 */
export function compileCapabilityPack(
  manifestInput: unknown,
  options: CapabilityCompileOptions,
): CapabilityCompilation {
  const manifest = parseCapabilityPackManifest(manifestInput);
  const target = parseTarget(options.target);
  const gateway = parseGateway(options.gateway);
  const sourceFiles = parseSourceFiles(options.sourceFiles ?? {});
  assertTargetDeclared(manifest, target);

  const warnings: string[] = [];
  const files = compileTarget(manifest, target, gateway, sourceFiles, warnings);
  files.push({
    relativePath: `.one-status/capabilities/${manifest.name}/manifest.json`,
    content: stableJson(manifest),
    mediaType: "application/json",
    purpose: "manifest",
  });

  const finalizedFiles = finalizeFiles(files);
  const planSeed = {
    format: "one-status.capability-compilation" as const,
    formatVersion: 1 as const,
    pack: { name: manifest.name, version: manifest.version },
    target,
    files: finalizedFiles,
    warnings: [...warnings].sort(),
  };
  return {
    ...planSeed,
    planId: sha256(stableJson(planSeed)),
  };
}

/**
 * Compare a compilation with a caller-supplied filesystem snapshot. The result
 * carries all preconditions required by an installer to avoid blind overwrites.
 */
export function createCapabilityInstallPreview(
  compilation: CapabilityCompilation,
  existingEntries: readonly ExistingInstallEntry[] = [],
): CapabilityInstallPreview {
  validateCompilation(compilation);
  const existing = new Map<string, ExistingInstallEntry>();
  const existingCollisionKeys = new Set<string>();
  for (const entry of existingEntries) {
    const relativePath = normalizeCapabilityRelativePath(entry.relativePath);
    const collisionKey = relativePath.toLowerCase();
    if (existingCollisionKeys.has(collisionKey)) {
      throw new Error(`Duplicate existing entry: ${relativePath}`);
    }
    existingCollisionKeys.add(collisionKey);
    if (entry.content !== undefined && entry.sha256 !== undefined) {
      const contentSha256 = sha256(entry.content);
      if (contentSha256 !== normalizeSha256(entry.sha256)) {
        throw new Error(
          `Existing entry digest does not match content: ${relativePath}`,
        );
      }
    }
    existing.set(collisionKey, { ...entry, relativePath });
  }

  const files = compilation.files.map((file, index) => {
    const current = existing.get(file.relativePath.toLowerCase());
    const currentKind = current?.kind ?? "file";
    const currentSha256 = current
      ? current.content !== undefined
        ? sha256(current.content)
        : current.sha256
          ? normalizeSha256(current.sha256)
          : null
      : null;
    const blockedReason = current && currentKind !== "file"
      ? `Target exists as ${currentKind}; refusing to replace it.`
      : current && currentSha256 === null
        ? "Existing file content or SHA-256 digest is required before replacement."
        : undefined;
    const disposition: FileInstallPreview["disposition"] = blockedReason
      ? "blocked"
      : !current
        ? "create"
        : currentSha256 === file.sha256
          ? "unchanged"
          : "update";
    const requiresApproval =
      disposition === "create" || disposition === "update";
    const audit: FileInstallPreview["audit"] = {
      eventType: "capability.file.install",
      planId: compilation.planId,
      packName: compilation.pack.name,
      packVersion: compilation.pack.version,
      target: compilation.target,
      relativePath: file.relativePath,
      previousSha256: currentSha256,
      nextSha256: file.sha256,
    };
    return {
      relativePath: file.relativePath,
      disposition,
      currentSha256,
      targetSha256: file.sha256,
      requiresApproval,
      ...(blockedReason ? { blockedReason } : {}),
      ...(requiresApproval
        ? {
            write: {
              strategy: "atomic-rename" as const,
              relativePath: file.relativePath,
              stagingRelativePath: stagingPath(compilation.planId, index),
              content: file.content,
              mode: file.mode,
              expectedPreviousSha256: currentSha256,
              sha256: file.sha256,
              createParents: true as const,
              rejectSymlinks: true as const,
              fsync: true as const,
            },
          }
        : {}),
      audit,
    };
  });

  const count = (disposition: FileInstallPreview["disposition"]): number =>
    files.filter((file) => file.disposition === disposition).length;
  const blocked = count("blocked");
  return {
    format: "one-status.capability-install-preview",
    formatVersion: 1,
    planId: compilation.planId,
    pack: compilation.pack,
    target: compilation.target,
    dryRun: true,
    installable: blocked === 0,
    creates: count("create"),
    updates: count("update"),
    unchanged: count("unchanged"),
    blocked,
    files,
  };
}

export function normalizeCapabilityRelativePath(value: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error("Capability output path must be a non-empty relative path.");
  }
  if (Buffer.byteLength(value, "utf8") > MAX_RELATIVE_PATH_BYTES) {
    throw new Error("Capability output path is too long.");
  }
  if (
    /^[a-zA-Z]:/.test(value) ||
    value.startsWith("/") ||
    value.startsWith("\\") ||
    value.startsWith("~")
  ) {
    throw new Error(`Absolute capability output path is not allowed: ${value}`);
  }
  if (
    value.includes("\\") ||
    /[\u0000-\u001f\u007f]/.test(value) ||
    /\p{Cf}/u.test(value)
  ) {
    throw new Error(`Unsafe capability output path: ${value}`);
  }
  const segments = value.split("/");
  if (
    segments.some(
      (segment) =>
        segment.length === 0 ||
        segment === "." ||
        segment === ".." ||
        Buffer.byteLength(segment, "utf8") > MAX_PATH_SEGMENT_BYTES ||
        /[<>:"|?*]/.test(segment) ||
        /[. ]$/.test(segment) ||
        /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?$/i.test(segment),
    )
  ) {
    throw new Error(`Unsafe capability output path: ${value}`);
  }
  return segments.join("/").normalize("NFC");
}

export function stableJson(value: unknown): string {
  const serialized = JSON.stringify(sortJsonValue(value), null, 2);
  if (serialized === undefined) {
    throw new Error("Value cannot be represented as JSON.");
  }
  return `${serialized}\n`;
}

function compileTarget(
  manifest: CapabilityPackManifest,
  target: AdapterTarget,
  gateway: CapabilityGateway,
  sourceFiles: CapabilitySourceFiles,
  warnings: string[],
): MutableCompiledFile[] {
  const instructions = renderInstructions(manifest, sourceFiles, warnings);
  const mcpConfig = renderMcpConfig(target, gateway);
  switch (target) {
    case "codex":
      return [
        {
          relativePath: ".codex-plugin/plugin.json",
          content: stableJson(codexPluginManifest(manifest)),
          mediaType: "application/json",
          purpose: "adapter-config",
        },
        {
          relativePath: ".mcp.json",
          content: stableJson(mcpConfig),
          mediaType: "application/json",
          purpose: "adapter-config",
        },
        {
          relativePath: "AGENTS.md",
          content: instructions,
          mediaType: "text/markdown",
          purpose: "instructions",
        },
        ...compileSkillFiles(
          manifest,
          "skills",
          sourceFiles,
          instructions,
          warnings,
        ),
      ];
    case "claude-code":
      return [
        {
          relativePath: ".mcp.json",
          content: stableJson(mcpConfig),
          mediaType: "application/json",
          purpose: "adapter-config",
        },
        {
          relativePath: "CLAUDE.md",
          content: instructions,
          mediaType: "text/markdown",
          purpose: "instructions",
        },
        ...compileSkillFiles(
          manifest,
          ".claude/skills",
          sourceFiles,
          instructions,
          warnings,
        ),
      ];
    case "cursor":
      return [
        {
          relativePath: ".cursor/mcp.json",
          content: stableJson(mcpConfig),
          mediaType: "application/json",
          purpose: "adapter-config",
        },
        {
          relativePath: `.cursor/rules/${manifest.name}.mdc`,
          content: renderCursorRule(manifest, instructions),
          mediaType: "text/markdown",
          purpose: "instructions",
        },
      ];
    case "markdown":
      return [
        {
          relativePath: `${manifest.name}.md`,
          content: instructions,
          mediaType: "text/markdown",
          purpose: "instructions",
        },
      ];
    case "local-mcp":
      return [
        {
          relativePath: ".mcp.json",
          content: stableJson(mcpConfig),
          mediaType: "application/json",
          purpose: "adapter-config",
        },
        {
          relativePath: `${manifest.name}.md`,
          content: instructions,
          mediaType: "text/markdown",
          purpose: "instructions",
        },
      ];
  }
}

function compileSkillFiles(
  manifest: CapabilityPackManifest,
  outputRoot: string,
  sourceFiles: CapabilitySourceFiles,
  instructions: string,
  warnings: string[],
): MutableCompiledFile[] {
  const source = manifest.skills?.source;
  const sourcePrefix = source ? normalizeSourceDirectory(source) : undefined;
  const declaredFiles = manifest.skills?.files ?? [];
  const outputPrefix = `${outputRoot}/${portableCapabilityName(manifest.name)}`;
  const files: MutableCompiledFile[] = [];
  for (const declaredPath of declaredFiles) {
    const suffix = normalizeCapabilityRelativePath(declaredPath);
    const sourcePath = `${sourcePrefix ?? ""}${suffix}`;
    const content = sourceFiles[sourcePath];
    if (content === undefined) {
      warnings.push(`Declared skill file was not supplied: ${sourcePath}`);
      continue;
    }
    files.push({
      relativePath: `${outputRoot}/${suffix}`,
      content: ensureTrailingNewline(content),
      mediaType: mediaTypeForPath(sourcePath),
      purpose: "skill-resource" as const,
    });
  }
  if (declaredFiles.length === 0 && sourcePrefix) {
    warnings.push(`No skill files are declared under ${sourcePrefix}.`);
  }
  if (!files.some((file) => file.relativePath === `${outputPrefix}/SKILL.md`)) {
    if (sourcePrefix) {
      warnings.push(
        `No SKILL.md was supplied under ${sourcePrefix}; generated one from the manifest.`,
      );
    }
    files.push({
      relativePath: `${outputPrefix}/SKILL.md`,
      content: renderSkill(manifest, instructions),
      mediaType: "text/markdown",
      purpose: "instructions",
    });
  }
  return files;
}

function renderSkill(
  manifest: CapabilityPackManifest,
  instructions: string,
): string {
  return [
    "---",
    `name: ${portableCapabilityName(manifest.name)}`,
    `description: ${JSON.stringify(manifest.description)}`,
    "---",
    "",
    instructions.trimEnd(),
    "",
  ].join("\n");
}

function renderInstructions(
  manifest: CapabilityPackManifest,
  sourceFiles: CapabilitySourceFiles,
  warnings: string[],
): string {
  const directMcpTools = manifest.tools.filter(
    (tool) => tool.metadata?.execution === "one-status-mcp",
  );
  const gatewayTools = manifest.tools.filter(
    (tool) => tool.metadata?.execution !== "one-status-mcp",
  );
  const memoryScopes = manifest.memory.scopes;
  const authorization = manifest.authorization;
  const lines = [
    `# ${manifest.displayName}`,
    "",
    manifest.description,
  ];
  if (gatewayTools.length > 0) {
    lines.push(
      "",
      "## One Status Gateway",
      "",
      "Use the One Status Gateway for the capabilities listed below. Call `tools_list` first, select an allowed action, then call `tools_execute` with arguments that match its `inputSchema`. For actions marked `requiresConfirmation`, call `tools_request_approval` and wait for Dashboard approval before execution.",
      "Provider credentials stay in the One Status Permission Vault. Do not ask the user for provider access tokens and do not send tokens to the Agent.",
      "",
      "### Tools",
      "",
      ...gatewayTools.map((tool) => `- \`${tool.id}\``),
    );
  }
  if (directMcpTools.length > 0) {
    lines.push(
      "",
      "## One Status MCP",
      "",
      "Call these tools directly through the connected One Status MCP server. Do not route them through `tools_execute`.",
      "",
      "### Tools",
      "",
      ...directMcpTools.map((tool) => `- \`${tool.id}\``),
    );
  }
  if (directMcpTools.some((tool) => tool.id === "persona.record")) {
    lines.push(
      "",
      "### Persona recording",
      "",
      "When the user states a durable personality or behavior preference, language or output style, project work habit, technical habit, long-term goal, future plan, or explicitly asks you to remember personal information, call `persona.record` with one concise structured observation.",
      "Use `explicit` confidence for direct user statements, `observed` for repeated behavior, and `inferred` only for a cautious inference. Call `persona.get_policy` when the current recording policy is unknown and honor every blocked category or confidence level.",
      "Never record passwords, API keys, access tokens, private keys, payment credentials, raw messages, full transcripts, or unrelated conversation text. Keep source project context minimal. Use `persona.update`, `persona.delete`, and `persona.set_policy` only when the user requests the change.",
    );
  }
  if (manifest.instructions.length > 0) {
    lines.push("", "### Workflows");
    for (const instruction of manifest.instructions) {
      lines.push("", `#### ${instruction.id}`, "");
      if (instruction.description) lines.push(instruction.description, "");
      const content = sourceFiles[instruction.source];
      if (content === undefined) {
        warnings.push(
          `Declared instruction file was not supplied: ${instruction.source}`,
        );
      } else {
        lines.push(content.trim(), "");
      }
    }
  }
  if (memoryScopes.length > 0) {
    lines.push(
      "",
      "### Memory scopes",
      "",
      ...memoryScopes.map((scope) => `- \`${scope}\``),
    );
  }
  if (authorization) {
    lines.push(
      "",
      "### Authorization",
      "",
      `Provider: \`${authorization.provider}\``,
      ...authorization.requiredScopes.map((scope) => `- \`${scope}\``),
    );
  }
  return `${lines.join("\n").trimEnd()}\n`;
}

function renderCursorRule(
  manifest: CapabilityPackManifest,
  instructions: string,
): string {
  return [
    "---",
    `description: ${JSON.stringify(manifest.description)}`,
    "alwaysApply: true",
    "---",
    "",
    instructions.trimEnd(),
    "",
  ].join("\n");
}

function codexPluginManifest(
  manifest: CapabilityPackManifest,
): Record<string, unknown> {
  const hasWrite = manifest.tools.some((tool) => !tool.readOnly);
  return {
    name: portableCapabilityName(manifest.name),
    version: manifest.version,
    description: manifest.description,
    author: { name: "One Status" },
    skills: "./skills/",
    mcpServers: "./.mcp.json",
    interface: {
      displayName: manifest.displayName,
      shortDescription: truncate(manifest.description, 120),
      longDescription: manifest.description,
      developerName: "One Status",
      category: "Productivity",
      capabilities: hasWrite
        ? ["Interactive", "Read", "Write"]
        : ["Interactive", "Read"],
      defaultPrompt: [
        truncate(
          `Use ${manifest.displayName} through the One Status Gateway`,
          128,
        ),
      ],
    },
  };
}

function renderMcpConfig(
  target: AdapterTarget,
  gateway: CapabilityGateway,
): Record<string, unknown> {
  const server = gateway.transport === "stdio"
    ? {
        command: gateway.command,
        args: [...(gateway.args ?? [])],
      }
    : target === "codex"
      ? {
          type: "http",
          url: gateway.url,
          ...(gateway.bearerTokenEnvVar
            ? { bearer_token_env_var: gateway.bearerTokenEnvVar }
            : {}),
        }
      : {
          type: "http",
          url: gateway.url,
          ...(gateway.bearerTokenEnvVar
            ? {
                headers: {
                  Authorization: `Bearer \${${gateway.bearerTokenEnvVar}}`,
                },
              }
            : {}),
        };
  return { mcpServers: { "one-status": server } };
}

function finalizeFiles(files: MutableCompiledFile[]): CompiledCapabilityFile[] {
  const seen = new Set<string>();
  return files
    .map((file) => {
      const relativePath = normalizeCapabilityRelativePath(file.relativePath);
      const collisionKey = relativePath.toLowerCase();
      if (seen.has(collisionKey)) {
        throw new Error(`Adapter produced duplicate output path: ${relativePath}`);
      }
      seen.add(collisionKey);
      const content = ensureTrailingNewline(file.content);
      return {
        ...file,
        relativePath,
        content,
        mode: GENERATED_FILE_MODE as typeof GENERATED_FILE_MODE,
        sha256: sha256(content),
      };
    })
    .sort((left, right) => compareText(left.relativePath, right.relativePath));
}

function parseSourceFiles(
  sourceFiles: CapabilitySourceFiles,
): CapabilitySourceFiles {
  const entries = Object.entries(sourceFiles);
  if (entries.length > MAX_SOURCE_FILES) {
      throw new Error(
        `Capability source contains more than ${MAX_SOURCE_FILES} files.`,
      );
  }
  let bytes = 0;
  const parsed: Record<string, string> = {};
  const collisionKeys = new Set<string>();
  for (const [path, content] of entries) {
    const normalized = normalizeCapabilityRelativePath(path);
    if (typeof content !== "string") {
      throw new Error(`Capability source file must contain text: ${normalized}`);
    }
    bytes += Buffer.byteLength(content, "utf8");
    if (bytes > MAX_SOURCE_BYTES) {
      throw new Error(`Capability source exceeds ${MAX_SOURCE_BYTES} bytes.`);
    }
    const collisionKey = normalized.toLowerCase();
    if (collisionKeys.has(collisionKey)) {
      throw new Error(`Duplicate normalized capability source path: ${normalized}`);
    }
    collisionKeys.add(collisionKey);
    parsed[normalized] = content;
  }
  return parsed;
}

function parseGateway(gateway: CapabilityGateway): CapabilityGateway {
  if (!gateway || typeof gateway !== "object") {
    throw new Error("A One Status Gateway configuration is required.");
  }
  if (gateway.transport === "stdio") {
    assertAllowedKeys(gateway, ["transport", "command", "args"]);
    if (!isSafeCommandValue(gateway.command)) {
      throw new Error("Gateway stdio command contains an unsafe value.");
    }
    if (!/^one-status(?:\.exe)?$/i.test(commandBasename(gateway.command))) {
      throw new Error("Gateway stdio command must invoke the One Status executable.");
    }
    const args = gateway.args ?? ["mcp", "--transport", "stdio"];
    if (args.some((argument) => !isSafeCommandValue(argument))) {
      throw new Error("Gateway stdio arguments contain an unsafe value.");
    }
    if (
      args.length !== 3 ||
      args[0] !== "mcp" ||
      args[1] !== "--transport" ||
      args[2] !== "stdio"
    ) {
      throw new Error(
        "Gateway stdio arguments must start the One Status stdio MCP transport.",
      );
    }
    return { transport: "stdio", command: gateway.command, args: [...args] };
  }
  if (gateway.transport === "http") {
    assertAllowedKeys(gateway, ["transport", "url", "bearerTokenEnvVar"]);
    const url = parseGatewayUrl(gateway.url);
    const bearerTokenEnvVar = gateway.bearerTokenEnvVar;
    if (bearerTokenEnvVar && !/^[A-Z_][A-Z0-9_]{0,127}$/.test(bearerTokenEnvVar)) {
      throw new Error(
        "Gateway bearer token must be referenced by a valid environment variable name.",
      );
    }
    return {
      transport: "http",
      url,
      ...(bearerTokenEnvVar ? { bearerTokenEnvVar } : {}),
    };
  }
  throw new Error("Unsupported One Status Gateway transport.");
}

function parseGatewayUrl(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error("Gateway URL must be an absolute URL.");
  }
  if (url.username || url.password || url.hash || url.search) {
    throw new Error(
      "Gateway URL cannot contain credentials, query parameters, or a fragment.",
    );
  }
  const loopback =
    url.hostname === "localhost" ||
    url.hostname === "127.0.0.1" ||
    url.hostname === "[::1]";
  if (url.protocol !== "https:" && !(url.protocol === "http:" && loopback)) {
    throw new Error("Gateway URL must use HTTPS, except for a loopback HTTP endpoint.");
  }
  return url.toString();
}

function parseTarget(value: string): AdapterTarget {
  if ((adapterTargets as readonly string[]).includes(value)) {
    return value as AdapterTarget;
  }
  throw new Error(`Unsupported adapter target: ${value}`);
}

function assertTargetDeclared(
  manifest: CapabilityPackManifest,
  target: AdapterTarget,
): void {
  const accepted = target === "codex"
    ? ["codex-plugin"]
    : target === "claude-code"
      ? ["claude-skill"]
      : target === "cursor"
        ? ["cursor-rules"]
        : target === "markdown"
          ? ["markdown"]
          : ["local-mcp"];
  const declaredAdapters: readonly string[] = manifest.adapters;
  if (!accepted.some((value) => declaredAdapters.includes(value))) {
    throw new Error(
      `Capability Pack ${manifest.name} does not declare an adapter for ${target}.`,
    );
  }
}

function normalizeSourceDirectory(value: string): string {
  const withoutTrailingSlash = value.endsWith("/") ? value.slice(0, -1) : value;
  return `${normalizeCapabilityRelativePath(withoutTrailingSlash)}/`;
}

function commandBasename(value: string): string {
  return value.split(/[\\/]/).at(-1) ?? value;
}

function assertAllowedKeys(
  value: object,
  allowedKeys: readonly string[],
): void {
  const allowed = new Set(allowedKeys);
  const unexpected = Object.keys(value).filter((key) => !allowed.has(key));
  if (unexpected.length > 0) {
    throw new Error(
      `Unknown Gateway configuration field: ${unexpected.sort().join(", ")}`,
    );
  }
}

function mediaTypeForPath(path: string): CompiledCapabilityFile["mediaType"] {
  return path.endsWith(".json")
    ? "application/json"
    : path.endsWith(".md") || path.endsWith(".mdc")
      ? "text/markdown"
      : "text/plain";
}

export function portableCapabilityName(name: string): string {
  const flattened = name.replaceAll(".", "-");
  if (flattened === name && flattened.length <= MAX_PORTABLE_NAME_LENGTH) {
    return flattened;
  }
  const suffix = sha256(name).slice(0, 10);
  const prefix = flattened
    .slice(0, MAX_PORTABLE_NAME_LENGTH - suffix.length - 1)
    .replace(/-+$/, "");
  return `${prefix}-${suffix}`;
}

function validateCompilation(compilation: CapabilityCompilation): void {
  if (
    compilation.format !== "one-status.capability-compilation" ||
    compilation.formatVersion !== 1
  ) {
    throw new Error("Unsupported capability compilation format.");
  }
  parseTarget(compilation.target);
  normalizeCapabilityRelativePath(compilation.pack.name);
  normalizeSha256(compilation.planId);
  const paths = new Set<string>();
  for (const file of compilation.files) {
    const path = normalizeCapabilityRelativePath(file.relativePath);
    if (path !== file.relativePath) {
      throw new Error(`Compiled output path is not normalized: ${file.relativePath}`);
    }
    const collisionKey = path.toLowerCase();
    if (paths.has(collisionKey)) {
      throw new Error(`Duplicate compiled output path: ${path}`);
    }
    paths.add(collisionKey);
    if (sha256(file.content) !== normalizeSha256(file.sha256)) {
      throw new Error(`Compiled file digest does not match content: ${path}`);
    }
    if (file.mode !== GENERATED_FILE_MODE) {
      throw new Error(`Unsupported compiled file mode for ${path}.`);
    }
  }
  const expectedPlanId = sha256(stableJson({
    format: compilation.format,
    formatVersion: compilation.formatVersion,
    pack: compilation.pack,
    target: compilation.target,
    files: compilation.files,
    warnings: compilation.warnings,
  }));
  if (expectedPlanId !== compilation.planId) {
    throw new Error("Capability compilation planId does not match its content.");
  }
}

function stagingPath(planId: string, index: number): string {
  return normalizeCapabilityRelativePath(
    `.one-status/staging/${planId}/${String(index).padStart(4, "0")}.tmp`,
  );
}

function normalizeSha256(value: string): string {
  const normalized = value.toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(normalized)) {
    throw new Error("Expected a hexadecimal SHA-256 digest.");
  }
  return normalized;
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function isSafeCommandValue(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= 4_096 &&
    !/[\u0000\r\n]/.test(value)
  );
}

function truncate(value: string, length: number): string {
  return value.length <= length
    ? value
    : `${value.slice(0, Math.max(0, length - 3))}...`;
}

function ensureTrailingNewline(value: string): string {
  return `${value.trimEnd()}\n`;
}

function sortJsonValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortJsonValue);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .filter(([, entry]) => entry !== undefined)
        .sort(([left], [right]) => compareText(left, right))
        .map(([key, entry]) => [key, sortJsonValue(entry)]),
    );
  }
  return value;
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
