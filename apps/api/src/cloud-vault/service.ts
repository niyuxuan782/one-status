import {
  createHash,
  createHmac,
  randomBytes,
  randomUUID,
  timingSafeEqual,
} from "node:crypto";
import {
  decryptCloudVaultSecrets,
  encryptCloudVaultSecrets,
} from "./crypto.js";
import type { CloudVaultKmsProvider } from "./kms.js";
import type { CloudVaultRepository } from "./repository.js";
import {
  cloudVaultCredentialKinds,
  isCredentialPublicFieldName,
  type CloudVaultAgentGrant,
  type CloudVaultAgentApproval,
  type CloudVaultAgentSession,
  type CloudVaultAuditAction,
  type CloudVaultAuditEvent,
  type CloudVaultCredentialAccessPolicy,
  type CloudVaultCredentialInput,
  type CloudVaultCredentialKind,
  type CloudVaultCredentialPatch,
  type CloudVaultCredentialPlaintext,
  type CloudVaultCredentialQuery,
  type CloudVaultCredentialRecord,
  type CloudVaultCredentialSource,
  type CloudVaultApprovalOperation,
  type CloudVaultApprovalSummary,
  type IssuedCloudVaultAgentSession,
  type IssuedCloudVaultAgentApproval,
  type MaskedCloudVaultCredential,
  type CloudVaultWalletPakeRecord,
} from "./types.js";

const AGENT_SESSION_PREFIX = "osva1_";
const AGENT_APPROVAL_PREFIX = "osvp1_";
const AGENT_APPROVAL_TTL_MS = 10 * 60_000;
const DEFAULT_AGENT_SESSION_TTL_MS = 15 * 60 * 1_000;
const MAX_AGENT_SESSION_TTL_MS = 60 * 60 * 1_000;
const DEFAULT_ACCESS_POLICY: CloudVaultCredentialAccessPolicy = {
  allowAgentRead: true,
  allowedAgentIds: [],
  allowedProjectIds: [],
  deniedAgentIds: [],
  deniedProjectIds: [],
  requireApproval: false,
};

export class CloudVaultConflictError extends Error {
  constructor() {
    super("Cloud Vault credential changed concurrently.");
  }
}

export class CloudVaultMigrationConflictError extends Error {
  constructor() {
    super("Cloud Vault contains credential changes that cannot be overwritten by migration.");
  }
}

export class CloudVaultApprovalRequiredError extends Error {
  constructor() {
    super("Cloud Vault operation requires a current user approval.");
  }
}

export class CloudVaultAccessDeniedError extends Error {
  constructor() {
    super("Cloud Vault credential is unavailable for this request.");
  }
}

export interface CloudVaultActor {
  id: string;
  projectId?: string;
  sessionId?: string;
  type: "user" | "agent" | "migration" | "system";
}

export interface ResolveCloudVaultCredentialInput {
  kinds?: CloudVaultCredentialKind[];
  limit?: number;
  matchFields?: Record<string, string>;
  projectId?: string;
  purpose: string;
  search?: string;
  tags?: string[];
}

export interface CloudVaultCredentialResolution {
  credentials: MaskedCloudVaultCredential[];
  selected: MaskedCloudVaultCredential | null;
}

export class CloudVaultService {
  readonly #kms: CloudVaultKmsProvider;
  readonly #now: () => Date;
  readonly #repository: CloudVaultRepository;

  constructor(options: {
    kms: CloudVaultKmsProvider;
    now?: () => Date;
    repository: CloudVaultRepository;
  }) {
    this.#kms = options.kms;
    this.#now = options.now ?? (() => new Date());
    this.#repository = options.repository;
  }

