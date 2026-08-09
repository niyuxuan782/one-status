import { mkdir, rm } from "node:fs/promises";
import { resolve } from "node:path";
import { build } from "esbuild";

const desktopRoot = resolve(import.meta.dirname, "..");
const outputDirectory = resolve(desktopRoot, "dist");

await rm(outputDirectory, { recursive: true, force: true });
await mkdir(outputDirectory, { recursive: true });

await build({
  banner: {
    js: 'import { createRequire as __oneStatusCreateRequire } from "node:module"; const require = __oneStatusCreateRequire(import.meta.url);',
  },
  bundle: true,
  define: { "process.env.NODE_ENV": '"production"' },
  entryPoints: [resolve(desktopRoot, "src", "main.ts")],
  external: ["electron"],
  format: "esm",
  legalComments: "eof",
  logLevel: "info",
  minify: false,
  outfile: resolve(outputDirectory, "main.js"),
  platform: "node",
  target: "node22",
});
