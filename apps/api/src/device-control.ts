import { createHash, randomUUID } from "node:crypto";
import { arch, platform, release } from "node:os";
import {
  ONE_STATUS_VERSION,
  type AgentToolId,
  type ConfigurationIntent,
  type DeviceReport,
  type DeviceToolReport,
  type ModelDefinition,
  type ModelSource,
} from "@one-status/protocol";
import type { DashboardBackend, DashboardStatusSnapshot } from "./dashboard-backend.js";
import type {
  LocalAgentAsset,
  LocalInventoryService,
  LocalInventorySnapshot,
} from "./local-inventory.js";
import type { PermissionVault } from "./permission-vault.js";

const APPROVAL_TTL_MS = 10 * 60 * 1_000;
const CLAIM_LEASE_MS = 2 * 60 * 1_000;
const REPORT_REFRESH_MS = 5 * 60 * 1_000;

export interface ModelConfigurationInput {
  apiKey?: string;
  expectedPlanId?: string;
  model: ModelDefinition;
  source: ModelSource;
  toolId: AgentToolId;
}

export interface ModelConfigurationPlan {
  planId: string;
  targets: Array<{
    purpose: string;
    path: string;
    existed: boolean;
    beforeSha256: string;
    afterSha256: string;
    beforeMode?: number;
    afterMode?: number;
  }>;
  changes: Array<{
    path: string;
    operation: string;
    before?: unknown;
    after?: unknown;
    sensitive?: boolean;
  }>;
  warnings: string[];
  requiresRestart: boolean;
}

export interface ModelConfigurationAdapter {
  preview?(input: ModelConfigurationInput): Promise<ModelConfigurationPlan>;
  apply(input: ModelConfigurationInput): Promise<{ appliedAt: string }>;
}

export class ModelConfigurationApplyError extends Error {
  constructor(
    message: string,
    readonly rolledBack: boolean,
  ) {
    super(message);
    this.name = "ModelConfigurationApplyError";
  }
}

export interface ConfigurationTarget {
  deviceId: string;
  toolId: AgentToolId;
}

interface ConfigurationApproval {
  configuration: ApprovedConfiguration;
  digest: string;
  expiresAt: number;
  modelId: string;
  sourceId: string;
  targets: ConfigurationTarget[];
  localPlanIds: Record<string, string>;
}

interface ApprovedConfiguration {
  model: ModelDefinition;
  source: ModelSource;
}

export class DeviceControlService {
  readonly #approvals = new Map<string, ConfigurationApproval>();
  #running?: Promise<DashboardStatusSnapshot>;

  constructor(
    private readonly backend: DashboardBackend,
    private readonly inventory: Pick<LocalInventoryService, "refresh">,
    private readonly permissionVault: Pick<
      PermissionVault,
      "getModelCredential" | "hasModelCredential"
    >,
    private readonly configurator: ModelConfigurationAdapter,
  ) {}

