import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  DesktopStartupControl,
  type StartupCommandRunner,
} from "./startup-control.js";

describe("DesktopStartupControl", () => {
  const directories: string[] = [];

  afterEach(async () => {
    await Promise.all(
      directories.splice(0).map((directory) =>
        rm(directory, { force: true, recursive: true }),
      ),
    );
  });

  it("writes and removes a user LaunchAgent for background-only startup", async () => {
    const homeDirectory = await temporaryDirectory(directories);
    const control = new DesktopStartupControl({
      executablePath: "/Applications/One Status.app/Contents/MacOS/one-status",
      homeDirectory,
      launchArguments: ["--background"],
      platform: "darwin",
    });

    await expect(control.status()).resolves.toMatchObject({
      enabled: false,
      mechanism: "launch-agent",
    });
    await expect(control.setEnabled(true)).resolves.toMatchObject({
      enabled: true,
    });

    const plist = await readFile(
      join(
        homeDirectory,
        "Library",
        "LaunchAgents",
        "top.furesta.onestatus.background.plist",
      ),
      "utf8",
    );
    expect(plist).toContain("<key>RunAtLoad</key>");
    expect(plist).toContain("<key>KeepAlive</key>");
    expect(plist).toContain("<string>--background</string>");
    expect(plist).not.toContain("--show-window");

    await expect(control.setEnabled(false)).resolves.toMatchObject({
      enabled: false,
    });
  });

  it("manages the current-user Windows Run entry", async () => {
    const runner = new MemoryRegistryRunner();
    const control = new DesktopStartupControl({
      commandRunner: runner,
      executablePath: "C:\\Program Files\\One Status\\one-status.exe",
      launchArguments: ["--background"],
      platform: "win32",
    });

    await expect(control.status()).resolves.toMatchObject({
      enabled: false,
      mechanism: "registry",
    });
    await expect(control.setEnabled(true)).resolves.toMatchObject({
      enabled: true,
    });
    expect(runner.value).toBe(
      '"C:\\Program Files\\One Status\\one-status.exe" --background',
    );
    await expect(control.setEnabled(false)).resolves.toMatchObject({
      enabled: false,
    });
  });

  it("creates a hidden XDG startup entry", async () => {
    const homeDirectory = await temporaryDirectory(directories);
    const control = new DesktopStartupControl({
      environment: {},
      executablePath: "/opt/One Status/one-status",
      homeDirectory,
      platform: "linux",
    });

    await expect(control.setEnabled(true)).resolves.toMatchObject({
      enabled: true,
      mechanism: "xdg-autostart",
    });
    const entry = await readFile(
      join(homeDirectory, ".config", "autostart", "one-status-background.desktop"),
      "utf8",
    );
    expect(entry).toContain("NoDisplay=true");
    expect(entry).toContain('Exec="/opt/One Status/one-status" "--background"');
  });
});

class MemoryRegistryRunner implements StartupCommandRunner {
  value: string | undefined;

  async run(
    _command: string,
    arguments_: readonly string[],
  ): Promise<{ stdout: string }> {
    if (arguments_[0] === "QUERY") {
      if (!this.value) throw new Error("The system was unable to find the registry value.");
      return {
        stdout: `One Status Background    REG_SZ    ${this.value}\n`,
      };
    }
    if (arguments_[0] === "ADD") {
      this.value = arguments_[arguments_.indexOf("/d") + 1];
      return { stdout: "The operation completed successfully.\n" };
    }
    if (arguments_[0] === "DELETE") {
      this.value = undefined;
      return { stdout: "The operation completed successfully.\n" };
    }
    throw new Error(`Unexpected registry command: ${String(arguments_[0])}`);
  }
}

async function temporaryDirectory(directories: string[]): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "one-status-startup-"));
  directories.push(directory);
  return directory;
}
