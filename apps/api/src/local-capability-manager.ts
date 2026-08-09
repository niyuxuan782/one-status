import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import {
  lstat,
  mkdir,
  open,
  readFile,
  realpath,
  rename,
  rmdir,
  unlink,
} from "node:fs/promises";
import { homedir } from "node:os";
import {
  basename,
  dirname,
  isAbsolute,
  join,
  parse as parsePath,
  relative,
  resolve,
  sep,
} from "node:path";
import {
  compileCapabilityPack,
  createCapabilityInstallPreview,
  normalizeCapabilityRelativePath,
  portableCapabilityName,
  stableJson,
  type CapabilityCompilation,
  type CapabilityGateway,
  type CapabilityInstallPreview,
  type CapabilitySourceFiles,
  type CompiledCapabilityFile,
  type ExistingInstallEntry,
} from "@one-status/adapter-engine";
import {
  getBuiltInCapabilityPack,
  listBuiltInCapabilityPacks,
  type CapabilityPackManifest,
} from "@one-status/capability-pack";
import { z } from "zod";

const MAX_EXISTING_FILE_BYTES = 10 * 1024 * 1024;
const COMMAND_TIMEOUT_MS = 30_000;
const COMMAND_OUTPUT_LIMIT_BYTES = 1024 * 1024;
const MANAGED_MARKETPLACE_NAME = "one-status";
const MARKETPLACE_RELATIVE_PATH = ".agents/plugins/marketplace.json";
const MAX_PREPARED_PLANS = 32;

export const localCapabilityTargets = [
  "codex",
  "claude-code",
  "markdown",
  "local-mcp",
] as const;

export type LocalCapabilityTarget =
  (typeof localCapabilityTargets)[number];

export interface LocalCapabilityCommand {
  command: string;
  args: string[];
  cwd: string;
}

export interface LocalCapabilityCommandResult {
  command: string;
  args: string[];
  stdout: string;
  stderr: string;
}

export interface LocalCapabilityCommandRunner {
  run(command: LocalCapabilityCommand): Promise<LocalCapabilityCommandResult>;
}

export interface LocalCapabilityManagerOptions {
  gateway?: CapabilityGateway;
  codexMarketplaceRoot?: string;
  claudeSkillsRoot?: string;
  exportRoot?: string;
  codexExecutable?: string;
  environment?: NodeJS.ProcessEnv;
  homeDir?: string;
  sourceFilesByPack?: Readonly<Record<string, CapabilitySourceFiles>>;
  commandRunner?: LocalCapabilityCommandRunner;
}

export interface LocalCapabilityInstallRequest {
  packName: string;
  target: LocalCapabilityTarget;
  confirmed?: boolean;
  approvalId?: string;
}

export interface PreparedLocalCapabilityInstall {
  format: "one-status.local-capability-install";
  formatVersion: 1;
  pack: {
    name: string;
    version: string;
  };
  target: LocalCapabilityTarget;
  baseRoot: string;
  root: string;
  compilation: CapabilityCompilation;
  preview: CapabilityInstallPreview;
  removals: LocalCapabilityRemoval[];
  commands: LocalCapabilityCommand[];
  approvalId: string;
}

export interface LocalCapabilityRemoval {
  relativePath: string;
  currentSha256: string;
}

export interface LocalCapabilityInstallResult
  extends PreparedLocalCapabilityInstall {
  applied: boolean;
  commandResults: LocalCapabilityCommandResult[];
}

interface MaterializedCompilation {
  compilation: CapabilityCompilation;
  capturedEntries: Map<string, ExistingInstallEntry>;
}

interface TargetRoots {
  baseRoot: string;
  root: string;
}

const marketplacePluginSchema = z
  .object({
    name: z.string().regex(/^[a-z0-9](?:[a-z0-9-]{0,126}[a-z0-9])?$/),
    source: z
      .object({
        source: z.literal("local"),
        path: z.string().regex(/^\.\/plugins\/[a-z0-9][a-z0-9-]*$/),
      })
      .strict(),
    policy: z
      .object({
        installation: z.enum([
          "NOT_AVAILABLE",
          "AVAILABLE",
          "INSTALLED_BY_DEFAULT",
        ]),
        authentication: z.enum(["ON_INSTALL", "ON_USE"]),
      })
      .strict(),
    category: z.string().min(1).max(120),
  })
  .strict();

const managedMarketplaceSchema = z
  .object({
    name: z.literal(MANAGED_MARKETPLACE_NAME),
    interface: z
      .object({ displayName: z.string().min(1).max(120) })
      .strict(),
    plugins: z.array(marketplacePluginSchema).max(200),
  })
  .strict();

