import { randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import {
  getBuiltInCapabilityPack,
  listBuiltInCapabilityPacks,
} from "@one-status/capability-pack";
import type {
  FastifyInstance,
  FastifyReply,
  FastifyRequest,
} from "fastify";
import {
  agentToolIdSchema,
  capabilityTargetSchema,
  modelApiProtocolSchema,
  modelSourceKindSchema,
  ONE_STATUS_VERSION,
} from "@one-status/protocol";
import {
  deletePersonaEvent,
  personaPolicyInputSchema,
  personaUpdateInputSchema,
  setPersonaPolicy,
  updatePersonaEvent,
} from "@one-status/protocol/persona-operations";
import { z } from "zod";
import type {
  AuthenticatedAgentSession,
  AuthenticatedSession,
  IssuedAgentCredential,
} from "./database.js";
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
import { providerExtensionById } from "./provider-extensions/index.js";
import type { PermissionSyncService } from "./permission-sync.js";
import {
  ToolApprovalError,
  type ToolGateway,
} from "./tool-gateway.js";
import type { LocalInventoryService } from "./local-inventory.js";
import type {
  LocalCapabilityManager,
  LocalCapabilityTarget,
} from "./local-capability-manager.js";
import type { LocalOnboardingService } from "./onboarding.js";
import type { DeviceControlService } from "./device-control.js";

const dashboardPaths = new Set([
  "/",
  "/status",
  "/projects",
  "/handoffs",
  "/memory",
  "/environment",
  "/models",
  "/capabilities",
  "/persona",
  "/integrations",
  "/devices",
  "/activity",
  "/security",
]);

export interface DashboardRuntime {
  authenticateAgent(
    authorization?: string,
  ): AuthenticatedAgentSession | undefined;
  authenticateDevice(authorization?: string): AuthenticatedSession | undefined;
  backend: DashboardBackend;
  capabilityManager?: Pick<
    LocalCapabilityManager,
    "install" | "prepareInstallation"
  >;
  closeLocalState?: () => void;
  handoffs: Pick<
    HandoffService,
    | "mapProject"
    | "openAndContinue"
    | "overview"
    | "preview"
    | "publish"
    | "registerProjectPath"
    | "unmapProject"
    | "write"
  >;
  githubCliImporter?: Pick<GitHubCliCredentialImporter, "import">;
  inventory: Pick<LocalInventoryService, "get" | "refresh">;
  deviceControl?: Pick<
    DeviceControlService,
    "previewConfiguration" | "queueConfiguration" | "synchronizeCurrentDevice"
  >;
  onboarding?: Pick<LocalOnboardingService, "login" | "register" | "status">;
  permissionVault: PermissionVault;
  permissionSync?: Pick<PermissionSyncService, "run">;
  publicBaseUrl?: string;
  issueAgentCredential(
    session: AuthenticatedSession,
    agentId: string,
  ): IssuedAgentCredential;
  revokeAgentCredential(
    userId: string,
    deviceId: string,
    credentialId: string,
  ): boolean;
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
          version: ONE_STATUS_VERSION,
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
          capabilityPacks: listBuiltInCapabilityPacks().map(
            ({ manifest, digest }) => ({ manifest, digest }),
          ),
          modelCredentialSources:
            runtime.permissionVault.listModelCredentialStatus(userId),
          integrations: {
            auditEvents: runtime.permissionVault.listAuditEvents(userId),
            approvals: runtime.toolGateway.listApprovals(userId),
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

  app.put(
    "/v1/dashboard/capabilities/:packId",
    async (request, reply) => {
      if (!authorizeDashboardWrite(request, reply, dashboardSession, csrfToken)) {
        return;
      }
      const { packId } = capabilityPackParameterSchema.parse(request.params);
      const input = capabilityInstallationInputSchema.parse(request.body);
      const manifest = getBuiltInCapabilityPack(packId);
      if (!manifest) return reply.code(404).send({ error: "not_found" });
      const entry = listBuiltInCapabilityPacks().find(
        ({ manifest: candidate }) => candidate.name === packId,
      );
      if (!entry) return reply.code(404).send({ error: "not_found" });
      return dashboardCall(reply, () =>
        runtime.backend.mutateStatus((status) => {
          const now = new Date().toISOString();
          const previous = status.capabilities.installations[packId];
          status.capabilities.installations[packId] = {
            packId,
            version: manifest.version,
            manifestDigest: entry.digest,
            source: { type: "builtin" },
            targets: [...new Set(input.targets)],
            enabled: input.enabled,
            installedAt: previous?.installedAt ?? now,
            updatedAt: now,
          };
        }),
      );
    },
  );

  app.delete(
    "/v1/dashboard/capabilities/:packId",
    async (request, reply) => {
      if (!authorizeDashboardWrite(request, reply, dashboardSession, csrfToken)) {
        return;
      }
      const { packId } = capabilityPackParameterSchema.parse(request.params);
      return dashboardCall(reply, () =>
        runtime.backend.mutateStatus((status) => {
          delete status.capabilities.installations[packId];
        }),
      );
    },
  );

  app.post(
    "/v1/dashboard/capabilities/:packId/preview",
    async (request, reply) => {
      if (!authorizeDashboardWrite(request, reply, dashboardSession, csrfToken)) {
        return;
      }
      if (!runtime.capabilityManager) {
        return reply.code(501).send({ error: "capability_installer_unavailable" });
      }
      const { packId } = capabilityPackParameterSchema.parse(request.params);
      const { target } = localCapabilityTargetInputSchema.parse(request.body);
      return dashboardCall(reply, () =>
        runtime.capabilityManager!.prepareInstallation({
          packName: packId,
          target: target as LocalCapabilityTarget,
        }),
      );
    },
  );

  app.post(
    "/v1/dashboard/capabilities/:packId/install",
    async (request, reply) => {
      if (!authorizeDashboardWrite(request, reply, dashboardSession, csrfToken)) {
        return;
      }
      if (!runtime.capabilityManager) {
        return reply.code(501).send({ error: "capability_installer_unavailable" });
      }
      const { packId } = capabilityPackParameterSchema.parse(request.params);
      const input = localCapabilityInstallInputSchema.parse(request.body);
      return dashboardCall(reply, () =>
        runtime.capabilityManager!.install({
          packName: packId,
          target: input.target as LocalCapabilityTarget,
          confirmed: true,
          approvalId: input.approvalId,
        }),
      );
    },
  );

  app.post("/v1/dashboard/local-inventory/refresh", async (request, reply) => {
    if (!authorizeDashboardWrite(request, reply, dashboardSession, csrfToken)) {
      return;
    }
    return dashboardCall(reply, () => runtime.inventory.refresh());
  });

  app.post("/v1/dashboard/device-control/sync", async (request, reply) => {
    if (!authorizeDashboardWrite(request, reply, dashboardSession, csrfToken)) {
      return;
    }
    if (!runtime.deviceControl) {
      return reply.code(501).send({ error: "device_control_unavailable" });
    }
    return dashboardCall(reply, () =>
      withPermissionVault(runtime, () =>
        runtime.deviceControl!.synchronizeCurrentDevice(),
      ),
    );
  });

  app.put(
    "/v1/dashboard/model-sources/:id",
    async (request, reply) => {
      if (!authorizeDashboardWrite(request, reply, dashboardSession, csrfToken)) {
        return;
      }
      const { id } = modelControlParameterSchema.parse(request.params);
      const input = modelSourceInputSchema.parse(request.body);
      return dashboardCall(reply, () =>
        withPermissionVault(runtime, async () => {
          const snapshot = await runtime.backend.getSnapshot();
          if (input.apiKey) {
            runtime.permissionVault.setModelCredential(
              snapshot.profile.userId,
              id,
              input.apiKey,
            );
          } else if (input.clearCredential) {
            runtime.permissionVault.deleteModelCredential(
              snapshot.profile.userId,
              id,
            );
          }
          const credentialRequired =
            input.kind !== "official-account" && input.kind !== "local-service";
          const credentialAvailable = credentialRequired
            ? runtime.permissionVault.hasModelCredential(
                snapshot.profile.userId,
                id,
              )
            : false;
          return runtime.backend.mutateStatus((status) => {
            const now = new Date().toISOString();
            const previous = status.deviceControl.sources[id];
            status.deviceControl.sources[id] = {
              id,
              label: input.label,
              kind: input.kind,
              protocol: input.protocol,
              ...(input.endpoint ? { endpoint: input.endpoint } : {}),
              supportedTools: [...new Set(input.supportedTools)],
              ...(credentialRequired
                ? { credentialRef: `model-source:${id}` }
                : {}),
              credentialStatus: credentialRequired
                ? credentialAvailable
                  ? "available"
                  : "missing"
                : "not-required",
              ...(credentialAvailable ? { lastVerifiedAt: now } : {}),
              createdAt: previous?.createdAt ?? now,
              updatedAt: now,
            };
          });
        }),
      );
    },
  );

  app.delete(
    "/v1/dashboard/model-sources/:id",
    async (request, reply) => {
      if (!authorizeDashboardWrite(request, reply, dashboardSession, csrfToken)) {
        return;
      }
      const { id } = modelControlParameterSchema.parse(request.params);
      return dashboardCall(reply, () =>
        withPermissionVault(runtime, async () => {
          const snapshot = await runtime.backend.getSnapshot();
          runtime.permissionVault.deleteModelCredential(
            snapshot.profile.userId,
            id,
          );
          return runtime.backend.mutateStatus((status) => {
            const modelIds = Object.values(status.deviceControl.models)
              .filter((model) => model.sourceId === id)
              .map((model) => model.id);
            const modelIdSet = new Set(modelIds);
            for (const modelId of modelIds) {
              delete status.deviceControl.models[modelId];
            }
            for (const [intentId, intent] of Object.entries(
              status.deviceControl.intents,
            )) {
              if (intent.sourceId === id || modelIdSet.has(intent.modelId)) {
                delete status.deviceControl.intents[intentId];
              }
            }
            delete status.deviceControl.sources[id];
          });
        }),
      );
    },
  );

  app.put("/v1/dashboard/models/:id", async (request, reply) => {
    if (!authorizeDashboardWrite(request, reply, dashboardSession, csrfToken)) {
      return;
    }
    const { id } = modelControlParameterSchema.parse(request.params);
    const input = modelInputSchema.parse(request.body);
    return dashboardCall(reply, async () => {
      const snapshot = await runtime.backend.getSnapshot();
      const source = snapshot.status.deviceControl.sources[input.sourceId];
      if (!source) throw new Error("Model source was not found.");
      if (
        input.supportedTools.some(
          (tool) => !source.supportedTools.includes(tool),
        )
      ) {
        throw new Error("Model tools must be supported by its source.");
      }
      return runtime.backend.mutateStatus((status) => {
        const now = new Date().toISOString();
        const previous = status.deviceControl.models[id];
        status.deviceControl.models[id] = {
          id,
          sourceId: input.sourceId,
          name: input.name,
          modelId: input.modelId,
          supportedTools: [...new Set(input.supportedTools)],
          createdAt: previous?.createdAt ?? now,
          updatedAt: now,
        };
      });
    });
  });

  app.delete("/v1/dashboard/models/:id", async (request, reply) => {
    if (!authorizeDashboardWrite(request, reply, dashboardSession, csrfToken)) {
      return;
    }
    const { id } = modelControlParameterSchema.parse(request.params);
    return dashboardCall(reply, () =>
      runtime.backend.mutateStatus((status) => {
        for (const [intentId, intent] of Object.entries(
          status.deviceControl.intents,
        )) {
          if (intent.modelId === id) delete status.deviceControl.intents[intentId];
        }
        delete status.deviceControl.models[id];
      }),
    );
  });

  app.post(
    "/v1/dashboard/model-configurations/preview",
    async (request, reply) => {
      if (!authorizeDashboardWrite(request, reply, dashboardSession, csrfToken)) {
        return;
      }
      if (!runtime.deviceControl) {
        return reply.code(501).send({ error: "device_control_unavailable" });
      }
      const input = modelConfigurationPreviewSchema.parse(request.body);
      return dashboardCall(reply, () =>
        withPermissionVault(runtime, () =>
          runtime.deviceControl!.previewConfiguration(input),
        ),
      );
    },
  );

  app.post(
    "/v1/dashboard/model-configurations/apply",
    async (request, reply) => {
      if (!authorizeDashboardWrite(request, reply, dashboardSession, csrfToken)) {
        return;
      }
      if (!runtime.deviceControl) {
        return reply.code(501).send({ error: "device_control_unavailable" });
      }
      const input = modelConfigurationApplySchema.parse(request.body);
      return dashboardCall(reply, () =>
        withPermissionVault(runtime, () =>
          runtime.deviceControl!.queueConfiguration(input),
        ),
      );
    },
  );

  app.get("/v1/dashboard/handoffs", async (request, reply) => {
    if (!authorizeDashboard(request, reply, dashboardSession)) return;
    return dashboardCall(reply, () => runtime.handoffs.overview());
  });

  app.put(
    "/v1/dashboard/local-project-paths/:projectId",
    async (request, reply) => {
      if (!authorizeDashboardWrite(request, reply, dashboardSession, csrfToken)) {
        return;
      }
      return dashboardCall(reply, async () => {
        const { projectId } = handoffProjectParameterSchema.parse(request.params);
        const { path } = localProjectMappingInputSchema.parse(request.body);
        return runtime.handoffs.registerProjectPath(projectId, path);
      });
    },
  );

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

  app.put("/v1/dashboard/persona/events/:id", async (request, reply) => {
    if (!authorizeDashboardWrite(request, reply, dashboardSession, csrfToken)) {
      return;
    }
    return dashboardCall(reply, async () => {
      const { id } = personaEventParameterSchema.parse(request.params);
      const body = personaUpdateInputSchema.parse({
        ...(request.body as Record<string, unknown>),
        id,
      });
      return runtime.backend.mutateStatus((status) => {
        updatePersonaEvent(status, body);
      });
    });
  });

  app.delete("/v1/dashboard/persona/events/:id", async (request, reply) => {
    if (!authorizeDashboardWrite(request, reply, dashboardSession, csrfToken)) {
      return;
    }
    return dashboardCall(reply, async () => {
      const { id } = personaEventParameterSchema.parse(request.params);
      return runtime.backend.mutateStatus((status) => {
        deletePersonaEvent(status, id);
      });
    });
  });

  app.put("/v1/dashboard/persona/policy", async (request, reply) => {
    if (!authorizeDashboardWrite(request, reply, dashboardSession, csrfToken)) {
      return;
    }
    return dashboardCall(reply, async () => {
      const body = personaPolicyInputSchema.parse(request.body);
      return runtime.backend.mutateStatus((status) => {
        setPersonaPolicy(status, body);
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

  app.put("/v1/dashboard/tasks/:id", async (request, reply) => {
    if (!authorizeDashboardWrite(request, reply, dashboardSession, csrfToken)) {
      return;
    }
    return dashboardCall(reply, async () => {
      const { id } = taskParameterSchema.parse(request.params);
      const body = taskInputSchema.parse(request.body);
      return runtime.backend.mutateStatus((status) => {
        if (body.projectId && !status.projects[body.projectId]) {
          throw new Error("Task project was not found.");
        }
        status.tasks[id] = {
          id,
          ...(body.projectId ? { projectId: body.projectId } : {}),
          title: body.title,
          status: body.status,
          completed: body.completed,
          next: body.next,
          updatedAt: new Date().toISOString(),
        };
      });
    });
  });

  app.delete("/v1/dashboard/tasks/:id", async (request, reply) => {
    if (!authorizeDashboardWrite(request, reply, dashboardSession, csrfToken)) {
      return;
    }
    return dashboardCall(reply, async () => {
      const { id } = taskParameterSchema.parse(request.params);
      return runtime.backend.mutateStatus((status) => {
        delete status.tasks[id];
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
          state: "confirmed",
          origin: { type: "manual", label: "One Status Dashboard" },
          createdAt: now,
          updatedAt: now,
        });
      });
    });
  });

  app.put("/v1/dashboard/memories/:id", async (request, reply) => {
    if (!authorizeDashboardWrite(request, reply, dashboardSession, csrfToken)) {
      return;
    }
    return dashboardCall(reply, async () => {
      const { id } = memoryParameterSchema.parse(request.params);
      const body = memoryInputSchema.parse(request.body);
      return runtime.backend.mutateStatus((status) => {
        if (body.scope === "project" && !body.projectId) {
          throw new Error("Project memory requires a project.");
        }
        const index = status.memory.findIndex((entry) => entry.id === id);
        if (index < 0) throw new Error("Memory was not found.");
        const current = status.memory[index]!;
        status.memory[index] = {
          ...current,
          scope: body.scope,
          ...(body.projectId
            ? { projectId: body.projectId }
            : { projectId: undefined }),
          content: body.content,
          tags: body.tags,
          updatedAt: new Date().toISOString(),
        };
      });
    });
  });

  app.put("/v1/dashboard/memories/:id/confirm", async (request, reply) => {
    if (!authorizeDashboardWrite(request, reply, dashboardSession, csrfToken)) {
      return;
    }
    return dashboardCall(reply, async () => {
      const { id } = memoryParameterSchema.parse(request.params);
      return runtime.backend.mutateStatus((status) => {
        const memory = status.memory.find((entry) => entry.id === id);
        if (!memory) throw new Error("Memory was not found.");
        memory.state = "confirmed";
        memory.updatedAt = new Date().toISOString();
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
    "/v1/dashboard/oauth/providers/:provider/import-token",
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
          const extension = providerExtensionById.get(provider);
          if (
            providerCatalog[provider].authMode !== "token" ||
            !extension?.tokenConnection
          ) {
            return reply.code(404).send({ error: "not_found" });
          }
          const { accessToken } = providerTokenInputSchema.parse(request.body);
          const userId = await runtime.backend.userId();
          const config = runtime.permissionVault.getProviderConfig(
            userId,
            provider,
          );
          if (!config) {
            throw new Error("Configure the provider app before connecting.");
          }
          const verified = await extension.tokenConnection.verify({
            accessToken,
            config,
          });
          const connection = runtime.permissionVault.upsertConnection({
            ...verified,
            credential: { accessToken, tokenType: "Token" },
            expiresAt: null,
            provider,
            source: "imported",
            userId,
          });
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
          if (providerCatalog[provider].authMode === "token") {
            throw new Error("This provider uses a Token connection.");
          }
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
        const body = dashboardToolExecuteInputSchema.parse(request.body);
        return {
          result: await runtime.toolGateway.execute({
            ...body,
            userId: await runtime.backend.userId(),
          }),
        };
      }),
    );
  });

  app.post(
    "/v1/dashboard/tool-approvals/:id",
    async (request, reply) => {
      if (!authorizeDashboardWrite(request, reply, dashboardSession, csrfToken)) {
        return;
      }
      return dashboardCall(reply, async () => {
        const { id } = toolApprovalParameterSchema.parse(request.params);
        const { decision } = toolApprovalDecisionSchema.parse(request.body);
        return {
          approval: runtime.toolGateway.decideApproval(
            await runtime.backend.userId(),
            id,
            decision,
          ),
        };
      });
    },
  );

  app.post("/v1/tools/credentials", async (request, reply) => {
    if (!isTrustedDashboardHost(request)) return forbidden(reply);
    const session = await authenticateDeviceRequest(
      runtime,
      request.headers.authorization,
    );
    if (!session) return unauthorized(reply);
    const { agentId } = agentCredentialInputSchema.parse(request.body);
    return {
      credential: runtime.issueAgentCredential(session, agentId),
    };
  });

  app.delete(
    "/v1/tools/credentials/:credentialId",
    async (request, reply) => {
      if (!isTrustedDashboardHost(request)) return forbidden(reply);
      const session = await authenticateDeviceRequest(
        runtime,
        request.headers.authorization,
      );
      if (!session) return unauthorized(reply);
      const { credentialId } = agentCredentialParameterSchema.parse(
        request.params,
      );
      if (
        !runtime.revokeAgentCredential(
          session.userId,
          session.deviceId,
          credentialId,
        )
      ) {
        return reply.code(404).send({
          error: {
            code: "agent_credential_not_found",
            message: "Agent credential was not found.",
          },
        });
      }
      return { credentialId, revoked: true };
    },
  );

  app.get("/v1/tools", async (request, reply) => {
    if (!isTrustedDashboardHost(request)) return forbidden(reply);
    const session = await authenticateAgentToolRequest(
      runtime,
      request.headers.authorization,
      reply,
    );
    if (!session) return;
    const { agentId: claimedAgentId } = agentQuerySchema.parse(request.query);
    if (!matchesAgentIdentity(claimedAgentId, session.agentId)) {
      return agentIdentityMismatch(reply);
    }
    return withPermissionVault(runtime, () => ({
      connections: runtime.toolGateway.list(session.userId, session.agentId),
    }));
  });

  app.post("/v1/tools/approval-requests", async (request, reply) => {
    if (!isTrustedDashboardHost(request)) return forbidden(reply);
    const session = await authenticateAgentToolRequest(
      runtime,
      request.headers.authorization,
      reply,
    );
    if (!session) return;
    const { agentId: claimedAgentId, ...body } =
      agentToolApprovalRequestInputSchema.parse(request.body);
    if (!matchesAgentIdentity(claimedAgentId, session.agentId)) {
      return agentIdentityMismatch(reply);
    }
    return withPermissionVault(runtime, () => ({
      approval: runtime.toolGateway.requestApproval({
        ...body,
        agentId: session.agentId,
        userId: session.userId,
      }),
      dashboardUrl: `http://${request.headers.host}/integrations`,
    }));
  });

  app.post("/v1/tools/execute", async (request, reply) => {
    if (!isTrustedDashboardHost(request)) return forbidden(reply);
    const session = await authenticateAgentToolRequest(
      runtime,
      request.headers.authorization,
      reply,
    );
    if (!session) return;
    const { agentId: claimedAgentId, ...body } =
      agentToolExecuteInputSchema.parse(request.body);
    if (!matchesAgentIdentity(claimedAgentId, session.agentId)) {
      return agentIdentityMismatch(reply);
    }
    return withPermissionVault(runtime, async () => ({
      result: await runtime.toolGateway.execute({
        ...body,
        agentId: session.agentId,
        userId: session.userId,
      }),
    }));
  });
}

async function authenticateDeviceRequest(
  runtime: DashboardRuntime,
  authorization?: string,
): Promise<AuthenticatedSession | undefined> {
  return (
    runtime.authenticateDevice(authorization) ??
    (await runtime.backend.authenticateDevice?.(authorization))
  );
}

async function authenticateAgentToolRequest(
  runtime: DashboardRuntime,
  authorization: string | undefined,
  reply: FastifyReply,
): Promise<AuthenticatedAgentSession | undefined> {
  const agent = runtime.authenticateAgent(authorization);
  if (agent) return agent;
  const device = await authenticateDeviceRequest(runtime, authorization);
  if (device) {
    agentCredentialRequired(reply);
    return undefined;
  }
  unauthorizedAgent(reply);
  return undefined;
}

function matchesAgentIdentity(
  claimedAgentId: string | undefined,
  authenticatedAgentId: string,
): boolean {
  return claimedAgentId === undefined || claimedAgentId === authenticatedAgentId;
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
    if (error instanceof ToolApprovalError) throw error;
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

function unauthorizedAgent(reply: FastifyReply) {
  return reply.code(401).send({
    error: {
      code: "unauthorized",
      message: "A valid One Status Agent credential is required.",
    },
  });
}

function agentCredentialRequired(reply: FastifyReply) {
  return reply.code(401).send({
    error: {
      code: "agent_credential_required",
      message:
        "Device sessions cannot call Agent tools. Upgrade or restart the One Status MCP to obtain an Agent credential.",
    },
  });
}

function agentIdentityMismatch(reply: FastifyReply) {
  return reply.code(403).send({
    error: {
      code: "agent_identity_mismatch",
      message: "The claimed Agent identity does not match the credential.",
    },
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

const taskParameterSchema = z.object({
  id: z.string().min(1).max(2_000),
});
const taskInputSchema = z
  .object({
    completed: z.array(z.string().max(1_000)).max(100).default([]),
    next: z.array(z.string().max(1_000)).max(100).default([]),
    projectId: z.string().min(1).max(120).optional(),
    status: z.enum(["todo", "in_progress", "blocked", "done"]),
    title: z.string().min(1).max(500),
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
const memoryParameterSchema = z.object({ id: z.string().min(1).max(2_000) });
const deviceParameterSchema = z.object({ id: z.uuid() });
const connectionParameterSchema = z.object({ id: z.uuid() });
const providerParameterSchema = z.object({ provider: z.string() });
const providerConfigInputSchema = z
  .object({
    clientId: z.string().min(1).max(500),
    clientSecret: z.string().max(1_000).optional(),
  })
  .strict();
const providerTokenInputSchema = z
  .object({ accessToken: z.string().min(1).max(32_000) })
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
const capabilityPackParameterSchema = z.object({
  packId: z.string().min(1).max(120),
});
const capabilityInstallationInputSchema = z
  .object({
    targets: z.array(capabilityTargetSchema).min(1).max(7),
    enabled: z.boolean().default(true),
  })
  .strict();
const localCapabilityTargetInputSchema = z
  .object({ target: z.enum(["codex", "claude-code", "markdown", "local-mcp"]) })
  .strict();
const localCapabilityInstallInputSchema = localCapabilityTargetInputSchema
  .extend({
    approvalId: z.string().regex(/^[a-f0-9]{64}$/),
    confirmed: z.literal(true),
  })
  .strict();
const modelControlParameterSchema = z.object({
  id: z
    .string()
    .min(1)
    .max(200)
    .regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/),
});
const personaEventParameterSchema = z.object({
  id: z.string().min(1).max(200),
});
const modelEndpointInputSchema = z
  .url()
  .max(2_000)
  .superRefine((value, context) => {
    const endpoint = new URL(value);
    if (
      endpoint.username ||
      endpoint.password ||
      endpoint.search ||
      endpoint.hash
    ) {
      context.addIssue({
        code: "custom",
        message: "Endpoint cannot include user info, query, or fragment.",
      });
    }
  });
const modelSourceInputSchema = z
  .object({
    label: z.string().trim().min(1).max(200),
    kind: modelSourceKindSchema,
    protocol: modelApiProtocolSchema,
    endpoint: modelEndpointInputSchema.optional(),
    supportedTools: z
      .array(agentToolIdSchema)
      .min(1)
      .max(agentToolIdSchema.options.length)
      .refine((tools) => new Set(tools).size === tools.length, {
        message: "supportedTools must be unique",
      }),
    apiKey: z.string().min(1).max(32_000).optional(),
    clearCredential: z.boolean().default(false),
  })
  .strict()
  .refine((input) => !(input.apiKey && input.clearCredential), {
    message: "apiKey and clearCredential cannot be used together",
  })
  .superRefine((input, context) => {
    if (
      input.apiKey &&
      (input.kind === "official-account" || input.kind === "local-service")
    ) {
      context.addIssue({
        code: "custom",
        message: "This model source type does not accept an API key.",
        path: ["apiKey"],
      });
    }
    if (
      input.supportedTools.includes("claude-code") &&
      input.protocol !== "anthropic" &&
      input.protocol !== "custom"
    ) {
      context.addIssue({
        code: "custom",
        message: "Claude Code requires an Anthropic or custom protocol source.",
        path: ["supportedTools"],
      });
    }
    if (
      input.supportedTools.includes("codex") &&
      input.protocol === "anthropic"
    ) {
      context.addIssue({
        code: "custom",
        message: "Codex cannot use an Anthropic protocol source directly.",
        path: ["supportedTools"],
      });
    }
  });
const modelInputSchema = z
  .object({
    sourceId: modelControlParameterSchema.shape.id,
    name: z.string().trim().min(1).max(200),
    modelId: z.string().trim().min(1).max(500),
    supportedTools: z
      .array(agentToolIdSchema)
      .min(1)
      .max(agentToolIdSchema.options.length)
      .refine((tools) => new Set(tools).size === tools.length, {
        message: "supportedTools must be unique",
      }),
  })
  .strict();
const modelConfigurationPreviewSchema = z
  .object({
    modelId: modelControlParameterSchema.shape.id,
    targets: z
      .array(
        z
          .object({
            deviceId: z.uuid(),
            toolId: agentToolIdSchema,
          })
          .strict(),
      )
      .min(1)
      .max(100),
  })
  .strict();
const modelConfigurationApplySchema = z
  .object({
    approvalId: z.uuid(),
    digest: z.string().regex(/^[a-f0-9]{64}$/),
    confirm: z.literal(true),
  })
  .strict();
const toolExecuteInputSchema = z
  .object({
    action: z.string().min(1).max(160),
    agentId: z.string().min(1).max(120),
    approvalId: z.uuid().optional(),
    arguments: z.record(z.string(), z.unknown()).default({}),
    connectionId: z.uuid(),
  })
  .strict();
const dashboardToolExecuteInputSchema = toolExecuteInputSchema
  .omit({ approvalId: true })
  .extend({ confirmed: z.literal(true) })
  .strict();
const toolApprovalRequestInputSchema = toolExecuteInputSchema
  .omit({ approvalId: true })
  .strict();
const agentToolExecuteInputSchema = toolExecuteInputSchema
  .partial({ agentId: true })
  .strict();
const agentToolApprovalRequestInputSchema = toolApprovalRequestInputSchema
  .partial({ agentId: true })
  .strict();
const toolApprovalParameterSchema = z.object({ id: z.uuid() });
const toolApprovalDecisionSchema = z
  .object({ decision: z.enum(["approve", "deny"]) })
  .strict();
const agentIdSchema = z
  .string()
  .trim()
  .min(1)
  .max(120)
  .regex(/^[a-zA-Z0-9._:-]+$/);
const agentQuerySchema = z.object({ agentId: agentIdSchema.optional() }).strict();
const agentCredentialInputSchema = z.object({ agentId: agentIdSchema }).strict();
const agentCredentialParameterSchema = z
  .object({ credentialId: z.uuid() })
  .strict();
