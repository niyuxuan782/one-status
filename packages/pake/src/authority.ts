import { createHash, randomBytes, randomUUID } from "node:crypto";
import {
  createOpaqueRegistrationResponse,
  finishOpaqueServerLogin,
  oneStatusOpaqueProfile,
  opaqueServerPublicKey,
  startOpaqueServerLogin,
  type OneStatusOpaqueProfile,
} from "./index.js";

const FLOW_TTL_MS = 5 * 60_000;
const MAX_STATE_ENTRIES = 5_000;
const WALLET_GRANT_PREFIX = "oswg1_";

export interface OpaquePasswordRecord {
  createdAt: string;
  profile: OneStatusOpaqueProfile;
  registrationRecord: string;
  updatedAt: string;
  userId: string;
}

export interface OpaquePasswordStore {
  get(userId: string): Promise<OpaquePasswordRecord | null>;
  set(record: OpaquePasswordRecord): Promise<void>;
}

interface LoginFlow {
  expiresAt: number;
  known: boolean;
  serverLoginState: string;
  userId: string;
}

interface RegistrationFlow {
  createdAt: string;
  expiresAt: number;
  userId: string;
}

interface WalletGrant {
  expiresAt: number;
  userId: string;
}

export class OpaquePasswordAuthority {
  readonly #grants = new Map<string, WalletGrant>();
  readonly #logins = new Map<string, LoginFlow>();
  readonly #registrations = new Map<string, RegistrationFlow>();
  readonly #serverSetup: Promise<string>;
  readonly #store: OpaquePasswordStore;

  constructor(options: {
    serverSetup: string | Promise<string>;
    store: OpaquePasswordStore;
  }) {
    this.#serverSetup = Promise.resolve(options.serverSetup);
    this.#store = options.store;
  }

  async startLogin(input: { startLoginRequest: string; userId: string }) {
    this.#prepare();
    const record = await this.#store.get(input.userId);
    const setup = await this.#serverSetup;
    const login = await startOpaqueServerLogin({
      registrationRecord: record?.registrationRecord,
      serverSetup: setup,
      startLoginRequest: input.startLoginRequest,
      userIdentifier: walletIdentifier(input.userId),
    });
    const flowId = randomUUID();
    this.#logins.set(flowId, {
      expiresAt: Date.now() + FLOW_TTL_MS,
      known: Boolean(record),
      serverLoginState: login.serverLoginState,
      userId: input.userId,
    });
    return {
      flowId,
      loginResponse: login.loginResponse,
      profile: record?.profile ?? oneStatusOpaqueProfile,
      serverPublicKey: await opaqueServerPublicKey(setup),
    };
  }

  async finishLogin(input: {
    finishLoginRequest: string;
    flowId: string;
    userId: string;
  }): Promise<{ walletGrant: string }> {
    const flow = this.#logins.get(input.flowId);
    this.#logins.delete(input.flowId);
    if (
      !flow ||
      flow.expiresAt <= Date.now() ||
      flow.userId !== input.userId
    ) {
      throw new Error("wallet_pake_invalid");
    }
    try {
      await finishOpaqueServerLogin({
        finishLoginRequest: input.finishLoginRequest,
        serverLoginState: flow.serverLoginState,
      });
    } catch {
      throw new Error("wallet_pake_invalid");
    }
    if (!flow.known) throw new Error("wallet_pake_uninitialized");
    const walletGrant = `${WALLET_GRANT_PREFIX}${randomBytes(32).toString("base64url")}`;
    this.#grants.set(hashToken(walletGrant), {
      expiresAt: Date.now() + FLOW_TTL_MS,
      userId: input.userId,
    });
    return { walletGrant };
  }

  async startRegistration(input: {
    authorization: "initial" | "change" | "reset";
    registrationRequest: string;
    userId: string;
    walletGrant?: string;
  }) {
    this.#prepare();
    const existing = await this.#store.get(input.userId);
    if (input.authorization === "initial" && existing) {
      throw new Error("wallet_pake_already_initialized");
    }
    if (input.authorization === "change") {
      if (!input.walletGrant || !this.consumeGrant(input.userId, input.walletGrant)) {
        throw new Error("wallet_pake_grant_invalid");
      }
    }
    if (input.authorization === "reset" && !existing) {
      throw new Error("wallet_pake_uninitialized");
    }
    const setup = await this.#serverSetup;
    const registrationResponse = await createOpaqueRegistrationResponse({
      registrationRequest: input.registrationRequest,
      serverSetup: setup,
      userIdentifier: walletIdentifier(input.userId),
    });
    const flowId = randomUUID();
    this.#registrations.set(flowId, {
      createdAt: existing?.createdAt ?? new Date().toISOString(),
      expiresAt: Date.now() + FLOW_TTL_MS,
      userId: input.userId,
    });
    return {
      flowId,
      profile: oneStatusOpaqueProfile,
      registrationResponse,
      serverPublicKey: await opaqueServerPublicKey(setup),
    };
  }

  async finishRegistration(input: {
    flowId: string;
    registrationRecord: string;
    userId: string;
  }): Promise<OpaquePasswordRecord> {
    const flow = this.#registrations.get(input.flowId);
    this.#registrations.delete(input.flowId);
    if (
      !flow ||
      flow.expiresAt <= Date.now() ||
      flow.userId !== input.userId
    ) {
      throw new Error("wallet_pake_invalid");
    }
    const record: OpaquePasswordRecord = {
      createdAt: flow.createdAt,
      profile: oneStatusOpaqueProfile,
      registrationRecord: input.registrationRecord,
      updatedAt: new Date().toISOString(),
      userId: input.userId,
    };
    await this.#store.set(record);
    return record;
  }

  consumeGrant(userId: string, walletGrant: string): boolean {
    if (!/^oswg1_[A-Za-z0-9_-]{43}$/u.test(walletGrant)) return false;
    const key = hashToken(walletGrant);
    const grant = this.#grants.get(key);
    this.#grants.delete(key);
    return Boolean(
      grant && grant.userId === userId && grant.expiresAt > Date.now(),
    );
  }

  close(): void {
    this.#grants.clear();
    this.#logins.clear();
    this.#registrations.clear();
  }

  #prepare(): void {
    const now = Date.now();
    for (const [id, flow] of this.#logins) {
      if (flow.expiresAt <= now) this.#logins.delete(id);
    }
    for (const [id, flow] of this.#registrations) {
      if (flow.expiresAt <= now) this.#registrations.delete(id);
    }
    for (const [id, grant] of this.#grants) {
      if (grant.expiresAt <= now) this.#grants.delete(id);
    }
    if (
      this.#logins.size + this.#registrations.size + this.#grants.size >=
      MAX_STATE_ENTRIES
    ) {
      throw new Error("wallet_pake_capacity_reached");
    }
  }
}

function walletIdentifier(userId: string): string {
  if (
    !userId ||
    userId.length > 500 ||
    /[\u0000-\u001f\u007f]/u.test(userId)
  ) {
    throw new Error("wallet_pake_user_invalid");
  }
  return `one-status-wallet:${userId}`;
}

function hashToken(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("base64url");
}