type ManagedMarketplace = z.infer<typeof managedMarketplaceSchema>;

export class LocalCapabilityManager {
  readonly #gateway: CapabilityGateway;
  readonly #codexMarketplaceRoot: string;
  readonly #claudeSkillsRoot: string;
  readonly #exportRoot: string;
  readonly #codexExecutable: string;
  readonly #sourceFilesByPack: Readonly<
    Record<string, CapabilitySourceFiles>
  >;
  readonly #commandRunner: LocalCapabilityCommandRunner;
  readonly #preparedPlans = new Map<
    string,
    PreparedLocalCapabilityInstall
  >();

  constructor(options: LocalCapabilityManagerOptions = {}) {
    const environment = options.environment ?? process.env;
    const home = options.homeDir ?? homedir();
    const dataRoot = environment.ONE_STATUS_HOME
      ? join(environment.ONE_STATUS_HOME, "capabilities")
      : join(
          environment.XDG_DATA_HOME ?? join(home, ".local", "share"),
          "one-status",
          "capabilities",
        );
    this.#gateway = options.gateway ?? {
      transport: "stdio",
      command: "one-status",
    };
    this.#codexMarketplaceRoot = requireAbsoluteRoot(
      options.codexMarketplaceRoot ?? join(dataRoot, "codex-marketplace"),
      "Codex marketplace root",
    );
    this.#claudeSkillsRoot = requireAbsoluteRoot(
      options.claudeSkillsRoot ?? join(home, ".claude", "skills"),
      "Claude skills root",
    );
    this.#exportRoot = requireAbsoluteRoot(
      options.exportRoot ?? join(dataRoot, "exports"),
      "capability export root",
    );
    this.#codexExecutable = options.codexExecutable ?? "codex";
    this.#sourceFilesByPack = mergeCapabilitySourceFiles(
      builtInCapabilitySourceFiles(),
      options.sourceFilesByPack ?? {},
    );
    this.#commandRunner =
      options.commandRunner ?? new ExecFileCapabilityCommandRunner(environment);
  }

  async install(
    request: LocalCapabilityInstallRequest,
  ): Promise<LocalCapabilityInstallResult> {
    const plan = await this.prepareInstallation(request);
    if (request.confirmed !== true) return dryRunResult(plan);
    if (!request.approvalId) {
      throw new Error(
        "approvalId is required with confirmed=true. Preview the installation first.",
      );
    }
    if (request.approvalId !== plan.approvalId) {
      throw new Error(
        "Capability installation changed after preview; review the new approvalId.",
      );
    }
    return this.applyPreparedInstallation(plan, { confirmed: true });
  }

  async prepareInstallation(
    request: Pick<LocalCapabilityInstallRequest, "packName" | "target">,
  ): Promise<PreparedLocalCapabilityInstall> {
    const target = parseLocalTarget(request.target);
    const manifest = getBuiltInCapabilityPack(request.packName);
    if (!manifest) {
      throw new Error(`Unknown built-in Capability Pack: ${request.packName}`);
    }
    const roots = await this.#targetRoots(target, manifest.name);
    const sourceFiles = this.#sourceFilesByPack[manifest.name];
    const compiled = compileCapabilityPack(manifest, {
      target,
      gateway: this.#gateway,
      ...(sourceFiles ? { sourceFiles } : {}),
    });
    const materialized = await materializeCompilation(
      compiled,
      manifest,
      target,
      roots.root,
    );
    const snapshot = await snapshotCompilation(
      roots.root,
      materialized.compilation,
      materialized.capturedEntries,
    );
    const preview = createCapabilityInstallPreview(
      materialized.compilation,
      snapshot,
    );
    const removals = await collectLegacyManagedRemovals(
      target,
      roots.root,
      manifest.name,
    );
    const commands = this.#commands(target, roots.root, manifest.name);
    const planWithoutApproval = {
      format: "one-status.local-capability-install" as const,
      formatVersion: 1 as const,
      pack: {
        name: manifest.name,
        version: manifest.version,
      },
      target,
      baseRoot: roots.baseRoot,
      root: roots.root,
      compilation: materialized.compilation,
      preview,
      removals,
      commands,
    };
    const plan = {
      ...planWithoutApproval,
      approvalId: computeApprovalId(planWithoutApproval),
    };
    this.#rememberPreparedPlan(plan);
    return plan;
  }

  async applyPreparedInstallation(
    plan: PreparedLocalCapabilityInstall,
    options: { confirmed?: boolean } = {},
  ): Promise<LocalCapabilityInstallResult> {
    validatePreparedPlan(plan);
    if (options.confirmed !== true) return dryRunResult(plan);
    const prepared = this.#preparedPlans.get(plan.approvalId);
    if (!prepared || stableJson(prepared) !== stableJson(plan)) {
      throw new Error(
        "Capability installation plan was not prepared by this local Manager.",
      );
    }
    this.#preparedPlans.delete(plan.approvalId);
    const expectedRoots = await this.#targetRoots(plan.target, plan.pack.name);
    if (
      expectedRoots.baseRoot !== plan.baseRoot ||
      expectedRoots.root !== plan.root
    ) {
      throw new Error("Capability installation root changed after preview.");
    }
    const expectedCommands = this.#commands(
      plan.target,
      plan.root,
      plan.pack.name,
    );
    if (stableJson(expectedCommands) !== stableJson(plan.commands)) {
      throw new Error("Capability registration commands changed after preview.");
    }
    const snapshot = await snapshotCompilation(
      plan.root,
      plan.compilation,
      new Map(),
    );
    const currentPreview = createCapabilityInstallPreview(
      plan.compilation,
      snapshot,
    );
    const currentRemovals = await collectLegacyManagedRemovals(
      plan.target,
      plan.root,
      plan.pack.name,
    );
    const currentApprovalId = computeApprovalId({
      format: plan.format,
      formatVersion: plan.formatVersion,
      pack: plan.pack,
      target: plan.target,
      baseRoot: plan.baseRoot,
      root: plan.root,
      compilation: plan.compilation,
      preview: currentPreview,
      removals: currentRemovals,
      commands: plan.commands,
    });
    if (currentApprovalId !== plan.approvalId) {
      throw new Error(
        "Capability installation files changed after preview; no files were written.",
      );
    }
    if (!currentPreview.installable) {
      throw new Error("Capability installation preview contains blocked files.");
    }

    await applyInstallPreview(plan.baseRoot, plan.root, currentPreview);
    for (const removal of currentRemovals) {
      await applyManagedRemoval(plan.root, removal);
    }
    const commandResults: LocalCapabilityCommandResult[] = [];
    for (const command of plan.commands) {
      commandResults.push(await this.#commandRunner.run(command));
    }
    return {
      ...plan,
      preview: currentPreview,
      applied: true,
      commandResults,
    };
  }

  async #targetRoots(
    target: LocalCapabilityTarget,
    packName: string,
  ): Promise<TargetRoots> {
    const configuredBase = target === "codex"
      ? this.#codexMarketplaceRoot
      : target === "claude-code"
        ? this.#claudeSkillsRoot
        : this.#exportRoot;
    const baseRoot = await canonicalizeConfiguredRoot(configuredBase);
    const root = target === "markdown" || target === "local-mcp"
      ? join(baseRoot, target, normalizeCapabilityRelativePath(packName))
      : baseRoot;
    await assertExistingDirectoryChain(baseRoot, root);
    return { baseRoot, root };
  }

  #commands(
    target: LocalCapabilityTarget,
    root: string,
    packName: string,
  ): LocalCapabilityCommand[] {
    if (target !== "codex") return [];
    const pluginName = portableCapabilityName(packName);
    return [
      {
        command: this.#codexExecutable,
        args: ["plugin", "marketplace", "add", root, "--json"],
        cwd: root,
      },
      {
        command: this.#codexExecutable,
        args: [
          "plugin",
          "add",
          `${pluginName}@${MANAGED_MARKETPLACE_NAME}`,
          "--json",
        ],
        cwd: root,
      },
    ];
  }

  #rememberPreparedPlan(plan: PreparedLocalCapabilityInstall): void {
    this.#preparedPlans.delete(plan.approvalId);
    this.#preparedPlans.set(plan.approvalId, plan);
    while (this.#preparedPlans.size > MAX_PREPARED_PLANS) {
      const oldest = this.#preparedPlans.keys().next().value;
      if (oldest === undefined) break;
      this.#preparedPlans.delete(oldest);
    }
  }
}

