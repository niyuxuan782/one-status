import { execFile } from "node:child_process";
import {
  chmod,
  lstat,
  mkdir,
  readFile,
  realpath,
  rename,
  stat,
  writeFile,
} from "node:fs/promises";
import {
  basename,
  dirname,
  extname,
  isAbsolute,
  join,
  relative,
  resolve,
  sep,
} from "node:path";
import { lintSource } from "@secretlint/core";
import { creator as recommendedSecretRules } from "@secretlint/secretlint-rule-preset-recommend";
import { z } from "zod";
import {
  LocalAgentLauncher,
  type AgentLauncher,
  type SupportedAgentId,
} from "./agent-adapter.js";
import type { DashboardBackend } from "./dashboard-backend.js";
import type { LocalWorkspaceStore } from "./local-workspace.js";

const GIT_TIMEOUT_MS = 10_000;
const GIT_NETWORK_TIMEOUT_MS = 120_000;
const MAX_CHANGED_FILES = 200;
const MAX_SECRET_SCAN_FILE_BYTES = 1024 * 1024;
const HANDOFF_FILES = ["HANDOFF.md", ".one-status/handoff.json"] as const;

const storedHandoffManifestSchema = z
  .object({
    format: z.literal("one-status.handoff"),
    version: z.literal(1),
    generatedAt: z.iso.datetime({ offset: true }),
    projectId: z.string().min(1),
    statusVersion: z.number().int().positive(),
    repository: z
      .object({
        branch: z.string().nullable(),
        changedFiles: z.array(z.string()),
        commit: z.string().regex(/^[0-9a-f]{40,64}$/),
        dirty: z.boolean(),
        remote: z.string().nullable(),
      })
      .strict(),
    context: z
      .object({
        completed: z.array(z.string()),
        currentContext: z.string().nullable(),
        currentGoal: z.string(),
        decisions: z.array(z.string()),
        next: z.array(z.string()),
        blocked: z.array(z.string()),
        lastAgentId: z.string().nullable(),
      })
      .strict(),
    validation: z
      .object({
        secretScan: z.enum(["blocked", "error", "passed"]),
        test: z.literal("not_run"),
      })
      .strict(),
  })
  .strict();

export interface SecretFinding {
  file: string;
  line: number;
  messageId?: string;
  ruleId: string;
}

export interface HandoffManifest {
  format: "one-status.handoff";
  version: 1;
  generatedAt: string;
  projectId: string;
  statusVersion: number;
  repository: {
    branch: string | null;
    changedFiles: string[];
    commit: string;
    dirty: boolean;
    remote: string | null;
  };
  context: {
    completed: string[];
    currentContext: string | null;
    currentGoal: string;
    decisions: string[];
    next: string[];
    blocked: string[];
    lastAgentId: string | null;
  };
  validation: {
    secretScan: "blocked" | "error" | "passed";
    test: "not_run";
  };
}

export interface HandoffPreview {
  canWrite: boolean;
  existingFiles: string[];
  findings: SecretFinding[];
  manifest: HandoffManifest;
  markdown: string;
  mapping: {
    path: string;
    projectId: string;
    repoRoot: string;
  };
  secretScanError?: string;
}

export interface HandoffServiceOptions {
  agentLauncher?: AgentLauncher;
  githubCredentialProvider?: GitHubCredentialProvider;
  resolvePortableRepositoryUrl?: (remote: string) => string | null;
}

export interface GitHubCredentialProvider {
  getGitEnvironment(repositoryUrl: string): Promise<Record<string, string>>;
}

export class HandoffService {
  readonly #agentLauncher: AgentLauncher;
  readonly #githubCredentialProvider?: GitHubCredentialProvider;
  readonly #resolvePortableRepositoryUrl: (remote: string) => string | null;

  constructor(
    private readonly backend: DashboardBackend,
    private readonly workspaceStore: LocalWorkspaceStore,
    options: HandoffServiceOptions = {},
  ) {
    this.#agentLauncher = options.agentLauncher ?? new LocalAgentLauncher();
    this.#githubCredentialProvider = options.githubCredentialProvider;
    this.#resolvePortableRepositoryUrl =
      options.resolvePortableRepositoryUrl ?? portableGitHubUrl;
  }

