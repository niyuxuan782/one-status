import { randomUUID } from "node:crypto";
import { access, mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { AddressInfo } from "node:net";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import {
  getDefaultEnvironment,
  StdioClientTransport,
} from "@modelcontextprotocol/sdk/client/stdio.js";
import { createApp } from "@one-status/api";
import { OneStatusClient } from "@one-status/client";
import { exportStatusKey, generateStatusKey } from "@one-status/crypto";
import { saveLocalProfile } from "@one-status/local-config";

const root = resolve(fileURLToPath(new URL("../../..", import.meta.url)));

async function main(): Promise<void> {
  const directory = await mkdtemp(join(tmpdir(), "one-status-demo-"));
  const serverDirectory = join(directory, "server");
  const dbPath = join(serverDirectory, "one-status.sqlite");
  const app = createApp({ dbPath });
  const clients: McpConnection[] = [];

  try {
    await app.listen({ host: "127.0.0.1", port: 0 });
    const address = app.server.address() as AddressInfo;
    const baseUrl = `http://127.0.0.1:${address.port}`;
    const account = {
      email: `demo-${Date.now()}@one-status.test`,
      password: "one status demo password",
    };
    const accountClient = new OneStatusClient({ baseUrl });
    const statusKey = generateStatusKey();
    const deviceA = await accountClient.register(
      {
        ...account,
        deviceName: "Mac A / Claude Code",
      },
      statusKey,
    );
    const deviceB = await accountClient.login({
      ...account,
      deviceName: "Mac B / Codex",
    });
    const exportedKey = exportStatusKey(statusKey);

    const homeA = join(directory, "device-a");
    const homeB = join(directory, "device-b");
    await Promise.all([
      saveLocalProfile(
        {
          version: 1,
          baseUrl,
          userId: deviceA.userId,
          deviceId: deviceA.deviceId,
          deviceName: "Mac A / Claude Code",
          token: deviceA.token,
          tokenExpiresAt: deviceA.expiresAt,
          statusKey: exportedKey,
        },
        join(homeA, "profile.json"),
      ),
      saveLocalProfile(
        {
          version: 1,
          baseUrl,
          userId: deviceB.userId,
          deviceId: deviceB.deviceId,
          deviceName: "Mac B / Codex",
          token: deviceB.token,
          tokenExpiresAt: deviceB.expiresAt,
          statusKey: exportedKey,
        },
        join(homeB, "profile.json"),
      ),
    ]);

    console.log("[1/5] Account created; two independent devices registered.");

    const agentA = await connectAgent("claude-code", homeA);
    clients.push(agentA);
    await write(agentA.client, {
      type: "upsert_project",
      id: "one-status",
      name: "One Status",
      summary: "Portable identity, context, memory, and permission layer for AI.",
      techStack: ["TypeScript", "Rust"],
      currentGoal: "Build the MCP Gateway",
      decisions: ["E2EE", "Open Core"],
    });
    await write(agentA.client, {
      type: "set_preference",
      key: "packageManager",
      value: "pnpm",
    });
    await write(agentA.client, {
      type: "append_memory",
      scope: "user",
      content: "Prefer pnpm. Do not use npm for project commands.",
      tags: ["tooling", "preference"],
    });
    await write(agentA.client, {
      type: "update_context",
      projectId: "one-status",
      currentContext: "Implementing the OAuth Gateway. Google OAuth is in progress.",
    });
    await write(agentA.client, {
      type: "upsert_task",
      id: "oauth-gateway",
      projectId: "one-status",
      title: "Complete OAuth Gateway",
      status: "in_progress",
      completed: [],
      next: ["Google OAuth", "GitHub OAuth", "Slack OAuth"],
    });
    await agentA.close();
    clients.splice(clients.indexOf(agentA), 1);
    console.log("[2/5] Claude Code wrote project, memory, preference, and task state; process stopped.");

    const agentB = await connectAgent("codex", homeB);
    clients.push(agentB);
    const [contextOnB, profileOnB, memoryOnB] = await Promise.all([
      call(agentB.client, "status_get_context", {}),
      call(agentB.client, "status_get_profile", {}),
      call(agentB.client, "status_search_memory", {
        query: "pnpm",
        includeCandidates: true,
      }),
    ]);
    assertContains(contextOnB, "One Status");
    assertContains(profileOnB, "pnpm");
    assertContains(memoryOnB, "Do not use npm");
    console.log("[3/5] Codex recovered the same project context and pnpm preference with no local state from A.");

    await write(agentB.client, {
      type: "upsert_task",
      id: "oauth-gateway",
      projectId: "one-status",
      title: "Complete OAuth Gateway",
      status: "in_progress",
      completed: ["Google OAuth"],
      next: ["GitHub OAuth", "Slack OAuth"],
    });
    await write(agentB.client, {
      type: "update_context",
      projectId: "one-status",
      currentContext: "Google OAuth completed. Next: GitHub OAuth and Slack OAuth.",
    });
    await agentB.close();
    clients.splice(clients.indexOf(agentB), 1);
    console.log("[4/5] Codex updated the handoff state; process stopped.");

    const restartedA = await connectAgent("claude-code", homeA);
    clients.push(restartedA);
    const contextBackOnA = await call(
      restartedA.client,
      "status_get_context",
      {},
    );
    assertContains(contextBackOnA, "Google OAuth completed");
    assertContains(contextBackOnA, "GitHub OAuth");
    await restartedA.close();
    clients.splice(clients.indexOf(restartedA), 1);
    console.log("[5/5] Restarted Claude Code recovered Codex's latest handoff state.");

    await app.close();
    await assertServerHasNoPlaintext(serverDirectory, [
      "Prefer pnpm",
      "Google OAuth completed",
      "Build the MCP Gateway",
      account.password,
      exportedKey,
      deviceA.token,
      deviceB.token,
    ]);
    console.log("PASS: server persistence contains ciphertext and metadata; tested plaintext credentials and Status were absent.");
  } finally {
    await Promise.allSettled(clients.map((client) => client.close()));
    if (app.server.listening) {
      await app.close();
    }
    await rm(directory, { recursive: true, force: true });
  }
}

interface McpConnection {
  client: Client;
  close(): Promise<void>;
}

async function connectAgent(agentId: string, home: string): Promise<McpConnection> {
  const tsx = join(root, "node_modules", ".bin", "tsx");
  await access(tsx);
  const transport = new StdioClientTransport({
    command: tsx,
    args: [join(root, "apps", "mcp", "src", "main.ts")],
    cwd: root,
    env: {
      ...getDefaultEnvironment(),
      ONE_STATUS_HOME: home,
      ONE_STATUS_AGENT_ID: agentId,
    },
    stderr: "pipe",
  });
  const client = new Client({ name: `${agentId}-demo`, version: "1.0.0" });
  await client.connect(transport);
  return {
    client,
    async close() {
      await client.close();
    },
  };
}

async function write(client: Client, mutation: Record<string, unknown>) {
  return call(client, "write_status", { mutationId: randomUUID(), mutation });
}

async function call(
  client: Client,
  name: string,
  arguments_: Record<string, unknown>,
): Promise<unknown> {
  const response = await client.callTool({ name, arguments: arguments_ });
  if (response.isError) {
    throw new Error(`MCP tool ${name} failed: ${JSON.stringify(response.content)}`);
  }
  return response.structuredContent ?? response.content;
}

function assertContains(value: unknown, expected: string): void {
  if (!JSON.stringify(value).includes(expected)) {
    throw new Error(`Expected MCP result to contain ${JSON.stringify(expected)}.`);
  }
}

async function assertServerHasNoPlaintext(
  directory: string,
  secrets: string[],
): Promise<void> {
  const files = await readdir(directory);
  const contents = await Promise.all(
    files.map((file) => readFile(join(directory, file))),
  );
  const persisted = Buffer.concat(contents).toString("utf8");
  for (const secret of secrets) {
    if (persisted.includes(secret)) {
      throw new Error(`Server persistence leaked tested plaintext: ${secret}`);
    }
  }
}

await main();