class ExecFileCapabilityCommandRunner
  implements LocalCapabilityCommandRunner {
  readonly #environment: NodeJS.ProcessEnv;

  constructor(environment: NodeJS.ProcessEnv) {
    this.#environment = environment;
  }

  run(command: LocalCapabilityCommand): Promise<LocalCapabilityCommandResult> {
    return new Promise((resolvePromise, reject) => {
      execFile(
        command.command,
        command.args,
        {
          cwd: command.cwd,
          env: this.#environment,
          timeout: COMMAND_TIMEOUT_MS,
          maxBuffer: COMMAND_OUTPUT_LIMIT_BYTES,
          encoding: "utf8",
        },
        (error, stdout, stderr) => {
          if (error) {
            reject(
              new Error(
                `Capability registration command failed: ${command.command} ${command.args.join(" ")}: ${stderr || error.message}`,
              ),
            );
            return;
          }
          resolvePromise({
            command: command.command,
            args: [...command.args],
            stdout,
            stderr,
          });
        },
      );
    });
  }
}

async function materializeCompilation(
  compilation: CapabilityCompilation,
  manifest: CapabilityPackManifest,
  target: LocalCapabilityTarget,
  root: string,
): Promise<MaterializedCompilation> {
  if (target === "codex") {
    const pluginName = portableCapabilityName(manifest.name);
    const marketplaceEntry = await inspectExistingEntry(
      root,
      MARKETPLACE_RELATIVE_PATH,
    );
    const marketplace = mergeMarketplace(
      marketplaceEntry?.kind === "file"
        ? marketplaceEntry.content
        : undefined,
      pluginName,
    );
    const files = withManagedCodexPluginManifest(
      compilation.files.filter(
        (file) =>
          file.relativePath !== ".mcp.json" && file.relativePath !== "AGENTS.md",
      ),
      manifest.version,
    ).map((file) => ({
      ...file,
      relativePath: `plugins/${pluginName}/${file.relativePath}`,
    }));
    files.push(
      compiledTextFile(
        MARKETPLACE_RELATIVE_PATH,
        stableJson(marketplace),
        "adapter-config",
      ),
    );
    return {
      compilation: rebuildCompilation(compilation, files),
      capturedEntries: marketplaceEntry
        ? new Map([[MARKETPLACE_RELATIVE_PATH, marketplaceEntry]])
        : new Map(),
    };
  }

  if (target === "claude-code") {
    const prefix = ".claude/skills/";
    const files = compilation.files
      .filter((file) => file.relativePath.startsWith(prefix))
      .map((file) => ({
        ...file,
        relativePath: file.relativePath.slice(prefix.length),
      }));
    if (files.length === 0) {
      throw new Error("Claude Code adapter did not produce a Skill.");
    }
    return {
      compilation: rebuildCompilation(compilation, files),
      capturedEntries: new Map(),
    };
  }

  return { compilation, capturedEntries: new Map() };
}