  async createCredential(
    inputValue: CloudVaultCredentialInput,
    actor: CloudVaultActor,
  ): Promise<MaskedCloudVaultCredential> {
    const input = normalizeCredentialInput(inputValue);
    const id = input.id ?? randomUUID();
    const now = this.#now().toISOString();
    const revision = 1;
    const envelope = await encryptCloudVaultSecrets({
      credentialId: id,
      kms: this.#kms,
      revision,
      secrets: input.secrets,
      userId: input.userId,
    });
    const record: CloudVaultCredentialRecord = {
      accessPolicy: input.accessPolicy,
      createdAt: now,
      deletedAt: null,
      envelope,
      expiresAt: input.expiresAt,
      fields: input.fields,
      id,
      kind: input.kind,
      label: input.label,
      purposes: input.purposes,
      revision,
      secretKeys: Object.keys(input.secrets).sort(),
      source: input.source,
      tags: input.tags,
      updatedAt: now,
      userId: input.userId,
    };
    await this.#repository.transaction(async (repository) => {
      await repository.createCredential(record);
      await this.#audit({
        action: "credential.create",
        actor,
        credentialId: id,
        metadata: { kind: record.kind, revision },
        reason: "created",
        userId: input.userId,
      }, repository);
    });
    return maskCredential(record);
  }

  async updateCredential(input: {
    actor: CloudVaultActor;
    credentialId: string;
    patch: CloudVaultCredentialPatch;
    userId: string;
  }): Promise<MaskedCloudVaultCredential> {
    const current = await this.#requiredCredential(
      input.userId,
      input.credentialId,
    );
    const previousSecrets = await this.#decrypt(current);
    const patch = normalizeCredentialPatch(input.patch);
    const secrets = normalizeMap(
      { ...previousSecrets, ...patch.secrets },
      "Secret",
      false,
      true,
    );
    const revision = current.revision + 1;
    const envelope = await encryptCloudVaultSecrets({
      credentialId: current.id,
      kms: this.#kms,
      revision,
      secrets,
      userId: current.userId,
    });
    const updated: CloudVaultCredentialRecord = {
      ...current,
      accessPolicy: patch.accessPolicy
        ? normalizeAccessPolicy({
            ...current.accessPolicy,
            ...patch.accessPolicy,
          })
        : current.accessPolicy,
      envelope,
      expiresAt:
        patch.expiresAt === undefined ? current.expiresAt : patch.expiresAt,
      fields: patch.fields
        ? normalizeMap(
            { ...current.fields, ...patch.fields },
            "Field",
            true,
            false,
          )
        : current.fields,
      kind: patch.kind ?? current.kind,
      label: patch.label ?? current.label,
      purposes: patch.purposes ?? current.purposes,
      revision,
      secretKeys: Object.keys(secrets).sort(),
      source: patch.source
        ? normalizeSource({ ...current.source, ...patch.source })
        : current.source,
      tags: patch.tags ?? current.tags,
      updatedAt: this.#now().toISOString(),
    };
    await this.#repository.transaction(async (repository) => {
      if (!(await repository.updateCredential(updated, current.revision))) {
        throw new CloudVaultConflictError();
      }
      await this.#audit({
        action: "credential.update",
        actor: input.actor,
        credentialId: current.id,
        metadata: { kind: updated.kind, revision },
        reason: "updated",
        userId: current.userId,
      }, repository);
    });
    return maskCredential(updated);
  }

  async deleteCredential(input: {
    actor: CloudVaultActor;
    credentialId: string;
    userId: string;
  }): Promise<boolean> {
    const current = await this.#repository.getCredential(
      input.userId,
      input.credentialId,
    );
    if (!current) return false;
    await this.#repository.transaction(async (repository) => {
      const deleted = await repository.deleteCredential(
        input.userId,
        input.credentialId,
        current.revision,
        this.#now().toISOString(),
      );
      if (!deleted) throw new CloudVaultConflictError();
      await this.#audit({
        action: "credential.delete",
        actor: input.actor,
        credentialId: current.id,
        metadata: { kind: current.kind, revision: current.revision + 1 },
        reason: "deleted_and_dek_destroyed",
        userId: current.userId,
      }, repository);
    });
    return true;
  }

  async listCredentials(
    query: CloudVaultCredentialQuery,
    actor: CloudVaultActor,
  ): Promise<MaskedCloudVaultCredential[]> {
    const records = await this.#repository.listCredentials(query);
    await this.#audit({
      action: "credential.list",
      actor,
      metadata: { resultCount: records.length },
      reason: "metadata_only",
      userId: query.userId,
    });
    return records.map(maskCredential);
  }

  async listForAgent(
    token: string,
    input: Omit<CloudVaultCredentialQuery, "userId"> & {
      projectId?: string;
    },
  ): Promise<MaskedCloudVaultCredential[]> {
    const session = await this.#requiredAgentSession(token);
    const projectId = trustedSessionProject(session, input.projectId);
    const now = this.#now().toISOString();
    const [records, grants] = await Promise.all([
      this.#repository.listCredentials({ ...input, userId: session.userId }),
      this.#repository.listAgentGrants(session.userId, session.agentId, now),
    ]);
    const credentials = records
      .filter((credential) =>
        agentPolicyAllows(
          credential,
          session.agentId,
          projectId,
          false,
          now,
        ),
      )
      .filter((credential) =>
        grantAllowsCredential(
          grants,
          credential.id,
          input.purposes ?? [],
          projectId,
        ),
      )
      .map(maskCredential);
    await this.#audit({
      action: "credential.list",
      actor: agentActor(session, projectId),
      metadata: { resultCount: credentials.length },
      projectId,
      reason: "grant_and_policy_match",
      userId: session.userId,
    });
    return credentials;
  }

  async revealForUserAuthorized(input: {
    credentialId: string;
    userId: string;
  }): Promise<CloudVaultCredentialPlaintext> {
    const userId = metadata(input.userId, "User ID");
    const credentialId = metadata(input.credentialId, "Credential ID");
    const credential = await this.#repository.getCredential(userId, credentialId);
    await this.#audit({
      action: "credential.reveal",
      actor: { id: userId, type: "user" },
      credentialId,
      decision: credential ? "allow" : "deny",
      purpose: "user.reveal",
      reason: credential ? "wallet_pake_valid" : "credential_missing",
      userId,
    });
    if (!credential) throw new CloudVaultAccessDeniedError();
    return plaintextCredential(credential, await this.#decrypt(credential));
  }

  getWalletPakeRecord(
    userId: string,
  ): Promise<CloudVaultWalletPakeRecord | null> {
    return this.#repository.getWalletPake(metadata(userId, "User ID"));
  }

  async upsertWalletPakeRecord(
    record: CloudVaultWalletPakeRecord,
  ): Promise<void> {
    const userId = metadata(record.userId, "User ID");
    await this.#repository.transaction(async (repository) => {
      await repository.upsertWalletPake({ ...record, userId });
      await this.#audit(
        {
          action: "wallet.password.change",
          actor: { id: userId, type: "user" },
          reason: "wallet_pake_record_updated",
          userId,
        },
        repository,
      );
    });
  }

  async createAgentGrant(input: {
    actor: CloudVaultActor;
    agentId: string;
    credentialId?: string | null;
    expiresAt?: string | null;
    projectIds?: string[];
    purposes: string[];
    userId: string;
  }): Promise<CloudVaultAgentGrant> {
    if (input.credentialId) {
      await this.#requiredCredential(input.userId, input.credentialId);
    }
    const now = this.#now().toISOString();
    const grant: CloudVaultAgentGrant = {
      agentId: metadata(input.agentId, "Agent ID"),
      createdAt: now,
      credentialId: input.credentialId ?? null,
      expiresAt: optionalTimestamp(input.expiresAt),
      id: randomUUID(),
      projectIds: stringList(input.projectIds ?? [], "Project ID", true),
      purposes: stringList(input.purposes, "Purpose"),
      revokedAt: null,
      updatedAt: now,
      userId: metadata(input.userId, "User ID"),
    };
    await this.#repository.transaction(async (repository) => {
      await repository.createAgentGrant(grant);
      await this.#audit({
        action: "grant.create",
        actor: input.actor,
        credentialId: grant.credentialId,
        metadata: { agentId: grant.agentId, grantId: grant.id },
        reason: "grant_created",
        userId: grant.userId,
      }, repository);
    });
    return grant;
  }

  async requestAgentApproval(
    token: string,
    input: {
      operation: CloudVaultApprovalOperation;
      request: Record<string, unknown>;
    },
  ): Promise<IssuedCloudVaultAgentApproval> {
    const session = await this.#requiredAgentSession(token);
    const request = normalizeApprovalRequest(input.request);
    const projectId = trustedSessionProject(
      session,
      optionalApprovalMetadata(request.projectId, "Project ID"),
    );
    const credentialId = optionalApprovalMetadata(
      request.credentialId,
      "Credential ID",
    );
    const purpose = approvalPurpose(input.operation, request);
    if (input.operation === "credential.create") {
      if (credentialId) throw new CloudVaultAccessDeniedError();
    } else {
      if (!credentialId) throw new CloudVaultAccessDeniedError();
      const credential = await this.#repository.getCredential(
        session.userId,
        credentialId,
      );
      const grants = await this.#repository.listAgentGrants(
        session.userId,
        session.agentId,
        this.#now().toISOString(),
      );
      if (
        !credential ||
        !grantAllows(grants, credential.id, purpose, projectId) ||
        !agentPolicyAllows(
          credential,
          session.agentId,
          projectId,
          true,
          this.#now().toISOString(),
        )
      ) {
        throw new CloudVaultAccessDeniedError();
      }
    }

    const now = this.#now();
    const approvalToken = `${AGENT_APPROVAL_PREFIX}${randomBytes(32).toString("base64url")}`;
    const approval: CloudVaultAgentApproval = {
      agentId: session.agentId,
      clientId: session.clientId,
      consumedAt: null,
      createdAt: now.toISOString(),
      decidedAt: null,
      expiresAt: new Date(now.getTime() + AGENT_APPROVAL_TTL_MS).toISOString(),
      id: randomUUID(),
      operation: input.operation,
      requestDigest: approvalRequestDigest(
        approvalToken,
        input.operation,
        request,
      ),
      sessionId: session.id,
      status: "pending",
      summary: approvalSummary(
        input.operation,
        request,
        credentialId,
        projectId,
        purpose,
      ),
      tokenHash: hashApprovalToken(approvalToken),
      userId: session.userId,
    };
    await this.#repository.transaction(async (repository) => {
      await repository.createAgentApproval(approval);
      await this.#audit({
        action: "approval.request",
        actor: agentActor(session, projectId),
        credentialId,
        metadata: { approvalId: approval.id, operation: approval.operation },
        projectId,
        purpose,
        reason: "approval_requested",
        userId: session.userId,
      }, repository);
    });
    return {
      approval: publicApproval(approval),
      approvalToken,
    };
  }

  async listAgentApprovals(userIdValue: string, limit = 100) {
    const userId = metadata(userIdValue, "User ID");
    const approvals = await this.#repository.listAgentApprovals(userId, limit);
    return approvals.map(publicApproval);
  }

  async decideAgentApproval(input: {
    approvalId: string;
    decision: "approve" | "deny";
    userId: string;
  }): Promise<boolean> {
    const userId = metadata(input.userId, "User ID");
    const approvalId = metadata(input.approvalId, "Approval ID");
    return this.#repository.transaction(async (repository) => {
      const decided = await repository.decideAgentApproval(
        userId,
        approvalId,
        input.decision === "approve" ? "approved" : "denied",
        this.#now().toISOString(),
      );
      await this.#audit({
        action: "approval.decision",
        actor: { id: userId, type: "user" },
        decision: decided ? "allow" : "deny",
        metadata: { approvalId, approved: input.decision === "approve" },
        reason: decided ? "approval_decided" : "approval_unavailable",
        userId,
      }, repository);
      return decided;
    });
  }

  async consumeAgentApproval(
    token: string,
    input: {
      approvalToken: string;
      operation: CloudVaultApprovalOperation;
      request: Record<string, unknown>;
    },
  ): Promise<void> {
    const session = await this.#requiredAgentSession(token);
    if (!input.approvalToken.startsWith(AGENT_APPROVAL_PREFIX)) {
      throw new CloudVaultApprovalRequiredError();
    }
    const now = this.#now().toISOString();
    const approval = await this.#repository.findAgentApprovalByTokenHash(
      hashApprovalToken(input.approvalToken),
      now,
    );
    const request = normalizeApprovalRequest(input.request);
    const expectedDigest = approvalRequestDigest(
      input.approvalToken,
      input.operation,
      request,
    );
    const matches =
      approval?.status === "approved" &&
      approval.userId === session.userId &&
      approval.agentId === session.agentId &&
      approval.sessionId === session.id &&
      approval.operation === input.operation &&
      constantTimeTextEqual(approval.requestDigest, expectedDigest);
    if (!approval || !matches) throw new CloudVaultApprovalRequiredError();
    await this.#repository.transaction(async (repository) => {
      if (
        !(await repository.consumeAgentApproval(
          session.userId,
          approval.id,
          now,
        ))
      ) {
        throw new CloudVaultApprovalRequiredError();
      }
      await this.#audit({
        action: "approval.consume",
        actor: agentActor(
          session,
          optionalApprovalMetadata(request.projectId, "Project ID"),
        ),
        credentialId: approval.summary.credentialId,
        metadata: { approvalId: approval.id, operation: approval.operation },
        projectId: approval.summary.projectId ?? undefined,
        purpose: approval.summary.purpose ?? undefined,
        reason: "approval_consumed",
        userId: session.userId,
      }, repository);
    });
  }

  async revokeAgentGrant(input: {
    actor: CloudVaultActor;
    grantId: string;
    userId: string;
  }): Promise<boolean> {
    return this.#repository.transaction(async (repository) => {
      const revoked = await repository.revokeAgentGrant(
        input.userId,
        input.grantId,
        this.#now().toISOString(),
      );
      if (revoked) {
        await this.#audit({
          action: "grant.revoke",
          actor: input.actor,
          metadata: { grantId: input.grantId },
          reason: "grant_revoked",
          userId: input.userId,
        }, repository);
      }
      return revoked;
    });
  }

  async issueAgentSession(input: {
    agentId: string;
    clientId?: string;
    projectIds?: string[];
    ttlMs?: number;
    userId: string;
  }): Promise<IssuedCloudVaultAgentSession> {
    const now = this.#now();
    const ttlMs = input.ttlMs ?? DEFAULT_AGENT_SESSION_TTL_MS;
    if (
      !Number.isSafeInteger(ttlMs) ||
      ttlMs < 1_000 ||
      ttlMs > MAX_AGENT_SESSION_TTL_MS
    ) {
      throw new Error("Cloud Vault Agent session lifetime is invalid.");
    }
    const retentionCutoff = new Date(
      now.getTime() - 7 * 24 * 60 * 60_000,
    ).toISOString();
    await Promise.all([
      this.#repository.purgeExpiredAgentSessions(now.toISOString()),
      this.#repository.purgeExpiredAgentApprovals(retentionCutoff),
      this.#repository.purgeExpiredAgentGrants(retentionCutoff),
    ]);
    const token = `${AGENT_SESSION_PREFIX}${randomBytes(32).toString("base64url")}`;
    const session: CloudVaultAgentSession = {
      agentId: metadata(input.agentId, "Agent ID"),
      clientId: input.clientId
        ? metadata(input.clientId, "Client ID")
        : null,
      createdAt: now.toISOString(),
      expiresAt: new Date(now.getTime() + ttlMs).toISOString(),
      id: randomUUID(),
      lastUsedAt: null,
      projectIds: stringList(input.projectIds ?? [], "Project ID", true),
      revokedAt: null,
      tokenHash: hashAgentToken(token),
      userId: metadata(input.userId, "User ID"),
    };
    await this.#repository.transaction(async (repository) => {
      await repository.createAgentSession(session);
      await this.#audit({
        action: "session.issue",
        actor: { id: session.agentId, type: "system" },
        metadata: { agentId: session.agentId, sessionId: session.id },
        reason: "short_lived_session_issued",
        userId: session.userId,
      }, repository);
    });
    const { tokenHash: _tokenHash, ...visible } = session;
    return { ...visible, token };
  }

  async authenticateAgentSession(
    token: string,
  ): Promise<Omit<CloudVaultAgentSession, "tokenHash"> | null> {
    if (!token.startsWith(AGENT_SESSION_PREFIX)) return null;
    const now = this.#now().toISOString();
    const session = await this.#repository.findAgentSessionByTokenHash(
      hashAgentToken(token),
      now,
    );
    if (!session) return null;
    await this.#repository.touchAgentSession(session.id, now);
    const { tokenHash: _tokenHash, ...visible } = session;
    return { ...visible, lastUsedAt: now };
  }

  async revokeAgentSession(input: {
    sessionId: string;
    userId: string;
  }): Promise<boolean> {
    return this.#repository.transaction(async (repository) => {
      const revoked = await repository.revokeAgentSession(
        input.userId,
        input.sessionId,
        this.#now().toISOString(),
      );
      if (revoked) {
        await this.#audit({
          action: "session.revoke",
          actor: { id: "session-manager", type: "system" },
          metadata: { sessionId: input.sessionId },
          reason: "session_revoked",
          userId: input.userId,
        }, repository);
      }
      return revoked;
    });
  }

  async resolveForAgent(
    token: string,
    inputValue: ResolveCloudVaultCredentialInput,
  ): Promise<CloudVaultCredentialResolution> {
    const session = await this.#requiredAgentSession(token);
    const input = normalizeResolutionInput(inputValue);
    const projectId = trustedSessionProject(session, input.projectId);
    const candidates = await this.#repository.listCredentials({
      kinds: input.kinds,
      limit: 500,
      purposes: [input.purpose],
      search: input.search,
      tags: input.tags,
      userId: session.userId,
    });
    const grants = await this.#repository.listAgentGrants(
      session.userId,
      session.agentId,
      this.#now().toISOString(),
    );
    const scored = candidates
      .filter((credential) =>
        agentPolicyAllows(
          credential,
          session.agentId,
          projectId,
          false,
          this.#now().toISOString(),
        ),
      )
      .filter((credential) =>
        grantAllows(grants, credential.id, input.purpose, projectId),
      )
      .map((credential) => ({
        credential,
        score: fieldMatchScore(credential.fields, input.matchFields),
      }))
      .filter(({ score }) => score >= 0)
      .sort(
        (left, right) =>
          right.score - left.score ||
          right.credential.updatedAt.localeCompare(left.credential.updatedAt) ||
          left.credential.id.localeCompare(right.credential.id),
      )
      .slice(0, input.limit);
    const credentials = scored.map(({ credential }) => maskCredential(credential));
    const selected =
      scored.length === 1 ||
      (scored.length > 1 && scored[0]!.score > scored[1]!.score)
        ? maskCredential(scored[0]!.credential)
        : null;
    await this.#audit({
      action: "credential.resolve",
      actor: agentActor(session, projectId),
      metadata: {
        resultCount: credentials.length,
        selected: selected !== null,
      },
      projectId,
      purpose: input.purpose,
      reason: "grant_and_metadata_match",
      userId: session.userId,
    });
    return { credentials, selected };
  }

  async getForAgent(
    token: string,
    input: {
      approved?: boolean;
      approvalToken?: string;
      credentialId: string;
      matchCredentialPurpose?: boolean;
      projectId?: string;
      purpose: string;
    },
  ): Promise<CloudVaultCredentialPlaintext> {
    const session = await this.#requiredAgentSession(token);
    const projectId = trustedSessionProject(session, input.projectId);
    const credential = await this.#repository.getCredential(
      session.userId,
      input.credentialId,
    );
    const purpose = metadata(input.purpose, "Purpose");
    const grants = await this.#repository.listAgentGrants(
      session.userId,
      session.agentId,
      this.#now().toISOString(),
    );
    const policyAllowed =
      credential &&
      (input.matchCredentialPurpose === false ||
        credential.purposes.some((stored) => purposeMatches(stored, purpose))) &&
      grantAllows(grants, credential.id, purpose, projectId) &&
      agentPolicyAllows(
        credential,
        session.agentId,
        projectId,
        true,
        this.#now().toISOString(),
      );
    if (
      policyAllowed &&
      credential.accessPolicy.requireApproval &&
      input.approved !== true
    ) {
      if (!input.approvalToken) throw new CloudVaultApprovalRequiredError();
      await this.consumeAgentApproval(token, {
        approvalToken: input.approvalToken,
        operation: "credential.get",
        request: {
          credentialId: input.credentialId,
          ...(projectId ? { projectId } : {}),
          purpose,
        },
      });
    }
    const allowed = Boolean(policyAllowed);
    await this.#audit({
      action: "credential.get",
      actor: agentActor(session, projectId),
      credentialId: credential?.id ?? input.credentialId,
      decision: allowed ? "allow" : "deny",
      projectId,
      purpose,
      reason: allowed ? "grant_allowed" : "grant_missing",
      userId: session.userId,
    });
    if (!credential || !allowed) throw new CloudVaultAccessDeniedError();
    return plaintextCredential(credential, await this.#decrypt(credential));
  }

  async exportPlaintextForMigration(
    userId: string,
    credentialIds?: Iterable<string>,
  ): Promise<CloudVaultCredentialPlaintext[]> {
    if (credentialIds) {
      const records = await Promise.all(
        [...new Set(credentialIds)].map((credentialId) =>
          this.#repository.getCredential(userId, credentialId),
        ),
      );
      return Promise.all(
        records
          .filter((record): record is CloudVaultCredentialRecord => Boolean(record))
          .map(async (record) =>
            plaintextCredential(record, await this.#decrypt(record)),
          ),
      );
    }
    const records: CloudVaultCredentialRecord[] = [];
    for (let offset = 0; ; offset += 500) {
      const page = await this.#repository.listCredentials({
        limit: 500,
        offset,
        userId,
      });
      records.push(...page);
      if (page.length < 500) break;
    }
    return Promise.all(
      records.map(async (record) =>
        plaintextCredential(record, await this.#decrypt(record)),
      ),
    );
  }

  async upsertMigratedCredential(
    input: CloudVaultCredentialPlaintext,
  ): Promise<MaskedCloudVaultCredential> {
    const existing = await this.#repository.getCredential(input.userId, input.id);
    const actor: CloudVaultActor = { id: "permission-vault", type: "migration" };
    if (!existing) {
      return this.createCredential(
        {
          fields: input.fields,
          accessPolicy: input.accessPolicy,
          expiresAt: input.expiresAt,
          id: input.id,
          kind: input.kind,
          label: input.label,
          purposes: input.purposes,
          secrets: input.secrets,
          source: input.source,
          tags: input.tags,
          userId: input.userId,
        },
        actor,
      );
    }
    const normalized = normalizeCredentialInput({
      fields: input.fields,
      accessPolicy: input.accessPolicy,
      expiresAt: input.expiresAt,
      id: input.id,
      kind: input.kind,
      label: input.label,
      purposes: input.purposes,
      secrets: input.secrets,
      source: input.source,
      tags: input.tags,
      userId: input.userId,
    });
    const revision = existing.revision + 1;
    const envelope = await encryptCloudVaultSecrets({
      credentialId: existing.id,
      kms: this.#kms,
      revision,
      secrets: normalized.secrets,
      userId: existing.userId,
    });
    const replaced: CloudVaultCredentialRecord = {
      ...existing,
      accessPolicy: normalized.accessPolicy,
      envelope,
      expiresAt: normalized.expiresAt,
      fields: normalized.fields,
      kind: normalized.kind,
      label: normalized.label,
      purposes: normalized.purposes,
      revision,
      secretKeys: Object.keys(normalized.secrets).sort(),
      source: normalized.source,
      tags: normalized.tags,
      updatedAt: this.#now().toISOString(),
    };
    await this.#repository.transaction(async (repository) => {
      if (!(await repository.updateCredential(replaced, existing.revision))) {
        throw new CloudVaultConflictError();
      }
      await this.#audit({
        action: "migration.dual_write",
        actor,
        credentialId: replaced.id,
        metadata: { kind: replaced.kind, revision },
        reason: "migration_record_replaced",
        userId: replaced.userId,
      }, repository);
    });
    return maskCredential(replaced);
  }

  async importMigratedCredential(
    input: CloudVaultCredentialPlaintext,
  ): Promise<MaskedCloudVaultCredential> {
    const existing = await this.#repository.getCredential(input.userId, input.id);
    if (!existing) return this.upsertMigratedCredential(input);

    const normalized = normalizeCredentialInput({
      accessPolicy: input.accessPolicy,
      expiresAt: input.expiresAt,
      fields: input.fields,
      id: input.id,
      kind: input.kind,
      label: input.label,
      purposes: input.purposes,
      secrets: input.secrets,
      source: input.source,
      tags: input.tags,
      userId: input.userId,
    });
    const existingPlaintext = plaintextCredential(
      existing,
      await this.#decrypt(existing),
    );
    if (!credentialContentEqual(existingPlaintext, normalized)) {
      throw new CloudVaultMigrationConflictError();
    }
    return maskCredential(existing);
  }

  async deleteMigratedCredential(
    userId: string,
    credentialId: string,
  ): Promise<boolean> {
    return this.deleteCredential({
      actor: { id: "permission-vault", type: "migration" },
      credentialId,
      userId,
    });
  }

  listAuditEvents(userId: string, limit?: number) {
    return this.#repository.listAuditEvents(userId, limit);
  }

  async #requiredAgentSession(
    token: string,
  ): Promise<Omit<CloudVaultAgentSession, "tokenHash">> {
    const session = await this.authenticateAgentSession(token);
    if (!session) throw new CloudVaultAccessDeniedError();
    return session;
  }

  async #requiredCredential(
    userId: string,
    credentialId: string,
  ): Promise<CloudVaultCredentialRecord> {
    const record = await this.#repository.getCredential(userId, credentialId);
    if (!record) throw new Error("Cloud Vault credential was not found.");
    return record;
  }

  #decrypt(record: CloudVaultCredentialRecord) {
    return decryptCloudVaultSecrets({
      credentialId: record.id,
      envelope: record.envelope,
      kms: this.#kms,
      revision: record.revision,
      userId: record.userId,
    });
  }

  async #audit(input: {
    action: CloudVaultAuditAction;
    actor: CloudVaultActor;
    credentialId?: string | null;
    decision?: "allow" | "deny";
    metadata?: CloudVaultAuditEvent["metadata"];
    projectId?: string;
    purpose?: string;
    reason: string;
    userId: string;
  }, repository: CloudVaultRepository = this.#repository): Promise<void> {
    const event: CloudVaultAuditEvent = {
      action: input.action,
      actorId: metadata(input.actor.id, "Audit actor ID"),
      actorType: input.actor.type,
      createdAt: this.#now().toISOString(),
      credentialId: input.credentialId ?? null,
      decision: input.decision ?? "allow",
      id: randomUUID(),
      metadata: safeAuditMetadata(input.metadata ?? {}),
      projectId: input.projectId ?? input.actor.projectId ?? null,
      purpose: input.purpose ?? null,
      reason: metadata(input.reason, "Audit reason"),
      sessionId: input.actor.sessionId ?? null,
      userId: metadata(input.userId, "User ID"),
    };
    await repository.insertAuditEvent(event);
  }
}

