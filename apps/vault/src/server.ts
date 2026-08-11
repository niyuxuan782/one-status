import { startVaultServerFromEnv } from "./runtime.js";

const runtime = await startVaultServerFromEnv();
console.error(`One Status Vault listening at ${runtime.url}`);

let closing = false;
const close = async () => {
  if (closing) return;
  closing = true;
  await runtime.close();
};
process.once("SIGINT", () => void close());
process.once("SIGTERM", () => void close());
