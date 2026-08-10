import { execFile } from "node:child_process";
import {
  access,
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createEmptyStatus, type StatusDocument } from "@one-status/protocol";
import type { AgentLauncher } from "./agent-adapter.js";
import type {
  DashboardBackend,
  DashboardStatusSnapshot,
} from "./dashboard-backend.js";
import { HandoffService, portableGitHubUrl } from "./handoff.js";
import { LocalWorkspaceStore } from "./local-workspace.js";

const execFileAsync = promisify(execFile);
const projectId = "project-1";

describe("handoff service", () => {
  let backend: MemoryDashboardBackend;
  let directory: string;
  let credentialProvider: {
    getGitEnvironment: ReturnType<
      typeof vi.fn<(repositoryUrl: string) => Promise<Record<string, string>>>
    >;
  };
  let launcher: AgentLauncher;
  let launch: ReturnType<typeof vi.fn<AgentLauncher["launch"]>>;
  let repositoryRewrite: string | undefined;
  let service: HandoffService;
  let store: LocalWorkspaceStore;

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), "one-status-handoff-"));
    backend = new MemoryDashboardBackend();
    store = new LocalWorkspaceStore(join(directory, "workspace.sqlite"));
    launch = vi.fn<AgentLauncher["launch"]>(async (input) => ({
      agentId: input.agentId,
      command: input.agentId === "codex" ? "codex" : "claude",
      cwd: input.cwd,
      launched: true,
      mode: "terminal",
    }));
    launcher = { launch };
    repositoryRewrite = undefined;
    credentialProvider = {
      getGitEnvironment: vi.fn(async () => ({
        ONE_STATUS_TEST_GITHUB_TOKEN: "test-token-must-never-leak",
        ...(repositoryRewrite
          ? {
              GIT_CONFIG_COUNT: "1",
              GIT_CONFIG_KEY_0: `url.${repositoryRewrite}.insteadOf`,
              GIT_CONFIG_VALUE_0: "https://github.com/acme/project.git",
            }
          : {}),
      })),
    };
    service = createHandoffService(backend, store, launcher, credentialProvider);
  });

  afterEach(async () => {
    store.close();
    await rm(directory, { recursive: true, force: true });
  });

  it("normalizes GitHub remotes without carrying credentials", () => {
    expect(portableGitHubUrl("git@github.com:acme/project.git")).toBe(
      "https://github.com/acme/project.git",
    );
    expect(
      portableGitHubUrl(
        "https://token-user:token-secret@github.com/acme/project.git?token=hidden",
      ),
    ).toBe("https://github.com/acme/project.git");
    expect(portableGitHubUrl("https://example.test/acme/project.git")).toBeNull();
  });

  it("maps a portable project to a canonical Git repository root", async () => {
    const repository = await createRepository(directory);

    const mapping = await service.mapProject(projectId, repository);

    expect(mapping).toMatchObject({
      projectId,
      path: await realpath(repository),
      repoRoot: await realpath(repository),
    });
    expect(store.getMapping(projectId)).toEqual(mapping);
    expect(store.listActivity(1)[0]).toMatchObject({
      type: "project_mapped",
      projectId,
    });

    const nested = join(repository, "src");
    await mkdir(nested);
    await expect(service.mapProject(projectId, nested)).rejects.toThrow(
      "Select the Git repository root",
    );

    const unborn = join(directory, "unborn");
    await mkdir(unborn);
    await git(unborn, ["init", "-b", "main"]);
    await expect(service.mapProject(projectId, unborn)).rejects.toThrow(
      "first commit before mapping",
    );
  });

  it("collects branch, commit, dirty files, and a sanitized remote", async () => {
    const repository = await createRepository(directory);
    await git(repository, [
      "remote",
      "add",
      "origin",
      "https://user:password@example.test/acme/project.git?token=hidden#part",
    ]);
    await writeFile(join(repository, "README.md"), "updated\n");
    await writeFile(join(repository, "notes.txt"), "next step\n");
    await service.mapProject(projectId, repository);

    const preview = await service.preview(projectId);

    expect(preview.manifest.repository).toEqual({
      branch: "main",
      changedFiles: ["README.md", "notes.txt"],
      commit: await git(repository, ["rev-parse", "HEAD"]),
      dirty: true,
      remote: "https://example.test/acme/project.git",
    });
    expect(preview.markdown).toContain("## Current Goal");
    expect(preview.markdown).toContain("Ship local Handoff");
    expect(JSON.stringify(preview)).not.toContain("password");
    expect(JSON.stringify(preview)).not.toContain("token=hidden");
  });

  it("blocks writing when a changed file contains a secret", async () => {
    const repository = await createRepository(directory);
    const fakeSecret = "1234567890123456789012345678901234567890";
    await writeFile(
      join(repository, "credentials.env"),
      `AWS_SECRET_ACCESS_KEY=${fakeSecret}\n`,
    );
    await service.mapProject(projectId, repository);

    const preview = await service.preview(projectId);

    expect(preview.canWrite).toBe(false);
    expect(preview.manifest.validation.secretScan).toBe("blocked");
    expect(preview.findings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          file: "credentials.env",
          line: 1,
          ruleId: "@secretlint/secretlint-rule-aws",
        }),
      ]),
    );
    expect(JSON.stringify(preview.findings)).not.toContain(fakeSecret);
    await expect(
      service.write({
        projectId,
        expectedCommit: preview.manifest.repository.commit,
        expectedStatusVersion: preview.manifest.statusVersion,
      }),
    ).rejects.toThrow("blocked by Secret scan");
    await expect(access(join(repository, "HANDOFF.md"))).rejects.toThrow();
    await expect(
      access(join(repository, ".one-status", "handoff.json")),
    ).rejects.toThrow();
  });

  it("blocks Secretlint suppression directives", async () => {
    const repository = await createRepository(directory);
    await writeFile(
      join(repository, "ignored.env"),
      "# secretlint-disable\nAWS_SECRET_ACCESS_KEY=1234567890123456789012345678901234567890\n",
    );
    await service.mapProject(projectId, repository);

    const preview = await service.preview(projectId);

    expect(preview.canWrite).toBe(false);
    expect(preview.findings).toContainEqual({
      file: "ignored.env",
      line: 1,
      ruleId: "one-status/secretlint-directive",
    });
  });

  it("blocks changed files that cannot be scanned as bounded text", async () => {
    const repository = await createRepository(directory);
    await writeFile(join(repository, "binary.dat"), Buffer.from([0, 1, 2, 3]));
    await writeFile(
      join(repository, "large.txt"),
      Buffer.alloc(1024 * 1024 + 1, "a"),
    );
    const outside = join(directory, "outside-secret.txt");
    await writeFile(outside, "external\n");
    await symlink(outside, join(repository, "linked.txt"));
    await service.mapProject(projectId, repository);

    const preview = await service.preview(projectId);

    expect(preview.canWrite).toBe(false);
    expect(preview.findings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          file: "binary.dat",
          ruleId: "one-status/binary-file",
        }),
        expect.objectContaining({
          file: "large.txt",
          ruleId: "one-status/file-too-large",
        }),
        expect.objectContaining({
          file: "linked.txt",
          ruleId: "one-status/unscanned-file-type",
        }),
      ]),
    );
  });

  it("writes HANDOFF.md and handoff.json for a clean repository", async () => {
    const repository = await createRepository(directory);
    await service.mapProject(projectId, repository);
    const preview = await service.preview(projectId);

    const result = await service.write({
      projectId,
      expectedCommit: preview.manifest.repository.commit,
      expectedStatusVersion: preview.manifest.statusVersion,
    });

    const markdownPath = join(repository, "HANDOFF.md");
    const manifestPath = join(repository, ".one-status", "handoff.json");
    const markdown = await readFile(markdownPath, "utf8");
    const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
    expect(result).toMatchObject({
      written: true,
      committed: false,
      pushed: false,
      files: ["HANDOFF.md", ".one-status/handoff.json"],
    });
    expect(markdown).toContain("# One Status Handoff");
    expect(markdown).toContain("- Keep encrypted state client-side");
    expect(manifest).toEqual(result.manifest);
    expect(manifest).toMatchObject({
      format: "one-status.handoff",
      version: 1,
      projectId,
      validation: { secretScan: "passed", test: "not_run" },
    });
    expect((await stat(markdownPath)).mode & 0o777).toBe(0o600);
    expect((await stat(manifestPath)).mode & 0o777).toBe(0o600);
    expect(store.listActivity(1)[0]).toMatchObject({
      type: "handoff_written",
      projectId,
    });
  });

  it("publishes the full worktree and opens the exact commit on another device", async () => {
    const remote = join(directory, "remote.git");
    await git(directory, ["init", "--bare", "--initial-branch=main", remote]);
    repositoryRewrite = pathToFileURL(remote).toString();
    const repository = await createRepository(directory);
    await git(repository, [
      "remote",
      "add",
      "origin",
      "https://github.com/acme/project.git",
    ]);
    const leakedTokenPath = join(directory, "pre-push-token.txt");
    const prePushHook = join(repository, ".git", "hooks", "pre-push");
    await writeFile(
      prePushHook,
      `#!/bin/sh\nprintf '%s' "$ONE_STATUS_TEST_GITHUB_TOKEN" > ${JSON.stringify(leakedTokenPath)}\n`,
    );
    await chmod(prePushHook, 0o700);
    await writeFile(join(repository, "src.txt"), "portable work\n");
    await service.mapProject(projectId, repository);
    const preview = await service.preview(projectId);

    const published = await service.publish({
      projectId,
      expectedCommit: preview.manifest.repository.commit,
      expectedStatusVersion: preview.manifest.statusVersion,
      confirmCommit: true,
      confirmPush: true,
    });

    expect(published).toMatchObject({
      committed: true,
      pushed: true,
      repository: { branch: "main", commit: expect.any(String) },
    });
    expect(await git(remote, ["rev-parse", "refs/heads/main"])).toBe(
      published.repository.commit,
    );
    expect(backend.status.projects[projectId]?.handoff).toMatchObject({
      repositoryUrl: "https://github.com/acme/project.git",
      branch: "main",
      commit: published.repository.commit,
      sourceCommit: preview.manifest.repository.commit,
      fileDigests: {
        handoffMarkdownSha256: expect.stringMatching(/^[0-9a-f]{64}$/),
        manifestSha256: expect.stringMatching(/^[0-9a-f]{64}$/),
      },
    });
    const tracked = await git(repository, ["show", "--format=", "--name-only", "HEAD"]);
    expect(tracked).toContain("src.txt");
    expect(tracked).toContain("HANDOFF.md");
    expect(tracked).toContain(".one-status/handoff.json");
    await expect(access(leakedTokenPath)).rejects.toMatchObject({ code: "ENOENT" });

    const targetStore = new LocalWorkspaceStore(
      join(directory, "target-workspace.sqlite"),
    );
    try {
      const targetService = createHandoffService(
        backend,
        targetStore,
        launcher,
        credentialProvider,
      );
      const destination = join(directory, "cloned-project");
      const opened = await targetService.openAndContinue({
        agentId: "codex",
        confirmCheckout: true,
        destinationPath: destination,
        projectId,
      });

      expect(opened).toMatchObject({
        cloned: true,
        commit: published.repository.commit,
        opened: true,
        launch: { agentId: "codex", launched: true },
      });
      expect(await git(destination, ["rev-parse", "HEAD"])).toBe(
        published.repository.commit,
      );
      expect(await git(destination, ["branch", "--show-current"])).toBe(
        `one-status/continue/${projectId}-${published.repository.commit.slice(0, 12)}`,
      );
      expect(await readFile(join(destination, "src.txt"), "utf8")).toBe(
        "portable work\n",
      );
      expect(targetStore.getMapping(projectId)?.repoRoot).toBe(
        await realpath(destination),
      );
      expect(launch).toHaveBeenCalledWith(
        expect.objectContaining({
          agentId: "codex",
          commit: published.repository.commit,
          cwd: await realpath(destination),
        }),
      );

      await writeFile(join(repository, "src.txt"), "second handoff\n");
      const secondPreview = await service.preview(projectId);
      const second = await service.publish({
        projectId,
        expectedCommit: secondPreview.manifest.repository.commit,
        expectedStatusVersion: secondPreview.manifest.statusVersion,
        confirmCommit: true,
        confirmPush: true,
        overwrite: true,
      });
      const updated = await targetService.openAndContinue({
        agentId: "claude-code",
        confirmCheckout: true,
        projectId,
      });
      expect(updated).toMatchObject({
        cloned: false,
        commit: second.repository.commit,
        launch: { agentId: "claude-code", command: "claude" },
      });
      expect(await readFile(join(destination, "src.txt"), "utf8")).toBe(
        "second handoff\n",
      );
    } finally {
      targetStore.close();
    }

    const exposed = JSON.stringify({
      published,
      handoff: backend.status.projects[projectId]?.handoff,
      activity: store.listActivity(),
      remote: await git(repository, ["remote", "get-url", "origin"]),
    });
    expect(credentialProvider.getGitEnvironment).toHaveBeenCalled();
    expect(exposed).not.toContain("test-token-must-never-leak");
  });

  it("keeps injected GitHub credentials out of failures and activity", async () => {
    const repository = await createRepository(directory);
    const missingRemote = join(directory, "missing", "remote.git");
    repositoryRewrite = pathToFileURL(missingRemote).toString();
    await git(repository, [
      "remote",
      "add",
      "origin",
      "https://github.com/acme/project.git",
    ]);
    await service.mapProject(projectId, repository);
    const preview = await service.preview(projectId);

    const error = await service
      .publish({
        projectId,
        expectedCommit: preview.manifest.repository.commit,
        expectedStatusVersion: preview.manifest.statusVersion,
        confirmCommit: true,
        confirmPush: true,
      })
      .catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toBe("Git command failed (push).");
    expect(
      JSON.stringify({
        error: (error as Error).message,
        activity: store.listActivity(),
        remote: await git(repository, ["remote", "get-url", "origin"]),
      }),
    ).not.toContain("test-token-must-never-leak");
    expect(backend.status.projects[projectId]?.handoff).toBeUndefined();
  });

  it("detects Status and Git HEAD changes after preview", async () => {
    const repository = await createRepository(directory);
    await service.mapProject(projectId, repository);
    const initial = await service.preview(projectId);

    backend.version += 1;
    await expect(
      service.write({
        projectId,
        expectedCommit: initial.manifest.repository.commit,
        expectedStatusVersion: initial.manifest.statusVersion,
      }),
    ).rejects.toThrow("One Status changed after preview");

    const current = await service.preview(projectId);
    await writeFile(join(repository, "README.md"), "new commit\n");
    await git(repository, ["add", "README.md"]);
    await git(repository, ["commit", "-m", "advance head"]);
    await expect(
      service.write({
        projectId,
        expectedCommit: current.manifest.repository.commit,
        expectedStatusVersion: current.manifest.statusVersion,
      }),
    ).rejects.toThrow("Git HEAD changed after preview");
  });

  it("refuses symlinked output targets that escape the repository", async () => {
    const repository = await createRepository(directory);
    const outside = join(directory, "outside");
    await mkdir(outside);
    await service.mapProject(projectId, repository);
    const preview = await service.preview(projectId);
    await symlink(join(outside, "HANDOFF.md"), join(repository, "HANDOFF.md"));

    await expect(
      service.write({
        projectId,
        expectedCommit: preview.manifest.repository.commit,
        expectedStatusVersion: preview.manifest.statusVersion,
        overwrite: true,
      }),
    ).rejects.toThrow("HANDOFF.md must be a regular file");
    await expect(access(join(outside, "HANDOFF.md"))).rejects.toThrow();

    await rm(join(repository, "HANDOFF.md"));
    await writeFile(join(repository, ".git", "info", "exclude"), ".one-status\n");
    await symlink(outside, join(repository, ".one-status"));
    await expect(
      service.write({
        projectId,
        expectedCommit: preview.manifest.repository.commit,
        expectedStatusVersion: preview.manifest.statusVersion,
        overwrite: true,
      }),
    ).rejects.toThrow(".one-status must be a real directory");
    await expect(access(join(outside, "handoff.json"))).rejects.toThrow();
  });
});

