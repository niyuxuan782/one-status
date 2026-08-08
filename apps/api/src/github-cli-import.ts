import { execFile } from "node:child_process";
import { accessSync, constants } from "node:fs";
import { isAbsolute } from "node:path";
import { z } from "zod";
import type { ProviderFetch } from "./oauth-providers.js";
import {
  type OAuthConnection,
  PermissionVault,
} from "./permission-vault.js";

const GH_COMMAND_TIMEOUT_MS = 10_000;
const GH_MAX_OUTPUT_BYTES = 64 * 1024;
const GITHUB_RESPONSE_MAX_BYTES = 256 * 1024;
const GITHUB_REQUEST_TIMEOUT_MS = 15_000;

export interface GitHubCliCommandOptions {
  encoding: "utf8";
  maxBuffer: number;
  shell: false;
  timeout: number;
  windowsHide: true;
}

export type GitHubCliCommandRunner = (
  command: string,
  arguments_: readonly string[],
  options: GitHubCliCommandOptions,
) => Promise<{ stdout: string }>;

export interface GitHubCliCredentialImporterOptions {
  command?: string;
  fetch?: ProviderFetch;
  runCommand?: GitHubCliCommandRunner;
}

export class GitHubCliImportError extends Error {
  constructor(
    readonly code:
      | "github_cli_unavailable"
      | "github_cli_credential_invalid"
      | "github_cli_verification_failed",
    message: string,
  ) {
    super(message);
    this.name = "GitHubCliImportError";
  }
}

export class GitHubCliCredentialImporter {
  readonly #fetch: ProviderFetch;
  readonly #command?: string;
  readonly #runCommand: GitHubCliCommandRunner;

  constructor(
    private readonly vault: PermissionVault,
    options: GitHubCliCredentialImporterOptions = {},
  ) {
    this.#command = options.command;
    this.#fetch = options.fetch ?? globalThis.fetch;
    this.#runCommand = options.runCommand ?? runGitHubCliCommand;
  }

  async import(userId: string): Promise<OAuthConnection> {
    const accessToken = await this.#readAccessToken();
    const verified = await this.#verifyCredential(accessToken);
    return this.vault.upsertConnection({
      accountId: verified.accountId,
      credential: { accessToken, tokenType: "Bearer" },
      expiresAt: null,
      label: verified.label,
      provider: "github",
      scopes: verified.scopes,
      source: "imported",
      userId,
    });
  }

  async #readAccessToken(): Promise<string> {
    let stdout: string;
    try {
      ({ stdout } = await this.#runCommand(
        this.#command ?? resolveGitHubCliCommand(),
        ["auth", "token", "--hostname", "github.com"],
        {
          encoding: "utf8",
          maxBuffer: GH_MAX_OUTPUT_BYTES,
          shell: false,
          timeout: GH_COMMAND_TIMEOUT_MS,
          windowsHide: true,
        },
      ));
    } catch {
      throw new GitHubCliImportError(
        "github_cli_unavailable",
        "GitHub CLI is unavailable or has no active github.com login.",
      );
    }
    const accessToken = stdout.trim();
    if (
      !accessToken ||
      accessToken.length > 32_000 ||
      Buffer.byteLength(accessToken, "utf8") >= GH_MAX_OUTPUT_BYTES ||
      /\s/.test(accessToken)
    ) {
      throw new GitHubCliImportError(
        "github_cli_credential_invalid",
        "GitHub CLI returned invalid credential data.",
      );
    }
    return accessToken;
  }

  async #verifyCredential(accessToken: string): Promise<{
    accountId: string;
    label: string;
    scopes: string[];
  }> {
    try {
      const response = await this.#fetch("https://api.github.com/user", {
        headers: {
          accept: "application/vnd.github+json",
          authorization: `Bearer ${accessToken}`,
          "user-agent": "one-status/0.1.1",
          "x-github-api-version": "2022-11-28",
        },
        signal: AbortSignal.timeout(GITHUB_REQUEST_TIMEOUT_MS),
      });
      if (!response.ok) throw new Error("credential_rejected");
      const profile = githubUserSchema.parse(
        JSON.parse(
          await readLimitedResponse(response, GITHUB_RESPONSE_MAX_BYTES),
        ),
      );
      return {
        accountId: String(profile.id),
        label: profile.login,
        scopes: [
          ...new Set([
            ...parseGitHubScopes(response.headers.get("x-oauth-scopes")),
            "read:user",
          ]),
        ],
      };
    } catch {
      throw new GitHubCliImportError(
        "github_cli_verification_failed",
        "GitHub rejected the imported CLI credential.",
      );
    }
  }
}

export function resolveGitHubCliCommand(
  environment: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
  isExecutable: (path: string) => boolean = executableFile,
): string {
  const override = environment.ONE_STATUS_GH_PATH?.trim();
  if (override) {
    if (!isAbsolute(override) || !isExecutable(override)) {
      throw new GitHubCliImportError(
        "github_cli_unavailable",
        "ONE_STATUS_GH_PATH does not point to an executable GitHub CLI.",
      );
    }
    return override;
  }
  const candidates =
    platform === "darwin"
      ? ["/opt/homebrew/bin/gh", "/usr/local/bin/gh"]
      : platform === "linux"
        ? [
            "/home/linuxbrew/.linuxbrew/bin/gh",
            "/usr/local/bin/gh",
            "/usr/bin/gh",
          ]
        : [];
  return candidates.find(isExecutable) ?? (platform === "win32" ? "gh.exe" : "gh");
}

function executableFile(path: string): boolean {
  try {
    accessSync(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

export function runGitHubCliCommand(
  command: string,
  arguments_: readonly string[],
  options: GitHubCliCommandOptions,
): Promise<{ stdout: string }> {
  return new Promise((resolve, reject) => {
    execFile(command, [...arguments_], options, (error, stdout) => {
      if (error) {
        reject(new Error("GitHub CLI command failed."));
        return;
      }
      resolve({ stdout });
    });
  });
}

async function readLimitedResponse(
  response: Response,
  maxBytes: number,
): Promise<string> {
  const declaredLength = Number(response.headers.get("content-length"));
  if (Number.isFinite(declaredLength) && declaredLength > maxBytes) {
    throw new Error("response_too_large");
  }
  if (!response.body) return "";
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > maxBytes) {
      await reader.cancel();
      throw new Error("response_too_large");
    }
    chunks.push(value);
  }
  const body = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(body);
}

function parseGitHubScopes(value: string | null): string[] {
  if (!value) return [];
  if (value.length > 20_000) throw new Error("scope_header_too_large");
  const scopes = [
    ...new Set(
      value
        .split(",")
        .map((scope) => scope.trim())
        .filter(Boolean),
    ),
  ];
  if (scopes.length > 100 || scopes.some((scope) => scope.length > 500)) {
    throw new Error("scope_header_invalid");
  }
  return scopes;
}

const githubUserSchema = z
  .object({
    id: z.number().int().positive().safe(),
    login: z.string().min(1).max(500),
  })
  .passthrough();
