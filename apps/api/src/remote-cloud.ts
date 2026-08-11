import {
  remoteMcpDefaultScopes,
  remoteMcpSupportedScopes,
  remoteMcpScopes,
  type RemoteMcpAgentSession,
  type RemoteMcpGateway,
  type RemoteMcpStatusReadRequest,
} from "@one-status/mcp/remote";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { OneStatusDatabase } from "./database.js";
import type { RemoteCloudVaultGatewayFactory } from "./cloud-vault-client.js";
import { DeviceRelayError, type DeviceRelayHub } from "./device-relay.js";
import {
  registerRemoteMcpRoutes,
  type FastifyRemoteMcpRoutes,
} from "./remote-mcp.js";
import { RemoteOAuthService } from "./remote-oauth.js";
import type { OpaqueAuthService } from "./opaque-auth.js";

export interface RemoteCloudOptions {
  database: Pick<OneStatusDatabase, "getAccount">;
  deviceRelay: Pick<DeviceRelayHub, "execute" | "listOnlineDevices">;
  issuer: string;
  oauthDbPath: string;
  opaqueAuth: Pick<OpaqueAuthService, "consumeProof">;
  resource: string;
  vault?: RemoteCloudVaultGatewayFactory;
}

export interface RemoteCloudRuntime {
  close(): Promise<void>;
  mcp: FastifyRemoteMcpRoutes;
  openAiMcp: FastifyRemoteMcpRoutes;
  oauth: RemoteOAuthService;
}

export function registerRemoteCloudServices(
  app: FastifyInstance,
  options: RemoteCloudOptions,
): RemoteCloudRuntime {
  const openAiResource = new URL("/openai/mcp", options.resource).toString();
  const oauth = new RemoteOAuthService({
    additionalResources: [
      {
        resource: openAiResource,
        supportedScopes: remoteMcpDefaultScopes,
      },
    ],
    allowProjectScopes: true,
    consumeAccountProof: (proofToken) =>
      options.opaqueAuth.consumeProof(proofToken, "oauth-authorize"),
    dbPath: options.oauthDbPath,
    defaultScopes: remoteMcpDefaultScopes,
    issuer: options.issuer,
    resource: options.resource,
    supportedScopes: remoteMcpSupportedScopes,
  });
  oauth.registerRoutes(app);
  const mcp = registerRemoteMcpRoutes(app, {
    authorizationServers: [oauth.issuer],
    resource: options.resource,
    verifier: oauth,
    resolveAgentSession(authInfo) {
      const subject = authInfo.extra?.subject;
      const agentId = authInfo.extra?.agentId;
      if (typeof subject !== "string" || typeof agentId !== "string") {
        throw new Error("OAuth Agent claims are incomplete.");
      }
      return { agentId, subject };
    },
    async resolveGateway(session) {
      const vaultAuthorized =
        session.scopes.includes(remoteMcpScopes.vaultRead) ||
        session.scopes.includes(remoteMcpScopes.vaultWrite);
      const vaultGateway = vaultAuthorized
        ? await options.vault?.createAgentGateway(session)
        : undefined;
      return relayGateway(options, oauth, session, vaultGateway);
    },
    resolveStatusReader(session) {
      return relayStatusReader(options.deviceRelay, oauth, session);
    },
  });
  const openAiMcp = registerRemoteMcpRoutes(app, {
    authorizationServers: [oauth.issuer],
    endpoint: new URL(openAiResource).pathname,
    includeRootResourceMetadata: false,
    publicStatusProjection: true,
    resource: openAiResource,
    resourceName: "One Status for ChatGPT and Codex",
    supportedScopes: remoteMcpDefaultScopes,
    verifier: oauth,
    resolveAgentSession(authInfo) {
      const subject = authInfo.extra?.subject;
      const agentId = authInfo.extra?.agentId;
      if (typeof subject !== "string" || typeof agentId !== "string") {
        throw new Error("OAuth Agent claims are incomplete.");
      }
      return { agentId, subject };
    },
    resolveStatusReader(session) {
      return relayStatusReader(options.deviceRelay, oauth, session);
    },
  });
  let closed = false;
  const runtime: RemoteCloudRuntime = {
    mcp,
    openAiMcp,
    oauth,
    async close() {
      if (closed) return;
      closed = true;
      await Promise.all([mcp.close(), openAiMcp.close()]);
      oauth.close();
    },
  };
  app.addHook("onClose", () => runtime.close());
  return runtime;
}

function relayStatusReader(
  relay: Pick<DeviceRelayHub, "execute">,
  audit: RemoteOAuthService,
  session: RemoteMcpAgentSession,
) {
  return {
    async read(request: RemoteMcpStatusReadRequest) {
      return audited(audit, session, "status.read", async () => {
        const routed = await relay.execute({
          agentId: session.agentId,
          operation: "status.read",
          payload: request,
          userId: session.subject,
        });
        return statusViewSchema(request).parse(routed.result);
      });
    },
  };
}