  synchronizeCurrentDevice(): Promise<DashboardStatusSnapshot> {
    if (this.#running) {
      const running = this.#running;
      return running.then(() => this.synchronizeCurrentDevice());
    }
    this.#running = this.#synchronize().finally(() => {
      this.#running = undefined;
    });
    return this.#running;
  }

  async previewConfiguration(input: {
    modelId: string;
    targets: ConfigurationTarget[];
  }): Promise<{
    approvalId: string;
    digest: string;
    expiresAt: string;
    model: ModelDefinition;
    source: ModelSource;
    changes: Array<{
      deviceId: string;
      deviceName: string;
      toolId: AgentToolId;
      previousModelId: string | null;
      nextModelId: string;
      online: boolean;
      execution: "immediate" | "pending";
      localPlan?: ModelConfigurationPlan;
    }>;
  }> {
    const snapshot = await this.backend.getSnapshot();
    const model = snapshot.status.deviceControl.models[input.modelId];
    if (!model) throw new Error("Model was not found.");
    const source = snapshot.status.deviceControl.sources[model.sourceId];
    if (!source) throw new Error("Model source was not found.");
    if (
      source.credentialRef &&
      !this.permissionVault.hasModelCredential(snapshot.profile.userId, source.id)
    ) {
      throw new Error("Add a model source credential before configuring devices.");
    }
    const targets = uniqueTargets(input.targets);
    if (targets.length === 0) throw new Error("Select at least one device and tool.");
    const devices = new Map(snapshot.account.devices.map((device) => [device.id, device]));
    const credential = source.credentialRef
      ? this.permissionVault.getModelCredential(snapshot.profile.userId, source.id)
      : undefined;
    const changes = await Promise.all(targets.map(async (target) => {
      const device = devices.get(target.deviceId);
      if (!device) throw new Error("Target device was not found.");
      if (!model.supportedTools.includes(target.toolId)) {
        throw new Error("The model does not support the selected AI tool.");
      }
      if (!source.supportedTools.includes(target.toolId)) {
        throw new Error("The model source does not support the selected AI tool.");
      }
      const report = snapshot.status.deviceControl.reports[target.deviceId];
      const tool = report?.tools.find((entry) => entry.toolId === target.toolId);
      if (report && tool && !tool.installed) {
        throw new Error("The selected AI tool is not installed on the target device.");
      }
      const online = device.online || device.id === snapshot.profile.deviceId;
      const localPlan =
        device.id === snapshot.profile.deviceId && this.configurator.preview
          ? await this.configurator.preview({
              ...(credential ? { apiKey: credential } : {}),
              model,
              source,
              toolId: target.toolId,
            })
          : undefined;
      return {
        deviceId: target.deviceId,
        deviceName: device.name,
        toolId: target.toolId,
        previousModelId: tool?.currentModelId ?? null,
        nextModelId: model.modelId,
        online,
        execution: online ? ("immediate" as const) : ("pending" as const),
        ...(localPlan ? { localPlan } : {}),
      };
    }));
    const localPlanIds = Object.fromEntries(
      changes.flatMap((change) =>
        change.localPlan
          ? [[targetKey(change), change.localPlan.planId]]
          : [],
      ),
    );
    const digest = configurationDigest(
      {
        state: configurationApprovalState(snapshot, model, source, targets),
        localPlanIds,
      },
    );
    const approvalId = randomUUID();
    const expiresAt = Date.now() + APPROVAL_TTL_MS;
    this.#approvals.set(approvalId, {
      configuration: cloneApprovedConfiguration(model, source),
      digest,
      expiresAt,
      modelId: model.id,
      sourceId: source.id,
      targets,
      localPlanIds,
    });
    this.#pruneApprovals();
    return {
      approvalId,
      digest,
      expiresAt: new Date(expiresAt).toISOString(),
      model,
      source,
      changes,
    };
  }

  async queueConfiguration(input: {
    approvalId: string;
    digest: string;
    confirm: boolean;
  }): Promise<DashboardStatusSnapshot> {
    if (!input.confirm) throw new Error("Configuration changes require confirmation.");
    const approval = this.#approvals.get(input.approvalId);
    this.#approvals.delete(input.approvalId);
    if (!approval || approval.expiresAt <= Date.now()) {
      throw new Error("Configuration preview expired. Create a new preview.");
    }
    if (approval.digest !== input.digest) {
      throw new Error("Configuration preview changed. Create a new preview.");
    }
    const current = await this.backend.getSnapshot();
    const model = current.status.deviceControl.models[approval.modelId];
    const source = current.status.deviceControl.sources[approval.sourceId];
    if (!model || !source || model.sourceId !== source.id) {
      throw new Error("The selected model configuration is no longer available.");
    }
    const currentDigest = configurationDigest(
      {
        state: configurationApprovalState(
          current,
          model,
          source,
          approval.targets,
        ),
        localPlanIds: approval.localPlanIds,
      },
    );
    if (currentDigest !== approval.digest) {
      throw new Error("Configuration state changed. Create a new preview.");
    }
    const approved = approval.configuration;
    await this.backend.mutateStatus((status) => {
      const now = new Date().toISOString();
      for (const target of approval.targets) {
        const report = status.deviceControl.reports[target.deviceId];
        const tool = report?.tools.find((entry) => entry.toolId === target.toolId);
        const id = randomUUID();
        status.deviceControl.intents[id] = {
          id,
          deviceId: target.deviceId,
          toolId: target.toolId,
          modelId: approved.model.id,
          sourceId: approved.source.id,
          status: "pending",
          requestedAt: now,
          requestedByDeviceId: current.profile.deviceId,
          updatedAt: now,
          attempts: 0,
          configuration: structuredClone(approved),
          ...(approval.localPlanIds[targetKey(target)]
            ? { expectedPlanId: approval.localPlanIds[targetKey(target)] }
            : {}),
          ...(tool?.currentModelId || tool?.sourceId
            ? {
                previous: {
                  ...(tool.currentModelId ? { modelId: tool.currentModelId } : {}),
                  ...(tool.sourceId ? { sourceId: tool.sourceId } : {}),
                },
              }
            : {}),
        };
      }
    });
    return this.synchronizeCurrentDevice();
  }

  async #synchronize(): Promise<DashboardStatusSnapshot> {
    const inventory = await this.inventory.refresh();
    let snapshot = await this.backend.getSnapshot();
    const report = buildDeviceReport(snapshot, inventory);
    const previousReport = snapshot.status.deviceControl.reports[report.deviceId];
    const credentialsChanged = modelCredentialStatusChanged(
      snapshot.status.deviceControl.sources,
      snapshot.profile.userId,
      this.permissionVault,
    );
    const shouldPublish =
      !previousReport ||
      !sameReport(previousReport, report) ||
      Date.now() - Date.parse(previousReport.reportedAt) >= REPORT_REFRESH_MS;
    if (shouldPublish || credentialsChanged) {
      snapshot = await this.backend.mutateStatus((status) => {
        if (shouldPublish) {
          mergeDiscoveredCatalog(status.deviceControl, report, inventory);
          status.deviceControl.reports[report.deviceId] = report;
        }
        reconcileModelCredentialStatus(
          status.deviceControl.sources,
          snapshot.profile.userId,
          this.permissionVault,
        );
      });
    }

    const now = Date.now();
    const pending = Object.values(snapshot.status.deviceControl.intents)
      .filter(
        (intent) =>
          intent.deviceId === snapshot.profile.deviceId &&
          isClaimableIntent(intent, now),
      )
      .sort(
        (left, right) =>
          Date.parse(left.requestedAt) - Date.parse(right.requestedAt),
      );
    for (const intent of pending) {
      await this.#applyIntent(intent);
    }
    return this.backend.getSnapshot();
  }

  async #applyIntent(intent: ConfigurationIntent): Promise<void> {
    const claimId = randomUUID();
    const claimedAtMs = Date.now();
    const claimedAt = new Date(claimedAtMs).toISOString();
    const claimExpiresAt = new Date(
      claimedAtMs + CLAIM_LEASE_MS,
    ).toISOString();
    let claimed = false;
    const snapshot = await this.backend.mutateStatus((status) => {
      claimed = false;
      const current = status.deviceControl.intents[intent.id];
      if (!current || !isClaimableIntent(current, claimedAtMs)) return;
      current.status = "applying";
      current.claimId = claimId;
      current.claimedAt = claimedAt;
      current.claimExpiresAt = claimExpiresAt;
      current.attempts += 1;
      current.updatedAt = claimedAt;
      delete current.error;
      claimed = true;
    });
    const current = snapshot.status.deviceControl.intents[intent.id];
    if (
      !claimed ||
      !current ||
      current.status !== "applying" ||
      current.claimId !== claimId
    ) {
      return;
    }
    const configuration = current.configuration;
    if (!configuration || !configurationMatchesIntent(current, configuration)) {
      await this.#finishIntent(
        current,
        claimId,
        "failed",
        "The approved model configuration snapshot is unavailable.",
      );
      return;
    }
    const { model, source } = configuration;
    const requiresCredential = Boolean(source.credentialRef);
    const credential = requiresCredential
      ? this.permissionVault.getModelCredential(
          snapshot.profile.userId,
          current.sourceId,
        )
      : undefined;
    if (requiresCredential && !credential) {
      await this.#finishIntent(
        current,
        claimId,
        "failed",
        "Model source credential is unavailable on this device.",
      );
      return;
    }
    try {
      const result = await this.configurator.apply({
        ...(credential ? { apiKey: credential } : {}),
        model,
        source,
        toolId: current.toolId,
        ...(current.expectedPlanId
          ? { expectedPlanId: current.expectedPlanId }
          : {}),
      });
      await this.backend.mutateStatus((status) => {
        const target = status.deviceControl.intents[current.id];
        if (
          !target ||
          target.status !== "applying" ||
          target.claimId !== claimId
        ) {
          return;
        }
        target.status = "applied";
        target.appliedAt = result.appliedAt;
        target.updatedAt = result.appliedAt;
        delete target.error;
        clearIntentClaim(target);
        const device = status.deviceControl.reports[target.deviceId];
        const tool = device?.tools.find((entry) => entry.toolId === target.toolId);
        if (tool) {
          tool.currentModelRef = model.id;
          tool.currentModelId = model.modelId;
          tool.sourceId = source.id;
          tool.sourceLabel = source.label;
          tool.sourceKind = source.kind;
          tool.protocol = source.protocol;
          tool.endpointHost = source.endpoint
            ? new URL(source.endpoint).host
            : undefined;
          tool.health = "healthy";
          tool.lastConfiguredAt = result.appliedAt;
          device!.reportedAt = result.appliedAt;
        }
      });
    } catch (error) {
      const rolledBack =
        error instanceof ModelConfigurationApplyError && error.rolledBack;
      await this.#finishIntent(
        current,
        claimId,
        rolledBack ? "rollback" : "failed",
        safeError(error, credential),
      );
    }
  }

  async #finishIntent(
    intent: ConfigurationIntent,
    claimId: string,
    status: "failed" | "rollback",
    error: string,
  ): Promise<void> {
    await this.backend.mutateStatus((document) => {
      const current = document.deviceControl.intents[intent.id];
      if (
        !current ||
        current.status !== "applying" ||
        current.claimId !== claimId
      ) {
        return;
      }
      const now = new Date().toISOString();
      current.status = status;
      current.error = error;
      current.updatedAt = now;
      clearIntentClaim(current);
      if (status === "rollback") current.rollbackAt = now;
      const report = document.deviceControl.reports[current.deviceId];
      const tool = report?.tools.find((entry) => entry.toolId === current.toolId);
      if (tool) tool.health = "error";
    });
  }

  #pruneApprovals(): void {
    const now = Date.now();
    for (const [id, approval] of this.#approvals) {
      if (approval.expiresAt <= now) this.#approvals.delete(id);
    }
  }
}