function withManagedCodexPluginManifest(
  files: CompiledCapabilityFile[],
  packVersion: string,
): CompiledCapabilityFile[] {
  const manifestPath = ".codex-plugin/plugin.json";
  const baseFiles = files.map((file) => {
    if (file.relativePath !== manifestPath) return file;
    const parsed = parseJson(file.content, "Codex plugin manifest");
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error("Managed Codex plugin manifest must be a JSON object.");
    }
    const pluginManifest = { ...(parsed as Record<string, unknown>) };
    delete pluginManifest.mcpServers;
    pluginManifest.version = packVersion.split("+", 1)[0];
    return compiledTextFile(
      manifestPath,
      stableJson(pluginManifest),
      file.purpose,
    );
  });
  const pluginFile = baseFiles.find((file) => file.relativePath === manifestPath);
  if (!pluginFile) {
    throw new Error("Codex adapter did not produce a plugin manifest.");
  }
  const cachebuster = sha256(
    stableJson({
      format: "one-status.managed-codex-plugin",
      formatVersion: 1,
      files: baseFiles.map((file) => ({
        relativePath: file.relativePath,
        content: file.content,
        purpose: file.purpose,
      })),
    }),
  ).slice(0, 16);
  const parsed = parseJson(pluginFile.content, "Codex plugin manifest");
  const pluginManifest = { ...(parsed as Record<string, unknown>) };
  pluginManifest.version = `${packVersion.split("+", 1)[0]}+codex.${cachebuster}`;
  return baseFiles.map((file) =>
    file.relativePath === manifestPath
      ? compiledTextFile(manifestPath, stableJson(pluginManifest), file.purpose)
      : file,
  );
}