function relayGateway(
  options: Pick<RemoteCloudOptions, "database" | "deviceRelay">,
  audit: RemoteOAuthService,
  session: RemoteMcpAgentSession,
  vaultGateway?: Pick<RemoteMcpGateway, "credential">,
) {
  const execute = (
    operation: "tools.list" | "tools.request_approval" | "tools.execute",
    deviceId: string | undefined,
    payload: Record<string, unknown>,
  ) =>
    audited(audit, session, operation, () =>
      options.deviceRelay.execute({
        agentId: session.agentId,
        deviceId,
        operation,
        payload,
        userId: session.subject,
      }),
    );
  return {
    credential(
      operation:
        | "credentials.create"
        | "credentials.delete"
        | "credentials.get"
        | "credentials.list"
        | "credentials.request_approval"
        | "credentials.resolve"
        | "credentials.update",
      input: Record<string, unknown>,
    ) {
      if (vaultGateway) {
        return audited(audit, session, operation, () =>
          vaultGateway.credential(operation, input),
        );
      }
      if (operation === "credentials.request_approval") {
        throw new Error("vault_service_unavailable");
      }
      return audited(audit, session, operation, () =>
        options.deviceRelay.execute({
          agentId: session.agentId,
          operation,
          payload: input,
          userId: session.subject,
        }),
      );
    },
    async listDevices() {
      return audited(audit, session, "devices.list", async () => {
        const account = options.database.getAccount(session.subject);
        const relayDevices = new Map(
          options.deviceRelay
            .listOnlineDevices(session.subject)
            .map((device) => [device.deviceId, device]),
        );
        return {
          devices: account.devices.map((device) => {
            const relay = relayDevices.get(device.id);
            return {
              ...device,
              online: Boolean(relay),
              relayCapabilities: relay?.capabilities ?? [],
              relayConnectedAt: relay?.connectedAt ?? null,
            };
          }),
        };
      });
    },
    listTools({ deviceId }: { deviceId?: string }) {
      return execute("tools.list", deviceId, {});
    },
    requestToolApproval(input: {
      action: string;
      arguments: Record<string, unknown>;
      connectionId: string;
      deviceId?: string;
    }) {
      const { deviceId, ...payload } = input;
      return execute("tools.request_approval", deviceId, payload);
    },
    executeTool(input: {
      action: string;
      approvalId?: string;
      arguments: Record<string, unknown>;
      connectionId: string;
      deviceId?: string;
    }) {
      const { deviceId, ...payload } = input;
      return execute("tools.execute", deviceId, payload);
    },
  };
}

async function audited<T>(
  audit: RemoteOAuthService,
  session: RemoteMcpAgentSession,
  action: string,
  operation: () => Promise<T>,
): Promise<T> {
  try {
    audit.recordAgentAction({
      action,
      agentId: session.agentId,
      clientId: session.clientId,
      outcome: "attempted",
      userId: session.subject,
    });
  } catch {
    throw new Error("audit_service_unavailable");
  }
  try {
    const result = await operation();
    try {
      audit.recordAgentAction({
        action,
        agentId: session.agentId,
        clientId: session.clientId,
        outcome: "success",
        userId: session.subject,
      });
    } catch {
      // The durable attempted event already records the call.
    }
    return result;
  } catch (error) {
    try {
      audit.recordAgentAction({
        action,
        agentId: session.agentId,
        clientId: session.clientId,
        outcome: "failed",
        userId: session.subject,
      });
    } catch {
      // The durable attempted event already records the call.
    }
    if (error instanceof DeviceRelayError) {
      throw new Error(error.remoteCode ?? error.code);
    }
    throw new Error("remote_operation_failed");
  }
}

const statusViewBase = {
  version: z.number().int().nonnegative(),
};
const statusProfileViewSchema = z
  .object({
    ...statusViewBase,
    identity: z.record(z.string(), z.unknown()),
    preferences: z.record(z.string(), z.unknown()),
    personaProfile: z.record(z.string(), z.unknown()),
  })
  .strict();
const statusContextViewSchema = z
  .object({
    ...statusViewBase,
    workspace: z.record(z.string(), z.unknown()),
    project: z.unknown().nullable(),
    openTasks: z.array(z.unknown()),
    sessionMemory: z.array(z.unknown()),
  })
  .strict();
const statusMemoryViewSchema = z
  .object({
    ...statusViewBase,
    memory: z.array(z.unknown()),
  })
  .strict();

function statusViewSchema(request: RemoteMcpStatusReadRequest) {
  if (request.view === "profile") return statusProfileViewSchema;
  if (request.view === "context") return statusContextViewSchema;
  return statusMemoryViewSchema;
}