function cloneApprovedConfiguration(
  model: ModelDefinition,
  source: ModelSource,
): ApprovedConfiguration {
  return structuredClone({ model, source });
}

function configurationMatchesIntent(
  intent: ConfigurationIntent,
  configuration: ApprovedConfiguration,
): boolean {
  return (
    configuration.model.id === intent.modelId &&
    configuration.model.sourceId === intent.sourceId &&
    configuration.source.id === intent.sourceId &&
    configuration.model.supportedTools.includes(intent.toolId) &&
    configuration.source.supportedTools.includes(intent.toolId)
  );
}

function isClaimableIntent(intent: ConfigurationIntent, now: number): boolean {
  if (intent.status === "pending") return true;
  if (intent.status !== "applying") return false;
  const expiresAt = intent.claimExpiresAt
    ? Date.parse(intent.claimExpiresAt)
    : Date.parse(intent.updatedAt) + CLAIM_LEASE_MS;
  return !Number.isFinite(expiresAt) || expiresAt <= now;
}

function clearIntentClaim(intent: ConfigurationIntent): void {
  delete intent.claimId;
  delete intent.claimedAt;
  delete intent.claimExpiresAt;
}

function buildDeviceReport(
  snapshot: DashboardStatusSnapshot,
  inventory: LocalInventorySnapshot,
): DeviceReport {
  const previousReport =
    snapshot.status.deviceControl.reports[snapshot.profile.deviceId];
  const pending = Object.values(snapshot.status.deviceControl.intents).filter(
    (intent) =>
      intent.deviceId === snapshot.profile.deviceId &&
      (intent.status === "pending" || intent.status === "applying"),
  );
  return {
    deviceId: snapshot.profile.deviceId,
    deviceName: snapshot.profile.deviceName,
    operatingSystem: operatingSystem(),
    osVersion: release(),
    architecture: arch(),
    backgroundVersion: ONE_STATUS_VERSION,
    tools: inventory.agents.map((agent) => {
      const previous = previousReport?.tools.find(
        (entry) => entry.toolId === agent.id,
      );
      const previousSource = previous?.sourceId
        ? snapshot.status.deviceControl.sources[previous.sourceId]
        : undefined;
      const discoveredSourceId = agent.model
        ? normalizeControlId(agent.model.providerId)
        : undefined;
      const knownModel = agent.model?.modelId
        ? Object.values(snapshot.status.deviceControl.models).find(
            (model) =>
              model.sourceId === discoveredSourceId &&
              model.modelId === agent.model!.modelId,
          )
        : undefined;
      const knownSource = knownModel
        ? snapshot.status.deviceControl.sources[knownModel.sourceId]
        : undefined;
      return buildToolReport(
        agent,
        pending.some((intent) => intent.toolId === agent.id),
        previous,
        previousSource,
        knownModel,
        knownSource,
      );
    }),
    reportedAt: new Date().toISOString(),
  };
}

