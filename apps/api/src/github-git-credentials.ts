import type { DashboardBackend } from "./dashboard-backend.js";
import type { GitHubCredentialProvider } from "./handoff.js";
import type {
  OAuthConnection,
  PermissionVault,
} from "./permission-vault.js";

const WRITE_SCOPES = new Set(["repo", "public_repo"]);

export class PermissionVaultGitHubCredentialProvider
  implements GitHubCredentialProvider
{
  constructor(
    private readonly backend: Pick<DashboardBackend, "userId">,
    private readonly vault: PermissionVault,
  ) {}

  async getGitEnvironment(repositoryUrl: string): Promise<Record<string, string>> {
    const owner = githubRepositoryOwner(repositoryUrl);
    const userId = await this.backend.userId();
    const connections = this.vault
      .listConnections(userId)
      .filter(
        (connection) =>
          connection.provider === "github" && connection.status === "connected",
      );
    const connection = selectConnection(connections, owner);
    if (!connection) {
      throw new Error(
        "Connect the GitHub repository owner in One Status before publishing or cloning.",
      );
    }
    if (!connection.scopes.some((scope) => WRITE_SCOPES.has(scope))) {
      throw new Error(
        "Reconnect GitHub with repository access before publishing or cloning.",
      );
    }
    const stored = this.vault.getConnectionWithCredential(userId, connection.id);
    if (!stored) throw new Error("The GitHub OAuth connection was not found.");
    if (stored.expiresAt && Date.parse(stored.expiresAt) <= Date.now()) {
      throw new Error("Reconnect the expired GitHub account before using Handoff.");
    }

    const authorization = Buffer.from(
      `x-access-token:${stored.credential.accessToken}`,
      "utf8",
    ).toString("base64");
    return {
      GIT_CONFIG_COUNT: "2",
      GIT_CONFIG_KEY_0: "http.https://github.com/.extraHeader",
      GIT_CONFIG_VALUE_0: `Authorization: Basic ${authorization}`,
      GIT_CONFIG_KEY_1: "credential.helper",
      GIT_CONFIG_VALUE_1: "",
      GIT_TERMINAL_PROMPT: "0",
    };
  }
}

function selectConnection(
  connections: OAuthConnection[],
  repositoryOwner: string,
): OAuthConnection | undefined {
  const ownerMatches = connections.filter(
    (connection) => connection.label.toLowerCase() === repositoryOwner,
  );
  if (ownerMatches.length === 1) return ownerMatches[0];
  return connections.length === 1 ? connections[0] : undefined;
}

function githubRepositoryOwner(repositoryUrl: string): string {
  const url = new URL(repositoryUrl);
  if (url.protocol !== "https:" || url.hostname.toLowerCase() !== "github.com") {
    throw new Error("GitHub OAuth credentials can only be used with github.com.");
  }
  const [owner, repository, ...extra] = url.pathname
    .replace(/^\/+|\/+$/g, "")
    .split("/");
  if (!owner || !repository || extra.length > 0) {
    throw new Error("The GitHub repository URL is invalid.");
  }
  return owner.toLowerCase();
}
