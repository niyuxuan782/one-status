import type {
  RemoteMcpAgentSession,
  RemoteMcpGateway,
} from "@one-status/mcp/remote";
import { remoteMcpProjectIds } from "@one-status/mcp/remote";

const AGENT_SESSION_TTL_SECONDS = 3_600;
const SESSION_REFRESH_WINDOW_MS = 11 * 60_000;

export interface CloudVaultServiceClientOptions {
  baseUrl: string;
  fetch?: typeof fetch;
  serviceToken: string;
}

export interface RemoteCloudVaultGatewayFactory {
  createAgentGateway(
    session: RemoteMcpAgentSession,
  ): Promise<Pick<RemoteMcpGateway, "credential">>;
}

export interface CloudVaultUserClient {
  backfillUserCredentials(input: {
    credentials: unknown[];
    digest: string;
    userId: string;
    validationKey: string;
  }): Promise<unknown>;
  listUserCredentials(
    userId: string,
    input?: Record<string, unknown>,
  ): Promise<unknown>;
  listUserApprovals(userId: string, limit?: number): Promise<unknown>;
  decideUserApproval(input: {
    approvalId: string;
    decision: "approve" | "deny";
    userId: string;
  }): Promise<unknown>;
  revealUserCredential(input: {
    credentialId: string;
    walletGrant: string;
    userId: string;
  }): Promise<unknown>;
  startUserWalletPakeLogin(input: {
    startLoginRequest: string;
    userId: string;
  }): Promise<unknown>;
  finishUserWalletPakeLogin(input: {
    finishLoginRequest: string;
    flowId: string;
    userId: string;
  }): Promise<unknown>;
  startUserWalletPakeRegistration(input: {
    authorization: "initial" | "change" | "reset";
    registrationRequest: string;
    userId: string;
    walletGrant?: string;
  }): Promise<unknown>;
  finishUserWalletPakeRegistration(input: {
    flowId: string;
    registrationRecord: string;
    userId: string;
  }): Promise<unknown>;
}