function normalizeCredentialInput(input: CloudVaultCredentialInput) {
  if (!cloudVaultCredentialKinds.includes(input.kind)) {
    throw new Error("Cloud Vault credential kind is invalid.");
  }
  return {
    accessPolicy: normalizeAccessPolicy(input.accessPolicy),
    expiresAt: optionalTimestamp(input.expiresAt),
    fields: normalizeMap(input.fields ?? {}, "Field", true, false),
    ...(input.id ? { id: metadata(input.id, "Credential ID") } : {}),
    kind: input.kind,
    label: metadata(input.label, "Credential label"),
    purposes: stringList(input.purposes, "Purpose"),
    secrets: normalizeMap(input.secrets, "Secret", false, true),
    source: normalizeSource(input.source),
    tags: stringList(input.tags ?? [], "Tag", true),
    userId: metadata(input.userId, "User ID"),
  };
}

function normalizeCredentialPatch(patch: CloudVaultCredentialPatch) {
  if (patch.kind && !cloudVaultCredentialKinds.includes(patch.kind)) {
    throw new Error("Cloud Vault credential kind is invalid.");
  }
  return {
    ...(patch.accessPolicy ? { accessPolicy: patch.accessPolicy } : {}),
    ...(patch.expiresAt !== undefined
      ? { expiresAt: optionalTimestamp(patch.expiresAt) }
      : {}),
    ...(patch.fields
      ? { fields: normalizeMap(patch.fields, "Field", true, false) }
      : {}),
    ...(patch.kind ? { kind: patch.kind } : {}),
    ...(patch.label ? { label: metadata(patch.label, "Credential label") } : {}),
    ...(patch.purposes
      ? { purposes: stringList(patch.purposes, "Purpose") }
      : {}),
    ...(patch.secrets
      ? { secrets: normalizeMap(patch.secrets, "Secret", false, false) }
      : {}),
    ...(patch.source ? { source: patch.source } : {}),
    ...(patch.tags ? { tags: stringList(patch.tags, "Tag", true) } : {}),
  };
}

