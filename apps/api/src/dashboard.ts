import { randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import type {
  FastifyInstance,
  FastifyReply,
  FastifyRequest,
} from "fastify";
import { z } from "zod";
import type { AuthenticatedSession } from "./database.js";
import type { DashboardBackend } from "./dashboard-backend.js";
import type { HandoffService } from "./handoff.js";
import { GitHubCliCredentialImporter } from "./github-cli-import.js";
import {
  dashboardCss,
  dashboardJs,
  renderDashboardPage,
} from "./dashboard-ui.js";
import {
  buildAuthorizationUrl,
  exchangeOAuthCode,
  parseOAuthProvider,
  providerCatalog,
  revokeOAuthCredential,
} from "./oauth-providers.js";
import type { OAuthProvider, PermissionVault } from "./permission-vault.js";
import type { PermissionSyncService } from "./permission-sync.js";
import type { ToolGateway } from "./tool-gateway.js";
import type { LocalInventoryService } from "./local-inventory.js";
import type { LocalOnboardingService } from "./onboarding.js";

const dashboardPaths = new Set([
  "/",
  "/status",
  "/projects",
  "/handoffs",
  "/memory",
  "/environment",
  "/integrations",
  "/devices",
]);

export interface DashboardRuntime {
  authenticateDevice(authorization?: string): AuthenticatedSession | undefined;
  backend: DashboardBackend;
  closeLocalState?: () => void;
  handoffs: Pick<
    HandoffService,
    | "mapProject"
    | "openAndContinue"
    | "overview"
    | "preview"
    | "publish"
    | "unmapProject"
    | "write"
  >;
  githubCliImporter?: Pick<GitHubCliCredentialImporter, "import">;
  inventory: Pick<LocalInventoryService, "get" | "refresh">;
  onboarding?: Pick<LocalOnboardingService, "login" | "register" | "status">;
  permissionVault: PermissionVault;
  permissionSync?: Pick<PermissionSyncService, "run">;
  publicBaseUrl?: string;
  toolGateway: ToolGateway;
}

export function registerDashboardRoutes(
  app: FastifyInstance,
  runtime: DashboardRuntime,
): void {
  const dashboardSession = randomBytes(32).toString("base64url");
  const csrfToken = randomBytes(32).toString("base64url");
  const githubCliImporter =
    runtime.githubCliImporter ??
    new GitHubCliCredentialImporter(runtime.permissionVault);

  app.get("/assets/dashboard.css", async (_request, reply) => {
    return reply
      .header("cache-control", "no-store")
      .type("text/css; charset=utf-8")
      .send(dashboardCss);
  });
  app.get("/assets/dashboard.js", async (_request, reply) => {
    return reply
      .header("cache-control", "no-store")
      .type("application/javascript; charset=utf-8")
      .send(dashboardJs);
  });

  for (const path of dashboardPaths) {
    app.get(path, async (request, reply) => {
      if (path === "/" && !request.headers.accept?.includes("text/html")) {
        return {
          name: "One Status",
          version: "0.1.1",
          tagline: "One user. One status. Every AI. Private by design.",
          dashboard: "/",
          health: "/health",
        };
      }
      if (!isTrustedDashboardHost(request)) return forbidden(reply);
      setDashboardHeaders(reply);
      reply.header(
        "set-cookie",
        `one_status_dashboard=${dashboardSession}; HttpOnly; SameSite=Lax; Path=/`,
      );
      return reply
        .type("text/html; charset=utf-8")
        .send(renderDashboardPage(csrfToken));
    });
  }

  app.get("/v1/dashboard/onboarding", async (request, reply) => {
    if (!authorizeDashboard(request, reply, dashboardSession)) return;
    if (!runtime.onboarding) {
      return { authenticated: true, defaultServerUrl: "", deviceName: "" };
    }
    return dashboardCall(reply, () => runtime.onboarding!.status());
  });

  app.post("/v1/dashboard/onboarding/register", async (request, reply) => {
    if (!authorizeDashboardWrite(request, reply, dashboardSession, csrfToken)) {
      return;
    }
    if (!runtime.onboarding) return reply.code(404).send({ error: "not_found" });
    return dashboardCall(reply, () =>
      runtime.onboarding!.register(onboardingAccountSchema.parse(request.body)),
    );
  });

  app.post("/v1/dashboard/onboarding/login", async (request, reply) => {
    if (!authorizeDashboardWrite(request, reply, dashboardSession, csrfToken)) {
      return;
    }
    if (!runtime.onboarding) return reply.code(404).send({ error: "not_found" });
    return dashboardCall(reply, () =>
      runtime.onboarding!.login(onboardingLoginSchema.parse(request.body)),
    );
  });

  app.get("/v1/dashboard/snapshot", async (request, reply) => {
    if (!authorizeDashboard(request, reply, dashboardSession)) return;
    return dashboardCall(reply, () =>
      withPermissionVault(runtime, async () => {
        const snapshot = await runtime.backend.getSnapshot();
        const userId = snapshot.profile.userId;
        return {
          ...snapshot,
          integrations: {
            connections: runtime.permissionVault.listConnections(userId),
            grants: runtime.permissionVault.listGrants(userId),
            providers: Object.values(providerCatalog).map((provider) => {
              const config = runtime.permissionVault.getProviderConfig(
                userId,
                provider.id,
              );
              return {
                ...provider,
                callbackUrl: callbackUrl(runtime, request, provider.id),
                clientId: config?.clientId ?? null,
                configured: Boolean(config),
              };
            }),
          },
        };
      }),
    );
  });

  app.get("/v1/dashboard/local-inventory", async (request, reply) => {
    if (!authorizeDashboard(request, reply, dashboardSession)) return;
    return dashboardCall(reply, () => runtime.inventory.get());
  });

  app.post("/v1/dashboard/local-inventory/refresh", async (request, reply) => {
    if (!authorizeDashboardWrite(request, reply, dashboardSession, csrfToken)) {
      return;
    }
    return dashboardCall(reply, () => runtime.inventory.refresh());
  });

  app.get("/v1/dashboard/handoffs", async (request, reply) => {
    if (!authorizeDashboard(request, reply, dashboardSession)) return;
    return dashboardCall(reply, () => runtime.handoffs.overview());
  });

  app.put(
    "/v1/dashboard/local-project-mappings/:projectId",
    async (request, reply) => {
      if (!authorizeDashboardWrite(request, reply, dashboardSession, csrfToken)) {
        return;
      }
      return dashboardCall(reply, async () => {
        const { projectId } = handoffProjectParameterSchema.parse(request.params);
        const { path } = localProjectMappingInputSchema.parse(request.body);
        return runtime.handoffs.mapProject(projectId, path);
      });
    },
  );

  app.delete(
    "/v1/dashboard/local-project-mappings/:projectId",
    async (request, reply) => {
      if (!authorizeDashboardWrite(request, reply, dashboardSession, csrfToken)) {
        return;
      }
      return dashboardCall(reply, async () => {
        const { projectId } = handoffProjectParameterSchema.parse(request.params);
        return { unmapped: runtime.handoffs.unmapProject(projectId) };
      });
    },
  );

  app.post(
    "/v1/dashboard/handoffs/:projectId/preview",
    async (request, reply) => {
      if (!authorizeDashboardWrite(request, reply, dashboardSession, csrfToken)) {
        return;
      }
      return dashboardCall(reply, async () => {
        const { projectId } = handoffProjectParameterSchema.parse(request.params);
        return runtime.handoffs.preview(projectId);
      });
    },
  );

  app.post(
    "/v1/dashboard/handoffs/:projectId/write",
    async (request, reply) => {
      if (!authorizeDashboardWrite(request, reply, dashboardSession, csrfToken)) {
        return;
      }
      return dashboardCall(reply, async () => {
        const { projectId } = handoffProjectParameterSchema.parse(request.params);
        const body = handoffWriteInputSchema.parse(request.body);
        return runtime.handoffs.write({ projectId, ...body });
      });
    },
  );

  app.post(
    "/v1/dashboard/handoffs/:projectId/publish",
    async (request, reply) => {
      if (!authorizeDashboardWrite(request, reply, dashboardSession, csrfToken)) {
        return;
      }
      return dashboardCall(reply, async () => {
        const { projectId } = handoffProjectParameterSchema.parse(request.params);
        const body = handoffPublishInputSchema.parse(request.body);
        return runtime.handoffs.publish({ projectId, ...body });
      });
    },
  );

  app.post(
    "/v1/dashboard/handoffs/:projectId/open",
    async (request, reply) => {
      if (!authorizeDashboardWrite(request, reply, dashboardSession, csrfToken)) {
        return;
      }
      return dashboardCall(reply, async () => {
        const { projectId } = handoffProjectParameterSchema.parse(request.params);
        const body = handoffOpenInputSchema.parse(request.body);
        return runtime.handoffs.openAndContinue({ projectId, ...body });
      });
    },
  );

  app.put("/v1/dashboard/context", async (request, reply) => {
    if (!authorizeDashboardWrite(request, reply, dashboardSession, csrfToken)) {
      return;
    }
    return dashboardCall(reply, async () => {
      const body = contextInputSchema.parse(request.body);
      return runtime.backend.mutateStatus((status) => {
        status.workspace.currentContext = body.currentContext;
        if (body.activeProjectId) {
          if (!status.projects[body.activeProjectId]) {
            throw new Error("Active project was not found.");
          }
          status.workspace.activeProjectId = body.activeProjectId;
        } else {
          delete status.workspace.activeProjectId;
        }
        status.workspace.lastAgentId = "one-status-dashboard";
      });
    });
  });

  app.put("/v1/dashboard/identity", async (request, reply) => {
    if (!authorizeDashboardWrite(request, reply, dashboardSession, csrfToken)) {
      return;
    }
    return dashboardCall(reply, async () => {
      const body = identityInputSchema.parse(request.body);
      return runtime.backend.mutateStatus((status) => {
        status.identity = stripEmpty(body);
      });
    });
  });

  app.put("/v1/dashboard/preferences/:key", async (request, reply) => {
    if (!authorizeDashboardWrite(request, reply, dashboardSession, csrfToken)) {
      return;
    }
    return dashboardCall(reply, async () => {
      const { key } = keyParameterSchema.parse(request.params);
      const { value } = preferenceInputSchema.parse(request.body);
      return runtime.backend.mutateStatus((status) => {
        status.preferences[key] = value;
      });
    });
  });

  app.delete("/v1/dashboard/preferences/:key", async (request, reply) => {
    if (!authorizeDashboardWrite(request, reply, dashboardSession, csrfToken)) {
      return;
    }
    return dashboardCall(reply, async () => {
      const { key } = keyParameterSchema.parse(request.params);
      return runtime.backend.mutateStatus((status) => {
        delete status.preferences[key];
      });
    });
  });

  app.put("/v1/dashboard/projects/:id", async (request, reply) => {
    if (!authorizeDashboardWrite(request, reply, dashboardSession, csrfToken)) {
      return;
    }
    return dashboardCall(reply, async () => {
      const { id } = projectParameterSchema.parse(request.params);
      const body = projectInputSchema.parse(request.body);
      return runtime.backend.mutateStatus((status) => {
        const previous = status.projects[id];
        status.projects[id] = {
          id,
          name: body.name,
          summary: body.summary,
          techStack: body.techStack,
          currentGoal: body.currentGoal,
          decisions: body.decisions,
          ...(previous?.handoff ? { handoff: previous.handoff } : {}),
          updatedAt: new Date().toISOString(),
        };
        if (!previous || body.makeActive) {
          status.workspace.activeProjectId = id;
        }
      });
    });
  });

  app.delete("/v1/dashboard/projects/:id", async (request, reply) => {
    if (!authorizeDashboardWrite(request, reply, dashboardSession, csrfToken)) {
      return;
    }
    return dashboardCall(reply, async () => {
      const { id } = projectParameterSchema.parse(request.params);
      return runtime.backend.mutateStatus((status) => {
        delete status.projects[id];
        status.memory = status.memory.filter(
          (entry) => entry.projectId !== id,
        );
        for (const [taskId, task] of Object.entries(status.tasks)) {
          if (task.projectId === id) delete status.tasks[taskId];
        }
        if (status.workspace.activeProjectId === id) {
          delete status.workspace.activeProjectId;
        }
      });
    });
  });

  app.post("/v1/dashboard/memories", async (request, reply) => {
    if (!authorizeDashboardWrite(request, reply, dashboardSession, csrfToken)) {
      return;
    }
    return dashboardCall(reply, async () => {
      const body = memoryInputSchema.parse(request.body);
      const now = new Date().toISOString();
      return runtime.backend.mutateStatus((status) => {
        if (body.scope === "project" && !body.projectId) {
          throw new Error("Project memory requires a project.");
        }
        status.memory.unshift({
          id: randomUUID(),
          scope: body.scope,
          ...(body.projectId ? { projectId: body.projectId } : {}),
          content: body.content,
          tags: body.tags,
          createdAt: now,
          updatedAt: now,
        });
      });
    });
  });

  app.delete("/v1/dashboard/memories/:id", async (request, reply) => {
    if (!authorizeDashboardWrite(request, reply, dashboardSession, csrfToken)) {
      return;
    }
    return dashboardCall(reply, async () => {
      const { id } = memoryParameterSchema.parse(request.params);
      return runtime.backend.mutateStatus((status) => {
        status.memory = status.memory.filter((entry) => entry.id !== id);
      });
    });
  });

  app.delete("/v1/dashboard/devices/:id", async (request, reply) => {
    if (!authorizeDashboardWrite(request, reply, dashboardSession, csrfToken)) {
      return;
    }
    return dashboardCall(reply, async () => {
      const { id } = deviceParameterSchema.parse(request.params);
      await runtime.backend.revokeDevice(id);
      return { revoked: true };
    });
  });

  app.put(
    "/v1/dashboard/oauth/providers/:provider/config",
    async (request, reply) => {
      if (!authorizeDashboardWrite(request, reply, dashboardSession, csrfToken)) {
        return;
      }
      return dashboardCall(reply, () =>
        withPermissionVault(runtime, async () => {
          const { provider: rawProvider } = providerParameterSchema.parse(
            request.params,
          );
          const provider = parseOAuthProvider(rawProvider);
          const body = providerConfigInputSchema.parse(request.body);
          const userId = await runtime.backend.userId();
          const current = runtime.permissionVault.getProviderConfig(
            userId,
            provider,
          );
          if (
            providerCatalog[provider].requiresSecret &&
            !body.clientSecret &&
            !current?.clientSecret
          ) {
            throw new Error("Client secret is required for this provider.");
          }
          runtime.permissionVault.configureProvider(
            userId,
            provider,
            providerCatalog[provider].requiresSecret
              ? body
              : { clientId: body.clientId },
          );
          return { configured: true, provider };
        }),
      );
    },
  );

  app.post(
    "/v1/dashboard/oauth/providers/github/import-cli",
    async (request, reply) => {
      if (!authorizeDashboardWrite(request, reply, dashboardSession, csrfToken)) {
        return;
      }
      return dashboardCall(reply, () =>
        withPermissionVault(runtime, async () => {
          const userId = await runtime.backend.userId();
          const connection = await githubCliImporter.import(userId);
          return { connected: true, connection };
        }),
      );
    },
  );

  app.post(
    "/v1/dashboard/oauth/providers/:provider/start",
    async (request, reply) => {
      if (!authorizeDashboardWrite(request, reply, dashboardSession, csrfToken)) {
        return;
      }
      return dashboardCall(reply, () =>
        withPermissionVault(runtime, async () => {
          const { provider: rawProvider } = providerParameterSchema.parse(
            request.params,
          );
          const provider = parseOAuthProvider(rawProvider);
          const userId = await runtime.backend.userId();
          const config = runtime.permissionVault.getProviderConfig(
            userId,
            provider,
          );
          if (!config) throw new Error("Configure the OAuth app before connecting.");
          const redirectUri = callbackUrl(runtime, request, provider);
          const flow = runtime.permissionVault.createFlow({
            provider,
            redirectUri,
            returnTo: "/integrations",
            userId,
          });
          return {
            authorizationUrl: buildAuthorizationUrl({
              codeChallenge: flow.codeChallenge,
              config,
              provider,
              redirectUri,
              state: flow.state,
            }),
          };
        }),
      );
    },
  );

  app.get("/oauth/:provider/callback", async (request, reply) => {
    if (!isTrustedOAuthCallbackHost(request, runtime.publicBaseUrl)) {
      return forbidden(reply);
    }
    const parameter = providerParameterSchema.safeParse(request.params);
    if (!parameter.success) {
      return reply.code(404).send({ error: "not_found" });
    }
    let provider: OAuthProvider;
    try {
      provider = parseOAuthProvider(parameter.data.provider);
    } catch {
      return reply.code(404).send({ error: "not_found" });
    }
    const parsedQuery = oauthCallbackSchema.safeParse(request.query);
    if (!parsedQuery.success) {
      return redirectOAuthFailure(reply, "/integrations", provider, "invalid_oauth_state");
    }
    const query = parsedQuery.data;
    let flow = null;
    try {
      flow = query.state
        ? runtime.permissionVault.consumeFlow(query.state)
        : null;
    } catch (error) {
      request.log.error(error);
    }
    if (!flow || flow.provider !== provider) {
      return redirectOAuthFailure(reply, "/integrations", provider, "invalid_oauth_state");
    }
    if (query.error) {
      return redirectOAuthFailure(
        reply,
        flow.returnTo,
        provider,
        normalizeOAuthCallbackError(query.error),
      );
    }
    if (!query.code) {
      return redirectOAuthFailure(reply, flow.returnTo, provider, "missing_code");
    }
    const authorizationCode = query.code;
    try {
      await withPermissionVault(runtime, async () => {
        const config = runtime.permissionVault.getProviderConfig(
          flow.userId,
          provider,
        );
        if (!config) throw new Error("OAuth provider configuration is missing.");
        const connection = await exchangeOAuthCode({
          code: authorizationCode,
          codeVerifier: flow.codeVerifier,
          config,
          provider,
          redirectUri: flow.redirectUri,
        });
        runtime.permissionVault.upsertConnection({
          ...connection,
          provider,
          userId: flow.userId,
        });
      });
      return reply.redirect(
        `${flow.returnTo}?oauth=connected&provider=${provider}`,
        303,
      );
    } catch (error) {
      request.log.error(error);
      return redirectOAuthFailure(
        reply,
        flow.returnTo,
        provider,
        "oauth_exchange_failed",
      );
    }
  });

  app.delete(
    "/v1/dashboard/oauth/connections/:id",
    async (request, reply) => {
      if (!authorizeDashboardWrite(request, reply, dashboardSession, csrfToken)) {
        return;
      }
      return dashboardCall(reply, () =>
        withPermissionVault(runtime, async () => {
          const { id } = connectionParameterSchema.parse(request.params);
          const userId = await runtime.backend.userId();
          const connection = runtime.permissionVault.getConnectionWithCredential(
            userId,
            id,
          );
          if (!connection) return reply.code(404).send({ error: "not_found" });
          if (connection.credentialOwnership === "managed") {
            const config = runtime.permissionVault.getProviderConfig(
              userId,
              connection.provider,
            );
            if (!config) {
              throw new Error("OAuth provider configuration is missing.");
            }
            await revokeOAuthCredential({
              config,
              credential: connection.credential,
              provider: connection.provider,
            });
          }
          runtime.permissionVault.deleteConnection(userId, id);
          return { disconnected: true };
        }),
      );
    },
  );

  app.put(
    "/v1/dashboard/oauth/connections/:id/grants/:agentId",
    async (request, reply) => {
      if (!authorizeDashboardWrite(request, reply, dashboardSession, csrfToken)) {
        return;
      }
      return dashboardCall(reply, () =>
        withPermissionVault(runtime, async () => {
          const { agentId, id } = grantParameterSchema.parse(request.params);
          const { actions } = grantInputSchema.parse(request.body);
          const userId = await runtime.backend.userId();
          const connection = runtime.permissionVault.getConnection(userId, id);
          if (!connection) throw new Error("OAuth connection was not found.");
          const supported = new Set(
            providerCatalog[connection.provider].actions.map((action) => action.id),
          );
          if (actions.some((action) => !supported.has(action))) {
            throw new Error("Grant contains an unsupported action.");
          }
          return runtime.permissionVault.setGrant(
            userId,
            id,
            agentId,
            actions,
          );
        }),
      );
    },
  );

  app.post("/v1/dashboard/tools/execute", async (request, reply) => {
    if (!authorizeDashboardWrite(request, reply, dashboardSession, csrfToken)) {
      return;
    }
    return dashboardCall(reply, () =>
      withPermissionVault(runtime, async () => {
        const body = toolExecuteInputSchema.parse(request.body);
        return {
          result: await runtime.toolGateway.execute({
            ...body,
            userId: await runtime.backend.userId(),
          }),
        };
      }),
    );
  });

  app.get("/v1/tools", async (request, reply) => {
    if (!isTrustedDashboardHost(request)) return forbidden(reply);
    const session = await authenticateToolRequest(
      runtime,
      request.headers.authorization,
    );
    if (!session) return unauthorized(reply);
    const { agentId } = agentQuerySchema.parse(request.query);
    return withPermissionVault(runtime, () => ({
      connections: runtime.toolGateway.list(session.userId, agentId),
    }));
  });

  app.post("/v1/tools/execute", async (request, reply) => {
    if (!isTrustedDashboardHost(request)) return forbidden(reply);
    const session = await authenticateToolRequest(
      runtime,
      request.headers.authorization,
    );
    if (!session) return unauthorized(reply);
    const body = toolExecuteInputSchema.parse(request.body);
    return withPermissionVault(runtime, async () => ({
      result: await runtime.toolGateway.execute({
        ...body,
        userId: session.userId,
      }),
    }));
  });
}

async function authenticateToolRequest(
  runtime: DashboardRuntime,
  authorization?: string,
): Promise<AuthenticatedSession | undefined> {
  return (
    runtime.authenticateDevice(authorization) ??
    (await runtime.backend.authenticateDevice?.(authorization))
  );
}

function withPermissionVault<T>(
  runtime: DashboardRuntime,
  operation: () => Promise<T> | T,
): Promise<T> {
  return runtime.permissionSync
    ? runtime.permissionSync.run(operation)
    : Promise.resolve().then(operation);
}

function authorizeDashboard(
  request: FastifyRequest,
  reply: FastifyReply,
  expectedSession: string,
): boolean {
  if (!isTrustedDashboardHost(request)) {
    forbidden(reply);
    return false;
  }
  const actual = parseCookies(request.headers.cookie).one_status_dashboard;
  if (!actual || !safeEqual(actual, expectedSession)) {
    reply.code(401).send({ error: "dashboard_session_required" });
    return false;
  }
  return true;
}

function authorizeDashboardWrite(
  request: FastifyRequest,
  reply: FastifyReply,
  expectedSession: string,
  expectedCsrf: string,
): boolean {
  if (!authorizeDashboard(request, reply, expectedSession)) return false;
  const origin = request.headers.origin;
  const host = request.headers.host;
  let originHost: string | undefined;
  try {
    originHost = origin ? new URL(origin).host : undefined;
  } catch {
    originHost = undefined;
  }
  if (!originHost || !host || originHost !== host) {
    forbidden(reply);
    return false;
  }
  const csrf = request.headers["x-one-status-csrf"];
  if (typeof csrf !== "string" || !safeEqual(csrf, expectedCsrf)) {
    reply.code(403).send({ error: "invalid_csrf_token" });
    return false;
  }
  return true;
}

function isTrustedDashboardHost(request: FastifyRequest): boolean {
  try {
    const hostname = new URL(`http://${request.headers.host}`).hostname;
    return (
      hostname === "127.0.0.1" ||
      hostname === "localhost" ||
      hostname === "[::1]"
    );
  } catch {
    return false;
  }
}

function isTrustedOAuthCallbackHost(
  request: FastifyRequest,
  publicBaseUrl?: string,
): boolean {
  if (isTrustedDashboardHost(request)) return true;
  if (!publicBaseUrl) return false;
  try {
    return new URL(`https://${request.headers.host}`).host === new URL(publicBaseUrl).host;
  } catch {
    return false;
  }
}

function callbackUrl(
  runtime: DashboardRuntime,
  request: FastifyRequest,
  provider: string,
): string {
  const base = runtime.publicBaseUrl ?? `http://${request.headers.host}`;
  return new URL(`/oauth/${provider}/callback`, base).toString();
}

type OAuthCallbackFailure =
  | "access_denied"
  | "invalid_oauth_state"
  | "missing_code"
  | "oauth_exchange_failed"
  | "provider_error"
  | "temporarily_unavailable";

function normalizeOAuthCallbackError(error: string): OAuthCallbackFailure {
  if (error === "access_denied") return "access_denied";
  if (error === "temporarily_unavailable" || error === "server_error") {
    return "temporarily_unavailable";
  }
  return "provider_error";
}

function redirectOAuthFailure(
  reply: FastifyReply,
  returnTo: string,
  provider: OAuthProvider,
  reason: OAuthCallbackFailure,
) {
  const parameters = new URLSearchParams({
    oauth: "error",
    provider,
    reason,
  });
  return reply.redirect(`${returnTo}?${parameters.toString()}`, 303);
}

function setDashboardHeaders(reply: FastifyReply): void {
  reply.headers({
    "cache-control": "no-store",
    "content-security-policy":
      "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self' https://accounts.google.com https://github.com https://slack.com",
    "referrer-policy": "no-referrer",
    "x-content-type-options": "nosniff",
    "x-frame-options": "DENY",
  });
}

async function dashboardCall(
  reply: FastifyReply,
  operation: () => Promise<unknown>,
): Promise<unknown> {
  try {
    return await operation();
  } catch (error) {
    const message = error instanceof Error ? error.message : "Request failed.";
    const status = error instanceof z.ZodError ? 400 : 422;
    return reply.code(status).send({ error: { message } });
  }
}

function parseCookies(value?: string): Record<string, string> {
  return Object.fromEntries(
    (value ?? "")
      .split(";")
      .map((part) => part.trim().split("="))
      .filter((entry) => entry.length === 2)
      .map(([key, raw]) => [key!, decodeURIComponent(raw!)]),
  );
}

function safeEqual(left: string, right: string): boolean {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
}

function stripEmpty<T extends Record<string, string | undefined>>(value: T): T {
  return Object.fromEntries(
    Object.entries(value).filter(([, entry]) => Boolean(entry)),
  ) as T;
}

function forbidden(reply: FastifyReply) {
  return reply.code(403).send({ error: "forbidden" });
}

function unauthorized(reply: FastifyReply) {
  return reply.code(401).send({
    error: { code: "unauthorized", message: "A valid device session is required." },
  });
}

const contextInputSchema = z
  .object({
    activeProjectId: z.string().min(1).max(120).optional(),
    currentContext: z.string().max(20_000),
  })
  .strict();

const onboardingAccountSchema = z
  .object({
    deviceName: z.string().trim().min(1).max(120),
    email: z.email().transform((value) => value.toLowerCase()),
    password: z.string().min(10).max(256),
    serverUrl: z.url().max(2_000),
  })
  .strict();

const onboardingLoginSchema = onboardingAccountSchema
  .extend({ statusKey: z.string().startsWith("os1_").max(200) })
  .strict();

const identityInputSchema = z
  .object({
    displayName: z.string().max(120).optional(),
    locale: z.string().max(40).optional(),
    timezone: z.string().max(100).optional(),
  })
  .strict();

const preferenceValueSchema = z.union([
  z.string().max(2_000),
  z.number(),
  z.boolean(),
  z.array(z.string().max(200)).max(100),
]);
const preferenceInputSchema = z.object({ value: preferenceValueSchema }).strict();
const keyParameterSchema = z.object({ key: z.string().min(1).max(120) });

const projectParameterSchema = z.object({
  id: z.string().min(1).max(120).regex(/^[a-zA-Z0-9._-]+$/),
});
const handoffProjectParameterSchema = z.object({
  projectId: z.string().min(1).max(120).regex(/^[a-zA-Z0-9._-]+$/),
});
const localProjectMappingInputSchema = z
  .object({ path: z.string().min(1).max(4096) })
  .strict();
const handoffWriteInputSchema = z
  .object({
    expectedCommit: z.string().regex(/^[0-9a-f]{40,64}$/i),
    expectedStatusVersion: z.number().int().nonnegative(),
    overwrite: z.boolean().default(false),
  })
  .strict();

const handoffPublishInputSchema = handoffWriteInputSchema
  .extend({
    confirmCommit: z.literal(true),
    confirmPush: z.literal(true),
  })
  .strict();

const handoffOpenInputSchema = z
  .object({
    agentId: z.enum(["codex", "claude-code"]),
    confirmCheckout: z.literal(true),
    destinationPath: z.string().min(1).optional(),
  })
  .strict();
const projectInputSchema = z
  .object({
    currentGoal: z.string().max(5_000).default(""),
    decisions: z.array(z.string().max(1_000)).max(100).default([]),
    makeActive: z.boolean().default(false),
    name: z.string().min(1).max(160),
    summary: z.string().max(10_000).default(""),
    techStack: z.array(z.string().max(120)).max(100).default([]),
  })
  .strict();

const memoryInputSchema = z
  .object({
    content: z.string().min(1).max(20_000),
    projectId: z.string().min(1).max(120).optional(),
    scope: z.enum(["user", "project", "session"]),
    tags: z.array(z.string().max(80)).max(50).default([]),
  })
  .strict();
const memoryParameterSchema = z.object({ id: z.uuid() });
const deviceParameterSchema = z.object({ id: z.uuid() });
const connectionParameterSchema = z.object({ id: z.uuid() });
const providerParameterSchema = z.object({ provider: z.string() });
const providerConfigInputSchema = z
  .object({
    clientId: z.string().min(1).max(500),
    clientSecret: z.string().max(1_000).optional(),
  })
  .strict();
const oauthCallbackSchema = z.object({
  code: z.string().max(10_000).optional(),
  error: z.string().max(200).optional(),
  state: z.string().max(500).optional(),
});
const grantParameterSchema = z.object({
  agentId: z.string().min(1).max(120),
  id: z.uuid(),
});
const grantInputSchema = z
  .object({ actions: z.array(z.string().min(1)).max(100) })
  .strict();
const toolExecuteInputSchema = z
  .object({
    action: z.string().min(1).max(160),
    agentId: z.string().min(1).max(120),
    arguments: z.unknown().optional(),
    connectionId: z.uuid(),
  })
  .strict();
const agentQuerySchema = z.object({ agentId: z.string().min(1).max(120) });
