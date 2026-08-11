import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { wrapStatusKeyWithOpaqueExportKey } from "@one-status/crypto";
import {
  finishOpaqueLogin,
  finishOpaqueRegistration,
  startOpaqueLogin,
  startOpaqueRegistration,
  type OneStatusOpaqueProfile,
} from "@one-status/pake";
import { createEmptyStatus, type EncryptedEnvelope } from "@one-status/protocol";
import { WebSocket } from "ws";
import { afterEach, describe, expect, it } from "vitest";
import { createApp } from "./app.js";

const oauthIssuer = "http://127.0.0.1:9901";
const mcpResource = "http://127.0.0.1:9902/mcp";
const redirectUri = "https://chatgpt.com/connector_platform_oauth_redirect";
const initialEnvelope: EncryptedEnvelope = {
  format: "one-status.encrypted-status",
  version: 1,
  algorithm: "AES-256-GCM",
  revision: 1,
  iv: "iv-value",
  ciphertext: "initial-ciphertext-value",
  authTag: "auth-tag-value",
};
const statusKey = new Uint8Array(32).fill(9);

describe("Remote Cloud runtime", () => {
  const cleanups: Array<() => Promise<void> | void> = [];

  afterEach(async () => {
    await Promise.allSettled(cleanups.splice(0).reverse().map((cleanup) => cleanup()));
  });

  it("isolates the public OpenAI MCP resource to read-only Status scopes", async () => {
    const directory = await mkdtemp(join(tmpdir(), "one-status-openai-mcp-"));
    const app = createApp({
      authRateLimit: false,
      dbPath: join(directory, "cloud.sqlite"),
      remoteCloud: { issuer: oauthIssuer, resource: mcpResource },
    });
    await app.ready();
    cleanups.push(async () => {
      await app.close();
      await rm(directory, { recursive: true, force: true });
    });

    const publicResource = new URL("/openai/mcp", mcpResource).toString();
    const metadata = await app.inject({
      method: "GET",
      url: "/.well-known/oauth-protected-resource/openai/mcp",
    });
    expect(metadata.statusCode).toBe(200);
    expect(metadata.json()).toMatchObject({
      resource: publicResource,
      resource_name: "One Status for ChatGPT and Codex",
      scopes_supported: [
        "status:profile:read",
        "status:context:read",
        "status:memory:read",
      ],
    });

    const unauthorized = await app.inject({
      method: "POST",
      url: "/openai/mcp",
      payload: {
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: "2025-06-18",
          capabilities: {},
          clientInfo: { name: "review", version: "1.0.0" },
        },
      },
    });
    expect(unauthorized.statusCode).toBe(401);
    expect(unauthorized.headers["www-authenticate"]).toContain(
      "/.well-known/oauth-protected-resource/openai/mcp",
    );

    const clientId = await registerOAuthClient(app);
    const rejected = await app.inject({
      method: "GET",
      url:
        "/oauth/authorize?" +
        new URLSearchParams({
          response_type: "code",
          client_id: clientId,
          redirect_uri: redirectUri,
          code_challenge: "a".repeat(43),
          code_challenge_method: "S256",
          scope: "status:profile:read vault:read",
          resource: publicResource,
        }),
    });
    expect(rejected.statusCode).toBe(400);
    expect(rejected.body).toContain("requested OAuth scope is not supported");
  });

  it("routes an OAuth Remote MCP profile read to the authenticated user's Desktop", async () => {
    const directory = await mkdtemp(join(tmpdir(), "one-status-remote-cloud-"));
    const app = createApp({
      authRateLimit: false,
      dbPath: join(directory, "cloud.sqlite"),
      remoteCloud: { issuer: oauthIssuer, resource: mcpResource },
    });
    await app.listen({ host: "127.0.0.1", port: 0 });
    const port = (app.server.address() as AddressInfo).port;
    cleanups.push(async () => {
      await app.close();
      await rm(directory, { recursive: true, force: true });
    });

    const device = await registerOpaque(app, {
      deviceName: "Online Mac",
      email: "remote-user@example.test",
      password: "correct horse battery staple",
    });
    const desktop = new WebSocket(`ws://127.0.0.1:${port}/v1/relay`, {
      headers: { authorization: `Bearer ${device.token}` },
    });
    await opened(desktop);
    cleanups.push(() => desktop.close());
    desktop.send(
      JSON.stringify({
        type: "hello",
        capabilities: [
          "status.read",
          "tools.list",
          "tools.request_approval",
          "tools.execute",
          "credentials.create",
          "credentials.delete",
          "credentials.get",
          "credentials.list",
          "credentials.resolve",
          "credentials.update",
        ],
      }),
    );
    desktop.on("message", (data) => {
      const request = JSON.parse(data.toString()) as Record<string, unknown>;
      if (request.type !== "request") return;
      let result: unknown;
      if (request.operation === "status.read") {
        const status = createEmptyStatus();
        status.identity = { displayName: "Remote Ryan" };
        status.preferences = { language: "zh-CN" };
        const view = (request.payload as { view?: string } | undefined)?.view;
        if (view !== "profile") throw new Error("Unexpected status view.");
        result = {
          version: 3,
          identity: status.identity,
          preferences: status.preferences,
          personaProfile: status.persona.profile,
        };
      } else if (request.operation === "tools.list") {
        result = {
          connections: [
            {
              id: "22222222-2222-4222-8222-222222222222",
              provider: "google_calendar",
              actions: ["calendar.list_events"],
            },
          ],
        };
      } else if (request.operation === "tools.execute") {
        result = {
          result: {
            events: [{ title: "Product review", startsAt: "2026-08-12T14:00:00+08:00" }],
          },
        };
      } else if (request.operation === "credentials.resolve") {
        result = {
          credentials: [
            {
              id: "33333333-3333-4333-8333-333333333333",
              kind: "api",
              label: "Calendar automation account",
              secrets: { apiKey: "********" },
            },
          ],
        };
      } else if (request.operation === "credentials.get") {
        result = {
          credential: {
            id: "33333333-3333-4333-8333-333333333333",
            kind: "api",
            secrets: { apiKey: "temporary-test-secret" },
          },
        };
      } else {
        result = { approval: { state: "pending" } };
      }
      desktop.send(
        JSON.stringify({
          type: "response",
          requestId: request.requestId,
          ok: true,
          result,
        }),
      );
    });
    await waitForRelayHello();

    const oauthClient = await registerOAuthClient(app);
    const accessToken = await authorize(app, oauthClient);
    const client = new Client({ name: "remote-test", version: "1.0.0" });
    const transport = new StreamableHTTPClientTransport(
      new URL(`http://127.0.0.1:${port}/mcp`),
      { requestInit: { headers: { authorization: `Bearer ${accessToken}` } } },
    );
    await client.connect(transport);
    cleanups.push(() => client.close());

    const tools = await client.listTools();
    expect(tools.tools.map((tool) => tool.name)).toEqual([
      "status_get_profile",
      "status_get_context",
      "status_get_memory",
      "devices_list",
      "tools_list",
      "tools_request_approval",
      "tools_execute",
      "credentials_request_approval",
      "credentials_list",
      "credentials_resolve",
      "credentials_get",
      "credentials_register",
      "credentials_update",
      "credentials_delete",
    ]);
    const profile = await client.callTool({
      name: "status_get_profile",
      arguments: {},
    });
    expect(profile.structuredContent).toMatchObject({
      version: 3,
      identity: { displayName: "Remote Ryan" },
      preferences: { language: "zh-CN" },
    });
    const devices = await client.callTool({ name: "devices_list", arguments: {} });
    expect(devices.structuredContent).toMatchObject({
      devices: [
        {
          id: device.deviceId,
          name: "Online Mac",
          online: true,
          relayCapabilities: expect.arrayContaining([
            "status.read",
            "tools.list",
            "tools.execute",
          ]),
        },
      ],
    });
    const availableTools = await client.callTool({
      name: "tools_list",
      arguments: {},
    });
    expect(availableTools.structuredContent).toMatchObject({
      deviceId: device.deviceId,
      result: {
        connections: [
          expect.objectContaining({ provider: "google_calendar" }),
        ],
      },
    });
    const calendar = await client.callTool({
      name: "tools_execute",
      arguments: {
        connectionId: "22222222-2222-4222-8222-222222222222",
        action: "calendar.list_events",
        arguments: { timeMin: "2026-08-12T12:00:00+08:00" },
      },
    });
    expect(JSON.stringify(calendar.structuredContent)).toContain("Product review");
    const resolved = await client.callTool({
      name: "credentials_resolve",
      arguments: { purpose: "calendar.automation", kinds: ["api"] },
    });
    expect(JSON.stringify(resolved.structuredContent)).not.toContain(
      "temporary-test-secret",
    );
    const credential = await client.callTool({
      name: "credentials_get",
      arguments: {
        credentialId: "33333333-3333-4333-8333-333333333333",
        purpose: "calendar.automation",
      },
    });
    expect(credential.structuredContent).toMatchObject({
      deviceId: device.deviceId,
      result: {
        credential: { secrets: { apiKey: "temporary-test-secret" } },
      },
    });

    const publicOAuthClient = await registerOAuthClient(app);
    const publicResource = new URL("/openai/mcp", mcpResource).toString();
    const publicAccessToken = await authorize(app, publicOAuthClient, {
      resource: publicResource,
      scope:
        "status:profile:read status:context:read status:memory:read",
    });
    const publicClient = new Client({
      name: "openai-plugin-review",
      version: "1.0.0",
    });
    const publicTransport = new StreamableHTTPClientTransport(
      new URL(`http://127.0.0.1:${port}/openai/mcp`),
      {
        requestInit: {
          headers: { authorization: `Bearer ${publicAccessToken}` },
        },
      },
    );
    await publicClient.connect(publicTransport);
    cleanups.push(() => publicClient.close());
    await expect(publicClient.listTools()).resolves.toMatchObject({
      tools: [
        { name: "status_get_profile", outputSchema: { type: "object" } },
        { name: "status_get_context", outputSchema: { type: "object" } },
        { name: "status_get_memory", outputSchema: { type: "object" } },
      ],
    });
  });

  it("returns device_offline without exposing internal Relay details", async () => {
    const directory = await mkdtemp(join(tmpdir(), "one-status-remote-offline-"));
    const app = createApp({
      authRateLimit: false,
      dbPath: join(directory, "cloud.sqlite"),
      remoteCloud: { issuer: oauthIssuer, resource: mcpResource },
    });
    await app.listen({ host: "127.0.0.1", port: 0 });
    const port = (app.server.address() as AddressInfo).port;
    cleanups.push(async () => {
      await app.close();
      await rm(directory, { recursive: true, force: true });
    });
    await registerOpaque(app, {
      deviceName: "Offline Mac",
      email: "remote-user@example.test",
      password: "correct horse battery staple",
    });
    const oauthClient = await registerOAuthClient(app);
    const accessToken = await authorize(app, oauthClient);
    const client = new Client({ name: "offline-test", version: "1.0.0" });
    const transport = new StreamableHTTPClientTransport(
      new URL(`http://127.0.0.1:${port}/mcp`),
      { requestInit: { headers: { authorization: `Bearer ${accessToken}` } } },
    );
    await client.connect(transport);
    cleanups.push(() => client.close());

    await expect(
      client.callTool({ name: "status_get_profile", arguments: {} }),
    ).resolves.toMatchObject({
      isError: true,
      content: [{ type: "text", text: "device_offline" }],
    });
  });

  it("uses Cloud Vault while every Desktop device is offline", async () => {
    const directory = await mkdtemp(join(tmpdir(), "one-status-cloud-vault-"));
    const operations: string[] = [];
    const app = createApp({
      authRateLimit: false,
      dbPath: join(directory, "cloud.sqlite"),
      remoteCloud: {
        issuer: oauthIssuer,
        resource: mcpResource,
        vault: {
          async createAgentGateway(session) {
            expect(session).toMatchObject({
              agentId: expect.stringMatching(/^remote:/u),
              subject: expect.any(String),
            });
            return {
              async credential(operation) {
                operations.push(operation);
                if (operation === "credentials.get") {
                  return {
                    credential: {
                      id: "33333333-3333-4333-8333-333333333333",
                      secrets: { apiKey: "cloud-runtime-secret" },
                    },
                  };
                }
                return {
                  credentials: [
                    {
                      id: "33333333-3333-4333-8333-333333333333",
                      kind: "api",
                      secrets: { apiKey: "********" },
                    },
                  ],
                };
              },
            };
          },
        },
      },
    });
    await app.listen({ host: "127.0.0.1", port: 0 });
    const port = (app.server.address() as AddressInfo).port;
    cleanups.push(async () => {
      await app.close();
      await rm(directory, { recursive: true, force: true });
    });
    await registerOpaque(app, {
      deviceName: "Offline Mac",
      email: "remote-user@example.test",
      password: "correct horse battery staple",
    });
    const oauthClient = await registerOAuthClient(app);
    const accessToken = await authorize(app, oauthClient);
    const client = new Client({ name: "cloud-vault-test", version: "1.0.0" });
    const transport = new StreamableHTTPClientTransport(
      new URL(`http://127.0.0.1:${port}/mcp`),
      { requestInit: { headers: { authorization: `Bearer ${accessToken}` } } },
    );
    await client.connect(transport);
    cleanups.push(() => client.close());

    await expect(
      client.callTool({
        name: "credentials_get",
        arguments: {
          credentialId: "33333333-3333-4333-8333-333333333333",
          purpose: "model.use",
        },
      }),
    ).resolves.toMatchObject({
      structuredContent: {
        credential: { secrets: { apiKey: "cloud-runtime-secret" } },
      },
    });
    expect(operations).toEqual(["credentials.get"]);
  });
});