export class CloudVaultServiceClient
  implements RemoteCloudVaultGatewayFactory, CloudVaultUserClient
{
  readonly #baseUrl: string;
  readonly #fetch: typeof fetch;
  readonly #serviceToken: string;

  constructor(options: CloudVaultServiceClientOptions) {
    this.#baseUrl = normalizeBaseUrl(options.baseUrl);
    this.#fetch = options.fetch ?? fetch;
    this.#serviceToken = requiredToken(options.serviceToken);
  }

  backfillUserCredentials(input: {
    credentials: unknown[];
    digest: string;
    userId: string;
    validationKey: string;
  }): Promise<unknown> {
    return this.#request(
      `/v1/internal/users/${encodeURIComponent(requiredIdentity(input.userId))}/migrations/backfill`,
      {
        body: JSON.stringify({
          credentials: input.credentials,
          digest: input.digest,
          validationKey: input.validationKey,
        }),
        method: "POST",
      },
    );
  }

  async createAgentGateway(
    session: RemoteMcpAgentSession,
  ): Promise<Pick<RemoteMcpGateway, "credential">> {
    const sessions = new Map<string, IssuedAgentSession>();
    const authorizedProjectIds = remoteMcpProjectIds(session.scopes);
    const agentToken = async (projectIds: string[]) => {
      const key = projectIds.join("\0");
      let issued = sessions.get(key);
      if (
        !issued ||
        Date.parse(issued.expiresAt) - Date.now() <= SESSION_REFRESH_WINDOW_MS
      ) {
        issued = await this.#issueAgentSession(session, projectIds);
        sessions.set(key, issued);
      }
      return issued.token;
    };
    return {
      credential: async (operation, input) => {
        const projectIds = credentialOperationProjectIds(
          operation,
          input,
          authorizedProjectIds,
        );
        return this.#credential(
          await agentToken(projectIds),
          operation,
          input,
        );
      },
    };
  }

  listUserCredentials(
    userId: string,
    input: Record<string, unknown> = {},
  ): Promise<unknown> {
    return this.#request(
      `/v1/internal/users/${encodeURIComponent(requiredIdentity(userId))}/credentials/list`,
      { body: JSON.stringify(input), method: "POST" },
    );
  }

  listUserApprovals(userId: string, limit = 100): Promise<unknown> {
    return this.#request(
      `/v1/internal/users/${encodeURIComponent(requiredIdentity(userId))}/approvals?limit=${encodeURIComponent(String(limit))}`,
      { method: "GET" },
    );
  }

  decideUserApproval(input: {
    approvalId: string;
    decision: "approve" | "deny";
    userId: string;
  }): Promise<unknown> {
    return this.#request(
      `/v1/internal/users/${encodeURIComponent(requiredIdentity(input.userId))}/approvals/${requiredCredentialId(input.approvalId)}`,
      {
        body: JSON.stringify({ decision: input.decision }),
        method: "PATCH",
      },
    );
  }

  revealUserCredential(input: {
    credentialId: string;
    walletGrant: string;
    userId: string;
  }): Promise<unknown> {
    return this.#request(
      `/v1/internal/users/${encodeURIComponent(requiredIdentity(input.userId))}/credentials/${requiredCredentialId(input.credentialId)}/reveal`,
      {
        body: JSON.stringify({ walletGrant: input.walletGrant }),
        method: "POST",
      },
    );
  }

  startUserWalletPakeLogin(input: {
    startLoginRequest: string;
    userId: string;
  }): Promise<unknown> {
    return this.#request(
      `/v1/internal/users/${encodeURIComponent(requiredIdentity(input.userId))}/wallet-pake/login/start`,
      {
        body: JSON.stringify({ startLoginRequest: input.startLoginRequest }),
        method: "POST",
      },
    );
  }

  finishUserWalletPakeLogin(input: {
    finishLoginRequest: string;
    flowId: string;
    userId: string;
  }): Promise<unknown> {
    return this.#request(
      `/v1/internal/users/${encodeURIComponent(requiredIdentity(input.userId))}/wallet-pake/login/finish`,
      {
        body: JSON.stringify({
          finishLoginRequest: input.finishLoginRequest,
          flowId: input.flowId,
        }),
        method: "POST",
      },
    );
  }

  startUserWalletPakeRegistration(input: {
    authorization: "initial" | "change" | "reset";
    registrationRequest: string;
    userId: string;
    walletGrant?: string;
  }): Promise<unknown> {
    return this.#request(
      `/v1/internal/users/${encodeURIComponent(requiredIdentity(input.userId))}/wallet-pake/register/start`,
      {
        body: JSON.stringify({
          authorization: input.authorization,
          registrationRequest: input.registrationRequest,
          ...(input.walletGrant ? { walletGrant: input.walletGrant } : {}),
        }),
        method: "POST",
      },
    );
  }

  finishUserWalletPakeRegistration(input: {
    flowId: string;
    registrationRecord: string;
    userId: string;
  }): Promise<unknown> {
    return this.#request(
      `/v1/internal/users/${encodeURIComponent(requiredIdentity(input.userId))}/wallet-pake/register/finish`,
      {
        body: JSON.stringify({
          flowId: input.flowId,
          registrationRecord: input.registrationRecord,
        }),
        method: "PUT",
      },
    );
  }

  async #issueAgentSession(
    session: RemoteMcpAgentSession,
    projectIds: string[],
  ): Promise<IssuedAgentSession> {
    const result = await this.#request("/v1/internal/agent-sessions", {
      body: JSON.stringify({
        agentId: session.agentId,
        clientId: session.clientId,
        grants: [{ projectIds, purposes: ["*"] }],
        projectIds,
        ttlSeconds: AGENT_SESSION_TTL_SECONDS,
        userId: session.subject,
      }),
      method: "POST",
    });
    const issued = isRecord(result) && isRecord(result.session)
      ? result.session
      : undefined;
    if (
      !issued ||
      typeof issued.token !== "string" ||
      !issued.token.startsWith("osva1_") ||
      typeof issued.expiresAt !== "string" ||
      !Number.isFinite(Date.parse(issued.expiresAt))
    ) {
      throw new Error("vault_session_unavailable");
    }
    return { expiresAt: issued.expiresAt, token: issued.token };
  }

  async #credential(
    agentToken: string,
    operation: Parameters<RemoteMcpGateway["credential"]>[0],
    input: Record<string, unknown>,
  ): Promise<unknown> {
    if (operation === "credentials.create") {
      return this.#request("/v1/internal/credentials", {
        agentToken,
        body: JSON.stringify(input),
        method: "POST",
      });
    }
    if (operation === "credentials.list") {
      return this.#request("/v1/internal/credentials/list", {
        agentToken,
        body: JSON.stringify(input),
        method: "POST",
      });
    }
    if (operation === "credentials.resolve") {
      return this.#request("/v1/internal/credentials/resolve", {
        agentToken,
        body: JSON.stringify(input),
        method: "POST",
      });
    }
    if (operation === "credentials.request_approval") {
      return this.#request("/v1/internal/approvals", {
        agentToken,
        body: JSON.stringify(approvalServiceRequest(input)),
        method: "POST",
      });
    }
    const credentialId = requiredCredentialId(input.credentialId);
    const rest = { ...input };
    delete rest.credentialId;
    if (operation === "credentials.get") {
      return this.#request(
        `/v1/internal/credentials/${credentialId}/get`,
        {
          agentToken,
          body: JSON.stringify(rest),
          method: "POST",
        },
      );
    }
    if (operation === "credentials.update") {
      const { approvalToken, projectId, ...patch } = rest;
      return this.#request(`/v1/internal/credentials/${credentialId}`, {
        agentToken,
        body: JSON.stringify({
          approvalToken,
          patch,
          ...(typeof projectId === "string" ? { projectId } : {}),
          purpose: "credential.update",
        }),
        method: "PATCH",
      });
    }
    return this.#request(`/v1/internal/credentials/${credentialId}`, {
      agentToken,
      body: JSON.stringify({
        approvalToken: rest.approvalToken,
        ...(typeof rest.projectId === "string"
          ? { projectId: rest.projectId }
          : {}),
        purpose: "credential.delete",
      }),
      method: "DELETE",
    });
  }

  async #request(
    path: string,
    input: {
      agentToken?: string;
      body?: string;
      method: "DELETE" | "GET" | "PATCH" | "POST" | "PUT";
    },
  ): Promise<unknown> {
    const headers = new Headers({
      accept: "application/json",
      authorization: `Bearer ${this.#serviceToken}`,
    });
    if (input.agentToken) {
      headers.set("x-one-status-agent-token", input.agentToken);
    }
    if (input.body !== undefined) headers.set("content-type", "application/json");
    let response: Response;
    try {
      response = await this.#fetch(`${this.#baseUrl}${path}`, {
        body: input.body,
        headers,
        method: input.method,
        signal: AbortSignal.timeout(15_000),
      });
    } catch {
      throw new Error("vault_service_unavailable");
    }
    const payload = (await response.json().catch(() => null)) as unknown;
    if (!response.ok) throw new Error(vaultErrorCode(payload, response.status));
    return payload;
  }
}