async function collectLegacyManagedRemovals(
  target: LocalCapabilityTarget,
  root: string,
  packName: string,
): Promise<LocalCapabilityRemoval[]> {
  if (target !== "codex") return [];
  const pluginName = portableCapabilityName(packName);
  const removals: LocalCapabilityRemoval[] = [];
  for (const legacyPath of [".mcp.json", "AGENTS.md"] as const) {
    const relativePath = `plugins/${pluginName}/${legacyPath}`;
    const entry = await inspectExistingEntry(root, relativePath);
    if (!entry) continue;
    if (entry.kind !== "file" || entry.content === undefined) {
      throw new Error(
        `Legacy managed capability output cannot be removed safely: ${relativePath}`,
      );
    }
    removals.push({
      relativePath,
      currentSha256: sha256(entry.content),
    });
  }
  return removals;
}

function mergeMarketplace(
  existingContent: string | undefined,
  pluginName: string,
): ManagedMarketplace {
  const existing = existingContent
    ? managedMarketplaceSchema.parse(parseJson(existingContent, "marketplace"))
    : {
        name: MANAGED_MARKETPLACE_NAME,
        interface: { displayName: "One Status" },
        plugins: [],
      } satisfies ManagedMarketplace;
  const entry = marketplacePluginSchema.parse({
    name: pluginName,
    source: { source: "local", path: `./plugins/${pluginName}` },
    policy: {
      installation: "AVAILABLE",
      authentication: "ON_INSTALL",
    },
    category: "Productivity",
  });
  const plugins = existing.plugins
    .filter((plugin) => plugin.name !== pluginName)
    .concat(entry)
    .sort((left, right) => compareText(left.name, right.name));
  return managedMarketplaceSchema.parse({ ...existing, plugins });
}

function rebuildCompilation(
  source: CapabilityCompilation,
  files: CompiledCapabilityFile[],
): CapabilityCompilation {
  const finalizedFiles = [...files].sort((left, right) =>
    compareText(left.relativePath, right.relativePath));
  const seed = {
    format: "one-status.capability-compilation" as const,
    formatVersion: 1 as const,
    pack: source.pack,
    target: source.target,
    files: finalizedFiles,
    warnings: source.warnings,
  };
  return { ...seed, planId: sha256(stableJson(seed)) };
}

function compiledTextFile(
  relativePath: string,
  content: string,
  purpose: CompiledCapabilityFile["purpose"],
): CompiledCapabilityFile {
  const normalizedContent = `${content.trimEnd()}\n`;
  return {
    relativePath: normalizeCapabilityRelativePath(relativePath),
    content: normalizedContent,
    mediaType: relativePath.endsWith(".json")
      ? "application/json"
      : "text/plain",
    mode: 0o644,
    sha256: sha256(normalizedContent),
    purpose,
  };
}

async function snapshotCompilation(
  root: string,
  compilation: CapabilityCompilation,
  capturedEntries: Map<string, ExistingInstallEntry>,
): Promise<ExistingInstallEntry[]> {
  const entries: ExistingInstallEntry[] = [];
  for (const file of compilation.files) {
    const captured = capturedEntries.get(file.relativePath);
    const entry =
      captured ?? await inspectExistingEntry(root, file.relativePath);
    if (entry) entries.push(entry);
  }
  return entries;
}

async function inspectExistingEntry(
  root: string,
  relativePath: string,
): Promise<ExistingInstallEntry | undefined> {
  const normalized = normalizeCapabilityRelativePath(relativePath);
  await assertSafeExistingParents(root, normalized);
  const path = resolveInside(root, normalized);
  try {
    const metadata = await lstat(path);
    if (metadata.isSymbolicLink()) {
      return { relativePath: normalized, kind: "symlink" };
    }
    if (metadata.isDirectory()) {
      return { relativePath: normalized, kind: "directory" };
    }
    if (!metadata.isFile()) {
      return { relativePath: normalized, kind: "other" };
    }
    if (metadata.size > MAX_EXISTING_FILE_BYTES) {
      return { relativePath: normalized, kind: "file" };
    }
    return {
      relativePath: normalized,
      kind: "file",
      content: await readFile(path, "utf8"),
    };
  } catch (error) {
    if (isMissing(error)) return undefined;
    throw error;
  }
}