  async #gitEnvironment(repositoryUrl: string): Promise<Record<string, string>> {
    try {
      return {
        ...((await this.#githubCredentialProvider?.getGitEnvironment(
          repositoryUrl,
        )) ?? {}),
        GIT_TERMINAL_PROMPT: "0",
      };
    } catch {
      throw new Error("GitHub credentials could not be prepared.");
    }
  }

  async overview() {
    const snapshot = await this.backend.getSnapshot();
    return {
      mappings: this.workspaceStore.listMappings().map((mapping) => ({
        ...mapping,
        projectName:
          snapshot.status.projects[mapping.projectId]?.name ?? mapping.projectId,
      })),
      projects: Object.values(snapshot.status.projects).map((project) => ({
        id: project.id,
        name: project.name,
        goal: project.currentGoal,
        handoff: project.handoff ?? null,
        mapped: Boolean(this.workspaceStore.getMapping(project.id)),
      })),
      activity: this.workspaceStore.listActivity(),
    };
  }

  async mapProject(projectId: string, requestedPath: string) {
    const snapshot = await this.backend.getSnapshot();
    if (!snapshot.status.projects[projectId]) {
      throw new Error("Portable project was not found.");
    }
    const path = await canonicalDirectory(requestedPath);
    const repoRoot = await canonicalDirectory(
      (await runGit(path, ["rev-parse", "--show-toplevel"])).trim(),
    );
    if (path !== repoRoot) {
      throw new Error("Select the Git repository root as the local checkout.");
    }
    try {
      await runGit(repoRoot, ["rev-parse", "--verify", "HEAD"]);
    } catch {
      throw new Error(
        "Create the Git repository's first commit before mapping it.",
      );
    }
    return this.workspaceStore.setMapping(projectId, path, repoRoot);
  }

  unmapProject(projectId: string): boolean {
    return this.workspaceStore.deleteMapping(projectId);
  }

  async preview(projectId: string): Promise<HandoffPreview> {
    const mapping = this.workspaceStore.getMapping(projectId);
    if (!mapping) throw new Error("Map a local checkout before creating Handoff.");
    const snapshot = await this.backend.getSnapshot();
    const project = snapshot.status.projects[projectId];
    if (!project) throw new Error("Portable project was not found.");
    const repoRoot = await canonicalDirectory(mapping.repoRoot);
    const git = await collectGitState(repoRoot);
    const tasks = Object.values(snapshot.status.tasks).filter(
      (task) => task.projectId === projectId,
    );
    const generatedAt = new Date().toISOString();
    const manifest: HandoffManifest = {
      format: "one-status.handoff",
      version: 1,
      generatedAt,
      projectId,
      statusVersion: snapshot.version,
      repository: git,
      context: {
        currentGoal: project.currentGoal,
        decisions: project.decisions,
        currentContext:
          snapshot.status.workspace.activeProjectId === projectId
            ? snapshot.status.workspace.currentContext ?? null
            : null,
        lastAgentId: snapshot.status.workspace.lastAgentId ?? null,
        completed: uniqueStrings(
          tasks.flatMap((task) => [
            ...(task.status === "done" ? [task.title] : []),
            ...task.completed,
          ]),
        ),
        next: uniqueStrings(
          tasks.flatMap((task) => [
            ...(task.status === "todo" || task.status === "in_progress"
              ? [task.title]
              : []),
            ...task.next,
          ]),
        ),
        blocked: uniqueStrings(
          tasks
            .filter((task) => task.status === "blocked")
            .map((task) => task.title),
        ),
      },
      validation: { secretScan: "passed", test: "not_run" },
    };
    const markdown = renderHandoffMarkdown(project.name, manifest);
    let findings: SecretFinding[] = [];
    let secretScanError: string | undefined;
    try {
      findings = await this.#scanSecrets(repoRoot, git.changedFiles, [
        { file: "HANDOFF.md", content: markdown },
        {
          file: ".one-status/handoff.json",
          content: JSON.stringify(manifest, null, 2),
        },
      ]);
      manifest.validation.secretScan = findings.length ? "blocked" : "passed";
    } catch {
      manifest.validation.secretScan = "error";
      secretScanError = "Secret scan could not complete.";
    }
    const existingFiles = (
      await Promise.all(
        ["HANDOFF.md", ".one-status/handoff.json"].map(async (file) =>
          (await pathExists(join(repoRoot, file))) ? file : undefined,
        ),
      )
    ).filter((file): file is string => Boolean(file));
    return {
      canWrite: manifest.validation.secretScan === "passed",
      existingFiles,
      findings,
      manifest,
      markdown,
      mapping: {
        projectId,
        path: mapping.path,
        repoRoot,
      },
      ...(secretScanError ? { secretScanError } : {}),
    };
  }

  async write(input: {
    expectedCommit: string;
    expectedStatusVersion: number;
    overwrite?: boolean;
    projectId: string;
  }) {
    const preview = await this.preview(input.projectId);
    if (preview.manifest.repository.commit !== input.expectedCommit) {
      throw new Error("Git HEAD changed after preview. Create a new preview.");
    }
    if (preview.manifest.statusVersion !== input.expectedStatusVersion) {
      throw new Error("One Status changed after preview. Create a new preview.");
    }
    if (!preview.canWrite) {
      throw new Error("Handoff is blocked by Secret scan.");
    }
    if (preview.existingFiles.length && !input.overwrite) {
      throw new Error("Handoff files already exist. Confirm overwrite explicitly.");
    }
    const root = preview.mapping.repoRoot;
    const handoffPath = join(root, "HANDOFF.md");
    const oneStatusDirectory = join(root, ".one-status");
    const manifestPath = join(oneStatusDirectory, "handoff.json");
    await assertWritableTarget(handoffPath);
    await ensureRealDirectory(oneStatusDirectory);
    await assertWritableTarget(manifestPath);
    await atomicWrite(
      manifestPath,
      `${JSON.stringify(preview.manifest, null, 2)}\n`,
    );
    await atomicWrite(handoffPath, `${preview.markdown.trimEnd()}\n`);
    this.workspaceStore.recordActivity({
      type: "handoff_written",
      projectId: input.projectId,
      summary: `Handoff files written for ${preview.manifest.repository.commit.slice(0, 12)}.`,
    });
    return {
      written: true as const,
      files: ["HANDOFF.md", ".one-status/handoff.json"],
      manifest: preview.manifest,
      committed: false,
      pushed: false,
    };
  }

  async publish(input: {
    confirmCommit: boolean;
    confirmPush: boolean;
    expectedCommit: string;
    expectedStatusVersion: number;
    overwrite?: boolean;
    projectId: string;
  }) {
    if (!input.confirmCommit || !input.confirmPush) {
      throw new Error("Publishing requires explicit commit and push confirmation.");
    }
    const preview = await this.preview(input.projectId);
    validateExpectedPreview(preview, input);
    const branch = preview.manifest.repository.branch;
    if (!branch) throw new Error("Publish Handoff requires a named Git branch.");
    await runGit(preview.mapping.repoRoot, ["check-ref-format", "--branch", branch]);
    const rawRemote = (
      await runGit(preview.mapping.repoRoot, ["remote", "get-url", "origin"])
    ).trim();
    const repositoryUrl = this.#resolvePortableRepositoryUrl(rawRemote);
    if (!repositoryUrl) {
      throw new Error("Publish Handoff requires a GitHub origin remote.");
    }
    const gitEnvironment = await this.#gitEnvironment(repositoryUrl);
    const pushRemote = this.#githubCredentialProvider
      ? repositoryUrl
      : "origin";
    const sourceSnapshot = await this.backend.getSnapshot();
    if (sourceSnapshot.version !== input.expectedStatusVersion) {
      throw new Error("One Status changed after preview. Create a new preview.");
    }
    const project = sourceSnapshot.status.projects[input.projectId];
    if (!project) throw new Error("Portable project was not found.");

    const written = await this.write(input);
    const expectedMarkdown = `${renderHandoffMarkdown(project.name, written.manifest).trimEnd()}\n`;
    const [actualMarkdown, actualManifest] = await Promise.all([
      readFile(join(preview.mapping.repoRoot, "HANDOFF.md"), "utf8"),
      readFile(
        join(preview.mapping.repoRoot, ".one-status", "handoff.json"),
        "utf8",
      ),
    ]);
    if (
      actualMarkdown !== expectedMarkdown ||
      actualManifest !== `${JSON.stringify(written.manifest, null, 2)}\n`
    ) {
      throw new Error("Handoff files changed during publication. Create a new preview.");
    }
    const rescanned = await this.preview(input.projectId);
    if (!rescanned.canWrite) {
      throw new Error("Handoff is blocked by Secret scan.");
    }
    if (rescanned.manifest.repository.commit !== input.expectedCommit) {
      throw new Error("Git HEAD changed after preview. Create a new preview.");
    }

    await runGit(preview.mapping.repoRoot, ["add", "-A", "--"]);
    await runGit(preview.mapping.repoRoot, ["add", "-f", "--", ...HANDOFF_FILES]);
    await runGit(preview.mapping.repoRoot, [
      "-c",
      "core.hooksPath=/dev/null",
      "commit",
      "-m",
      "chore(one-status): publish handoff",
    ]);
    const publishedCommit = (
      await runGit(preview.mapping.repoRoot, ["rev-parse", "HEAD"])
    ).trim();
    await runGit(
      preview.mapping.repoRoot,
      ["push", "--no-verify", pushRemote, `HEAD:refs/heads/${branch}`],
      { environment: gitEnvironment, timeout: GIT_NETWORK_TIMEOUT_MS },
    );
    const remoteHead = (
      await runGit(
        preview.mapping.repoRoot,
        ["ls-remote", "--exit-code", pushRemote, `refs/heads/${branch}`],
        { environment: gitEnvironment, timeout: GIT_NETWORK_TIMEOUT_MS },
      )
    )
      .trim()
      .split(/\s+/)[0];
    if (remoteHead !== publishedCommit) {
      throw new Error("GitHub did not report the published Handoff commit.");
    }

    const publishedAt = new Date().toISOString();
    const synced = await this.backend.mutateStatus((status) => {
      const current = status.projects[input.projectId];
      if (!current) throw new Error("Portable project was not found.");
      current.handoff = {
        provider: "github",
        repositoryUrl,
        branch,
        commit: publishedCommit,
        publishedAt,
        sourceDeviceId: sourceSnapshot.profile.deviceId,
        statusVersion: written.manifest.statusVersion,
      };
      current.updatedAt = publishedAt;
    });
    this.workspaceStore.recordActivity({
      type: "handoff_published",
      projectId: input.projectId,
      summary: `Handoff ${publishedCommit.slice(0, 12)} pushed to ${branch}.`,
    });
    return {
      written: true as const,
      committed: true as const,
      pushed: true as const,
      files: [...HANDOFF_FILES],
      repository: {
        provider: "github" as const,
        url: repositoryUrl,
        branch,
        commit: publishedCommit,
      },
      statusVersion: synced.version,
    };
  }

  async openAndContinue(input: {
    agentId: SupportedAgentId;
    confirmCheckout: boolean;
    destinationPath?: string;
    projectId: string;
  }) {
    if (!input.confirmCheckout) {
      throw new Error("Opening a Handoff requires explicit checkout confirmation.");
    }
    const snapshot = await this.backend.getSnapshot();
    const project = snapshot.status.projects[input.projectId];
    if (!project) throw new Error("Portable project was not found.");
    const handoff = project.handoff;
    if (!handoff) throw new Error("Publish a Handoff before continuing this project.");
    const gitEnvironment = await this.#gitEnvironment(handoff.repositoryUrl);
    let mapping = this.workspaceStore.getMapping(input.projectId);
    let repoRoot: string;
    let cloned = false;

    if (mapping) {
      repoRoot = await canonicalDirectory(mapping.repoRoot);
      if (input.destinationPath) {
        const requested = await canonicalDirectory(input.destinationPath);
        if (requested !== repoRoot) {
          throw new Error("The selected path differs from this device's project mapping.");
        }
      }
      const dirty = await runGit(repoRoot, ["status", "--porcelain=v1"]);
      if (dirty.trim()) {
        throw new Error("The local checkout has uncommitted changes.");
      }
      await assertMatchingOrigin(
        repoRoot,
        handoff.repositoryUrl,
        this.#resolvePortableRepositoryUrl,
      );
      await runGit(
        repoRoot,
        [
          "fetch",
          this.#githubCredentialProvider ? handoff.repositoryUrl : "origin",
          handoff.branch,
        ],
        { environment: gitEnvironment, timeout: GIT_NETWORK_TIMEOUT_MS },
      );
    } else {
      if (!input.destinationPath) {
        throw new Error("Choose a new local folder for this project.");
      }
      repoRoot = await prepareCloneDestination(input.destinationPath);
      await runGit(
        dirname(repoRoot),
        [
          "clone",
          "--no-checkout",
          "--origin",
          "origin",
          "--",
          handoff.repositoryUrl,
          basename(repoRoot),
        ],
        { environment: gitEnvironment, timeout: GIT_NETWORK_TIMEOUT_MS },
      );
      repoRoot = await canonicalDirectory(repoRoot);
      cloned = true;
    }

    await runGit(repoRoot, ["cat-file", "-e", `${handoff.commit}^{commit}`]);
    const continuationBranch = continuationBranchName(
      input.projectId,
      handoff.commit,
    );
    await runGit(repoRoot, [
      "-c",
      "core.hooksPath=/dev/null",
      "checkout",
      "-B",
      continuationBranch,
      handoff.commit,
    ]);
    const actualCommit = (await runGit(repoRoot, ["rev-parse", "HEAD"])).trim();
    if (actualCommit !== handoff.commit) {
      throw new Error("The local checkout does not match the published Handoff commit.");
    }
    await verifyHandoffFiles(
      repoRoot,
      input.projectId,
      handoff.statusVersion,
    );
    mapping = this.workspaceStore.setMapping(input.projectId, repoRoot, repoRoot);
    const launch = await this.#agentLauncher.launch({
      agentId: input.agentId,
      commit: handoff.commit,
      cwd: repoRoot,
      projectName: project.name,
    });
    this.workspaceStore.recordActivity({
      type: "handoff_opened",
      projectId: input.projectId,
      summary: `${input.agentId} opened Handoff ${handoff.commit.slice(0, 12)}.`,
    });
    return {
      branch: continuationBranch,
      cloned,
      commit: actualCommit,
      mapping,
      launch,
      opened: true as const,
    };
  }

  async #scanSecrets(
    repoRoot: string,
    changedFiles: string[],
    generated: Array<{ content: string; file: string }>,
  ): Promise<SecretFinding[]> {
    const contents = [...generated];
    const findings: SecretFinding[] = [];
    for (const file of changedFiles) {
      if (file === "HANDOFF.md" || file === ".one-status/handoff.json") {
        continue;
      }
      const path = resolveInside(repoRoot, file);
      let metadata;
      try {
        metadata = await lstat(path);
      } catch {
        continue;
      }
      if (metadata.isSymbolicLink() || !metadata.isFile()) {
        findings.push({
          file,
          line: 1,
          ruleId: "one-status/unscanned-file-type",
        });
        continue;
      }
      if (metadata.size > MAX_SECRET_SCAN_FILE_BYTES) {
        findings.push({
          file,
          line: 1,
          ruleId: "one-status/file-too-large",
        });
        continue;
      }
      const content = await readFile(path);
      if (content.includes(0)) {
        findings.push({
          file,
          line: 1,
          ruleId: "one-status/binary-file",
        });
        continue;
      }
      contents.push({ file, content: content.toString("utf8") });
    }
    for (const source of contents) {
      if (/secretlint-(?:disable|enable)(?:-line|-next-line)?/i.test(source.content)) {
        findings.push({
          file: source.file,
          line: directiveLine(source.content),
          ruleId: "one-status/secretlint-directive",
        });
        continue;
      }
      const filePath = join(repoRoot, source.file);
      const result = await lintSource({
        source: {
          content: source.content,
          contentType: "text",
          ext: extname(filePath),
          filePath,
        },
        options: {
          maskSecrets: true,
          config: {
            rules: [
              {
                id: "@secretlint/secretlint-rule-preset-recommend",
                rule: recommendedSecretRules,
              },
            ],
          },
        },
      });
      for (const message of result.messages) {
        findings.push({
          file: relative(repoRoot, result.filePath),
          line: message.loc.start.line,
          ruleId: message.ruleId,
          ...(message.messageId ? { messageId: message.messageId } : {}),
        });
      }
    }
    return findings;
  }
}

