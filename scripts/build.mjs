import { execFileSync } from "node:child_process";
import { chmod, mkdir, rm } from "node:fs/promises";
import { resolve } from "node:path";
import { build } from "esbuild";

const root = resolve(import.meta.dirname, "..");
const outputDirectory = resolve(root, "dist");
const outputFile = resolve(outputDirectory, "one-status.js");

await rm(outputDirectory, { recursive: true, force: true });
await mkdir(outputDirectory, { recursive: true });

await build({
  banner: {
    js: 'import { createRequire as __oneStatusCreateRequire } from "node:module"; const require = __oneStatusCreateRequire(import.meta.url);',
  },
  bundle: true,
  define: { "process.env.NODE_ENV": '"production"' },
  entryPoints: [resolve(root, "apps/cli/src/main.ts")],
  format: "esm",
  legalComments: "eof",
  logLevel: "info",
  minify: false,
  outfile: outputFile,
  platform: "node",
  target: "node22",
});

await chmod(outputFile, 0o755);

execFileSync(
  process.execPath,
  [
    resolve(root, "scripts", "generate-third-party-notices.mjs"),
    resolve(outputDirectory, "THIRD_PARTY_NOTICES.txt"),
  ],
  { cwd: root, stdio: "inherit" },
);
