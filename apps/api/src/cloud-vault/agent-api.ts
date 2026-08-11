import type {
  CloudVaultApprovalOperation,
  CloudVaultCredentialInput,
  CloudVaultCredentialKind,
  CloudVaultCredentialPatch,
} from "./types.js";
import {
  CloudVaultAccessDeniedError,
  type CloudVaultActor,
  type CloudVaultService,
} from "./service.js";

export class CloudVaultAgentApi {
  constructor(private readonly service: CloudVaultService) {}

  async register(
    token: string,
    input: Omit<CloudVaultCredentialInput, "source" | "userId"> & {
      approvalToken: string;
      projectId?: string;
    },
  ) {
    const session = await this.#session(token);
    const projectId = trustedProject(session.projectIds, input.projectId);
    const { approvalToken, projectId: _projectId, ...credential } = input;
    await this.service.consumeAgentApproval(token, {
      approvalToken,
      operation: "credential.create",
      request: { ...credential, ...(projectId ? { projectId } : {}) },
    });
    return this.service.createCredential(
      {
        ...credential,
        source: {
          agentId: session.agentId,
          ...(projectId ? { projectId } : {}),
          type: "agent",
        },
        userId: session.userId,
      },
      agentActor(session, projectId),
    );
  }

  list(
    token: string,
    input: {
      kinds?: CloudVaultCredentialKind[];
      limit?: number;
      projectId?: string;
      purposes?: string[];
      search?: string;
      tags?: string[];
    },
  ) {
    return this.service.listForAgent(token, input);
  }

  resolve(
    token: string,
    input: {
      kinds?: CloudVaultCredentialKind[];
      limit?: number;
      matchFields?: Record<string, string>;
      projectId?: string;
      purpose: string;
      search?: string;
      tags?: string[];
    },
  ) {
    return this.service.resolveForAgent(token, input);
  }

  get(
    token: string,
    input: {
      credentialId: string;
      approvalToken?: string;
      projectId?: string;
      purpose: string;
    },
  ) {
    return this.service.getForAgent(token, input);
  }

  async update(
    token: string,
    input: {
      credentialId: string;
      approvalToken: string;
      patch: CloudVaultCredentialPatch;
      projectId?: string;
      purpose: string;
    },
  ) {
    const session = await this.#session(token);
    await this.service.consumeAgentApproval(token, {
      approvalToken: input.approvalToken,
      operation: "credential.update",
      request: mutationApprovalRequest(input),
    });
    await this.service.getForAgent(token, {
      approved: true,
      credentialId: input.credentialId,
      matchCredentialPurpose: false,
      ...(input.projectId ? { projectId: input.projectId } : {}),
      purpose: input.purpose,
    });
    return this.service.updateCredential({
      actor: agentActor(session, input.projectId),
      credentialId: input.credentialId,
      patch: input.patch,
      userId: session.userId,
    });
  }

  async delete(
    token: string,
    input: {
      credentialId: string;
      approvalToken: string;
      projectId?: string;
      purpose: string;
    },
  ) {
    const session = await this.#session(token);
    await this.service.consumeAgentApproval(token, {
      approvalToken: input.approvalToken,
      operation: "credential.delete",
      request: mutationApprovalRequest(input),
    });
    await this.service.getForAgent(token, {
      approved: true,
      ...input,
      matchCredentialPurpose: false,
    });
    return this.service.deleteCredential({
      actor: agentActor(session, input.projectId),
      credentialId: input.credentialId,
      userId: session.userId,
    });
  }

  requestApproval(
    token: string,
    input: {
      operation: CloudVaultApprovalOperation;
      request: Record<string, unknown>;
    },
  ) {
    return this.service.requestAgentApproval(token, input);
  }

  async #session(token: string) {
    const session = await this.service.authenticateAgentSession(token);
    if (!session) throw new CloudVaultAccessDeniedError();
    return session;
  }
}

function mutationApprovalRequest(input: {
  approvalToken: string;
  credentialId: string;
  patch?: CloudVaultCredentialPatch;
  projectId?: string;
  purpose: string;
}) {
  return {
    credentialId: input.credentialId,
    ...(input.patch ? { patch: input.patch } : {}),
    ...(input.projectId ? { projectId: input.projectId } : {}),
    purpose: input.purpose,
  };
}

function agentActor(
  session: {
    agentId: string;
    id: string;
  },
  projectId?: string,
): CloudVaultActor {
  return {
    id: session.agentId,
    ...(projectId ? { projectId } : {}),
    sessionId: session.id,
    type: "agent",
  };
}

function trustedProject(
  allowedProjectIds: string[],
  requested: string | undefined,
): string | undefined {
  if (!requested) return undefined;
  if (!allowedProjectIds.includes(requested)) {
    throw new CloudVaultAccessDeniedError();
  }
  return requested;
}