function approvalServiceRequest(input: Record<string, unknown>) {
  const operation = input.operation;
  const request = isRecord(input.request) ? { ...input.request } : undefined;
  if (
    !request ||
    ![
      "credential.create",
      "credential.get",
      "credential.update",
      "credential.delete",
    ].includes(String(operation))
  ) {
    throw new Error("invalid_approval_request");
  }
  delete request.approvalToken;
  if (operation === "credential.update") {
    const credentialId = request.credentialId;
    const projectId = request.projectId;
    delete request.credentialId;
    delete request.projectId;
    return {
      operation,
      request: {
        credentialId,
        patch: request,
        ...(typeof projectId === "string" ? { projectId } : {}),
        purpose: "credential.update",
      },
    };
  }
  if (operation === "credential.delete") {
    return {
      operation,
      request: {
        credentialId: request.credentialId,
        ...(typeof request.projectId === "string"
          ? { projectId: request.projectId }
          : {}),
        purpose: "credential.delete",
      },
    };
  }
  return { operation, request };
}

interface IssuedAgentSession {
  expiresAt: string;
  token: string;
}

function credentialOperationProjectIds(
  operation: Parameters<RemoteMcpGateway["credential"]>[0],
  input: Record<string, unknown>,
  authorizedProjectIds: string[],
): string[] {
  const rawProjectId = operation === "credentials.request_approval"
    ? isRecord(input.request)
      ? input.request.projectId
      : undefined
    : input.projectId;
  if (typeof rawProjectId !== "string") return [];
  const projectId = requiredIdentity(rawProjectId);
  if (!authorizedProjectIds.includes(projectId)) {
    throw new Error("vault_project_not_authorized");
  }
  return [projectId];
}

function normalizeBaseUrl(value: string): string {
  const url = new URL(value);
  if (
    !["http:", "https:"].includes(url.protocol) ||
    url.username ||
    url.password ||
    (url.pathname !== "/" && url.pathname !== "") ||
    url.search ||
    url.hash
  ) {
    throw new Error("Vault Service URL must be an HTTP origin.");
  }
  return url.toString().replace(/\/$/u, "");
}

function requiredToken(value: string): string {
  if (
    value.length < 32 ||
    value.length > 4_096 ||
    /[\u0000-\u0020\u007f]/u.test(value)
  ) {
    throw new Error("Vault Service token is invalid.");
  }
  return value;
}

function requiredCredentialId(value: unknown): string {
  if (
    typeof value !== "string" ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(
      value,
    )
  ) {
    throw new Error("invalid_credential_id");
  }
  return value;
}

function requiredIdentity(value: string): string {
  const normalized = value.trim();
  if (
    !normalized ||
    normalized.length > 1_000 ||
    /[\u0000-\u001f\u007f]/u.test(normalized)
  ) {
    throw new Error("invalid_identity");
  }
  return normalized;
}

function vaultErrorCode(value: unknown, status: number): string {
  const code =
    isRecord(value) &&
    isRecord(value.error) &&
    typeof value.error.code === "string"
      ? value.error.code
      : undefined;
  const allowed = new Set([
    "credential_access_denied",
    "credential_approval_required",
    "credential_revision_conflict",
    "invalid_request",
    "migration_verification_failed",
    "migration_conflict",
    "approval_unavailable",
    "service_auth_required",
    "vault_operation_failed",
    "wallet_pake_already_initialized",
    "wallet_pake_capacity_reached",
    "wallet_pake_grant_invalid",
    "wallet_pake_invalid",
    "wallet_pake_uninitialized",
  ]);
  if (code && allowed.has(code)) return code;
  return status === 503 ? "vault_service_unavailable" : "vault_operation_failed";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