function validateExpectedPreview(
  preview: HandoffPreview,
  input: { expectedCommit: string; expectedStatusVersion: number },
): void {
  if (preview.manifest.repository.commit !== input.expectedCommit) {
    throw new Error("Git HEAD changed after preview. Create a new preview.");
  }
  if (preview.manifest.statusVersion !== input.expectedStatusVersion) {
    throw new Error("One Status changed after preview. Create a new preview.");
  }
  if (!preview.canWrite) {
    throw new Error("Handoff is blocked by Secret scan.");
  }
}

async function prepareCloneDestination(requestedPath: string): Promise<string> {
  if (!isAbsolute(requestedPath)) {
    throw new Error("The clone destination must be an absolute path.");
  }
  const destination = resolve(requestedPath);
  try {
    await lstat(destination);
    throw new Error("The clone destination must not already exist.");
  } catch (error) {
    if (!isMissing(error)) throw error;
  }
  const parent = await canonicalDirectory(dirname(destination));
  return join(parent, basename(destination));
}

async function assertMatchingOrigin(
  repoRoot: string,
  expected: string,
  resolvePortableRepositoryUrl: (remote: string) => string | null,
): Promise<void> {
  const remote = (
    await runGit(repoRoot, ["remote", "get-url", "origin"])
  ).trim();
  if (resolvePortableRepositoryUrl(remote) !== expected) {
    throw new Error("The local checkout origin does not match the Handoff repository.");
  }
}

