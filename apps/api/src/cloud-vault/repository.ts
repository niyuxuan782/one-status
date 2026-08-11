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

export interface CloudVaultRepository {
  transaction<T>(
    operation: (repository: CloudVaultRepository) => Promise<T>,
  ): Promise<T>;
  consumeAgentApproval(
    userId: string,
    approvalId: string,
    consumedAt: string,
  ): Promise<boolean>;
  createAgentApproval(approval: CloudVaultAgentApproval): Promise<void>;
  createAgentGrant(grant: CloudVaultAgentGrant): Promise<void>;
  createAgentSession(session: CloudVaultAgentSession): Promise<void>;
  createCredential(record: CloudVaultCredentialRecord): Promise<void>;
  createMigration(record: CloudVaultMigrationRecord): Promise<boolean>;
  deleteCredential(
    userId: string,
    credentialId: string,
    expectedRevision: number,
    deletedAt: string,
  ): Promise<boolean>;
  findAgentSessionByTokenHash(
    tokenHash: string,
    now: string,
  ): Promise<CloudVaultAgentSession | null>;
  findAgentApprovalByTokenHash(
    tokenHash: string,
    now: string,
  ): Promise<CloudVaultAgentApproval | null>;
  getCredential(
    userId: string,
    credentialId: string,
    includeDeleted?: boolean,
  ): Promise<CloudVaultCredentialRecord | null>;
  getMigration(userId: string): Promise<CloudVaultMigrationRecord | null>;
  getWalletPake(userId: string): Promise<CloudVaultWalletPakeRecord | null>;
  insertAuditEvent(event: CloudVaultAuditEvent): Promise<void>;
  listAgentGrants(
    userId: string,
    agentId: string,
    now: string,
  ): Promise<CloudVaultAgentGrant[]>;
  listAgentApprovals(
    userId: string,
    limit?: number,
  ): Promise<CloudVaultAgentApproval[]>;
  listAuditEvents(
    userId: string,
    limit?: number,
  ): Promise<CloudVaultAuditEvent[]>;
  listCredentials(
    query: CloudVaultCredentialQuery,
  ): Promise<CloudVaultCredentialRecord[]>;
  purgeExpiredAgentSessions(now: string): Promise<number>;
  purgeExpiredAgentApprovals(before: string): Promise<number>;
  purgeExpiredAgentGrants(before: string): Promise<number>;
  revokeAgentGrant(
    userId: string,
    grantId: string,
    revokedAt: string,
  ): Promise<boolean>;
  decideAgentApproval(
    userId: string,
    approvalId: string,
    decision: "approved" | "denied",
    decidedAt: string,
  ): Promise<boolean>;
  revokeAgentSession(
    userId: string,
    sessionId: string,
    revokedAt: string,
  ): Promise<boolean>;
  touchAgentSession(sessionId: string, lastUsedAt: string): Promise<void>;
  upsertWalletPake(record: CloudVaultWalletPakeRecord): Promise<void>;
  updateCredential(
    record: CloudVaultCredentialRecord,
    expectedRevision: number,
  ): Promise<boolean>;
  updateMigration(
    record: CloudVaultMigrationRecord,
    expectedState: CloudVaultMigrationState,
  ): Promise<boolean>;
}