function normalizeAccessPolicy(
  input: Partial<CloudVaultCredentialAccessPolicy> | undefined,
): CloudVaultCredentialAccessPolicy {
  const policy: CloudVaultCredentialAccessPolicy = {
    allowAgentRead: input?.allowAgentRead ?? DEFAULT_ACCESS_POLICY.allowAgentRead,
    allowedAgentIds: stringList(
      input?.allowedAgentIds ?? DEFAULT_ACCESS_POLICY.allowedAgentIds,
      "Allowed Agent ID",
      true,
    ),
    allowedProjectIds: stringList(
      input?.allowedProjectIds ?? DEFAULT_ACCESS_POLICY.allowedProjectIds,
      "Allowed project ID",
      true,
    ),
    deniedAgentIds: stringList(
      input?.deniedAgentIds ?? DEFAULT_ACCESS_POLICY.deniedAgentIds,
      "Denied Agent ID",
      true,
    ),
    deniedProjectIds: stringList(
      input?.deniedProjectIds ?? DEFAULT_ACCESS_POLICY.deniedProjectIds,
      "Denied project ID",
      true,
    ),
    requireApproval: input?.requireApproval ?? DEFAULT_ACCESS_POLICY.requireApproval,
  };
  assertDisjoint(policy.allowedAgentIds, policy.deniedAgentIds);
  assertDisjoint(policy.allowedProjectIds, policy.deniedProjectIds);
  return policy;
}