async function applyInstallPreview(
  baseRoot: string,
  root: string,
  preview: CapabilityInstallPreview,
): Promise<void> {
  await ensureAbsoluteDirectory(baseRoot);
  await ensureDirectoryInside(baseRoot, root);
  const orderedFiles = [...preview.files].sort((left, right) => {
    if (left.relativePath === MARKETPLACE_RELATIVE_PATH) return 1;
    if (right.relativePath === MARKETPLACE_RELATIVE_PATH) return -1;
    return compareText(left.relativePath, right.relativePath);
  });
  for (const file of orderedFiles) {
    if (file.disposition === "blocked") {
      throw new Error(`Blocked capability output: ${file.relativePath}`);
    }
    await verifyExpectedEntry(
      root,
      file.relativePath,
      file.currentSha256,
    );
    if (file.disposition === "unchanged") continue;
    if (!file.write) {
      throw new Error(`Missing atomic write intent: ${file.relativePath}`);
    }
    await atomicWriteIntent(baseRoot, root, file.write);
  }

  const stagingRoot = resolveInside(
    root,
    `.one-status/staging/${preview.planId}`,
  );
  await rmdir(stagingRoot).catch(ignoreMissingOrNotEmpty);
}

async function applyManagedRemoval(
  root: string,
  removal: LocalCapabilityRemoval,
): Promise<void> {
  await verifyExpectedEntry(
    root,
    removal.relativePath,
    removal.currentSha256,
  );
  const target = resolveInside(root, removal.relativePath);
  await unlink(target);
  await syncDirectory(dirname(target));
  if (await inspectExistingEntry(root, removal.relativePath)) {
    throw new Error(
      `Legacy managed capability output still exists: ${removal.relativePath}`,
    );
  }
}

async function atomicWriteIntent(
  baseRoot: string,
  root: string,
  write: NonNullable<CapabilityInstallPreview["files"][number]["write"]>,
): Promise<void> {
  if (
    write.strategy !== "atomic-rename" ||
    write.fsync !== true ||
    write.createParents !== true ||
    write.rejectSymlinks !== true
  ) {
    throw new Error(`Unsupported write constraints: ${write.relativePath}`);
  }
  const target = resolveInside(root, write.relativePath);
  const temporary = resolveInside(root, write.stagingRelativePath);
  await ensureDirectoryInside(baseRoot, dirname(target));
  await ensureDirectoryInside(baseRoot, dirname(temporary));
  await verifyExpectedEntry(
    root,
    write.relativePath,
    write.expectedPreviousSha256,
  );

  let handle: Awaited<ReturnType<typeof open>> | undefined;
  let temporaryCreated = false;
  try {
    handle = await open(temporary, "wx", write.mode);
    temporaryCreated = true;
    await handle.writeFile(write.content, "utf8");
    await handle.chmod(write.mode);
    await handle.sync();
    await handle.close();
    handle = undefined;
    if (sha256(await readFile(temporary, "utf8")) !== write.sha256) {
      throw new Error(
        `Staged capability output digest mismatch: ${write.relativePath}`,
      );
    }
    await verifyExpectedEntry(
      root,
      write.relativePath,
      write.expectedPreviousSha256,
    );
    await rename(temporary, target);
    temporaryCreated = false;
    await syncDirectory(dirname(target));
  } finally {
    await handle?.close().catch(() => undefined);
    if (temporaryCreated) {
      await unlink(temporary).catch(ignoreMissing);
    }
  }

  const metadata = await lstat(target);
  if (!metadata.isFile() || metadata.isSymbolicLink()) {
    throw new Error(
      `Installed capability output is not a regular file: ${write.relativePath}`,
    );
  }
  if (sha256(await readFile(target, "utf8")) !== write.sha256) {
    throw new Error(
      `Installed capability output digest mismatch: ${write.relativePath}`,
    );
  }
}

async function verifyExpectedEntry(
  root: string,
  relativePath: string,
  expectedSha256: string | null,
): Promise<void> {
  const current = await inspectExistingEntry(root, relativePath);
  if (expectedSha256 === null) {
    if (current) {
      throw new Error(
        `Capability output appeared after preview: ${relativePath}`,
      );
    }
    return;
  }
  if (current?.kind !== "file" || current.content === undefined) {
    throw new Error(
      `Capability output is no longer a readable regular file: ${relativePath}`,
    );
  }
  if (sha256(current.content) !== expectedSha256) {
    throw new Error(`Capability output changed after preview: ${relativePath}`);
  }
}

async function canonicalizeConfiguredRoot(path: string): Promise<string> {
  const absolute = resolve(path);
  let current = absolute;
  const missingSegments: string[] = [];
  while (true) {
    try {
      const metadata = await lstat(current);
      if (current === absolute && metadata.isSymbolicLink()) {
        throw new Error(
          `Managed capability root cannot be a symlink: ${absolute}`,
        );
      }
      if (!metadata.isDirectory() && !metadata.isSymbolicLink()) {
        throw new Error(
          `Managed capability root must be a directory: ${current}`,
        );
      }
      const canonical = await realpath(current);
      return join(canonical, ...missingSegments);
    } catch (error) {
      if (!isMissing(error)) throw error;
      const parent = dirname(current);
      if (parent === current) throw error;
      missingSegments.unshift(basename(current));
      current = parent;
    }
  }
}

