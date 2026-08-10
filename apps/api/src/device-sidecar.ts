import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import type {
  AgentToolId,
  ModelSource,
} from "@one-status/protocol";
import {
  ModelConfigurationApplyError,
  type ModelConfigurationAdapter,
  type ModelConfigurationInput,
  type ModelConfigurationPlan,
} from "./device-control.js";
import { z } from "zod";

const COMMAND_TIMEOUT_MS = 20_000;
const MAX_OUTPUT_BYTES = 2 * 1024 * 1024;

export type SidecarCommand = "apply" | "preview" | "rollback" | "scan" | "usage";

interface SidecarSuccess<T> {
  schemaVersion: 1;
  ok: true;
  command: SidecarCommand;
  data: T;
}

interface SidecarFailure {
  schemaVersion: 1;
  ok: false;
  command: SidecarCommand;
  error: {
    code: string;
    message: string;
    rolledBack?: boolean;
  };
}

export interface DeviceSidecarRunner {
  run<T>(
    command: SidecarCommand,
    input: unknown,
    environment?: NodeJS.ProcessEnv,
  ): Promise<T>;
}

export interface DeviceSidecarOptions {
  environment?: NodeJS.ProcessEnv;
  executable?: string;
  runner?: DeviceSidecarRunner;
}

export class DeviceSidecarCommandError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly rolledBack: boolean,
  ) {
    super(message);
    this.name = "DeviceSidecarCommandError";
  }
}

export class DeviceSidecarProcessRunner implements DeviceSidecarRunner {
  readonly #environment: NodeJS.ProcessEnv;
  readonly #executable: string;

  constructor(options: Omit<DeviceSidecarOptions, "runner"> = {}) {
    this.#environment = options.environment ?? process.env;
    this.#executable =
      options.executable ?? resolveDeviceSidecarExecutable(this.#environment);
  }

  run<T>(
    command: SidecarCommand,
    input: unknown,
    environment: NodeJS.ProcessEnv = {},
  ): Promise<T> {
    return new Promise<T>((resolvePromise, rejectPromise) => {
      const child = spawn(this.#executable, [command], {
        env: sidecarEnvironment(this.#environment, environment),
        shell: false,
        stdio: ["pipe", "pipe", "pipe"],
        windowsHide: true,
      });
      const stdout: Buffer[] = [];
      let stdoutBytes = 0;
      let settled = false;
      const finish = (callback: () => void): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        callback();
      };
      const timeout = setTimeout(() => {
        child.kill();
        finish(() =>
          rejectPromise(
            new DeviceSidecarCommandError(
              "sidecar_timeout",
              "The local configuration sidecar timed out.",
              false,
            ),
          ),
        );
      }, COMMAND_TIMEOUT_MS);

      child.stdout.on("data", (chunk: Buffer) => {
        stdoutBytes += chunk.length;
        if (stdoutBytes > MAX_OUTPUT_BYTES) {
          child.kill();
          finish(() =>
            rejectPromise(
              new DeviceSidecarCommandError(
                "sidecar_output_limit",
                "The local configuration sidecar exceeded its output limit.",
                false,
              ),
            ),
          );
          return;
        }
        stdout.push(chunk);
      });
      // Stderr is discarded so local config contents cannot reach API logs or Status.
      child.stderr.resume();
      child.stdin.on("error", () => undefined);
      child.on("error", () => {
        finish(() =>
          rejectPromise(
            new DeviceSidecarCommandError(
              "sidecar_unavailable",
              "The One Status device sidecar is unavailable.",
              false,
            ),
          ),
        );
      });
      child.on("close", () => {
        finish(() => {
          let response: SidecarSuccess<T> | SidecarFailure;
          try {
            response = JSON.parse(Buffer.concat(stdout).toString("utf8")) as
              | SidecarSuccess<T>
              | SidecarFailure;
          } catch {
            rejectPromise(
              new DeviceSidecarCommandError(
                "sidecar_invalid_response",
                "The local configuration sidecar returned an invalid response.",
                false,
              ),
            );
            return;
          }
          if (
            !response ||
            response.schemaVersion !== 1 ||
            typeof response.ok !== "boolean"
          ) {
            rejectPromise(
              new DeviceSidecarCommandError(
                "sidecar_invalid_response",
                "The local configuration sidecar returned an invalid response.",
                false,
              ),
            );
            return;
          }
          if (!response.ok) {
            rejectPromise(
              new DeviceSidecarCommandError(
                response.error.code,
                sanitizeSidecarMessage(response.error.message),
                response.error.rolledBack === true,
              ),
            );
            return;
          }
          resolvePromise(response.data);
        });
      });
      child.stdin.end(JSON.stringify(input));
    });
  }
}

