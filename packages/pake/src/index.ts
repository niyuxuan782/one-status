import * as opaque from "@serenity-kit/opaque";

const OPAQUE_VALUE_PATTERN = /^[A-Za-z0-9_-]+$/u;
const MAX_OPAQUE_VALUE_LENGTH = 16_384;

export const oneStatusOpaqueSuite = "opaque-rfc9807-ristretto255-sha512" as const;
export const oneStatusOpaqueKeyStretching = "memory-constrained" as const;
export const oneStatusOpaqueProfile = {
  version: 1,
  suite: oneStatusOpaqueSuite,
  keyStretching: oneStatusOpaqueKeyStretching,
  argon2id: {
    memoryKiB: 65_536,
    iterations: 3,
    parallelism: 4,
  },
} as const;

export type OneStatusOpaqueProfile = typeof oneStatusOpaqueProfile;

export interface OpaqueClientRegistrationStart {
  clientRegistrationState: string;
  registrationRequest: string;
}

export interface OpaqueClientRegistrationFinish {
  exportKey: string;
  registrationRecord: string;
  serverStaticPublicKey: string;
}

export interface OpaqueClientLoginStart {
  clientLoginState: string;
  startLoginRequest: string;
}

export interface OpaqueClientLoginFinish {
  exportKey: string;
  finishLoginRequest: string;
  serverStaticPublicKey: string;
  sessionKey: string;
}

export interface OpaqueServerLoginStart {
  loginResponse: string;
  serverLoginState: string;
}

export async function createOpaqueServerSetup(): Promise<string> {
  await opaque.ready;
  return opaque.server.createSetup();
}

export async function opaqueServerPublicKey(serverSetup: string): Promise<string> {
  await opaque.ready;
  return opaque.server.getPublicKey(validOpaqueValue(serverSetup, "server setup"));
}

export async function startOpaqueRegistration(
  password: string,
): Promise<OpaqueClientRegistrationStart> {
  await opaque.ready;
  return opaque.client.startRegistration({ password: validPassword(password) });
}

export async function createOpaqueRegistrationResponse(input: {
  registrationRequest: string;
  serverSetup: string;
  userIdentifier: string;
}): Promise<string> {
  await opaque.ready;
  return opaque.server.createRegistrationResponse({
    registrationRequest: validOpaqueValue(
      input.registrationRequest,
      "registration request",
    ),
    serverSetup: validOpaqueValue(input.serverSetup, "server setup"),
    userIdentifier: validIdentifier(input.userIdentifier),
  }).registrationResponse;
}

export async function finishOpaqueRegistration(input: {
  clientRegistrationState: string;
  password: string;
  profile?: OneStatusOpaqueProfile;
  registrationResponse: string;
}): Promise<OpaqueClientRegistrationFinish> {
  await opaque.ready;
  const result = opaque.client.finishRegistration({
    clientRegistrationState: validOpaqueValue(
      input.clientRegistrationState,
      "client registration state",
    ),
    keyStretching: profileKeyStretching(input.profile),
    password: validPassword(input.password),
    registrationResponse: validOpaqueValue(
      input.registrationResponse,
      "registration response",
    ),
  });
  return {
    exportKey: validOpaqueValue(result.exportKey, "export key"),
    registrationRecord: validOpaqueValue(
      result.registrationRecord,
      "registration record",
    ),
    serverStaticPublicKey: validOpaqueValue(
      result.serverStaticPublicKey,
      "server public key",
    ),
  };
}

export async function startOpaqueLogin(
  password: string,
): Promise<OpaqueClientLoginStart> {
  await opaque.ready;
  return opaque.client.startLogin({ password: validPassword(password) });
}

export async function startOpaqueServerLogin(input: {
  registrationRecord?: string | null;
  serverSetup: string;
  startLoginRequest: string;
  userIdentifier: string;
}): Promise<OpaqueServerLoginStart> {
  await opaque.ready;
  return opaque.server.startLogin({
    registrationRecord: input.registrationRecord
      ? validOpaqueValue(input.registrationRecord, "registration record")
      : null,
    serverSetup: validOpaqueValue(input.serverSetup, "server setup"),
    startLoginRequest: validOpaqueValue(
      input.startLoginRequest,
      "login request",
    ),
    userIdentifier: validIdentifier(input.userIdentifier),
  });
}

export async function finishOpaqueLogin(input: {
  clientLoginState: string;
  loginResponse: string;
  password: string;
  profile?: OneStatusOpaqueProfile;
}): Promise<OpaqueClientLoginFinish | null> {
  await opaque.ready;
  const result = opaque.client.finishLogin({
    clientLoginState: validOpaqueValue(
      input.clientLoginState,
      "client login state",
    ),
    keyStretching: profileKeyStretching(input.profile),
    loginResponse: validOpaqueValue(input.loginResponse, "login response"),
    password: validPassword(input.password),
  });
  if (!result) return null;
  return {
    exportKey: validOpaqueValue(result.exportKey, "export key"),
    finishLoginRequest: validOpaqueValue(
      result.finishLoginRequest,
      "login finish request",
    ),
    serverStaticPublicKey: validOpaqueValue(
      result.serverStaticPublicKey,
      "server public key",
    ),
    sessionKey: validOpaqueValue(result.sessionKey, "session key"),
  };
}

export async function finishOpaqueServerLogin(input: {
  finishLoginRequest: string;
  serverLoginState: string;
}): Promise<string> {
  await opaque.ready;
  return opaque.server.finishLogin({
    finishLoginRequest: validOpaqueValue(
      input.finishLoginRequest,
      "login finish request",
    ),
    serverLoginState: validOpaqueValue(
      input.serverLoginState,
      "server login state",
    ),
  }).sessionKey;
}

export function opaqueSessionKeysMatch(
  clientSessionKey: string,
  serverSessionKey: string,
): boolean {
  return validOpaqueValue(clientSessionKey, "client session key") ===
    validOpaqueValue(serverSessionKey, "server session key");
}

function validPassword(value: string): string {
  if (typeof value !== "string" || value.length < 6 || value.length > 256) {
    throw new Error("Password must contain between 6 and 256 characters.");
  }
  return value;
}

function validIdentifier(value: string): string {
  if (
    typeof value !== "string" ||
    value.length < 1 ||
    value.length > 500 ||
    value !== value.trim() ||
    /[\u0000-\u001f\u007f]/u.test(value)
  ) {
    throw new Error("OPAQUE user identifier is invalid.");
  }
  return value;
}

function validOpaqueValue(value: string, label: string): string {
  if (
    typeof value !== "string" ||
    value.length < 1 ||
    value.length > MAX_OPAQUE_VALUE_LENGTH ||
    !OPAQUE_VALUE_PATTERN.test(value)
  ) {
    throw new Error(`OPAQUE ${label} is invalid.`);
  }
  return value;
}

function profileKeyStretching(
  value?: OneStatusOpaqueProfile,
): typeof oneStatusOpaqueKeyStretching {
  const profile = value ?? oneStatusOpaqueProfile;
  if (
    profile.version !== oneStatusOpaqueProfile.version ||
    profile.suite !== oneStatusOpaqueProfile.suite ||
    profile.keyStretching !== oneStatusOpaqueProfile.keyStretching ||
    profile.argon2id.memoryKiB !== oneStatusOpaqueProfile.argon2id.memoryKiB ||
    profile.argon2id.iterations !== oneStatusOpaqueProfile.argon2id.iterations ||
    profile.argon2id.parallelism !== oneStatusOpaqueProfile.argon2id.parallelism
  ) {
    throw new Error("OPAQUE profile is unsupported.");
  }
  return profile.keyStretching;
}
