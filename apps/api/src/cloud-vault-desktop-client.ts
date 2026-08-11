import {
  loadLocalProfile,
  type LocalProfile,
} from "@one-status/local-config";

export interface CloudVaultDesktopApproval {
  agentId: string;
  clientId: string | null;
  consumedAt: string | null;
  createdAt: string;
  decidedAt: string | null;
  expiresAt: string;
  id: string;
  operation: string;
  sessionId: string;
  status: "pending" | "approved" | "denied" | "consumed";
  summary: {
    credentialId: string | null;
    fieldKeys: string[];
    kind: string | null;
    label: string | null;
    projectId: string | null;
    purpose: string | null;
    secretKeys: string[];
  };
  userId: string;
}

export class CloudVaultDesktopClient {
  readonly #fetch: typeof fetch;
  readonly #loadProfile: () => Promise<LocalProfile>;

  constructor(options: {
    fetch?: typeof fetch;
    loadProfile?: () => Promise<LocalProfile>;
  } = {}) {
    this.#fetch = options.fetch ?? fetch;
    this.#loadProfile = options.loadProfile ?? loadLocalProfile;
  }

  async listApprovals(): Promise<CloudVaultDesktopApproval[]> {
    const profile = await this.#loadProfile();
    const result = await this.#request(profile, "/v1/vault/approvals?limit=100", {
      method: "GET",
    });
    if (!isRecord(result) || !Array.isArray(result.approvals)) {
      throw new Error("Cloud Vault approval response is invalid.");
    }
    return result.approvals.filter(isCloudVaultApproval);
  }

  async decideApproval(
    approvalId: string,
    decision: "approve" | "deny",
  ): Promise<unknown> {
    const profile = await this.#loadProfile();
    if (!isUuid(approvalId)) throw new Error("Cloud Vault approval ID is invalid.");
    return this.#request(
      profile,
      `/v1/vault/approvals/${encodeURIComponent(approvalId)}`,
      {
        body: JSON.stringify({ decision }),
        method: "PATCH",
      },
    );
  }

  async startWalletPakeLogin(startLoginRequest: string): Promise<unknown> {
    const profile = await this.#loadProfile();
    return this.#request(profile, "/v1/vault/wallet-pake/login/start", {
      body: JSON.stringify({ startLoginRequest }),
      method: "POST",
    });
  }

  async finishWalletPakeLogin(
    flowId: string,
    finishLoginRequest: string,
  ): Promise<unknown> {
    const profile = await this.#loadProfile();
    return this.#request(
      profile,
      "/v1/vault/wallet-pake/login/finish",
      {
        body: JSON.stringify({ finishLoginRequest, flowId }),
        method: "POST",
      },
    );
  }

  async startWalletPakeRegistration(input: {
    accountProof?: string;
    authorization: "initial" | "change" | "reset";
    registrationRequest: string;
    walletGrant?: string;
  }): Promise<unknown> {
    const profile = await this.#loadProfile();
    return this.#request(profile, "/v1/vault/wallet-pake/register/start", {
      body: JSON.stringify(input),
      method: "POST",
    });
  }

  async finishWalletPakeRegistration(
    flowId: string,
    registrationRecord: string,
  ): Promise<unknown> {
    const profile = await this.#loadProfile();
    return this.#request(profile, "/v1/vault/wallet-pake/register/finish", {
      body: JSON.stringify({ flowId, registrationRecord }),
      method: "PUT",
    });
  }

  async revealCredential(
    credentialId: string,
    walletGrant: string,
  ): Promise<unknown> {
    const profile = await this.#loadProfile();
    if (!isUuid(credentialId)) throw new Error("Cloud Vault credential ID is invalid.");
    return this.#request(
      profile,
      `/v1/vault/credentials/${encodeURIComponent(credentialId)}/reveal`,
      {
        body: JSON.stringify({ walletGrant }),
        method: "POST",
      },
    );
  }

  async #request(
    profile: LocalProfile,
    path: string,
    init: RequestInit,
  ): Promise<unknown> {
    const headers = new Headers(init.headers);
    headers.set("accept", "application/json");
    headers.set("authorization", `Bearer ${profile.token}`);
    if (init.body !== undefined) headers.set("content-type", "application/json");
    const response = await this.#fetch(`${cloudBaseUrl(profile.baseUrl)}${path}`, {
      ...init,
      headers,
      signal: AbortSignal.timeout(3_000),
    });
    const result = (await response.json().catch(() => null)) as unknown;
    if (!response.ok) throw new Error(cloudApprovalError(result));
    return result;
  }
}

function cloudBaseUrl(value: string): string {
  const url = new URL(value);
  const loopback = ["127.0.0.1", "[::1]", "localhost"].includes(
    url.hostname.toLowerCase(),
  );
  if (url.protocol !== "https:" && !(url.protocol === "http:" && loopback)) {
    throw new Error("Cloud Vault approval service requires HTTPS.");
  }
  if (url.username || url.password || url.search || url.hash) {
    throw new Error("Cloud Vault approval URL is invalid.");
  }
  return url.toString().replace(/\/$/u, "");
}

function cloudApprovalError(value: unknown): string {
  const code =
    isRecord(value) &&
    isRecord(value.error) &&
    typeof value.error.code === "string"
      ? value.error.code
      : undefined;
  return code === "approval_unavailable"
    ? "approval_unavailable"
    : code === "unauthorized"
      ? "cloud_session_expired"
      : "cloud_vault_unavailable";
}

function isCloudVaultApproval(value: unknown): value is CloudVaultDesktopApproval {
  const summary = isRecord(value) && isRecord(value.summary)
    ? value.summary
    : undefined;
  return (
    isRecord(value) &&
    isUuid(value.id) &&
    typeof value.agentId === "string" &&
    typeof value.operation === "string" &&
    typeof value.expiresAt === "string" &&
    ["pending", "approved", "denied", "consumed"].includes(
      String(value.status),
    ) &&
    Boolean(summary) &&
    Array.isArray(summary!.fieldKeys) &&
    summary!.fieldKeys.every((item) => typeof item === "string") &&
    Array.isArray(summary!.secretKeys) &&
    summary!.secretKeys.every((item) => typeof item === "string")
  );
}

function isUuid(value: unknown): value is string {
  return (
    typeof value === "string" &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(
      value,
    )
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
