import { createHash, randomBytes, randomUUID } from "node:crypto";
import {
  createOpaqueRegistrationResponse,
  createOpaqueServerSetup,
  finishOpaqueServerLogin,
  oneStatusOpaqueProfile,
  opaqueServerPublicKey,
  startOpaqueServerLogin,
  type OneStatusOpaqueProfile,
} from "@one-status/pake";
import type {
  AuthResponse,
  EncryptedEnvelope,
  StatusKeyMigrationResponse,
  WrappedStatusKey,
} from "@one-status/protocol";
import {
  EmailAlreadyRegisteredError,
  InvalidCredentialsError,
  type AuthenticatedSession,
  type OneStatusDatabase,
  type PasswordAuthScheme,
} from "./database.js";

const FLOW_TTL_MS = 5 * 60_000;
const MAX_PENDING_FLOWS = 5_000;

interface PendingRegistration {
  email: string;
  expectedAuthScheme?: PasswordAuthScheme;
  expectedRegistrationRecord?: string | null;
  expiresAt: number;
  profile: OneStatusOpaqueProfile;
  userId?: string;
}

interface PendingLogin {
  email: string;
  expiresAt: number;
  knownUserId?: string;
  proofPurpose?: OpaqueProofPurpose;
  serverLoginState: string;
}

interface PendingProof {
  expiresAt: number;
  purpose: OpaqueProofPurpose;
  userId: string;
}

export type OpaqueProofPurpose =
  | "oauth-authorize"
  | "wallet-reset"
  | "account-password-change";

export interface OpaqueStartResponse {
  flowId: string;
  profile: OneStatusOpaqueProfile;
  serverPublicKey: string;
}

export class OpaqueAuthService {
  readonly #database: OneStatusDatabase;
  readonly #logins = new Map<string, PendingLogin>();
  readonly #proofs = new Map<string, PendingProof>();
  readonly #registrations = new Map<string, PendingRegistration>();
  readonly #serverSetup: Promise<string>;