async function registerOAuthClient(
  app: ReturnType<typeof createApp>,
): Promise<string> {
  const response = await app.inject({
    method: "POST",
    url: "/oauth/register",
    payload: {
      client_name: "Remote Test Agent",
      redirect_uris: [redirectUri],
      token_endpoint_auth_method: "none",
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
    },
  });
  expect(response.statusCode).toBe(201);
  return (response.json() as { client_id: string }).client_id;
}

async function authorize(
  app: ReturnType<typeof createApp>,
  clientId: string,
  options: { resource?: string; scope?: string } = {},
): Promise<string> {
  const accountProof = await createAccountProof(
    app,
    "remote-user@example.test",
    "correct horse battery staple",
  );
  const verifier = "v".repeat(64);
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  const start = await app.inject({
    method: "GET",
    url:
      "/oauth/authorize?" +
      new URLSearchParams({
        response_type: "code",
        client_id: clientId,
        redirect_uri: redirectUri,
        code_challenge: challenge,
        code_challenge_method: "S256",
        scope:
          options.scope ??
          "status:read devices:read tools:read tools:execute vault:read vault:write",
        resource: options.resource ?? mcpResource,
        state: "remote-test-state",
      }),
  });
  const request = start.body.match(/name="request" value="([^"]+)"/u)?.[1];
  expect(request).toBeTruthy();
  const approval = await app.inject({
    method: "POST",
    url: "/oauth/authorize",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    payload: new URLSearchParams({
      request: request!,
      decision: "allow",
      accountProof,
    }).toString(),
  });
  const callback = new URL(String(approval.headers.location));
  const code = callback.searchParams.get("code");
  expect(code).toBeTruthy();
  const token = await app.inject({
    method: "POST",
    url: "/oauth/token",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    payload: new URLSearchParams({
      grant_type: "authorization_code",
      code: code!,
      client_id: clientId,
      redirect_uri: redirectUri,
      code_verifier: verifier,
      resource: options.resource ?? mcpResource,
    }).toString(),
  });
  expect(token.statusCode).toBe(200);
  return (token.json() as { access_token: string }).access_token;
}