async function verifyHandoffFiles(
  repoRoot: string,
  projectId: string,
  statusVersion: number,
): Promise<void> {
  const markdownPath = join(repoRoot, "HANDOFF.md");
  const manifestPath = join(repoRoot, ".one-status", "handoff.json");
  for (const path of [markdownPath, manifestPath]) {
    const metadata = await lstat(path);
    if (!metadata.isFile() || metadata.isSymbolicLink()) {
      throw new Error("The published Handoff contains an invalid file target.");
    }
  }
  const manifest = storedHandoffManifestSchema.parse(
    JSON.parse(await readFile(manifestPath, "utf8")),
  );
  if (
    manifest.projectId !== projectId ||
    manifest.statusVersion !== statusVersion
  ) {
    throw new Error("The published Handoff manifest does not match One Status.");
  }
}

export function portableGitHubUrl(value: string): string | null {
  const scp = /^(?:[^@\s]+@)?github\.com:([^\s]+)$/i.exec(value);
  if (scp) return normalizeGitHubPath(scp[1]);
  try {
    const url = new URL(value);
    if (url.hostname.toLowerCase() !== "github.com") return null;
    return normalizeGitHubPath(url.pathname);
  } catch {
    return null;
  }
}

function continuationBranchName(projectId: string, commit: string): string {
  const slug = projectId
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);
  return `one-status/continue/${slug || "project"}-${commit.slice(0, 12)}`;
}

