import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { startApiServer } from "./runtime.js";

const host = process.env.ONE_STATUS_HOST ?? "127.0.0.1";
const port = Number.parseInt(process.env.ONE_STATUS_PORT ?? "8787", 10);
const workspaceRoot = fileURLToPath(new URL("../../..", import.meta.url));
const dbPath = resolve(
  workspaceRoot,
  process.env.ONE_STATUS_DB ?? ".data/one-status.sqlite",
);

try {
  await startApiServer({ dbPath, host, logger: true, port });
} catch (error) {
  console.error(error);
  process.exitCode = 1;
}