function sidecarEnvironment(
  base: NodeJS.ProcessEnv,
  operation: NodeJS.ProcessEnv,
): NodeJS.ProcessEnv {
  const allowed = [
    "CODEX_HOME",
    "CLAUDE_CONFIG_DIR",
    "HOME",
    "LANG",
    "LC_ALL",
    "LOCALAPPDATA",
    "PATH",
    "PATHEXT",
    "SystemRoot",
    "TEMP",
    "TMP",
    "USERPROFILE",
    "XDG_CONFIG_HOME",
    "XDG_DATA_HOME",
  ];
  const environment: NodeJS.ProcessEnv = {};
  for (const key of allowed) {
    if (base[key] !== undefined) environment[key] = base[key];
  }
  for (const [key, value] of Object.entries(operation)) {
    if (value !== undefined) environment[key] = value;
  }
  return environment;
}

export class SidecarModelConfigurationAdapter
  implements ModelConfigurationAdapter
{
  readonly #runner: DeviceSidecarRunner;

  constructor(options: DeviceSidecarOptions = {}) {
    this.#runner =
      options.runner ??
      new DeviceSidecarProcessRunner({
        ...(options.environment ? { environment: options.environment } : {}),
        ...(options.executable ? { executable: options.executable } : {}),
      });
  }

  async preview(input: ModelConfigurationInput): Promise<ModelConfigurationPlan> {
    const invocation = sidecarInvocation(input);
    const result = sidecarPreviewSchema.parse(
      await this.#runner.run(
        "preview",
        invocation.request,
        invocation.environment,
      ),
    );
    return {
      ...result,
      requiresRestart: true,
    };
  }

  async apply(
    input: ModelConfigurationInput,
  ): Promise<{ appliedAt: string; planId: string; transactionId: string }> {
    const invocation = sidecarInvocation(input);

    try {
      const planId =
        input.expectedPlanId ?? (await this.preview(input)).planId;
      const result = sidecarApplySchema.parse(
        await this.#runner.run(
          "apply",
          { ...invocation.request, expectedPlanId: planId },
          invocation.environment,
        ),
      );
      return {
        appliedAt: new Date().toISOString(),
        planId: result.planId,
        transactionId: result.transactionId,
      };
    } catch (error) {
      if (error instanceof DeviceSidecarCommandError) {
        throw new ModelConfigurationApplyError(
          error.message,
          error.rolledBack,
        );
      }
      throw new ModelConfigurationApplyError(
        "The local model configuration failed.",
        false,
      );
    }
  }
}

export interface LocalModelUsageSnapshot {
  scannedAt: string;
  scope: string;
  filesScanned: number;
  truncated: boolean;
  entries: Array<{
    tool: AgentToolId;
    modelId: string;
    dataSource: "claude-session" | "codex-session";
    inputTokens: number;
    cachedInputTokens: number;
    cacheCreationInputTokens: number;
    outputTokens: number;
    requests: number;
    latestAt?: string;
  }>;
  warnings: string[];
}

export class SidecarModelUsageReader {
  readonly #runner: DeviceSidecarRunner;
  readonly #cacheTtlMs: number;
  #cached?: { expiresAt: number; value: LocalModelUsageSnapshot };
  #pending?: Promise<LocalModelUsageSnapshot>;

  constructor(
    options: DeviceSidecarOptions & { cacheTtlMs?: number } = {},
  ) {
    this.#runner =
      options.runner ??
      new DeviceSidecarProcessRunner({
        ...(options.environment ? { environment: options.environment } : {}),
        ...(options.executable ? { executable: options.executable } : {}),
      });
    this.#cacheTtlMs = options.cacheTtlMs ?? 30_000;
  }

  async scan(): Promise<LocalModelUsageSnapshot> {
    if (this.#cached && this.#cached.expiresAt > Date.now()) {
      return this.#cached.value;
    }
    if (this.#pending) return this.#pending;
    this.#pending = this.#runner
      .run("usage", { maxFilesPerTool: 100 })
      .then((value) => sidecarUsageSchema.parse(value))
      .then((value) => {
        this.#cached = {
          expiresAt: Date.now() + this.#cacheTtlMs,
          value,
        };
        return value;
      })
      .finally(() => {
        this.#pending = undefined;
      });
    return this.#pending;
  }
}

function sidecarInvocation(input: ModelConfigurationInput): {
  environment?: NodeJS.ProcessEnv;
  request: { tool: AgentToolId; profile: Record<string, unknown> };
} {
  const credentialEnvVar = credentialVariable(input.source, input.toolId);
  const profile = {
    id: sidecarProfileId(input.source.id),
    displayName: input.source.label,
    modelId: input.model.modelId,
    modelName: input.model.name,
    source: sourceKind(input.source.kind),
    apiProtocol: apiProtocol(input.source.protocol, input.toolId),
    ...(input.source.endpoint ? { endpoint: input.source.endpoint } : {}),
    ...(credentialEnvVar ? { credentialEnvVar } : {}),
  };
  return {
    request: { tool: input.toolId, profile },
    ...(input.apiKey && credentialEnvVar
      ? { environment: { [credentialEnvVar]: input.apiKey } }
      : {}),
  };
}