function normalizeResolutionInput(input: ResolveCloudVaultCredentialInput) {
  const limit = input.limit ?? 20;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 50) {
    throw new Error("Credential resolution limit is invalid.");
  }
  return {
    kinds: input.kinds?.map((kind) => {
      if (!cloudVaultCredentialKinds.includes(kind)) {
        throw new Error("Cloud Vault credential kind is invalid.");
      }
      return kind;
    }),
    matchFields: input.matchFields
      ? normalizeMap(input.matchFields, "Match field", true, false)
      : {},
    limit,
    ...(input.projectId
      ? { projectId: metadata(input.projectId, "Project ID") }
      : {}),
    purpose: metadata(input.purpose, "Purpose"),
    ...(input.search ? { search: metadata(input.search, "Search") } : {}),
    tags: stringList(input.tags ?? [], "Tag", true),
  };
}

function normalizeSource(source: CloudVaultCredentialSource) {
  return {
    type: source.type,
    ...(source.agentId
      ? { agentId: metadata(source.agentId, "Source Agent ID") }
      : {}),
    ...(source.deviceId
      ? { deviceId: metadata(source.deviceId, "Source device ID") }
      : {}),
    ...(source.projectId
      ? { projectId: metadata(source.projectId, "Source project ID") }
      : {}),
  };
}

