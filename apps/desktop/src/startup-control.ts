import { execFile as execFileCallback } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  chmod,
  mkdir,
  readFile,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";

const execFile = promisify(execFileCallback);
const LAUNCH_AGENT_LABEL = "top.furesta.onestatus.background";
const WINDOWS_RUN_KEY = "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run";
const WINDOWS_VALUE_NAME = "One Status Background";

export type BackgroundStartupMechanism =
  | "launch-agent"
  | "registry"
  | "xdg-autostart"
  | "unsupported";

export interface BackgroundStartupState {
  available: boolean;
  enabled: boolean;
  mechanism: BackgroundStartupMechanism;
}

export interface StartupCommandRunner {
  run(command: string, arguments_: readonly string[]): Promise<{ stdout: string }>;
}

export interface DesktopStartupControlOptions {
  commandRunner?: StartupCommandRunner;
  environment?: NodeJS.ProcessEnv;
  executablePath: string;
  homeDirectory?: string;
  launchArguments?: readonly string[];
  platform?: NodeJS.Platform;
}

export class DesktopStartupControl {
  readonly #commandRunner: StartupCommandRunner;
  readonly #environment: NodeJS.ProcessEnv;
  readonly #executablePath: string;
  readonly #homeDirectory: string;
  readonly #launchArguments: readonly string[];
  readonly #platform: NodeJS.Platform;

  constructor(options: DesktopStartupControlOptions) {
    this.#commandRunner = options.commandRunner ?? defaultCommandRunner;
    this.#environment = options.environment ?? process.env;
    this.#executablePath = options.executablePath;
    this.#homeDirectory = options.homeDirectory ?? homedir();
    this.#launchArguments = options.launchArguments ?? ["--background"];
    this.#platform = options.platform ?? process.platform;
  }

  async status(): Promise<BackgroundStartupState> {
    if (this.#platform === "darwin") {
      return {
        available: true,
        enabled: await fileContains(
          this.#launchAgentPath(),
          `<string>${xmlEscape(this.#executablePath)}</string>`,
          `<string>${xmlEscape(this.#launchArguments.at(-1) ?? "")}</string>`,
        ),
        mechanism: "launch-agent",
      };
    }
    if (this.#platform === "win32") {
      return {
        available: true,
        enabled: await this.#windowsRunEntryExists(),
        mechanism: "registry",
      };
    }
    if (this.#platform === "linux") {
      return {
        available: true,
        enabled: await fileContains(
          this.#desktopEntryPath(),
          "X-One-Status-Background=true",
          `Exec=${desktopCommand(this.#command())}`,
        ),
        mechanism: "xdg-autostart",
      };
    }
    return { available: false, enabled: false, mechanism: "unsupported" };
  }

  async setEnabled(enabled: boolean): Promise<BackgroundStartupState> {
    if (this.#platform === "darwin") {
      if (enabled) {
        await writePrivateFile(this.#launchAgentPath(), this.#launchAgent());
      } else {
        await rm(this.#launchAgentPath(), { force: true });
      }
      return this.status();
    }
    if (this.#platform === "win32") {
      if (enabled) {
        await this.#commandRunner.run("reg.exe", [
          "ADD",
          WINDOWS_RUN_KEY,
          "/v",
          WINDOWS_VALUE_NAME,
          "/t",
          "REG_SZ",
          "/d",
          windowsCommand(this.#command()),
          "/f",
        ]);
      } else if (await this.#windowsRunEntryExists()) {
        await this.#commandRunner.run("reg.exe", [
          "DELETE",
          WINDOWS_RUN_KEY,
          "/v",
          WINDOWS_VALUE_NAME,
          "/f",
        ]);
      }
      return this.status();
    }
    if (this.#platform === "linux") {
      if (enabled) {
        await writePrivateFile(this.#desktopEntryPath(), this.#desktopEntry());
      } else {
        await rm(this.#desktopEntryPath(), { force: true });
      }
      return this.status();
    }
    return { available: false, enabled: false, mechanism: "unsupported" };
  }

  #command(): readonly string[] {
    return [this.#executablePath, ...this.#launchArguments];
  }

  #launchAgentPath(): string {
    return join(
      this.#homeDirectory,
      "Library",
      "LaunchAgents",
      `${LAUNCH_AGENT_LABEL}.plist`,
    );
  }

  #launchAgent(): string {
    const arguments_ = this.#command()
      .map((argument) => `      <string>${xmlEscape(argument)}</string>`)
      .join("\n");
    return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
  <dict>
    <key>Label</key>
    <string>${LAUNCH_AGENT_LABEL}</string>
    <key>ProgramArguments</key>
    <array>
${arguments_}
    </array>
    <key>RunAtLoad</key>
    <true/>
    <key>KeepAlive</key>
    <true/>
    <key>ProcessType</key>
    <string>Background</string>
  </dict>
</plist>
`;
  }

  #desktopEntryPath(): string {
    const configRoot =
      this.#environment.XDG_CONFIG_HOME ?? join(this.#homeDirectory, ".config");
    return join(configRoot, "autostart", "one-status-background.desktop");
  }

  #desktopEntry(): string {
    return `[Desktop Entry]
Type=Application
Name=One Status Background
Comment=One Status local Agent gateway
Exec=${desktopCommand(this.#command())}
Terminal=false
NoDisplay=true
X-GNOME-Autostart-enabled=true
X-One-Status-Background=true
`;
  }

  async #windowsRunEntryExists(): Promise<boolean> {
    try {
      const result = await this.#commandRunner.run("reg.exe", [
        "QUERY",
        WINDOWS_RUN_KEY,
        "/v",
        WINDOWS_VALUE_NAME,
      ]);
      return result.stdout.includes(windowsCommand(this.#command()));
    } catch {
      return false;
    }
  }
}

const defaultCommandRunner: StartupCommandRunner = {
  async run(command, arguments_) {
    const result = await execFile(command, [...arguments_], {
      encoding: "utf8",
      windowsHide: true,
    });
    return { stdout: result.stdout };
  },
};

async function writePrivateFile(path: string, content: string): Promise<void> {
  const temporaryPath = `${path}.${process.pid}.${randomUUID()}.tmp`;
  await mkdir(dirname(path), { mode: 0o700, recursive: true });
  await writeFile(temporaryPath, content, { encoding: "utf8", mode: 0o600 });
  await chmod(temporaryPath, 0o600);
  try {
    await rename(temporaryPath, path);
    await chmod(path, 0o600);
  } catch (error) {
    await rm(temporaryPath, { force: true });
    throw error;
  }
}

async function fileContains(
  path: string,
  ...expected: readonly string[]
): Promise<boolean> {
  try {
    const content = await readFile(path, "utf8");
    return expected.every((value) => content.includes(value));
  } catch (error) {
    if (isMissingFile(error)) return false;
    throw error;
  }
}

function windowsCommand(command: readonly string[]): string {
  return command.map(quoteWindowsArgument).join(" ");
}

function quoteWindowsArgument(value: string): string {
  if (value && !/[\s"]/u.test(value)) return value;
  return `"${value
    .replace(/(\\*)"/gu, "$1$1\\\"")
    .replace(/(\\+)$/u, "$1$1")}"`;
}

function desktopCommand(command: readonly string[]): string {
  return command.map((value) => `"${value.replace(/[\\"`$]/gu, "\\$&")}"`).join(" ");
}

function xmlEscape(value: string): string {
  return value.replace(/[&<>"']/gu, (character) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&apos;",
  })[character]!);
}

function isMissingFile(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === "ENOENT"
  );
}