async function assertExistingDirectoryChain(
  baseRoot: string,
  targetRoot: string,
): Promise<void> {
  const relativePath = relativeInside(baseRoot, targetRoot);
  let current = baseRoot;
  for (const segment of splitRelativePath(relativePath)) {
    current = join(current, segment);
    try {
      const metadata = await lstat(current);
      if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
        throw new Error(`Capability directory is unsafe: ${current}`);
      }
    } catch (error) {
      if (isMissing(error)) return;
      throw error;
    }
  }
}

async function assertSafeExistingParents(
  root: string,
  relativePath: string,
): Promise<void> {
  try {
    const rootMetadata = await lstat(root);
    if (!rootMetadata.isDirectory() || rootMetadata.isSymbolicLink()) {
      throw new Error(`Managed capability root is unsafe: ${root}`);
    }
  } catch (error) {
    if (isMissing(error)) return;
    throw error;
  }
  let current = root;
  const parent = dirname(relativePath);
  if (parent === ".") return;
  for (const segment of splitRelativePath(parent)) {
    current = join(current, segment);
    try {
      const metadata = await lstat(current);
      if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
        throw new Error(`Capability output parent is unsafe: ${current}`);
      }
    } catch (error) {
      if (isMissing(error)) return;
      throw error;
    }
  }
}

async function ensureAbsoluteDirectory(path: string): Promise<void> {
  const absolute = resolve(path);
  const parsed = parsePath(absolute);
  let current = parsed.root;
  for (const segment of splitRelativePath(relative(parsed.root, absolute))) {
    const parent = current;
    current = join(current, segment);
    let created = false;
    try {
      await mkdir(current, { mode: 0o755 });
      created = true;
    } catch (error) {
      if (!isAlreadyExists(error)) throw error;
    }
    const metadata = await lstat(current);
    if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
      throw new Error(`Capability directory is unsafe: ${current}`);
    }
    if (created) await syncDirectory(parent);
  }
}

async function ensureDirectoryInside(
  baseRoot: string,
  directory: string,
): Promise<void> {
  const relativePath = relativeInside(baseRoot, directory);
  let current = baseRoot;
  for (const segment of splitRelativePath(relativePath)) {
    const parent = current;
    current = join(current, segment);
    let created = false;
    try {
      await mkdir(current, { mode: 0o755 });
      created = true;
    } catch (error) {
      if (!isAlreadyExists(error)) throw error;
    }
    const metadata = await lstat(current);
    if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
      throw new Error(`Capability directory is unsafe: ${current}`);
    }
    if (created) await syncDirectory(parent);
  }
}