function normalizeMap(
  values: Record<string, string>,
  label: string,
  trimValues: boolean,
  requireOne: boolean,
): Record<string, string> {
  const entries = Object.entries(values);
  if ((requireOne && entries.length === 0) || entries.length > 128) {
    throw new Error(`${label} map size is invalid.`);
  }
  return Object.fromEntries(
    entries
      .map(([key, raw]) => {
        if (!/^[A-Za-z][A-Za-z0-9_.-]{0,127}$/.test(key)) {
          throw new Error(`${label} name is invalid.`);
        }
        const value = trimValues ? raw.trim() : raw;
        if (!value || value.length > 100_000) {
          throw new Error(`${label} value is invalid.`);
        }
        if (label === "Field" && !isCredentialPublicFieldName(key)) {
          throw new Error("Sensitive credential values must be stored in secrets.");
        }
        return [key, value] as const;
      })
      .sort(([left], [right]) => left.localeCompare(right)),
  );
}

function credentialContentEqual(
  left: CloudVaultCredentialPlaintext,
  right: ReturnType<typeof normalizeCredentialInput>,
): boolean {
  const leftDigest = credentialContentDigest(left);
  const rightDigest = credentialContentDigest(right);
  return timingSafeEqual(leftDigest, rightDigest);
}

function credentialContentDigest(
  credential:
    | CloudVaultCredentialPlaintext
    | ReturnType<typeof normalizeCredentialInput>,
): Buffer {
  const canonical = canonicalValue({
    accessPolicy: credential.accessPolicy,
    expiresAt: credential.expiresAt,
    fields: credential.fields,
    id: credential.id,
    kind: credential.kind,
    label: credential.label,
    purposes: [...credential.purposes].sort(),
    secrets: credential.secrets,
    source: credential.source,
    tags: [...credential.tags].sort(),
    userId: credential.userId,
  });
  return createHash("sha256")
    .update(JSON.stringify(canonical), "utf8")
    .digest();
}

function canonicalValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalValue);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, item]) => [key, canonicalValue(item)]),
    );
  }
  return value;
}

function stringList(
  values: string[],
  label: string,
  allowEmpty = false,
): string[] {
  const result = [...new Set(values.map((value) => metadata(value, label)))].sort();
  if ((!allowEmpty && result.length === 0) || result.length > 128) {
    throw new Error(`${label} list size is invalid.`);
  }
  return result;
}

function metadata(value: string, label: string): string {
  const normalized = value.trim();
  if (
    !normalized ||
    normalized.length > 1_000 ||
    /[\u0000-\u001f\u007f]/.test(normalized)
  ) {
    throw new Error(`${label} is invalid.`);
  }
  return normalized;
}

function optionalTimestamp(value?: string | null): string | null {
  if (!value) return null;
  const timestamp = new Date(value);
  if (Number.isNaN(timestamp.getTime())) {
    throw new Error("Timestamp is invalid.");
  }
  return timestamp.toISOString();
}

function maskCredential(
  record: CloudVaultCredentialRecord,
): MaskedCloudVaultCredential {
  const { envelope: _envelope, ...metadataOnly } = record;
  return {
    ...metadataOnly,
    secrets: Object.fromEntries(
      record.secretKeys.map((key) => [key, "********" as const]),
    ),
  };
}

function plaintextCredential(
  record: CloudVaultCredentialRecord,
  secrets: Record<string, string>,
): CloudVaultCredentialPlaintext {
  const {
    deletedAt: _deletedAt,
    envelope: _envelope,
    revision: _revision,
    secretKeys: _secretKeys,
    ...metadataOnly
  } = record;
  return { ...metadataOnly, secrets };
}

function grantAllows(
  grants: CloudVaultAgentGrant[],
  credentialId: string,
  purpose: string,
  projectId?: string,
): boolean {
  return grants.some(
    (grant) =>
      (grant.credentialId === null || grant.credentialId === credentialId) &&
      grant.purposes.some((stored) => purposeMatches(stored, purpose)) &&
      (grant.projectIds.length === 0 ||
        (projectId !== undefined && grant.projectIds.includes(projectId))),
  );
}

function grantAllowsCredential(
  grants: CloudVaultAgentGrant[],
  credentialId: string,
  purposes: string[],
  projectId?: string,
): boolean {
  return grants.some(
    (grant) =>
      (grant.credentialId === null || grant.credentialId === credentialId) &&
      (purposes.length === 0 ||
        purposes.some((purpose) =>
          grant.purposes.some((stored) => purposeMatches(stored, purpose)),
        )) &&
      (grant.projectIds.length === 0 ||
        (projectId !== undefined && grant.projectIds.includes(projectId))),
  );
}