function normalizeGitHubPath(value: string | undefined): string | null {
  if (!value) return null;
  const path = value.replace(/^\/+/, "").replace(/\/+$/, "");
  if (!/^[^/\s]+\/[^/\s]+(?:\.git)?$/.test(path)) return null;
  return `https://github.com/${path}`;
}

async function collectGitState(
  repoRoot: string,
): Promise<HandoffManifest["repository"]> {
  const [commit, branch, statusOutput, changedOutput, untrackedOutput, remote] =
    await Promise.all([
      runGit(repoRoot, ["rev-parse", "HEAD"]),
      runGit(repoRoot, ["branch", "--show-current"]),
      runGit(repoRoot, ["status", "--porcelain=v1", "-z"]),
      runGit(repoRoot, ["diff", "--name-only", "-z", "HEAD"]),
      runGit(repoRoot, ["ls-files", "--others", "--exclude-standard", "-z"]),
      runGit(repoRoot, ["remote", "get-url", "origin"]).catch(() => ""),
    ]);
  const changedFiles = uniqueStrings([
    ...splitNull(changedOutput),
    ...splitNull(untrackedOutput),
  ]).sort();
  if (changedFiles.length > MAX_CHANGED_FILES) {
    throw new Error(
      `Handoff preview is limited to ${MAX_CHANGED_FILES} changed files.`,
    );
  }
  return {
    commit: commit.trim(),
    branch: branch.trim() || null,
    dirty: statusOutput.length > 0,
    changedFiles,
    remote: sanitizeGitRemote(remote.trim()),
  };
}

