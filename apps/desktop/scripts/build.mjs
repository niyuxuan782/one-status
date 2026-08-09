import { execFileSync } from "node:child_process";
import { chmod, copyFile, mkdir, rm } from "node:fs/promises";
import { resolve } from "node:path";
import { build } from "esbuild";

const desktopRoot = resolve(import.meta.dirname, "..");
const outputDirectory = resolve(desktopRoot, "dist");
const sidecarRoot = resolve(desktopRoot, "..", "device-sidecar");

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

const sidecarTarget = process.env.ONE_STATUS_SIDECAR_TARGET;
const cargoArguments = [
  "build",
  "--manifest-path",
  resolve(sidecarRoot, "Cargo.toml"),
  "--locked",
  "--release",
  ...(sidecarTarget ? ["--target", sidecarTarget] : []),
];
execFileSync("cargo", cargoArguments, { cwd: sidecarRoot, stdio: "inherit" });

const sidecarName = process.platform === "win32"
  ? "one-status-device-sidecar.exe"
  : "one-status-device-sidecar";
const sidecarBuildDirectory = sidecarTarget
  ? resolve(sidecarRoot, "target", sidecarTarget, "release")
  : resolve(sidecarRoot, "target", "release");
const resourceDirectory = resolve(outputDirectory, "resources");
const binaryDirectory = resolve(resourceDirectory, "bin");
const licenseDirectory = resolve(resourceDirectory, "licenses", "cc-switch");
await mkdir(binaryDirectory, { recursive: true });
await mkdir(licenseDirectory, { recursive: true });
await copyFile(
  resolve(sidecarBuildDirectory, sidecarName),
  resolve(binaryDirectory, sidecarName),
);
await copyFile(
  resolve(sidecarRoot, "third_party", "cc-switch", "LICENSE"),
  resolve(licenseDirectory, "LICENSE"),
);
await copyFile(
  resolve(sidecarRoot, "THIRD_PARTY_NOTICES.md"),
  resolve(resourceDirectory, "THIRD_PARTY_NOTICES.device-sidecar.md"),
);
if (process.platform !== "win32") {
  await chmod(resolve(binaryDirectory, sidecarName), 0o755);
}
