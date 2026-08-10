import {
  chmod,
  mkdir,
  mkdtemp,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import {
  discoverLocalModelCredentials,
  localModelSourceId,
  scanLocalInventory,
  type LocalInventoryOptions,
} from "./local-inventory.js";

describe("local inventory", () => {
  let directory: string | undefined;

  afterEach(async () => {
    if (directory) await rm(directory, { recursive: true, force: true });
  });

  it("uses the shared Status key to conceal credential fingerprints in source IDs", () => {
    const model = {
      providerId: "third-party",
      protocol: "openai" as const,
      endpoint: "https://api.example.test/v1",
      credentialFingerprint: "a".repeat(64),
    };
    const first = localModelSourceId(model, new Uint8Array(32).fill(1));
    const same = localModelSourceId(model, new Uint8Array(32).fill(1));
    const anotherAccount = localModelSourceId(
      model,
      new Uint8Array(32).fill(2),
    );

    expect(first).toBe(same);
    expect(first).not.toBe(anotherAccount);
    expect(first).not.toContain("a".repeat(16));
  });

  it("discovers local assets while removing MCP secret values", async () => {
    directory = await mkdtemp(join(tmpdir(), "one-status-inventory-"));
    const home = join(directory, "home");
    const bin = join(directory, "bin");
    const project = join(directory, "project");
    const linkedProject = join(directory, "linked-project");
    await mkdir(join(home, ".codex", "skills", "sample"), {
      recursive: true,
    });
    await mkdir(join(home, ".claude", "plugins"), { recursive: true });
    await mkdir(join(project, ".git"), { recursive: true });
    await mkdir(bin, { recursive: true });
    await writeFile(join(bin, "codex"), "#!/bin/sh\nexit 0\n");
    await chmod(join(bin, "codex"), 0o755);
    await writeFile(join(bin, "claude"), "#!/bin/sh\nexit 0\n");
    await chmod(join(bin, "claude"), 0o755);
    await writeFile(join(project, "package.json"), "{}\n");
    await writeFile(join(project, "AGENTS.md"), "project rules\n");
    await writeFile(join(project, ".git", "HEAD"), "ref: refs/heads/main\n");
    await symlink(project, linkedProject);
    await writeFile(
      join(home, ".codex", "config.toml"),
      `model = "gpt-test"\nmodel_provider = "custom-openai"\n[model_providers.custom-openai]\nname = "Third-party A"\nbase_url = "https://api.example.test/v1?secret=query"\nenv_key = "CODEX_API_KEY"\n[projects.${JSON.stringify(project)}]\ntrust_level = "trusted"\n[projects.${JSON.stringify(linkedProject)}]\ntrust_level = "trusted"\n`,
    );
    await writeFile(
      join(home, ".claude.json"),
      JSON.stringify({
        projects: { [project]: {} },
        mcpServers: {
          remote: {
            type: "http",
            url: "https://mcp.example.test/path?token=CLAUDE_QUERY_SECRET",
            env: { ACCESS_TOKEN: "CLAUDE_ENV_SECRET" },
          },
        },
      }),
    );
    await writeFile(
      join(home, ".codex", "skills", "sample", "SKILL.md"),
      "---\nname: sample-skill\ndescription: Safe description\n---\nTOP_SECRET_SKILL_BODY\n",
    );
    await writeFile(
      join(home, ".claude", "plugins", "installed_plugins.json"),
      JSON.stringify({ version: 1, plugins: {} }),
    );
    await writeFile(
      join(home, ".claude", "settings.json"),
      JSON.stringify({
        model: "claude-test",
        env: {
          ANTHROPIC_API_KEY: "CLAUDE_MODEL_KEY_SECRET",
          ANTHROPIC_BASE_URL: "https://claude.example.test/v1",
        },
      }),
    );

    const options: LocalInventoryOptions = {
      homeDir: home,
      environment: {
        HOME: home,
        PATH: [bin].join(delimiter),
        CODEX_HOME: join(home, ".codex"),
        CODEX_API_KEY: "CODEX_MODEL_KEY_SECRET",
        ONE_STATUS_INVENTORY_RUN_AGENT_COMMANDS: "true",
        ONE_STATUS_SCAN_ROOTS: [project, linkedProject].join(delimiter),
      },
      async runCommand(_executable, arguments_) {
        if (arguments_.join(" ") === "--version") return "codex 1.2.3";
        if (arguments_.join(" ") === "mcp list --json") {
          return JSON.stringify([
            {
              name: "local-memory",
              enabled: true,
              transport: {
                type: "stdio",
                command: "/secret/path/memory-server",
                env: { API_TOKEN: "CODEX_ENV_SECRET" },
              },
            },
          ]);
        }
        if (arguments_.join(" ") === "plugin list --json") {
          return JSON.stringify({
            installed: [
              { name: "documents", enabled: true, version: "1.0.0" },
            ],
          });
        }
        throw new Error("Unexpected command");
      },
    };
    const snapshot = await scanLocalInventory(options);

    expect(snapshot.projects).toHaveLength(1);
    expect(snapshot.projects[0]).toMatchObject({
      path: await realpath(project),
      git: true,
      branch: "main",
      agents: ["claude-code", "codex"],
    });
    expect(snapshot.skills).toEqual([
      expect.objectContaining({ name: "sample-skill", agent: "codex" }),
    ]);
    expect(snapshot.agents[0]).toMatchObject({
      id: "codex",
      model: {
        modelId: "gpt-test",
        providerId: "custom-openai",
        providerLabel: "Third-party A",
        sourceKind: "compatible-api",
        protocol: "openai",
        endpoint: "https://api.example.test/v1",
        endpointHost: "api.example.test",
        credentialStatus: "available",
        credentialFingerprint: expect.stringMatching(/^[a-f0-9]{64}$/),
        health: "healthy",
      },
    });
    expect(snapshot.agents[1]).toMatchObject({
      id: "claude-code",
      model: {
        modelId: "claude-test",
        sourceKind: "compatible-api",
        protocol: "anthropic",
        endpoint: "https://claude.example.test/v1",
        credentialStatus: "available",
        credentialFingerprint: expect.stringMatching(/^[a-f0-9]{64}$/),
      },
    });
    const credentials = await discoverLocalModelCredentials(options);
    expect(credentials).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          apiKey: "CODEX_MODEL_KEY_SECRET",
          sourceId: expect.stringMatching(
            /^custom-openai-[a-f0-9]{12}-[a-f0-9]{16}$/,
          ),
          toolId: "codex",
        }),
        expect.objectContaining({
          apiKey: "CLAUDE_MODEL_KEY_SECRET",
          sourceId: expect.stringMatching(
            /^anthropic-[a-f0-9]{12}-[a-f0-9]{12}-[a-f0-9]{16}$/,
          ),
          toolId: "claude-code",
        }),
      ]),
    );
    expect(snapshot.mcpServers).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: "remote",
          endpoint: "https://mcp.example.test/path",
          envNames: ["ACCESS_TOKEN"],
        }),
        expect.objectContaining({
          name: "local-memory",
          command: "memory-server",
          envNames: ["API_TOKEN"],
        }),
      ]),
    );
    const serialized = JSON.stringify(snapshot);
    expect(serialized).not.toContain("CLAUDE_QUERY_SECRET");
    expect(serialized).not.toContain("CLAUDE_ENV_SECRET");
    expect(serialized).not.toContain("CODEX_ENV_SECRET");
    expect(serialized).not.toContain("CODEX_MODEL_KEY_SECRET");
    expect(serialized).not.toContain("CLAUDE_MODEL_KEY_SECRET");
    expect(serialized).not.toContain("secret=query");
    expect(serialized).not.toContain("TOP_SECRET_SKILL_BODY");
  });

  it("reports a Sidecar-managed Codex bearer credential without exposing it", async () => {
    directory = await mkdtemp(join(tmpdir(), "one-status-inventory-"));
    const home = join(directory, "home");
    const bin = join(directory, "bin");
    await mkdir(join(home, ".codex"), { recursive: true });
    await mkdir(bin, { recursive: true });
    await writeFile(join(bin, "codex"), "#!/bin/sh\nexit 0\n");
    await chmod(join(bin, "codex"), 0o755);
    await writeFile(
      join(home, ".codex", "config.toml"),
      `model = "gpt-managed"\nmodel_provider = "managed"\n[model_providers.managed]\nname = "Managed provider"\nbase_url = "https://api.example.test/v1"\nexperimental_bearer_token = "SIDECAR_MANAGED_SECRET"\n`,
    );

    const snapshot = await scanLocalInventory({
      homeDir: home,
      environment: {
        HOME: home,
        PATH: bin,
        CODEX_HOME: join(home, ".codex"),
      },
    });

    expect(snapshot.agents[0]).toMatchObject({
      id: "codex",
      model: {
        modelId: "gpt-managed",
        credentialStatus: "available",
        health: "healthy",
      },
    });
    expect(JSON.stringify(snapshot)).not.toContain("SIDECAR_MANAGED_SECRET");
  });

  it("discovers a Codex auth.json API key for the active provider", async () => {
    directory = await mkdtemp(join(tmpdir(), "one-status-inventory-"));
    const home = join(directory, "home");
    const codexHome = join(home, ".codex");
    await mkdir(codexHome, { recursive: true });
    await writeFile(
      join(codexHome, "config.toml"),
      `model = "gpt-auth"\nmodel_provider = "auth-provider"\n[model_providers.auth-provider]\nbase_url = "https://auth.example.test/v1"\n`,
    );
    await writeFile(
      join(codexHome, "auth.json"),
      JSON.stringify({
        OPENAI_API_KEY: "CODEX_AUTH_JSON_SECRET",
        tokens: { access_token: "OAUTH_ACCESS_TOKEN_IGNORED" },
      }),
    );

    const credentials = await discoverLocalModelCredentials({
      homeDir: home,
      environment: { HOME: home, CODEX_HOME: codexHome, PATH: "" },
    });

    expect(credentials).toEqual([
      expect.objectContaining({
        apiKey: "CODEX_AUTH_JSON_SECRET",
        sourceId: expect.stringMatching(
          /^auth-provider-[a-f0-9]{12}-[a-f0-9]{16}$/,
        ),
        toolId: "codex",
      }),
    ]);
    expect(JSON.stringify(credentials)).not.toContain(
      "OAUTH_ACCESS_TOKEN_IGNORED",
    );
  });

  it("imports every configured Codex provider into the wallet", async () => {
    directory = await mkdtemp(join(tmpdir(), "one-status-inventory-"));
    const home = join(directory, "home");
    const codexHome = join(home, ".codex");
    await mkdir(codexHome, { recursive: true });
    await writeFile(
      join(codexHome, "config.toml"),
      `model = "gpt-active"\nmodel_provider = "provider-a"\n[model_providers.provider-a]\nname = "Provider A"\nbase_url = "https://a.example.test/v1"\nenv_key = "PROVIDER_A_KEY"\n[model_providers.provider-b]\nname = "Provider B"\nbase_url = "https://b.example.test/v1"\nexperimental_bearer_token = "PROVIDER_B_SECRET"\n`,
    );

    const credentials = await discoverLocalModelCredentials({
      homeDir: home,
      environment: {
        HOME: home,
        CODEX_HOME: codexHome,
        PATH: "",
        PROVIDER_A_KEY: "PROVIDER_A_SECRET",
      },
      ccSwitchDbPath: join(home, "missing-cc-switch.db"),
    });

    expect(credentials).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          apiKey: "PROVIDER_A_SECRET",
          model: expect.objectContaining({
            modelId: "gpt-active",
            providerId: "provider-a",
          }),
          toolId: "codex",
        }),
        expect.objectContaining({
          apiKey: "PROVIDER_B_SECRET",
          model: expect.objectContaining({
            providerId: "provider-b",
            endpoint: "https://b.example.test/v1",
          }),
          toolId: "codex",
        }),
      ]),
    );
    expect(credentials.find((entry) => entry.model.providerId === "provider-b")
      ?.model.modelId).toBeUndefined();
  });

  it("imports saved Codex and Claude profiles from a CC Switch database", async () => {
    directory = await mkdtemp(join(tmpdir(), "one-status-inventory-"));
    const home = join(directory, "home");
    const databasePath = join(home, ".cc-switch", "cc-switch.db");
    await mkdir(join(home, ".cc-switch"), { recursive: true });
    const database = new DatabaseSync(databasePath);
    database.exec(`CREATE TABLE providers (
      id TEXT NOT NULL,
      app_type TEXT NOT NULL,
      name TEXT NOT NULL,
      settings_config TEXT NOT NULL,
      sort_index INTEGER,
      PRIMARY KEY (id, app_type)
    )`);
    const insert = database.prepare(
      "INSERT INTO providers (id, app_type, name, settings_config, sort_index) VALUES (?, ?, ?, ?, ?)",
    );
    insert.run(
      "codex-saved",
      "codex",
      "Saved Codex",
      JSON.stringify({
        auth: { OPENAI_API_KEY: "CC_SWITCH_CODEX_SECRET" },
        config:
          'model = "gpt-saved"\nmodel_provider = "saved-provider"\n[model_providers.saved-provider]\nbase_url = "https://saved.example.test/v1"\n',
      }),
      1,
    );
    insert.run(
      "claude-saved",
      "claude",
      "Saved Claude",
      JSON.stringify({
        model: "claude-saved-model",
        env: {
          ANTHROPIC_AUTH_TOKEN: "CC_SWITCH_CLAUDE_SECRET",
          ANTHROPIC_BASE_URL: "https://claude-saved.example.test/v1",
        },
      }),
      2,
    );
    for (const [id, endpoint] of [
      ["shared-a", "https://shared-a.example.test/v1"],
      ["shared-b", "https://shared-b.example.test/v1"],
    ] as const) {
      insert.run(
        id,
        "codex",
        id,
        JSON.stringify({
          auth: { OPENAI_API_KEY: "CC_SWITCH_SHARED_SECRET" },
          config:
            `model = "gpt-shared"\nmodel_provider = "shared-provider"\n[model_providers.shared-provider]\nbase_url = "${endpoint}"\n`,
        }),
        3,
      );
    }
    insert.run(
      "missing-codex-key",
      "codex",
      "Missing Codex Key",
      JSON.stringify({
        config:
          'model = "gpt-missing"\nmodel_provider = "missing-provider"\n[model_providers.missing-provider]\nbase_url = "https://missing.example.test/v1"\n',
      }),
      4,
    );
    insert.run(
      "missing-claude-key",
      "claude",
      "Missing Claude Key",
      JSON.stringify({
        model: "claude-missing",
        env: {
          ANTHROPIC_BASE_URL: "https://claude-missing.example.test/v1",
        },
      }),
      5,
    );
    database.close();

    const credentials = await discoverLocalModelCredentials({
      homeDir: home,
      environment: {
        HOME: home,
        PATH: "",
        OPENAI_API_KEY: "PROCESS_OPENAI_SECRET",
        ANTHROPIC_API_KEY: "PROCESS_ANTHROPIC_SECRET",
      },
      ccSwitchDbPath: databasePath,
    });

    expect(credentials).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          apiKey: "CC_SWITCH_CODEX_SECRET",
          model: expect.objectContaining({
            modelId: "gpt-saved",
            providerId: "saved-provider",
            providerLabel: "Saved Codex",
          }),
          toolId: "codex",
        }),
        expect.objectContaining({
          apiKey: "CC_SWITCH_CLAUDE_SECRET",
          model: expect.objectContaining({
            modelId: "claude-saved-model",
            providerLabel: "Saved Claude",
          }),
          toolId: "claude-code",
        }),
      ]),
    );
    const shared = credentials.filter(
      (entry) => entry.model.providerId === "shared-provider",
    );
    expect(shared).toHaveLength(2);
    expect(new Set(shared.map((entry) => entry.sourceId)).size).toBe(2);
    expect(shared.map((entry) => entry.model.endpoint).sort()).toEqual([
      "https://shared-a.example.test/v1",
      "https://shared-b.example.test/v1",
    ]);
    expect(
      credentials.some(
        (entry) =>
          entry.model.providerLabel === "Missing Codex Key" ||
          entry.model.providerLabel === "Missing Claude Key",
      ),
    ).toBe(false);
  });

  it("keeps a shell-owned Codex environment credential unverified", async () => {
    directory = await mkdtemp(join(tmpdir(), "one-status-inventory-"));
    const home = join(directory, "home");
    const bin = join(directory, "bin");
    await mkdir(join(home, ".codex"), { recursive: true });
    await mkdir(bin, { recursive: true });
    await writeFile(join(bin, "codex"), "#!/bin/sh\nexit 0\n");
    await chmod(join(bin, "codex"), 0o755);
    await writeFile(
      join(home, ".codex", "config.toml"),
      `model = "gpt-shell"\nmodel_provider = "shell-provider"\n[model_providers.shell-provider]\nbase_url = "https://api.example.test/v1"\nenv_key = "CODEX_API_KEY"\n`,
    );

    const snapshot = await scanLocalInventory({
      homeDir: home,
      environment: {
        HOME: home,
        PATH: bin,
        CODEX_HOME: join(home, ".codex"),
      },
    });

    expect(snapshot.agents[0]).toMatchObject({
      id: "codex",
      model: {
        credentialStatus: "unverified",
        health: "unknown",
      },
    });
  });
});
