import { execFileSync } from "node:child_process";
import {
  chmod,
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  rm,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  deviceSidecarArtifactName,
  deviceSidecarExecutableName,
} from "./device-sidecar-release.mjs";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));

export async function packageDeviceSidecar({
  arch,
  binary,
  outputDirectory,
  platform,
  version,
}) {
  const executable = deviceSidecarExecutableName(platform);
  if (basename(binary) !== executable) {
    throw new Error(`Expected Sidecar binary named ${executable}: ${binary}`);
  }

  const stagingDirectory = await mkdtemp(
    resolve(tmpdir(), "one-status-device-sidecar-"),
  );
  const artifactName = deviceSidecarArtifactName(version, platform, arch);
  const artifactPath = resolve(outputDirectory, artifactName);

  try {
    await mkdir(resolve(stagingDirectory, "licenses", "cc-switch"), {
      recursive: true,
    });
    await mkdir(outputDirectory, { recursive: true });
    await copyFile(binary, resolve(stagingDirectory, executable));
    if (platform !== "windows") {
      await chmod(resolve(stagingDirectory, executable), 0o755);
    }
    await copyFile(
      resolve(root, "apps", "device-sidecar", "THIRD_PARTY_NOTICES.md"),
      resolve(stagingDirectory, "THIRD_PARTY_NOTICES.device-sidecar.md"),
    );
    await copyFile(
      resolve(root, "apps", "device-sidecar", "third_party", "cc-switch", "LICENSE"),
      resolve(stagingDirectory, "licenses", "cc-switch", "LICENSE"),
    );
    execFileSync(
      "tar",
      [
        "-czf",
        artifactPath,
        "-C",
        stagingDirectory,
        executable,
        "THIRD_PARTY_NOTICES.device-sidecar.md",
        "licenses",
      ],
      { stdio: "inherit" },
    );
  } finally {
    await rm(stagingDirectory, { force: true, recursive: true });
  }

  return artifactPath;
}

function readOption(arguments_, name) {
  const index = arguments_.indexOf(name);
  if (index === -1 || !arguments_[index + 1]) {
    throw new Error(`Missing required option ${name}`);
  }
  return arguments_[index + 1];
}

async function main() {
  const packageJson = JSON.parse(
    await readFile(resolve(root, "package.json"), "utf8"),
  );
  const arguments_ = process.argv.slice(2);
  const artifact = await packageDeviceSidecar({
    platform: readOption(arguments_, "--platform"),
    arch: readOption(arguments_, "--arch"),
    binary: resolve(readOption(arguments_, "--binary")),
    outputDirectory: resolve(readOption(arguments_, "--output")),
    version: packageJson.version,
  });
  console.log(`Packaged ${artifact}`);
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  await main();
}