function buildToolReport(
  agent: LocalAgentAsset,
  pending: boolean,
  previous?: DeviceToolReport,
  previousSource?: ModelSource,
  knownModel?: ModelDefinition,
  knownSource?: ModelSource,
): DeviceToolReport {
  const model = agent.model;
  const keepManagedSource = Boolean(
    model &&
      previous?.lastConfiguredAt &&
      previousSource &&
      previous.currentModelId === model.modelId &&
      previousSource.protocol === model.protocol &&
      effectiveEndpoint(previousSource) === model.endpoint,
  );
  const catalogSource = keepManagedSource ? previousSource : knownSource;
  const sourceId = model
    ? keepManagedSource
      ? previousSource!.id
      : knownModel?.sourceId ?? normalizeControlId(model.providerId)
    : undefined;
  const modelRef =
    model?.modelId && sourceId
      ? keepManagedSource && previous?.currentModelRef
        ? previous.currentModelRef
        : knownModel?.id ?? modelControlId(sourceId, model.modelId)
      : undefined;
  return {
    toolId: agent.id,
    name: agent.name,
    installed: agent.installed,
    ...(agent.version ? { version: agent.version } : {}),
    ...(modelRef ? { currentModelRef: modelRef } : {}),
    ...(model?.modelId ? { currentModelId: model.modelId } : {}),
    ...(sourceId ? { sourceId } : {}),
    ...(model?.providerLabel
      ? {
          sourceLabel: keepManagedSource
            ? catalogSource!.label
            : catalogSource
              ? catalogSource.label
            : model.providerLabel,
        }
      : {}),
    ...(model?.sourceKind
      ? {
          sourceKind: keepManagedSource
            ? catalogSource!.kind
            : catalogSource
              ? catalogSource.kind
            : model.sourceKind,
        }
      : {}),
    ...(model?.protocol
      ? {
          protocol: keepManagedSource
            ? catalogSource!.protocol
            : catalogSource
              ? catalogSource.protocol
            : model.protocol,
        }
      : {}),
    ...(model?.endpointHost ? { endpointHost: model.endpointHost } : {}),
    health: pending
      ? "pending"
      : !agent.installed
        ? "unknown"
        : model?.health ?? "unconfigured",
    ...(keepManagedSource && previous?.lastConfiguredAt
      ? { lastConfiguredAt: previous.lastConfiguredAt }
      : {}),
  };
}

