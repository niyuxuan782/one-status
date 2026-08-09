const DEFAULT_DASHBOARD_URL = "http://127.0.0.1:8787";
const REQUEST_TIMEOUT_MS = 120_000;
const PROJECT_ID_PATTERN = /^[a-zA-Z0-9._-]+$/;
const SUPPORTED_AGENTS = new Set(["claude-code", "codex"] as const);

export type HandoffAgentId = "claude-code" | "codex";

export interface HandoffCommandOptions {
  agentId: string;
  dashboardUrl?: string;
  projectId: string;
  publish: boolean;
}

export interface HandoffCommandResult {
  agentId: HandoffAgentId;
  checks: {
    canWrite: boolean;
    existingFiles: string[];
    secretFindingCount: number;
    secretScan: "blocked" | "error" | "passed";
    worktreeClean: boolean;
  };
  mode: "preview" | "published";
  projectId: string;
  publishedCommit: string | null;
  sourceCommit: string;
  statusVersion: number;
}

interface HandoffPreviewResponse {
  canWrite: boolean;
  existingFiles: string[];
  findings: Array<{
    file: string;
    line: number;
    messageId?: string;
    ruleId: string;
  }>;
  manifest: {
    projectId: string;
    repository: {
      commit: string;
      dirty: boolean;
    };
    statusVersion: number;
    validation: {
      secretScan: "blocked" | "error" | "passed";
    };
  };
  secretScanError?: string;
}

interface HandoffPublishResponse {
  committed: true;
  pushed: true;
  repository: {
    commit: string;
  };
  statusVersion: number;
  written: true;
}

interface DashboardSession {
  cookie: string;
  csrfToken: string;
}

interface HandoffCommandDependencies {
  fetch?: typeof fetch;
  requestTimeoutMs?: number;
}

export async function runHandoffCommand(
  options: HandoffCommandOptions,
  dependencies: HandoffCommandDependencies = {},
): Promise<HandoffCommandResult> {
  const projectId = validateProjectId(options.projectId);
  const agentId = validateAgentId(options.agentId);
  const baseUrl = normalizeDashboardUrl(
    options.dashboardUrl ??
      process.env.ONE_STATUS_DASHBOARD_URL ??
      DEFAULT_DASHBOARD_URL,
  );
  const request = dependencies.fetch ?? fetch;
  const timeoutMs = dependencies.requestTimeoutMs ?? REQUEST_TIMEOUT_MS;
  const session = await establishDashboardSession(baseUrl, request, timeoutMs);
  const previewValue = await dashboardRequest(
    baseUrl,
    session,
    `/v1/dashboard/handoffs/${encodeURIComponent(projectId)}/preview`,
    {},
    request,
    timeoutMs,
  );
  const preview = parsePreview(previewValue, projectId);
  assertSafePreview(preview);

  const result: HandoffCommandResult = {
    agentId,
    checks: {
      canWrite: preview.canWrite,
      existingFiles: preview.existingFiles,
      secretFindingCount: preview.findings.length,
      secretScan: preview.manifest.validation.secretScan,
      worktreeClean: !preview.manifest.repository.dirty,
    },
    mode: "preview",
    projectId,
    publishedCommit: null,
    sourceCommit: preview.manifest.repository.commit,
    statusVersion: preview.manifest.statusVersion,
  };

  if (!options.publish) return result;

  const publishedValue = await dashboardRequest(
    baseUrl,
    session,
    `/v1/dashboard/handoffs/${encodeURIComponent(projectId)}/publish`,
    {
      confirmCommit: true,
      confirmPush: true,
      expectedCommit: preview.manifest.repository.commit,
      expectedStatusVersion: preview.manifest.statusVersion,
      overwrite: preview.existingFiles.length > 0,
    },
    request,
    timeoutMs,
  );
  const published = parsePublished(publishedValue);
  return {
    ...result,
    mode: "published",
    publishedCommit: published.repository.commit,
    statusVersion: published.statusVersion,
  };
}

function validateProjectId(value: string): string {
  if (!value || value.length > 120 || !PROJECT_ID_PATTERN.test(value)) {
    throw new Error(
      "--project must contain only letters, numbers, dots, underscores, or hyphens.",
    );
  }
  return value;
}

function validateAgentId(value: string): HandoffAgentId {
  if (!SUPPORTED_AGENTS.has(value as HandoffAgentId)) {
    throw new Error("--agent must be claude-code or codex.");
  }
  return value as HandoffAgentId;
}

function normalizeDashboardUrl(value: string): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error("ONE_STATUS_DASHBOARD_URL must be a valid URL.");
  }
  if (
    !["127.0.0.1", "localhost", "[::1]"].includes(url.hostname) ||
    !["http:", "https:"].includes(url.protocol) ||
    url.username ||
    url.password
  ) {
    throw new Error("Handoff can only use a credential-free loopback dashboard URL.");
  }
  if (url.search || url.hash) {
    throw new Error("ONE_STATUS_DASHBOARD_URL cannot include a query or fragment.");
  }
  return new URL("/", url.origin);
}