async function createRepository(parent: string): Promise<string> {
  const repository = join(parent, "repository");
  await mkdir(repository);
  await git(repository, ["init", "-b", "main"]);
  await git(repository, ["config", "user.name", "One Status Test"]);
  await git(repository, ["config", "user.email", "one-status@example.test"]);
  await writeFile(join(repository, "README.md"), "initial\n");
  await git(repository, ["add", "README.md"]);
  await git(repository, ["commit", "-m", "initial"]);
  return repository;
}

function createHandoffService(
  backend: DashboardBackend,
  store: LocalWorkspaceStore,
  agentLauncher: AgentLauncher,
  githubCredentialProvider: {
    getGitEnvironment(repositoryUrl: string): Promise<Record<string, string>>;
  },
): HandoffService {
  return new HandoffService(backend, store, {
    agentLauncher,
    githubCredentialProvider,
  });
}

async function git(cwd: string, arguments_: string[]): Promise<string> {
  const result = await execFileAsync("/usr/bin/git", ["-C", cwd, ...arguments_], {
    encoding: "utf8",
  });
  return result.stdout.trim();
}

class MemoryDashboardBackend implements DashboardBackend {
  status: StatusDocument;
  version = 7;

  constructor() {
    this.status = createEmptyStatus();
    this.status.projects[projectId] = {
      id: projectId,
      name: "One Status",
      summary: "Portable Agent state",
      techStack: ["TypeScript"],
      currentGoal: "Ship local Handoff",
      decisions: ["Keep encrypted state client-side"],
      updatedAt: new Date(0).toISOString(),
    };
    this.status.workspace = {
      activeProjectId: projectId,
      currentContext: "Validate the Handoff flow",
      lastAgentId: "codex",
    };
    this.status.tasks["task-done"] = {
      id: "task-done",
      projectId,
      title: "Map the checkout",
      status: "done",
      completed: ["Record Git metadata"],
      next: [],
      updatedAt: new Date(0).toISOString(),
    };
    this.status.tasks["task-next"] = {
      id: "task-next",
      projectId,
      title: "Publish Handoff",
      status: "in_progress",
      completed: [],
      next: ["Open it on another device"],
      updatedAt: new Date(0).toISOString(),
    };
  }

  async getSnapshot(): Promise<DashboardStatusSnapshot> {
    return {
      account: {
        user: {
          id: "user-1",
          email: "ryan@example.test",
          createdAt: new Date(0).toISOString(),
        },
        devices: [],
        deviceLoginPolicy: { denyNewDeviceLogins: false },
      },
      profile: {
        baseUrl: "http://127.0.0.1:8787",
        deviceId: "device-1",
        deviceName: "Test Mac",
        tokenExpiresAt: new Date(Date.now() + 60_000).toISOString(),
        userId: "user-1",
      },
      status: structuredClone(this.status),
      updatedAt: new Date().toISOString(),
      version: this.version,
    };
  }

  async mutateStatus(
    mutator: (status: StatusDocument) => void,
  ): Promise<DashboardStatusSnapshot> {
    mutator(this.status);
    this.version += 1;
    return this.getSnapshot();
  }

  async revokeDevice(): Promise<void> {}

  async userId(): Promise<string> {
    return "user-1";
  }
}
