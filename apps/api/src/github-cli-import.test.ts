import { afterEach, describe, expect, it, vi } from "vitest";
import {
  GitHubCliCredentialImporter,
  type GitHubCliCommandOptions,
  resolveGitHubCliCommand,
} from "./github-cli-import.js";
import { PermissionVault } from "./permission-vault.js";

describe("GitHub CLI credential import", () => {
  const vaults: PermissionVault[] = [];

  afterEach(() => {
    for (const vault of vaults.splice(0)) vault.close();
  });

  it("reads the active gh token without a shell and verifies the GitHub account", async () => {
    const vault = createVault(vaults);
    const token = "github-cli-token-value";
    const commandCalls: Array<{
      arguments_: readonly string[];
      command: string;
      options: GitHubCliCommandOptions;
    }> = [];
    const fetch = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      expect(String(input)).toBe("https://api.github.com/user");
      expect(new Headers(init?.headers).get("authorization")).toBe(
        `Bearer ${token}`,
      );
      return Response.json(
        { id: 42, login: "ryan" },
        { headers: { "x-oauth-scopes": "repo, read:org, repo" } },
      );
    });
    const importer = new GitHubCliCredentialImporter(vault, {
      command: "gh",
      fetch,
      async runCommand(command, arguments_, options) {
        commandCalls.push({ arguments_, command, options });
        return { stdout: `${token}\n` };
      },
    });

    const connection = await importer.import("user-1");

    expect(commandCalls).toEqual([
      {
        arguments_: ["auth", "token", "--hostname", "github.com"],
        command: "gh",
        options: {
          encoding: "utf8",
          maxBuffer: 65_536,
          shell: false,
          timeout: 10_000,
          windowsHide: true,
        },
      },
    ]);
    expect(commandCalls[0]?.arguments_).not.toContain(token);
    expect(connection).toMatchObject({
      accountId: "42",
      credentialOwnership: "external",
      label: "ryan",
      provider: "github",
      scopes: ["repo", "read:org", "read:user"],
      source: "imported",
      status: "connected",
    });
    expect(JSON.stringify(connection)).not.toContain(token);
    expect(
      vault.getConnectionWithCredential("user-1", connection.id)?.credential,
    ).toEqual({ accessToken: token, tokenType: "Bearer" });
    expect(fetch).toHaveBeenCalledOnce();
  });

  it("returns fixed errors without exposing CLI or provider diagnostics", async () => {
    const token = "github-cli-secret-token";
    const cliFailure = new GitHubCliCredentialImporter(createVault(vaults), {
      command: "gh",
      async runCommand() {
        throw new Error(`gh failed with ${token}`);
      },
    });
    const cliError = await cliFailure.import("user-1").catch((error) => error);
    expect(cliError).toMatchObject({ code: "github_cli_unavailable" });
    expect((cliError as Error).message).not.toContain(token);

    const providerFailure = new GitHubCliCredentialImporter(
      createVault(vaults),
      {
        command: "gh",
        async fetch() {
          throw new Error(`transport failed for ${token}`);
        },
        async runCommand() {
          return { stdout: token };
        },
      },
    );
    const providerError = await providerFailure
      .import("user-1")
      .catch((error) => error);
    expect(providerError).toMatchObject({
      code: "github_cli_verification_failed",
    });
    expect((providerError as Error).message).not.toContain(token);
  });

  it("rejects oversized or malformed CLI output before making a request", async () => {
    const fetch = vi.fn();
    const importer = new GitHubCliCredentialImporter(createVault(vaults), {
      command: "gh",
      fetch,
      async runCommand() {
        return { stdout: "a".repeat(32_001) };
      },
    });
    await expect(importer.import("user-1")).rejects.toMatchObject({
      code: "github_cli_credential_invalid",
    });
    expect(fetch).not.toHaveBeenCalled();
  });

  it("resolves Homebrew gh without relying on a LaunchAgent PATH", () => {
    const executable = new Set(["/opt/homebrew/bin/gh"]);
    expect(
      resolveGitHubCliCommand({}, "darwin", (path) => executable.has(path)),
    ).toBe("/opt/homebrew/bin/gh");
    expect(
      resolveGitHubCliCommand(
        { ONE_STATUS_GH_PATH: "/custom/bin/gh" },
        "darwin",
        (path) => path === "/custom/bin/gh",
      ),
    ).toBe("/custom/bin/gh");
    expect(() =>
      resolveGitHubCliCommand(
        { ONE_STATUS_GH_PATH: "relative/gh" },
        "darwin",
        () => true,
      ),
    ).toThrow("ONE_STATUS_GH_PATH");
  });
});

function createVault(vaults: PermissionVault[]): PermissionVault {
  const vault = new PermissionVault({
    key: new Uint8Array(32).fill(vaults.length + 1),
    path: ":memory:",
  });
  vaults.push(vault);
  return vault;
}