async function establishDashboardSession(
  baseUrl: URL,
  request: typeof fetch,
  timeoutMs: number,
): Promise<DashboardSession> {
  let response: Response;
  try {
    response = await request(new URL("/handoffs", baseUrl), {
      headers: { accept: "text/html" },
      redirect: "error",
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (error) {
    throw dashboardConnectionError(error);
  }
  if (!response.ok) {
    throw new Error(`Local One Status dashboard returned HTTP ${response.status}.`);
  }
  const html = await response.text();
  const setCookie = response.headers.get("set-cookie") ?? "";
  const session = setCookie.match(
    /(?:^|,\s*)one_status_dashboard=([^;,\s]+)/,
  )?.[1];
  const csrfToken = html.match(
    /<meta\s+name=["']one-status-csrf["']\s+content=["']([^"']+)["']\s*\/?>/i,
  )?.[1];
  if (!session || !csrfToken) {
    throw new Error("Local One Status dashboard did not issue a secure session.");
  }
  return {
    cookie: `one_status_dashboard=${session}`,
    csrfToken,
  };
}

async function dashboardRequest(
  baseUrl: URL,
  session: DashboardSession,
  path: string,
  body: Record<string, unknown>,
  request: typeof fetch,
  timeoutMs: number,
): Promise<unknown> {
  let response: Response;
  try {
    response = await request(new URL(path, baseUrl), {
      body: JSON.stringify(body),
      headers: {
        accept: "application/json",
        "content-type": "application/json",
        cookie: session.cookie,
        origin: baseUrl.origin,
        "x-one-status-csrf": session.csrfToken,
      },
      method: "POST",
      redirect: "error",
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (error) {
    throw dashboardConnectionError(error);
  }
  const value = await readJson(response);
  if (!response.ok) {
    const message = dashboardErrorMessage(value);
    throw new Error(
      message ?? `Local One Status dashboard returned HTTP ${response.status}.`,
    );
  }
  return value;
}

async function readJson(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    throw new Error("Local One Status dashboard returned invalid JSON.");
  }
}

function dashboardErrorMessage(value: unknown): string | undefined {
  const record = asRecord(value);
  if (!record) return undefined;
  if (typeof record.error === "string") return record.error;
  const error = asRecord(record.error);
  return error && typeof error.message === "string" ? error.message : undefined;
}

function parsePreview(value: unknown, projectId: string): HandoffPreviewResponse {
  const preview = asRecord(value);
  const manifest = asRecord(preview?.manifest);
  const repository = asRecord(manifest?.repository);
  const validation = asRecord(manifest?.validation);
  if (
    !preview ||
    typeof preview.canWrite !== "boolean" ||
    !isStringArray(preview.existingFiles) ||
    !Array.isArray(preview.findings) ||
    !manifest ||
    manifest.projectId !== projectId ||
    !Number.isInteger(manifest.statusVersion) ||
    (manifest.statusVersion as number) < 0 ||
    !repository ||
    typeof repository.commit !== "string" ||
    !/^[0-9a-f]{40,64}$/i.test(repository.commit) ||
    typeof repository.dirty !== "boolean" ||
    !validation ||
    !["blocked", "error", "passed"].includes(
      validation.secretScan as string,
    ) ||
    !preview.findings.every(isSecretFinding)
  ) {
    throw new Error("Local One Status dashboard returned an invalid Handoff preview.");
  }
  return value as HandoffPreviewResponse;
}

function parsePublished(value: unknown): HandoffPublishResponse {
  const result = asRecord(value);
  const repository = asRecord(result?.repository);
  if (
    !result ||
    result.written !== true ||
    result.committed !== true ||
    result.pushed !== true ||
    !Number.isInteger(result.statusVersion) ||
    (result.statusVersion as number) < 0 ||
    !repository ||
    typeof repository.commit !== "string" ||
    !/^[0-9a-f]{40,64}$/i.test(repository.commit)
  ) {
    throw new Error("Local One Status dashboard returned an invalid publish result.");
  }
  return value as HandoffPublishResponse;
}

function assertSafePreview(preview: HandoffPreviewResponse): void {
  if (
    preview.canWrite &&
    preview.manifest.validation.secretScan === "passed" &&
    preview.findings.length === 0
  ) {
    return;
  }
  if (preview.findings.length > 0) {
    const summary = preview.findings
      .slice(0, 5)
      .map((finding) => `${finding.file}:${finding.line} (${finding.ruleId})`)
      .join(", ");
    throw new Error(
      `Handoff blocked by ${preview.findings.length} Secret finding(s): ${summary}`,
    );
  }
  throw new Error(
    preview.secretScanError ??
      `Handoff Secret scan is ${preview.manifest.validation.secretScan}.`,
  );
}

function isSecretFinding(value: unknown): boolean {
  const finding = asRecord(value);
  return Boolean(
    finding &&
      typeof finding.file === "string" &&
      Number.isInteger(finding.line) &&
      typeof finding.ruleId === "string",
  );
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((entry) => typeof entry === "string");
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object"
    ? (value as Record<string, unknown>)
    : undefined;
}

function dashboardConnectionError(error: unknown): Error {
  const detail = error instanceof Error ? ` ${error.message}` : "";
  return new Error(
    `Cannot reach the local One Status dashboard. Start the desktop app or run \`one-status server\`.${detail}`,
  );
}