async function registerOpaque(
  app: ReturnType<typeof createApp>,
  input: { deviceName: string; email: string; password: string },
): Promise<{ deviceId: string; token: string; userId: string }> {
  const started = await startOpaqueRegistration(input.password);
  const startResponse = await app.inject({
    method: "POST",
    payload: {
      email: input.email,
      registrationRequest: started.registrationRequest,
    },
    url: "/v1/auth/opaque/register/start",
  });
  expect(startResponse.statusCode).toBe(200);
  const challenge = startResponse.json<OpaqueRegistrationChallenge>();
  const finished = await finishOpaqueRegistration({
    clientRegistrationState: started.clientRegistrationState,
    password: input.password,
    profile: challenge.profile,
    registrationResponse: challenge.registrationResponse,
  });
  const wrappedStatusKey = wrapStatusKeyWithOpaqueExportKey(
    statusKey,
    finished.exportKey,
    challenge.accountBinding,
  );
  const response = await app.inject({
    method: "POST",
    payload: {
      deviceName: input.deviceName,
      flowId: challenge.flowId,
      initialEnvelope,
      registrationRecord: finished.registrationRecord,
      wrappedStatusKey,
    },
    url: "/v1/auth/opaque/register/finish",
  });
  expect(response.statusCode).toBe(201);
  return response.json();
}