async function runGit(
  cwd: string,
  arguments_: string[],
  options: {
    environment?: Record<string, string>;
    timeout?: number;
  } = {},
): Promise<string> {
  return new Promise((resolvePromise, reject) => {
    execFile(
      "/usr/bin/git",
      ["-C", cwd, ...arguments_],
      {
        encoding: "utf8",
        env: { ...process.env, ...options.environment },
        maxBuffer: 2 * 1024 * 1024,
        timeout: options.timeout ?? GIT_TIMEOUT_MS,
      },
      (error, stdout) => {
        if (error) {
          reject(new Error(`Git command failed (${gitOperation(arguments_)}).`));
        } else {
          resolvePromise(stdout);
        }
      },
    );
  });
}

function gitOperation(arguments_: string[]): string {
  return arguments_[0] === "-c"
    ? arguments_[2] ?? "unknown"
    : arguments_[0] ?? "unknown";
}

function renderHandoffMarkdown(
  projectName: string,
  manifest: HandoffManifest,
): string {
  const section = (title: string, values: string[]) =>
    `## ${title}\n\n${values.length ? values.map((value) => `- ${value}`).join("\n") : "- None"}`;
  return `# ${projectName} Handoff

Generated: ${manifest.generatedAt}

## Current Goal

${manifest.context.currentGoal || "No current goal recorded."}

## Current Context

${manifest.context.currentContext || "No active context recorded."}

${section("Architecture Decisions", manifest.context.decisions)}

${section("Completed", manifest.context.completed)}

${section("Next", manifest.context.next)}

${section("Blocked", manifest.context.blocked)}

## Git State

- Branch: ${manifest.repository.branch ?? "detached"}
- Commit: ${manifest.repository.commit}
- Dirty: ${manifest.repository.dirty ? "yes" : "no"}
- Tests: not run
`;
}

