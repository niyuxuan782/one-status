import { afterEach, describe, expect, it } from "vitest";
import { PermissionVaultGitHubCredentialProvider } from "./github-git-credentials.js";
import { PermissionVault } from "./permission-vault.js";

describe("GitHub Git credentials", () => {
  const vaults: PermissionVault[] = [];

  afterEach(() => {
    for (const vault of vaults.splice(0)) vault.close();
  });

  it("selects the repository owner and injects OAuth without plaintext argv", async () => {
    const vault = createVault();
    connect(vault, "other", "other-token", ["repo"]);
    connect(vault, "ryan", "github-oauth-token", ["read:user", "repo"]);
    const provider = new PermissionVaultGitHubCredentialProvider(
      { userId: async () => "user-1" },
      vault,
    );

    const environment = await provider.getGitEnvironment(
      "https://github.com/ryan/one-status",
    );

    expect(environment.GIT_TERMINAL_PROMPT).toBe("0");
    expect(environment.GIT_CONFIG_VALUE_0).not.toContain("github-oauth-token");
    const encoded = environment.GIT_CONFIG_VALUE_0!.split(" ").at(-1)!;
    expect(Buffer.from(encoded, "base64").toString("utf8")).toBe(
      "x-access-token:github-oauth-token",
    );
  });

  it("requires a connected account with repository scope", async () => {
    const vault = createVault();
    connect(vault, "ryan", "read-only-token", ["read:user"]);
    const provider = new PermissionVaultGitHubCredentialProvider(
      { userId: async () => "user-1" },
      vault,
    );

    await expect(
      provider.getGitEnvironment("https://github.com/ryan/private-repo"),
    ).rejects.toThrow("repository access");
    await expect(
      provider.getGitEnvironment("https://example.com/ryan/private-repo"),
    ).rejects.toThrow("github.com");
  });

  function createVault(): PermissionVault {
    const vault = new PermissionVault({
      key: new Uint8Array(32).fill(17),
      path: ":memory:",
    });
    vaults.push(vault);
    return vault;
  }
});

function connect(
  vault: PermissionVault,
  label: string,
  accessToken: string,
  scopes: string[],
): void {
  vault.upsertConnection({
    accountId: label,
    credential: { accessToken },
    label,
    provider: "github",
    scopes,
    userId: "user-1",
  });
}