async function syncDirectory(path: string): Promise<void> {
  const handle = await open(path, "r");
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

function validatePreparedPlan(plan: PreparedLocalCapabilityInstall): void {
  if (
    plan.format !== "one-status.local-capability-install" ||
    plan.formatVersion !== 1
  ) {
    throw new Error("Unsupported local Capability Pack installation plan.");
  }
  parseLocalTarget(plan.target);
  if (!isAbsolute(plan.baseRoot) || !isAbsolute(plan.root)) {
    throw new Error("Capability installation roots must be absolute.");
  }
  relativeInside(plan.baseRoot, plan.root);
  if (plan.preview.planId !== plan.compilation.planId) {
    throw new Error(
      "Capability installation preview does not match compilation.",
    );
  }
  if (
    plan.compilation.pack.name !== plan.pack.name ||
    plan.compilation.pack.version !== plan.pack.version ||
    plan.compilation.target !== plan.target
  ) {
    throw new Error("Capability installation metadata does not match compilation.");
  }
  const expectedApprovalId = computeApprovalId({
    format: plan.format,
    formatVersion: plan.formatVersion,
    pack: plan.pack,
    target: plan.target,
    baseRoot: plan.baseRoot,
    root: plan.root,
    compilation: plan.compilation,
    preview: plan.preview,
    removals: plan.removals,
    commands: plan.commands,
  });
  if (expectedApprovalId !== plan.approvalId) {
    throw new Error("Capability installation approvalId is invalid.");
  }
}

function computeApprovalId(
  plan: Omit<PreparedLocalCapabilityInstall, "approvalId">,
): string {
  return sha256(stableJson({
    format: plan.format,
    formatVersion: plan.formatVersion,
    pack: plan.pack,
    target: plan.target,
    baseRoot: plan.baseRoot,
    root: plan.root,
    planId: plan.compilation.planId,
    files: plan.preview.files.map((file) => ({
      relativePath: file.relativePath,
      disposition: file.disposition,
      currentSha256: file.currentSha256,
      targetSha256: file.targetSha256,
      blockedReason: file.blockedReason,
    })),
    removals: plan.removals,
    commands: plan.commands,
  }));
}

function dryRunResult(
  plan: PreparedLocalCapabilityInstall,
): LocalCapabilityInstallResult {
  return { ...plan, applied: false, commandResults: [] };
}

function builtInCapabilitySourceFiles(): Readonly<
  Record<string, CapabilitySourceFiles>
> {
  return Object.fromEntries(
    listBuiltInCapabilityPacks().map(({ manifest }) => {
      const files: Record<string, string> = {};
      for (const instruction of manifest.instructions) {
        files[instruction.source] = [
          "1. Call `capabilities_get` when capability installation state matters.",
          "2. Call `tools_list` immediately before using a connected service.",
          "3. Select only a connection and action returned for the current Agent.",
          "4. Call `tools_execute` with arguments that match the returned `inputSchema`.",
          "5. For every action marked `requiresConfirmation`, call `tools_request_approval`, wait for Dashboard approval, and pass its `approvalId` to `tools_execute`.",
          "",
          "Provider credentials stay inside the One Status Permission Vault.",
          "",
        ].join("\n");
      }
      for (const file of manifest.skills?.files ?? []) {
        const source = `${manifest.skills?.source ?? ""}${file}`;
        files[source] = [
          "---",
          `name: ${portableCapabilityName(manifest.name)}`,
          `description: ${JSON.stringify(manifest.description)}`,
          "---",
          "",
          `# ${manifest.displayName}`,
          "",
          "Use `tools_list` first, then call only actions returned for the current Agent through `tools_execute`.",
          "",
          ...manifest.tools.map((tool) => `- \`${tool.id}\``),
          "",
        ].join("\n");
      }
      return [manifest.name, files];
    }),
  );
}

function mergeCapabilitySourceFiles(
  defaults: Readonly<Record<string, CapabilitySourceFiles>>,
  overrides: Readonly<Record<string, CapabilitySourceFiles>>,
): Readonly<Record<string, CapabilitySourceFiles>> {
  const packNames = new Set([
    ...Object.keys(defaults),
    ...Object.keys(overrides),
  ]);
  return Object.fromEntries(
    [...packNames].map((packName) => [
      packName,
      { ...(defaults[packName] ?? {}), ...(overrides[packName] ?? {}) },
    ]),
  );
}

function parseLocalTarget(value: string): LocalCapabilityTarget {
  if ((localCapabilityTargets as readonly string[]).includes(value)) {
    return value as LocalCapabilityTarget;
  }
  throw new Error(`Unsupported local Capability Pack target: ${value}`);
}

function requireAbsoluteRoot(value: string, label: string): string {
  if (!isAbsolute(value)) throw new Error(`${label} must be an absolute path.`);
  return resolve(value);
}

function resolveInside(root: string, relativePath: string): string {
  const normalized = normalizeCapabilityRelativePath(relativePath);
  const resolved = resolve(root, normalized);
  relativeInside(root, resolved);
  return resolved;
}

function relativeInside(root: string, path: string): string {
  const value = relative(root, path);
  if (value === "") return "";
  if (isAbsolute(value) || value === ".." || value.startsWith(`..${sep}`)) {
    throw new Error(`Capability path escapes its managed root: ${path}`);
  }
  return value;
}

function splitRelativePath(value: string): string[] {
  return value.split(sep).filter(Boolean);
}

function parseJson(value: string, label: string): unknown {
  try {
    return JSON.parse(value) as unknown;
  } catch {
    throw new Error(`Managed ${label} contains invalid JSON.`);
  }
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function isMissing(error: unknown): boolean {
  return hasErrorCode(error, "ENOENT");
}

function isAlreadyExists(error: unknown): boolean {
  return hasErrorCode(error, "EEXIST");
}

function hasErrorCode(error: unknown, code: string): boolean {
  return error instanceof Error &&
    "code" in error &&
    (error as Error & { code?: string }).code === code;
}

function ignoreMissing(error: unknown): void {
  if (!isMissing(error)) throw error;
}

function ignoreMissingOrNotEmpty(error: unknown): void {
  if (!isMissing(error) && !hasErrorCode(error, "ENOTEMPTY")) throw error;
}
