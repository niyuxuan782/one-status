import type { CloudVaultRepository } from "./repository.js";
import type {
  CloudVaultAgentGrant,
  CloudVaultAgentApproval,
  CloudVaultAgentSession,
  CloudVaultAuditEvent,
  CloudVaultCredentialQuery,
  CloudVaultCredentialRecord,
  CloudVaultMigrationRecord,
  CloudVaultMigrationState,
  CloudVaultWalletPakeRecord,
} from "./types.js";

export class MemoryCloudVaultRepository implements CloudVaultRepository {
  readonly #approvals = new Map<string, CloudVaultAgentApproval>();
  readonly #audits: CloudVaultAuditEvent[] = [];
  readonly #credentials = new Map<string, CloudVaultCredentialRecord>();
  readonly #grants = new Map<string, CloudVaultAgentGrant>();
  readonly #migrations = new Map<string, CloudVaultMigrationRecord>();
  readonly #sessions = new Map<string, CloudVaultAgentSession>();
  readonly #walletPake = new Map<string, CloudVaultWalletPakeRecord>();

  async transaction<T>(
    operation: (repository: CloudVaultRepository) => Promise<T>,
  ): Promise<T> {
    const snapshot = {
      approvals: cloneMap(this.#approvals),
      audits: clone(this.#audits),
      credentials: cloneMap(this.#credentials),
      grants: cloneMap(this.#grants),
      migrations: cloneMap(this.#migrations),
      sessions: cloneMap(this.#sessions),
      walletPake: cloneMap(this.#walletPake),
    };
    try {
      return await operation(this);
    } catch (error) {
      restoreMap(this.#approvals, snapshot.approvals);
      this.#audits.splice(0, this.#audits.length, ...snapshot.audits);
      restoreMap(this.#credentials, snapshot.credentials);
      restoreMap(this.#grants, snapshot.grants);
      restoreMap(this.#migrations, snapshot.migrations);
      restoreMap(this.#sessions, snapshot.sessions);
      restoreMap(this.#walletPake, snapshot.walletPake);
      throw error;
    }
  }

  async createCredential(record: CloudVaultCredentialRecord): Promise<void> {
    const key = tenantKey(record.userId, record.id);
    if (this.#credentials.has(key)) {
      throw new Error("Cloud Vault credential already exists.");
    }
    this.#credentials.set(key, clone(record));
  }

  async createAgentApproval(approval: CloudVaultAgentApproval): Promise<void> {
    const key = tenantKey(approval.userId, approval.id);
    if (
      this.#approvals.has(key) ||
      [...this.#approvals.values()].some(
        (item) => item.tokenHash === approval.tokenHash,
      )
    ) {
      throw new Error("Agent approval already exists.");
    }
    this.#approvals.set(key, clone(approval));
  }

  async findAgentApprovalByTokenHash(
    tokenHash: string,
    now: string,
  ): Promise<CloudVaultAgentApproval | null> {
    const approval = [...this.#approvals.values()].find(
      (item) =>
        item.tokenHash === tokenHash &&
        item.expiresAt > now &&
        (item.status === "pending" || item.status === "approved"),
    );
    return approval ? clone(approval) : null;
  }

  async listAgentApprovals(
    userId: string,
    limit = 100,
  ): Promise<CloudVaultAgentApproval[]> {
    return [...this.#approvals.values()]
      .filter((approval) => approval.userId === userId)
      .sort(
        (left, right) =>
          right.createdAt.localeCompare(left.createdAt) ||
          right.id.localeCompare(left.id),
      )
      .slice(0, Math.min(Math.max(limit, 1), 500))
      .map(clone);
  }

  async decideAgentApproval(
    userId: string,
    approvalId: string,
    decision: "approved" | "denied",
    decidedAt: string,
  ): Promise<boolean> {
    const key = tenantKey(userId, approvalId);
    const current = this.#approvals.get(key);
    if (
      !current ||
      current.status !== "pending" ||
      current.expiresAt <= decidedAt
    ) {
      return false;
    }
    this.#approvals.set(key, {
      ...current,
      decidedAt,
      status: decision,
    });
    return true;
  }

  async consumeAgentApproval(
    userId: string,
    approvalId: string,
    consumedAt: string,
  ): Promise<boolean> {
    const key = tenantKey(userId, approvalId);
    const current = this.#approvals.get(key);
    if (
      !current ||
      current.status !== "approved" ||
      current.expiresAt <= consumedAt
    ) {
      return false;
    }
    this.#approvals.set(key, {
      ...current,
      consumedAt,
      status: "consumed",
    });
    return true;
  }

  async updateCredential(
    record: CloudVaultCredentialRecord,
    expectedRevision: number,
  ): Promise<boolean> {
    const key = tenantKey(record.userId, record.id);
    const current = this.#credentials.get(key);
    if (
      !current ||
      current.deletedAt !== null ||
      current.revision !== expectedRevision
    ) {
      return false;
    }
    this.#credentials.set(key, clone(record));
    return true;
  }

  async deleteCredential(
    userId: string,
    credentialId: string,
    expectedRevision: number,
    deletedAt: string,
  ): Promise<boolean> {
    const key = tenantKey(userId, credentialId);
    const current = this.#credentials.get(key);
    if (
      !current ||
      current.deletedAt !== null ||
      current.revision !== expectedRevision
    ) {
      return false;
    }
    this.#credentials.set(key, {
      ...current,
      deletedAt,
      envelope: {
        ...current.envelope,
        authTag: "",
        ciphertext: "",
        iv: "",
        wrappedDek: "",
      },
      revision: current.revision + 1,
      secretKeys: [],
      updatedAt: deletedAt,
    });
    return true;
  }

  async getCredential(
    userId: string,
    credentialId: string,
    includeDeleted = false,
  ): Promise<CloudVaultCredentialRecord | null> {
    const record = this.#credentials.get(tenantKey(userId, credentialId));
    if (!record || (!includeDeleted && record.deletedAt !== null)) return null;
    return clone(record);
  }

  async listCredentials(
    query: CloudVaultCredentialQuery,
  ): Promise<CloudVaultCredentialRecord[]> {
    const search = query.search?.trim().toLowerCase();
    const requiredTags = (query.tags ?? []).map((tag) => tag.toLowerCase());
    const records = [...this.#credentials.values()]
      .filter(
        (record) => record.userId === query.userId && record.deletedAt === null,
      )
      .filter(
        (record) => !query.kinds?.length || query.kinds.includes(record.kind),
      )
      .filter(
        (record) =>
          !query.purposes?.length ||
          query.purposes.every((requested) =>
            record.purposes.some((stored) => purposeMatches(stored, requested)),
          ),
      )
      .filter((record) => {
        const tags = record.tags.map((tag) => tag.toLowerCase());
        return requiredTags.every((tag) => tags.includes(tag));
      })
      .filter((record) => {
        if (!search) return true;
        return [
          record.label,
          ...Object.entries(record.fields).flat(),
          ...record.tags,
        ].some((value) => value.toLowerCase().includes(search));
      })
      .sort(
        (left, right) =>
          right.updatedAt.localeCompare(left.updatedAt) ||
          left.id.localeCompare(right.id),
      );
    const offset = Math.max(0, query.offset ?? 0);
    const limit = Math.min(Math.max(query.limit ?? 100, 1), 500);
    return records.slice(offset, offset + limit).map(clone);
  }

  async createAgentGrant(grant: CloudVaultAgentGrant): Promise<void> {
    const key = tenantKey(grant.userId, grant.id);
    if (this.#grants.has(key)) throw new Error("Agent grant already exists.");
    this.#grants.set(key, clone(grant));
  }

  async listAgentGrants(
    userId: string,
    agentId: string,
    now: string,
  ): Promise<CloudVaultAgentGrant[]> {
    return [...this.#grants.values()]
      .filter(
        (grant) =>
          grant.userId === userId &&
          grant.agentId === agentId &&
          grant.revokedAt === null &&
          (grant.expiresAt === null || grant.expiresAt > now),
      )
      .sort(
        (left, right) =>
          left.createdAt.localeCompare(right.createdAt) ||
          left.id.localeCompare(right.id),
      )
      .map(clone);
  }

  async revokeAgentGrant(
    userId: string,
    grantId: string,
    revokedAt: string,
  ): Promise<boolean> {
    const key = tenantKey(userId, grantId);
    const current = this.#grants.get(key);
    if (!current || current.revokedAt !== null) return false;
    this.#grants.set(key, {
      ...current,
      revokedAt,
      updatedAt: revokedAt,
    });
    return true;
  }

  async createAgentSession(session: CloudVaultAgentSession): Promise<void> {
    if ([...this.#sessions.values()].some((item) => item.tokenHash === session.tokenHash)) {
      throw new Error("Agent session token already exists.");
    }
    this.#sessions.set(tenantKey(session.userId, session.id), clone(session));
  }

  async findAgentSessionByTokenHash(
    tokenHash: string,
    now: string,
  ): Promise<CloudVaultAgentSession | null> {
    const session = [...this.#sessions.values()].find(
      (item) =>
        item.tokenHash === tokenHash &&
        item.revokedAt === null &&
        item.expiresAt > now,
    );
    return session ? clone(session) : null;
  }

  async touchAgentSession(sessionId: string, lastUsedAt: string): Promise<void> {
    const entry = [...this.#sessions.entries()].find(
      ([, session]) => session.id === sessionId,
    );
    if (!entry) return;
    this.#sessions.set(entry[0], { ...entry[1], lastUsedAt });
  }

  async revokeAgentSession(
    userId: string,
    sessionId: string,
    revokedAt: string,
  ): Promise<boolean> {
    const key = tenantKey(userId, sessionId);
    const current = this.#sessions.get(key);
    if (!current || current.revokedAt !== null) return false;
    this.#sessions.set(key, { ...current, revokedAt });
    return true;
  }

  async purgeExpiredAgentSessions(now: string): Promise<number> {
    let deleted = 0;
    for (const [key, session] of this.#sessions) {
      if (session.expiresAt <= now || session.revokedAt !== null) {
        this.#sessions.delete(key);
        deleted += 1;
      }
    }
    return deleted;
  }

  async purgeExpiredAgentApprovals(before: string): Promise<number> {
    let deleted = 0;
    for (const [key, approval] of this.#approvals) {
      if (approval.expiresAt <= before) {
        this.#approvals.delete(key);
        deleted += 1;
      }
    }
    return deleted;
  }

  async purgeExpiredAgentGrants(before: string): Promise<number> {
    let deleted = 0;
    for (const [key, grant] of this.#grants) {
      if (
        (grant.expiresAt !== null && grant.expiresAt <= before) ||
        (grant.revokedAt !== null && grant.revokedAt <= before)
      ) {
        this.#grants.delete(key);
        deleted += 1;
      }
    }
    return deleted;
  }

  async insertAuditEvent(event: CloudVaultAuditEvent): Promise<void> {
    this.#audits.push(clone(event));
  }

  async listAuditEvents(
    userId: string,
    limit = 100,
  ): Promise<CloudVaultAuditEvent[]> {
    return this.#audits
      .filter((event) => event.userId === userId)
      .sort(
        (left, right) =>
          right.createdAt.localeCompare(left.createdAt) ||
          right.id.localeCompare(left.id),
      )
      .slice(0, Math.min(Math.max(limit, 1), 500))
      .map(clone);
  }

  async createMigration(record: CloudVaultMigrationRecord): Promise<boolean> {
    if (this.#migrations.has(record.userId)) return false;
    this.#migrations.set(record.userId, clone(record));
    return true;
  }

  async getMigration(userId: string): Promise<CloudVaultMigrationRecord | null> {
    const record = this.#migrations.get(userId);
    return record ? clone(record) : null;
  }

  async getWalletPake(
    userId: string,
  ): Promise<CloudVaultWalletPakeRecord | null> {
    const record = this.#walletPake.get(userId);
    return record ? clone(record) : null;
  }

  async upsertWalletPake(record: CloudVaultWalletPakeRecord): Promise<void> {
    this.#walletPake.set(record.userId, clone(record));
  }

  async updateMigration(
    record: CloudVaultMigrationRecord,
    expectedState: CloudVaultMigrationState,
  ): Promise<boolean> {
    const current = this.#migrations.get(record.userId);
    if (!current || current.state !== expectedState) return false;
    this.#migrations.set(record.userId, clone(record));
    return true;
  }
}

function tenantKey(userId: string, id: string): string {
  return `${userId}\u0000${id}`;
}

function purposeMatches(storedValue: string, requestedValue: string): boolean {
  const stored = storedValue.toLowerCase();
  const requested = requestedValue.toLowerCase();
  if (stored === "*" || stored === requested) return true;
  return [".", ":", "/"].some(
    (separator) =>
      stored.startsWith(`${requested}${separator}`) ||
      requested.startsWith(`${stored}${separator}`),
  );
}

function clone<T>(value: T): T {
  return structuredClone(value);
}

function cloneMap<K, V>(value: Map<K, V>): Map<K, V> {
  return new Map([...value].map(([key, item]) => [key, clone(item)]));
}

function restoreMap<K, V>(target: Map<K, V>, source: Map<K, V>): void {
  target.clear();
  for (const [key, value] of source) target.set(key, clone(value));
}