function agentPolicyAllows(
  credential: CloudVaultCredentialRecord,
  agentId: string,
  projectId: string | undefined,
  approved: boolean,
  now: string,
): boolean {
  const policy = credential.accessPolicy;
  if (credential.expiresAt !== null && credential.expiresAt <= now) return false;
  if (!policy.allowAgentRead || policy.deniedAgentIds.includes(agentId)) {
    return false;
  }
  if (
    policy.allowedAgentIds.length > 0 &&
    !policy.allowedAgentIds.includes(agentId)
  ) {
    return false;
  }
  if (projectId && policy.deniedProjectIds.includes(projectId)) return false;
  if (
    policy.allowedProjectIds.length > 0 &&
    (!projectId || !policy.allowedProjectIds.includes(projectId))
  ) {
    return false;
  }
  return !policy.requireApproval || approved;
}

function purposeMatches(storedValue: string, requestedValue: string): boolean {
  const stored = storedValue.toLowerCase();
  const requested = requestedValue.toLowerCase();
  if (stored === "*" || stored === requested) return true;
  return [".", ":", "/"].some(
    (separator) =>
      requested.startsWith(`${stored}${separator}`),
  );
}

function assertDisjoint(left: string[], right: string[]): void {
  const overlap = left.find((value) => right.includes(value));
  if (overlap) {
    throw new Error("Cloud Vault access policy allow and deny lists overlap.");
  }
}

function fieldMatchScore(
  fields: Record<string, string>,
  expected: Record<string, string>,
): number {
  let score = 0;
  for (const [key, value] of Object.entries(expected)) {
    const actual = fields[key];
    if (actual === undefined || actual.toLowerCase() !== value.toLowerCase()) {
      return -1;
    }
    score += 10;
  }
  return score;
}

function hashAgentToken(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

function hashApprovalToken(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

function approvalRequestDigest(
  token: string,
  operation: CloudVaultApprovalOperation,
  request: Record<string, unknown>,
): string {
  return createHmac("sha256", token)
    .update(JSON.stringify(canonicalValue({ operation, request })), "utf8")
    .digest("hex");
}

function normalizeApprovalRequest(
  request: Record<string, unknown>,
): Record<string, unknown> {
  const normalized = structuredClone(request);
  delete normalized.approvalToken;
  if (Object.keys(normalized).length === 0) {
    throw new CloudVaultAccessDeniedError();
  }
  return canonicalValue(normalized) as Record<string, unknown>;
}

function optionalApprovalMetadata(
  value: unknown,
  label: string,
): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "string") throw new CloudVaultAccessDeniedError();
  return metadata(value, label);
}

function approvalPurpose(
  operation: CloudVaultApprovalOperation,
  request: Record<string, unknown>,
): string {
  if (operation === "credential.create") return "credential.create";
  if (operation === "credential.update") return "credential.update";
  if (operation === "credential.delete") return "credential.delete";
  return optionalApprovalMetadata(request.purpose, "Purpose") ?? "credential.get";
}

function approvalSummary(
  operation: CloudVaultApprovalOperation,
  request: Record<string, unknown>,
  credentialId: string | undefined,
  projectId: string | undefined,
  purpose: string,
): CloudVaultApprovalSummary {
  const patch = isRecord(request.patch) ? request.patch : undefined;
  const fields = isRecord(patch?.fields)
    ? patch.fields
    : isRecord(request.fields)
      ? request.fields
      : {};
  const secrets = isRecord(patch?.secrets)
    ? patch.secrets
    : isRecord(request.secrets)
      ? request.secrets
      : {};
  return {
    credentialId: credentialId ?? null,
    fieldKeys: Object.keys(fields).sort(),
    kind:
      typeof (patch?.kind ?? request.kind) === "string"
        ? String(patch?.kind ?? request.kind)
        : null,
    label:
      typeof (patch?.label ?? request.label) === "string"
        ? String(patch?.label ?? request.label)
        : null,
    projectId: projectId ?? null,
    purpose,
    secretKeys: Object.keys(secrets).sort(),
  };
}

function publicApproval(approval: CloudVaultAgentApproval) {
  const { requestDigest: _requestDigest, tokenHash: _tokenHash, ...visible } =
    approval;
  return visible;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function agentActor(
  session: Omit<CloudVaultAgentSession, "tokenHash">,
  projectId?: string,
): CloudVaultActor {
  return {
    id: session.agentId,
    ...(projectId ? { projectId } : {}),
    sessionId: session.id,
    type: "agent",
  };
}

function trustedSessionProject(
  session: Pick<CloudVaultAgentSession, "projectIds">,
  requested: string | undefined,
): string | undefined {
  if (!requested) return undefined;
  if (!session.projectIds.includes(requested)) {
    throw new CloudVaultAccessDeniedError();
  }
  return requested;
}

function safeAuditMetadata(
  input: CloudVaultAuditEvent["metadata"],
): CloudVaultAuditEvent["metadata"] {
  const forbidden =
    /(?:password|secret|token|private.?key|api.?key|ciphertext|wrapped.?dek|auth.?tag|authorization)/i;
  return Object.fromEntries(
    Object.entries(input).map(([key, value]) => {
      if (forbidden.test(key)) {
        throw new Error("Cloud Vault audit metadata contains a secret field.");
      }
      if (
        value !== null &&
        !["boolean", "number", "string"].includes(typeof value)
      ) {
        throw new Error("Cloud Vault audit metadata value is invalid.");
      }
      return [key, value];
    }),
  );
}

function constantTimeTextEqual(left: string, right: string): boolean {
  const leftDigest = createHash("sha256").update(left, "utf8").digest();
  const rightDigest = createHash("sha256").update(right, "utf8").digest();
  return timingSafeEqual(leftDigest, rightDigest);
}
