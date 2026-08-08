import { execFile } from "node:child_process";
import { access, constants } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, delimiter, join } from "node:path";

const COMMAND_TIMEOUT_MS = 10_000;

export type SupportedAgentId = "claude-code" | "codex";

export interface AgentLaunchInput {
  agentId: SupportedAgentId;
  commit: string;
  cwd: string;
  projectName: string;
}

export interface AgentLaunchResult {
  agentId: SupportedAgentId;
  command: string;
  cwd: string;
  launched: true;
  mode: "terminal";
}

export interface AgentLauncher {
  launch(input: AgentLaunchInput): Promise<AgentLaunchResult>;
}

export interface LocalAgentLauncherOptions {
  environment?: NodeJS.ProcessEnv;
  homeDir?: string;
  platform?: NodeJS.Platform;
  resolveExecutable?: (name: "claude" | "codex") => Promise<string | undefined>;
  runCommand?: (executable: string, arguments_: string[]) => Promise<void>;
}

export class LocalAgentLauncher implements AgentLauncher {
  readonly #environment: NodeJS.ProcessEnv;
  readonly #homeDir: string;
  readonly #platform: NodeJS.Platform;
  readonly #resolveExecutable?: LocalAgentLauncherOptions["resolveExecutable"];
  readonly #runCommand: NonNullable<LocalAgentLauncherOptions["runCommand"]>;

  constructor(options: LocalAgentLauncherOptions = {}) {
    this.#environment = options.environment ?? process.env;
    this.#homeDir = options.homeDir ?? homedir();
    this.#platform = options.platform ?? process.platform;
    this.#resolveExecutable = options.resolveExecutable;
    this.#runCommand = options.runCommand ?? runCommand;
  }

  async launch(input: AgentLaunchInput): Promise<AgentLaunchResult> {
    if (this.#platform !== "darwin") {
      throw new Error(
        "Interactive Agent launch currently requires the macOS desktop runtime.",
      );
    }
    const commandName = input.agentId === "codex" ? "codex" : "claude";
    const executable = await (this.#resolveExecutable
      ? this.#resolveExecutable(commandName)
      : findExecutable(commandName, this.#environment, this.#homeDir));
    if (!executable) {
      throw new Error(
        `${input.agentId === "codex" ? "Codex" : "Claude Code"} CLI was not found on this device.`,
      );
    }
    const prompt = continuationPrompt(input);
    const terminalCommand = [
      `cd -- ${shellQuote(input.cwd)}`,
      `exec ${shellQuote(executable)} ${shellQuote(prompt)}`,
    ].join(" && ");
    const appleScript = [
      'tell application "Terminal"',
      "activate",
      `do script ${JSON.stringify(terminalCommand)}`,
      "end tell",
    ].join("\n");
    await this.#runCommand("/usr/bin/osascript", ["-e", appleScript]);
    return {
      agentId: input.agentId,
      command: basename(executable),
      cwd: input.cwd,
      launched: true,
      mode: "terminal",
    };
  }
}

function continuationPrompt(input: AgentLaunchInput): string {
  return [
    `Continue ${input.projectName} from its One Status Handoff.`,
    "First read HANDOFF.md and .one-status/handoff.json in this repository.",
    "Then call the One Status status_get_context MCP tool before changing files.",
    `Verify git HEAD is ${input.commit}.`,
    "Summarize the current goal and next actions, then continue the work.",
  ].join(" ");
}

async function findExecutable(
  name: "claude" | "codex",
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
  ];
  for (const candidate of new Set(candidates)) {
    try {
      await access(candidate, constants.X_OK);
      return candidate;
    } catch {
      continue;
    }
  }
  return undefined;
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

function runCommand(executable: string, arguments_: string[]): Promise<void> {
  return new Promise((resolvePromise, reject) => {
    execFile(
      executable,
      arguments_,
      { timeout: COMMAND_TIMEOUT_MS },
      (error) => (error ? reject(error) : resolvePromise()),
    );
  });
}
