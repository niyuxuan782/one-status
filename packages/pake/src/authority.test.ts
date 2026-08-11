import { describe, expect, it } from "vitest";
import {
  createOpaqueServerSetup,
  finishOpaqueLogin,
  finishOpaqueRegistration,
  startOpaqueLogin,
  startOpaqueRegistration,
} from "./index.js";
import {
  OpaquePasswordAuthority,
  type OpaquePasswordRecord,
} from "./authority.js";

describe("OPAQUE password authority", () => {
  it("issues one-use grants and changes a password without receiving it", async () => {
    let stored: OpaquePasswordRecord | null = null;
    const authority = new OpaquePasswordAuthority({
      serverSetup: createOpaqueServerSetup(),
      store: {
        async get() {
          return stored;
        },
        async set(record) {
          stored = record;
        },
      },
    });
    await register(authority, "user-1", "initial", "123456");
    const grant = await login(authority, "user-1", "123456");
    await register(
      authority,
      "user-1",
      "change",
      "new wallet password",
      grant,
    );
    await expect(login(authority, "user-1", "123456")).rejects.toThrow(
      "invalid wallet password",
    );
    await expect(
      login(authority, "user-1", "new wallet password"),
    ).resolves.toMatch(/^oswg1_/u);
  });
});

async function register(
  authority: OpaquePasswordAuthority,
  userId: string,
  authorization: "initial" | "change" | "reset",
  password: string,
  walletGrant?: string,
) {
  const started = await startOpaqueRegistration(password);
  const challenge = await authority.startRegistration({
    authorization,
    registrationRequest: started.registrationRequest,
    userId,
    walletGrant,
  });
  const finished = await finishOpaqueRegistration({
    clientRegistrationState: started.clientRegistrationState,
    password,
    profile: challenge.profile,
    registrationResponse: challenge.registrationResponse,
  });
  expect(finished.serverStaticPublicKey).toBe(challenge.serverPublicKey);
  await authority.finishRegistration({
    flowId: challenge.flowId,
    registrationRecord: finished.registrationRecord,
    userId,
  });
}

async function login(
  authority: OpaquePasswordAuthority,
  userId: string,
  password: string,
) {
  const started = await startOpaqueLogin(password);
  const challenge = await authority.startLogin({
    startLoginRequest: started.startLoginRequest,
    userId,
  });
  const finished = await finishOpaqueLogin({
    clientLoginState: started.clientLoginState,
    loginResponse: challenge.loginResponse,
    password,
    profile: challenge.profile,
  });
  if (!finished) throw new Error("invalid wallet password");
  return (
    await authority.finishLogin({
      finishLoginRequest: finished.finishLoginRequest,
      flowId: challenge.flowId,
      userId,
    })
  ).walletGrant;
}
