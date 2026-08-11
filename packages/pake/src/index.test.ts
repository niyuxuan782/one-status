import { describe, expect, it } from "vitest";
import {
  createOpaqueRegistrationResponse,
  createOpaqueServerSetup,
  finishOpaqueLogin,
  finishOpaqueRegistration,
  finishOpaqueServerLogin,
  opaqueSessionKeysMatch,
  startOpaqueLogin,
  startOpaqueRegistration,
  startOpaqueServerLogin,
} from "./index.js";

describe("One Status OPAQUE", () => {
  it("registers and authenticates without sharing the password with the server", async () => {
    const password = "opaque account password";
    const serverSetup = await createOpaqueServerSetup();
    const registrationStart = await startOpaqueRegistration(password);
    const registrationResponse = await createOpaqueRegistrationResponse({
      registrationRequest: registrationStart.registrationRequest,
      serverSetup,
      userIdentifier: "user@example.test",
    });
    const registration = await finishOpaqueRegistration({
      clientRegistrationState: registrationStart.clientRegistrationState,
      password,
      registrationResponse,
    });

    const loginStart = await startOpaqueLogin(password);
    const serverLogin = await startOpaqueServerLogin({
      registrationRecord: registration.registrationRecord,
      serverSetup,
      startLoginRequest: loginStart.startLoginRequest,
      userIdentifier: "user@example.test",
    });
    const clientLogin = await finishOpaqueLogin({
      clientLoginState: loginStart.clientLoginState,
      loginResponse: serverLogin.loginResponse,
      password,
    });
    expect(clientLogin).not.toBeNull();
    const serverSessionKey = await finishOpaqueServerLogin({
      finishLoginRequest: clientLogin!.finishLoginRequest,
      serverLoginState: serverLogin.serverLoginState,
    });
    expect(
      opaqueSessionKeysMatch(clientLogin!.sessionKey, serverSessionKey),
    ).toBe(true);
    expect(clientLogin!.exportKey).toBe(registration.exportKey);
  }, 20_000);

  it("rejects the wrong password on the client", async () => {
    const serverSetup = await createOpaqueServerSetup();
    const registrationStart = await startOpaqueRegistration("correct password");
    const registrationResponse = await createOpaqueRegistrationResponse({
      registrationRequest: registrationStart.registrationRequest,
      serverSetup,
      userIdentifier: "user@example.test",
    });
    const registration = await finishOpaqueRegistration({
      clientRegistrationState: registrationStart.clientRegistrationState,
      password: "correct password",
      registrationResponse,
    });
    const loginStart = await startOpaqueLogin("incorrect password");
    const serverLogin = await startOpaqueServerLogin({
      registrationRecord: registration.registrationRecord,
      serverSetup,
      startLoginRequest: loginStart.startLoginRequest,
      userIdentifier: "user@example.test",
    });
    await expect(
      finishOpaqueLogin({
        clientLoginState: loginStart.clientLoginState,
        loginResponse: serverLogin.loginResponse,
        password: "incorrect password",
      }),
    ).resolves.toBeNull();
  }, 20_000);
});