const sidecarPlanTargetSchema = z
  .object({
    purpose: z.string().min(1).max(120),
    path: z.string().min(1).max(4_096),
    existed: z.boolean(),
    beforeSha256: z.string().regex(/^[a-f0-9]{64}$/),
    afterSha256: z.string().regex(/^[a-f0-9]{64}$/),
    beforeMode: z.number().int().min(0).max(0o777).optional(),
    afterMode: z.number().int().min(0).max(0o777).optional(),
  })
  .strict();

const sidecarChangeSchema = z
  .object({
    path: z.string().min(1).max(2_000),
    operation: z.enum(["add", "update", "remove"]),
    before: z.unknown().optional(),
    after: z.unknown().optional(),
    sensitive: z.boolean().optional(),
  })
  .strict();

const sidecarPreviewSchema = z
  .object({
    planId: z.string().regex(/^plan_[a-f0-9]{64}$/),
    tool: z.enum(["codex", "claude-code", "cursor"]),
    profile: z.record(z.string(), z.unknown()),
    targets: z.array(sidecarPlanTargetSchema).min(1).max(8),
    changes: z.array(sidecarChangeSchema).max(100),
    requiresCredentialEnv: z.string().max(128).optional(),
    warnings: z.array(z.string().max(2_000)).max(20).default([]),
  })
  .strict()
  .transform((value) => ({
    planId: value.planId,
    targets: value.targets,
    changes: value.changes,
    warnings: value.warnings,
  }));

const sidecarApplySchema = z
  .object({
    planId: z.string().regex(/^plan_[a-f0-9]{64}$/),
    state: z.literal("applied"),
    transactionId: z.string().min(20).max(96),
    tool: z.enum(["codex", "claude-code", "cursor"]),
    targets: z.array(sidecarPlanTargetSchema).min(1).max(8),
  })
  .strict();

const tokenCountSchema = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const sidecarUsageSchema = z
  .object({
    scannedAt: z.string().min(1).max(64),
    scope: z.string().min(1).max(120),
    filesScanned: z.number().int().nonnegative().max(1_000),
    truncated: z.boolean(),
    entries: z
      .array(
        z
          .object({
            tool: z.enum(["codex", "claude-code"]),
            modelId: z.string().min(1).max(300),
            dataSource: z.enum(["codex-session", "claude-session"]),
            inputTokens: tokenCountSchema,
            cachedInputTokens: tokenCountSchema,
            cacheCreationInputTokens: tokenCountSchema,
            outputTokens: tokenCountSchema,
            requests: tokenCountSchema,
            latestAt: z.string().min(1).max(64).optional(),
          })
          .strict(),
      )
      .max(2_000),
    warnings: z.array(z.string().max(500)).max(100).default([]),
  })
  .strict();

function sourceKind(kind: ModelSource["kind"]): string {
  switch (kind) {
    case "compatible-api":
      return "third-party-compatible-api";
    case "local-service":
      return "local-model-service";
    default:
      return kind;
  }
}

function apiProtocol(
  protocol: ModelSource["protocol"],
  toolId: AgentToolId,
): string {
  if (toolId === "claude-code") return "anthropic";
  if (protocol === "anthropic") return "anthropic";
  if (protocol === "azure-openai" || protocol === "ollama") {
    return "openai-chat-completions";
  }
  return "openai-responses";
}

function credentialVariable(
  source: ModelSource,
  toolId: AgentToolId,
): string | undefined {
  if (source.kind === "official-account" || source.kind === "local-service") {
    return undefined;
  }
  if (toolId === "claude-code") {
    return source.kind === "official-api"
      ? "ANTHROPIC_API_KEY"
      : "ANTHROPIC_AUTH_TOKEN";
  }
  const digest = createHash("sha256")
    .update(source.id)
    .digest("hex")
    .slice(0, 16)
    .toUpperCase();
  return `ONE_STATUS_MODEL_${digest}_API_KEY`;
}

function sidecarProfileId(sourceId: string): string {
  return `source-${createHash("sha256").update(sourceId).digest("hex").slice(0, 24)}`;
}

export function resolveDeviceSidecarExecutable(
  environment: NodeJS.ProcessEnv,
  entrypoint: string | undefined = process.argv[1],
): string {
  if (environment.ONE_STATUS_DEVICE_SIDECAR) {
    return resolve(environment.ONE_STATUS_DEVICE_SIDECAR);
  }
  const executable = process.platform === "win32"
    ? "one-status-device-sidecar.exe"
    : "one-status-device-sidecar";
  const cliDirectory = entrypoint
    ? dirname(resolve(entrypoint))
    : undefined;
  const candidates = [
    typeof process.resourcesPath === "string"
      ? join(process.resourcesPath, "bin", executable)
      : undefined,
    cliDirectory ? join(cliDirectory, executable) : undefined,
    resolve(process.cwd(), "apps", "device-sidecar", "target", "release", executable),
    resolve(process.cwd(), "apps", "device-sidecar", "target", "debug", executable),
  ];
  return candidates.find((candidate) => candidate && existsSync(candidate)) ?? executable;
}

function sanitizeSidecarMessage(message: string): string {
  return message
    .replace(/(?:sk|key|token)-[A-Za-z0-9._-]+/gi, "[redacted]")
    .slice(0, 2_000);
}