  constructor(options: {
    database: OneStatusDatabase;
    serverSetup?: string | Promise<string>;
  }) {
    this.#database = options.database;
    this.#serverSetup = Promise.resolve(
      options.serverSetup ?? createOpaqueServerSetup(),
    );
  }

  async startRegistration(input: {
    email: string;
    registrationRequest: string;
  }): Promise<
    OpaqueStartResponse & {
      accountBinding: string;
      registrationResponse: string;
    }
  > {
    this.#prune();
    if (this.#database.hasRegisteredEmail(input.email)) {
      throw new EmailAlreadyRegisteredError("Email is already registered.");
    }
    this.#reserveCapacity();
    const serverSetup = await this.#serverSetup;
    const flowId = randomUUID();
    const userId = randomUUID();
    const registrationResponse = await createOpaqueRegistrationResponse({
      registrationRequest: input.registrationRequest,
      serverSetup,
      userIdentifier: userId,
    });
    this.#registrations.set(flowId, {
      email: input.email,
      expiresAt: Date.now() + FLOW_TTL_MS,
      profile: oneStatusOpaqueProfile,
      userId,
    });
    return {
      accountBinding: userId,
      flowId,
      profile: oneStatusOpaqueProfile,
      registrationResponse,
      serverPublicKey: await opaqueServerPublicKey(serverSetup),
    };
  }

  finishRegistration(input: {
    deviceName: string;
    flowId: string;
    initialEnvelope: EncryptedEnvelope;
    installationId?: string;
    registrationRecord: string;
    wrappedStatusKey: WrappedStatusKey;
  }): AuthResponse {
    const flow = this.#consumeRegistration(input.flowId);
    if (!flow.userId) throw new Error("OPAQUE registration flow is invalid.");
    return this.#database.registerOpaque(
      flow.userId,
      flow.email,
      input.registrationRecord,
      flow.profile,
      input.deviceName,
      input.initialEnvelope,
      input.wrappedStatusKey,
      input.installationId,
    );
  }

  async startLogin(input: {
    email: string;
    startLoginRequest: string;
  }): Promise<OpaqueStartResponse & { loginResponse: string }> {
    this.#prune();
    this.#reserveCapacity();
    const account = this.#database.getOpaqueLoginRecord(input.email);
    const profile = account?.profile ?? oneStatusOpaqueProfile;
    const serverSetup = await this.#serverSetup;
    const accountBinding = account?.userId ?? randomUUID();
    const login = await startOpaqueServerLogin({
      registrationRecord: account?.registrationRecord,
      serverSetup,
      startLoginRequest: input.startLoginRequest,
      userIdentifier: accountBinding,
    });
    const flowId = randomUUID();
    this.#logins.set(flowId, {
      email: input.email,
      expiresAt: Date.now() + FLOW_TTL_MS,
      ...(account ? { knownUserId: account.userId } : {}),
      serverLoginState: login.serverLoginState,
    });
    return {
      flowId,
      loginResponse: login.loginResponse,
      profile,
      serverPublicKey: await opaqueServerPublicKey(serverSetup),
    };
  }

  async finishLoginProof(input: {
    finishLoginRequest: string;
    flowId: string;
  }): Promise<{ email: string; userId: string }> {
    const flow = this.#consumeLogin(input.flowId);
    try {
      await finishOpaqueServerLogin({
        finishLoginRequest: input.finishLoginRequest,
        serverLoginState: flow.serverLoginState,
      });
    } catch {
      throw new InvalidCredentialsError("Invalid email or password.");
    }
    if (!flow.knownUserId) {
      throw new InvalidCredentialsError("Invalid email or password.");
    }
    return { email: flow.email, userId: flow.knownUserId };
  }

  async finishLogin(input: {
    deviceName: string;
    finishLoginRequest: string;
    flowId: string;
    installationId?: string;
  }): Promise<AuthResponse> {
    const identity = await this.finishLoginProof(input);
    return this.#database.loginOpaque(
      identity.email,
      input.deviceName,
      input.installationId,
    );
  }

  async startProof(input: {
    email: string;
    purpose: OpaqueProofPurpose;
    startLoginRequest: string;
  }): Promise<OpaqueStartResponse & { loginResponse: string }> {
    const started = await this.startLogin(input);
    const flow = this.#logins.get(started.flowId);
    if (!flow) throw new InvalidCredentialsError("OPAQUE login flow expired.");
    flow.proofPurpose = input.purpose;
    return started;
  }

  async finishProof(input: {
    finishLoginRequest: string;
    flowId: string;
  }): Promise<{ proofToken: string }> {
    const flow = this.#logins.get(input.flowId);
    if (!flow?.proofPurpose) {
      throw new InvalidCredentialsError("OPAQUE proof flow is invalid.");
    }
    const purpose = flow.proofPurpose;
    const identity = await this.finishLoginProof(input);
    const proofToken = `osp1_${randomBytes(32).toString("base64url")}`;
    this.#proofs.set(hashProof(proofToken), {
      expiresAt: Date.now() + FLOW_TTL_MS,
      purpose,
      userId: identity.userId,
    });
    return { proofToken };
  }

  consumeProof(
    proofToken: string,
    purpose: OpaqueProofPurpose,
  ): { userId: string } | null {
    if (!/^osp1_[A-Za-z0-9_-]{43}$/u.test(proofToken)) return null;
    const key = hashProof(proofToken);
    const proof = this.#proofs.get(key);
    this.#proofs.delete(key);
    if (
      !proof ||
      proof.expiresAt <= Date.now() ||
      proof.purpose !== purpose
    ) {
      return null;
    }
    return { userId: proof.userId };
  }

  async startMigration(input: {
    accountProof?: string;
    registrationRequest: string;
    session: AuthenticatedSession;
  }): Promise<
    OpaqueStartResponse & {
      accountBinding: string;
      registrationResponse: string;
    }
  > {
    this.#prune();
    this.#reserveCapacity();
    const identity = this.#database.getOpaqueMigrationIdentity(
      input.session.userId,
    );
    if (!identity) {
      throw new InvalidCredentialsError("Invalid account session.");
    }
    if (identity.authScheme === "opaque") {
      const proof = input.accountProof
        ? this.consumeProof(input.accountProof, "account-password-change")
        : null;
      if (proof?.userId !== input.session.userId) {
        throw new InvalidCredentialsError(
          "Account password verification is required.",
        );
      }
    }
    const serverSetup = await this.#serverSetup;
    const flowId = randomUUID();
    const registrationResponse = await createOpaqueRegistrationResponse({
      registrationRequest: input.registrationRequest,
      serverSetup,
      userIdentifier: input.session.userId,
    });
    this.#registrations.set(flowId, {
      email: identity.email,
      expectedAuthScheme: identity.authScheme,
      expectedRegistrationRecord: identity.registrationRecord,
      expiresAt: Date.now() + FLOW_TTL_MS,
      profile: oneStatusOpaqueProfile,
      userId: input.session.userId,
    });
    return {
      accountBinding: input.session.userId,
      flowId,
      profile: oneStatusOpaqueProfile,
      registrationResponse,
      serverPublicKey: await opaqueServerPublicKey(serverSetup),
    };
  }

  finishMigration(input: {
    flowId: string;
    registrationRecord: string;
    session: AuthenticatedSession;
    wrappedStatusKey: WrappedStatusKey;
  }): StatusKeyMigrationResponse {
    const flow = this.#consumeRegistration(input.flowId);
    if (flow.userId !== input.session.userId) {
      throw new InvalidCredentialsError("OPAQUE migration flow is invalid.");
    }
    if (!flow.expectedAuthScheme) {
      throw new InvalidCredentialsError("OPAQUE migration flow is invalid.");
    }
    return this.#database.migrateOpaqueRegistration(
      input.session,
      input.registrationRecord,
      flow.profile,
      input.wrappedStatusKey,
      {
        authScheme: flow.expectedAuthScheme,
        registrationRecord: flow.expectedRegistrationRecord ?? null,
      },
    );
  }

  close(): void {
    this.#logins.clear();
    this.#proofs.clear();
    this.#registrations.clear();
  }

  #consumeLogin(flowId: string): PendingLogin {
    const flow = this.#logins.get(flowId);
    this.#logins.delete(flowId);
    if (!flow || flow.expiresAt <= Date.now()) {
      throw new InvalidCredentialsError("OPAQUE login flow expired.");
    }
    return flow;
  }

  #consumeRegistration(flowId: string): PendingRegistration {
    const flow = this.#registrations.get(flowId);
    this.#registrations.delete(flowId);
    if (!flow || flow.expiresAt <= Date.now()) {
      throw new InvalidCredentialsError("OPAQUE registration flow expired.");
    }
    return flow;
  }

  #prune(): void {
    const now = Date.now();
    for (const [id, flow] of this.#logins) {
      if (flow.expiresAt <= now) this.#logins.delete(id);
    }
    for (const [id, flow] of this.#registrations) {
      if (flow.expiresAt <= now) this.#registrations.delete(id);
    }
    for (const [id, proof] of this.#proofs) {
      if (proof.expiresAt <= now) this.#proofs.delete(id);
    }
  }

  #reserveCapacity(): void {
    if (
      this.#logins.size + this.#registrations.size + this.#proofs.size >=
      MAX_PENDING_FLOWS
    ) {
      throw new Error("OPAQUE flow capacity has been reached.");
    }
  }
}

function hashProof(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("base64url");
}
