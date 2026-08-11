export { isCredentialPublicFieldName } from "@one-status/protocol";

export const cloudVaultCredentialKinds = [
  "account",
  "ssh",
  "cloud_console",
  "github",
  "database",
  "api",
  "oauth",
  "license",
  "card_key",
  "model",
  "email",
  "vpn",
  "certificate",
  "signing",
  "container_registry",
  "package_registry",
  "domain",
  "remote_desktop",
  "webhook",
  "generic",
] as const;

export type CloudVaultCredentialKind =
  (typeof cloudVaultCredentialKinds)[number];

export interface CloudVaultCredentialSource {
  agentId?: string;
  deviceId?: string;
  projectId?: string;
  type: "user" | "agent" | "scan" | "import" | "migration";
}

export interface CloudVaultCredentialAccessPolicy {
  allowAgentRead: boolean;
  allowedAgentIds: string[];
  allowedProjectIds: string[];
  deniedAgentIds: string[];
  deniedProjectIds: string[];
  requireApproval: boolean;
}

export interface CloudVaultSecretEnvelope {
  algorithm: "AES-256-GCM";
  authTag: string;
  ciphertext: string;
  iv: string;
  kmsKeyId: string;
  kmsProvider: string;
  version: 1;
  wrappedDek: string;
}

export interface CloudVaultCredentialRecord {
  accessPolicy: CloudVaultCredentialAccessPolicy;
  createdAt: string;
  deletedAt: string | null;
  envelope: CloudVaultSecretEnvelope;
  expiresAt: string | null;
  fields: Record<string, string>;
  id: string;
  kind: CloudVaultCredentialKind;
  label: string;
  purposes: string[];
  revision: number;
  secretKeys: string[];
  source: CloudVaultCredentialSource;
  tags: string[];
  updatedAt: string;
  userId: string;
}

export interface CloudVaultCredentialPlaintext
  extends Omit<
    CloudVaultCredentialRecord,
    "deletedAt" | "envelope" | "revision" | "secretKeys"
  > {
  secrets: Record<string, string>;
}

export interface CloudVaultCredentialInput {
  accessPolicy?: Partial<CloudVaultCredentialAccessPolicy>;
  expiresAt?: string | null;
  fields?: Record<string, string>;
  id?: string;
  kind: CloudVaultCredentialKind;
  label: string;
  purposes: string[];
  secrets: Record<string, string>;
  source: CloudVaultCredentialSource;
  tags?: string[];
  userId: string;
}

export interface CloudVaultCredentialPatch {
  accessPolicy?: Partial<CloudVaultCredentialAccessPolicy>;
  expiresAt?: string | null;
  fields?: Record<string, string>;
  kind?: CloudVaultCredentialKind;
  label?: string;
  purposes?: string[];
  secrets?: Record<string, string>;
  source?: Partial<CloudVaultCredentialSource>;
  tags?: string[];
}

export interface MaskedCloudVaultCredential
  extends Omit<CloudVaultCredentialRecord, "envelope"> {
  secrets: Record<string, "********">;
}

export interface CloudVaultCredentialQuery {
  kinds?: CloudVaultCredentialKind[];
  limit?: number;
  offset?: number;
  purposes?: string[];
  search?: string;
  tags?: string[];
  userId: string;
}

export interface CloudVaultAgentGrant {
  agentId: string;
  createdAt: string;
  credentialId: string | null;
  expiresAt: string | null;
  id: string;
  projectIds: string[];
  purposes: string[];
  revokedAt: string | null;
  updatedAt: string;
  userId: string;
}

export interface CloudVaultAgentSession {
  agentId: string;
  clientId: string | null;
  createdAt: string;
  expiresAt: string;
  id: string;
  lastUsedAt: string | null;
  projectIds: string[];
  revokedAt: string | null;
  tokenHash: string;
  userId: string;
}

export interface IssuedCloudVaultAgentSession
  extends Omit<CloudVaultAgentSession, "tokenHash"> {
  token: string;
}

export const cloudVaultApprovalOperations = [
  "credential.create",
  "credential.get",
  "credential.update",
  "credential.delete",
] as const;

export type CloudVaultApprovalOperation =
  (typeof cloudVaultApprovalOperations)[number];

export type CloudVaultApprovalStatus =
  | "pending"
  | "approved"
  | "denied"
  | "consumed";

export interface CloudVaultApprovalSummary {
  credentialId: string | null;
  fieldKeys: string[];
  kind: string | null;
  label: string | null;
  projectId: string | null;
  purpose: string | null;
  secretKeys: string[];
}

export interface CloudVaultAgentApproval {
  agentId: string;
  clientId: string | null;
  consumedAt: string | null;
  createdAt: string;
  decidedAt: string | null;
  expiresAt: string;
  id: string;
  operation: CloudVaultApprovalOperation;
  requestDigest: string;
  sessionId: string;
  status: CloudVaultApprovalStatus;
  summary: CloudVaultApprovalSummary;
  tokenHash: string;
  userId: string;
}

export interface IssuedCloudVaultAgentApproval {
  approval: Omit<CloudVaultAgentApproval, "requestDigest" | "tokenHash">;
  approvalToken: string;
}

export type CloudVaultAuditAction =
  | "credential.create"
  | "credential.update"
  | "credential.delete"
  | "credential.list"
  | "credential.resolve"
  | "credential.get"
  | "credential.reveal"
  | "grant.create"
  | "grant.revoke"
  | "session.issue"
  | "session.authenticate"
  | "session.revoke"
  | "approval.request"
  | "approval.decision"
  | "approval.consume"
  | "wallet.password.change"
  | "wallet.password.reset"
  | "migration.backfill"
  | "migration.dual_write"
  | "migration.validate"
  | "migration.cutover";

export interface CloudVaultAuditEvent {
  action: CloudVaultAuditAction;
  actorId: string;
  actorType: "user" | "agent" | "migration" | "system";
  createdAt: string;
  credentialId: string | null;
  decision: "allow" | "deny";
  id: string;
  metadata: Record<string, boolean | number | string | null>;
  projectId: string | null;
  purpose: string | null;
  reason: string;
  sessionId: string | null;
  userId: string;
}

export interface CloudVaultWalletPakeRecord {
  createdAt: string;
  profile: {
    version: 1;
    suite: "opaque-rfc9807-ristretto255-sha512";
    keyStretching: "memory-constrained";
    argon2id: {
      memoryKiB: 65_536;
      iterations: 3;
      parallelism: 4;
    };
  };
  registrationRecord: string;
  updatedAt: string;
  userId: string;
}

export const cloudVaultMigrationStates = [
  "local_only",
  "backfilling",
  "dual_write",
  "validating",
  "cutover_ready",
  "cutover",
  "failed",
] as const;

export type CloudVaultMigrationState =
  (typeof cloudVaultMigrationStates)[number];

export interface CloudVaultMigrationRecord {
  cloudCount: number | null;
  cloudDigest: string | null;
  createdAt: string;
  failureCode: string | null;
  localCount: number | null;
  localDigest: string | null;
  state: CloudVaultMigrationState;
  updatedAt: string;
  userId: string;
  verifiedAt: string | null;
}

export interface CloudVaultMigrationVerification {
  cloudCount: number;
  cloudDigest: string;
  countMatches: boolean;
  digestMatches: boolean;
  localCount: number;
  localDigest: string;
  matches: boolean;
  verifiedAt: string;
}