function mergeDiscoveredCatalog(
  state: DashboardStatusSnapshot["status"]["deviceControl"],
  report: DeviceReport,
  inventory: LocalInventorySnapshot,
): void {
  const now = report.reportedAt;
  for (const agent of inventory.agents) {
    if (!agent.installed || !agent.model) continue;
    const reportedTool = report.tools.find(
      (entry) => entry.toolId === agent.id,
    );
    const sourceId =
      reportedTool?.sourceId && state.sources[reportedTool.sourceId]
        ? reportedTool.sourceId
        : normalizeControlId(agent.model.providerId);
    const existingSource = state.sources[sourceId];
    const supportedTools = uniqueTools([
      ...(existingSource?.supportedTools ?? []),
      agent.id,
    ]);
    state.sources[sourceId] = {
      id: sourceId,
      label: agent.model.providerLabel,
      kind: agent.model.sourceKind,
      protocol: agent.model.protocol,
      ...(agent.model.endpoint ? { endpoint: agent.model.endpoint } : {}),
      supportedTools,
      ...(agent.model.sourceKind === "official-account" ||
      agent.model.sourceKind === "local-service"
        ? {}
        : { credentialRef: `model-source:${sourceId}` }),
      credentialStatus:
        existingSource?.credentialStatus === "available"
          ? "available"
          : agent.model.credentialStatus,
      ...(existingSource?.lastVerifiedAt
        ? { lastVerifiedAt: existingSource.lastVerifiedAt }
        : {}),
      createdAt: existingSource?.createdAt ?? now,
      updatedAt: now,
    };
    if (!agent.model.modelId) continue;
    const reportedModel = reportedTool?.currentModelRef
      ? state.models[reportedTool.currentModelRef]
      : undefined;
    const matchingModel = Object.values(state.models).find(
      (model) =>
        model.sourceId === sourceId &&
        model.modelId === agent.model!.modelId,
    );
    const id =
      reportedModel?.sourceId === sourceId &&
      reportedModel.modelId === agent.model.modelId
        ? reportedModel.id
        : matchingModel
          ? matchingModel.id
        : modelControlId(sourceId, agent.model.modelId);
    const existingModel = state.models[id];
    state.models[id] = {
      id,
      sourceId,
      name: displayModelName(agent.model.modelId),
      modelId: agent.model.modelId,
      supportedTools: uniqueTools([
        ...(existingModel?.supportedTools ?? []),
        agent.id,
      ]),
      createdAt: existingModel?.createdAt ?? now,
      updatedAt: now,
    };
  }
}