async function canonicalDirectory(path: string): Promise<string> {
  const canonical = await realpath(resolve(path));
  const metadata = await lstat(canonical);
  if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
    throw new Error("Local project path must be a real directory.");
  }
  return canonical;
}

function resolveInside(root: string, path: string): string {
  const resolved = resolve(root, path);
  if (resolved !== root && !resolved.startsWith(`${root}${sep}`)) {
    throw new Error("Git returned a path outside the repository.");
  }
  return resolved;
}

function sanitizeGitRemote(value: string): string | null {
  if (!value) return null;
  try {
    const url = new URL(value);
    url.username = "";
    url.password = "";
    url.search = "";
    url.hash = "";
    return url.toString();
  } catch {
    const scp = /^[^@\s]+@([A-Za-z0-9.-]+):([^\s]+)$/.exec(value);
    return scp ? `${scp[1]}:${scp[2]}` : null;
  }
}

async function ensureRealDirectory(path: string): Promise<void> {
  try {
    const metadata = await lstat(path);
    if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
      throw new Error(".one-status must be a real directory.");
    }
  } catch (error) {
    if (!isMissing(error)) throw error;
    await mkdir(path, { mode: 0o700 });
  }
}

async function assertWritableTarget(path: string): Promise<void> {
  try {
    const metadata = await lstat(path);
    if (!metadata.isFile() || metadata.isSymbolicLink()) {
      throw new Error(`${basename(path)} must be a regular file.`);
    }
  } catch (error) {
    if (!isMissing(error)) throw error;
  }
}

async function atomicWrite(path: string, content: string): Promise<void> {
  const temporary = join(
    dirname(path),
    `.${basename(path)}.${process.pid}.${Date.now()}.tmp`,
  );
  await writeFile(temporary, content, { encoding: "utf8", mode: 0o600 });
  await chmod(temporary, 0o600);
  await rename(temporary, path);
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

function splitNull(value: string): string[] {
  return value.split("\0").filter(Boolean);
}

function uniqueStrings(values: string[]): string[] {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))];
}

function directiveLine(content: string): number {
  const index = content.search(
    /secretlint-(?:disable|enable)(?:-line|-next-line)?/i,
  );
  return index < 0 ? 1 : content.slice(0, index).split("\n").length;
}

function isMissing(error: unknown): boolean {
  return (
    error instanceof Error &&
    "code" in error &&
    (error as Error & { code?: string }).code === "ENOENT"
  );
}