async function createAccountProof(
  app: ReturnType<typeof createApp>,
  email: string,
  password: string,
): Promise<string> {
  const started = await startOpaqueLogin(password);
  const startResponse = await app.inject({
    method: "POST",
    payload: {
      email,
      purpose: "oauth-authorize",
      startLoginRequest: started.startLoginRequest,
    },
    url: "/v1/auth/opaque/proof/start",
  });
  expect(startResponse.statusCode).toBe(200);
  const challenge = startResponse.json<OpaqueLoginChallenge>();
  const finished = await finishOpaqueLogin({
    clientLoginState: started.clientLoginState,
    loginResponse: challenge.loginResponse,
    password,
    profile: challenge.profile,
  });
  if (!finished) throw new Error("Test OPAQUE proof unexpectedly failed locally.");
  const finishResponse = await app.inject({
    method: "POST",
    payload: {
      finishLoginRequest: finished.finishLoginRequest,
      flowId: challenge.flowId,
    },
    url: "/v1/auth/opaque/proof/finish",
  });
  expect(finishResponse.statusCode).toBe(200);
  return finishResponse.json<{ proofToken: string }>().proofToken;
}

interface OpaqueRegistrationChallenge {
  accountBinding: string;
  flowId: string;
  profile: OneStatusOpaqueProfile;
  registrationResponse: string;
}

interface OpaqueLoginChallenge {
  flowId: string;
  loginResponse: string;
  profile: OneStatusOpaqueProfile;
}

async function opened(socket: WebSocket): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    socket.once("open", resolve);
    socket.once("error", reject);
  });
}

async function waitForRelayHello(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 25));
}