function modelCredentialStatusChanged(
  sources: Record<string, ModelSource>,
  userId: string,
  permissionVault: Pick<PermissionVault, "hasModelCredential">,
): boolean {
  return Object.values(sources).some((source) =>
    source.credentialRef
      ? source.credentialStatus !==
        (permissionVault.hasModelCredential(userId, source.id)
          ? "available"
          : "missing")
      : false,
  );
}

function reconcileModelCredentialStatus(
  sources: Record<string, ModelSource>,
  userId: string,
  permissionVault: Pick<PermissionVault, "hasModelCredential">,
): void {
  for (const source of Object.values(sources)) {
    if (!source.credentialRef) continue;
    source.credentialStatus = permissionVault.hasModelCredential(
      userId,
      source.id,
    )
      ? "available"
      : "missing";
  }
}

function effectiveEndpoint(source: ModelSource): string | undefined {
  if (source.endpoint) return source.endpoint.replace(/\/$/, "");
  if (source.kind !== "official-api") return undefined;
  if (source.protocol === "anthropic") return "https://api.anthropic.com";
  if (source.protocol === "openai") return "https://api.openai.com/v1";
  return undefined;
}

function uniqueTargets(targets: ConfigurationTarget[]): ConfigurationTarget[] {
  const entries = new Map<string, ConfigurationTarget>();
  for (const target of targets) {
    entries.set(`${target.deviceId}\u0000${target.toolId}`, target);
  }
  return [...entries.values()].sort((left, right) =>
    `${left.deviceId}:${left.toolId}`.localeCompare(`${right.deviceId}:${right.toolId}`),
  );
}

function targetKey(target: ConfigurationTarget): string {
  return `${target.deviceId}\u0000${target.toolId}`;
}

function uniqueTools(tools: AgentToolId[]): AgentToolId[] {
  return [...new Set(tools)];
}

function sameReport(left: DeviceReport, right: DeviceReport): boolean {
  return JSON.stringify({ ...left, reportedAt: "" }) ===
    JSON.stringify({ ...right, reportedAt: "" });
}

function configurationDigest(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function configurationApprovalState(
  snapshot: DashboardStatusSnapshot,
  model: ModelDefinition,
  source: ModelSource,
  targets: ConfigurationTarget[],
): unknown {
  const devices = new Map(
    snapshot.account.devices.map((device) => [device.id, device]),
  );
  return {
    model: {
      id: model.id,
      sourceId: model.sourceId,
      name: model.name,
      modelId: model.modelId,
      supportedTools: model.supportedTools,
    },
    source: {
      id: source.id,
      label: source.label,
      kind: source.kind,
      protocol: source.protocol,
      endpoint: source.endpoint ?? null,
      supportedTools: source.supportedTools,
      credentialRef: source.credentialRef ?? null,
      credentialStatus: source.credentialStatus,
    },
    targets: targets.map((target) => {
      const device = devices.get(target.deviceId);
      const report = snapshot.status.deviceControl.reports[target.deviceId];
      const tool = report?.tools.find(
        (entry) => entry.toolId === target.toolId,
      );
      return {
        deviceId: target.deviceId,
        deviceName: device?.name ?? null,
        online: device?.online ?? null,
        toolId: target.toolId,
        installed: tool?.installed ?? null,
        currentModelRef: tool?.currentModelRef ?? null,
        currentModelId: tool?.currentModelId ?? null,
        sourceId: tool?.sourceId ?? null,
      };
    }),
  };
}

function normalizeControlId(value: string): string {
  const normalized = value
    .trim()
    .replace(/[^A-Za-z0-9._:-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 160);
  return normalized || `source-${createHash("sha256").update(value).digest("hex").slice(0, 12)}`;
}

function modelControlId(sourceId: string, modelId: string): string {
  return `${sourceId}:model:${createHash("sha256").update(modelId).digest("hex").slice(0, 16)}`;
}

function displayModelName(value: string): string {
  if (value === "default") return "Provider default";
  return value;
}

function operatingSystem(): DeviceReport["operatingSystem"] {
  const value = platform();
  if (value === "darwin") return "macos";
  if (value === "win32") return "windows";
  if (value === "linux") return "linux";
  return "other";
}

function safeError(error: unknown, credential?: string): string {
  const message = error instanceof Error ? error.message : "Configuration failed.";
  const withoutCredential = credential
    ? message.split(credential).join("[redacted]")
    : message;
  return withoutCredential
    .replace(/(?:sk|key|token)-[A-Za-z0-9._-]+/gi, "[redacted]")
    .slice(0, 2_000);
}
