import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

const root = resolve(import.meta.dirname, "..", "..", "..");
const packageVersion = (JSON.parse(
  await readFile(resolve(root, "package.json"), "utf8"),
) as { version: string }).version;
const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) =>
    rm(directory, { force: true, recursive: true })));
});

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(resolve(tmpdir(), "one-status-release-test-"));
  temporaryDirectories.push(directory);
  return directory;
}

async function sha256(path: string): Promise<string> {
  return createHash("sha256").update(await readFile(path)).digest("hex");
}

describe("Device Sidecar release artifacts", () => {
  it("keeps manual release runs artifact-only and tag pushes publishable", async () => {
    const workflow = await readFile(
      resolve(root, ".github", "workflows", "release.yml"),
      "utf8",
    );

    expect(workflow).toContain("workflow_dispatch:");
    expect(workflow).toContain('tags: ["v*"]');
    expect(workflow.match(/uses: actions\/upload-artifact@v4/g)).toHaveLength(2);
    expect(workflow).toContain("name: one-status-cli");
    expect(workflow).toContain(
      "name: one-status-desktop-${{ matrix.platform }}-${{ matrix.arch }}",
    );
    expect(workflow.match(
      /if: github\.event_name == 'push' && startsWith\(github\.ref, 'refs\/tags\/v'\)/g,
    )).toHaveLength(3);
  });

  it("uses electron-builder for app notarization and submits each DMG once", async () => {
    const workflow = await readFile(
      resolve(root, ".github", "workflows", "release.yml"),
      "utf8",
    );
    const desktopPackage = JSON.parse(
      await readFile(resolve(root, "apps", "desktop", "package.json"), "utf8"),
    ) as { build: { mac: { notarize?: boolean } } };

    expect(desktopPackage.build.mac.notarize).toBe(true);
    expect(workflow).toContain("APPLE_APP_SPECIFIC_PASSWORD:");
    expect(workflow).toContain("CSC_LINK:");
    expect(workflow).not.toContain('CSC_IDENTITY_AUTO_DISCOVERY: "false"');
    expect(workflow).toContain("xcrun stapler validate \"$app_path\"");
    expect(workflow.match(/xcrun notarytool submit "\$image"/g)).toHaveLength(1);
    expect(workflow.match(/xcrun stapler staple "\$image"/g)).toHaveLength(1);
    expect(workflow).not.toContain('xcrun notarytool submit "$app_path"');
    expect(workflow).not.toContain('xcrun stapler staple "$app_path"');

    const submit = workflow.indexOf('xcrun notarytool submit "$image"');
    const staple = workflow.indexOf('xcrun stapler staple "$image"');
    const validate = workflow.indexOf('xcrun stapler validate "$image"');
    expect(submit).toBeGreaterThan(-1);
    expect(staple).toBeGreaterThan(submit);
    expect(validate).toBeGreaterThan(staple);
  });

  it("clears every macOS extended attribute before code signing", async () => {
    const afterPack = await readFile(
      resolve(root, "apps", "desktop", "scripts", "after-pack.mjs"),
      "utf8",
    );

    expect(afterPack).toContain('"-dr"');
    expect(afterPack).toContain('"com.apple.provenance"');
    expect(afterPack).toContain('["-cr", context.appOutDir]');
    expect(afterPack).toContain('["-lr", context.appOutDir]');
    expect(afterPack).toContain("ResourceFork|FinderInfo");
    expect(afterPack).not.toContain('"-s"');
  });

  it("renders the macOS signing label from each published Release", async () => {
    const pagesWorkflow = await readFile(
      resolve(root, ".github", "workflows", "pages.yml"),
      "utf8",
    );
    const siteScript = await readFile(
      resolve(root, "apps", "site", "public", "app.js"),
      "utf8",
    );
    const bundledRelease = JSON.parse(
      await readFile(
        resolve(root, "apps", "site", "public", "release.json"),
        "utf8",
      ),
    ) as { macos_notarized?: boolean };

    expect(pagesWorkflow).toContain("macos_notarized:");
    expect(pagesWorkflow).toContain(
      "macOS packages are signed with Developer ID, notarized by Apple",
    );
    expect(siteScript).toContain("release.macos_notarized === true");
    expect(bundledRelease.macos_notarized).toBe(false);
  });

  it("keeps the macOS installer on the notarized Gatekeeper path", async () => {
    const installer = await readFile(
      resolve(root, "apps", "site", "public", "install.sh"),
      "utf8",
    );

    expect(installer).toContain("Authority=Developer ID Application:");
    expect(installer).toContain("spctl --assess --type execute");
    expect(installer).toContain("xcrun stapler validate");
    expect(installer).not.toContain('xattr -cr "$INSTALL_STAGING"');
  });

  it("packages the native executable with attribution files", async () => {
    const directory = await temporaryDirectory();
    const binary = resolve(directory, "one-status-device-sidecar");
    await writeFile(binary, "fixture", { mode: 0o755 });

    execFileSync(process.execPath, [
      resolve(root, "scripts", "package-device-sidecar.mjs"),
      "--platform",
      "mac",
      "--arch",
      "arm64",
      "--binary",
      binary,
      "--output",
      directory,
    ]);

    const artifact = resolve(
      directory,
      `one-status-device-sidecar-${packageVersion}-mac-arm64.tar.gz`,
    );
    const entries = execFileSync("tar", ["-tzf", artifact], {
      encoding: "utf8",
    }).trim().split("\n");
    expect(entries).toContain("one-status-device-sidecar");
    expect(entries).toContain("THIRD_PARTY_NOTICES.device-sidecar.md");
    expect(entries).toContain("licenses/cc-switch/LICENSE");
  });

  it("generates a Formula bound to each Homebrew artifact hash", async () => {
    const directory = await temporaryDirectory();
    const version = packageVersion;
    const names = [
      `one-status-${version}.tgz`,
      `one-status-device-sidecar-${version}-mac-arm64.tar.gz`,
      `one-status-device-sidecar-${version}-mac-x64.tar.gz`,
      `one-status-device-sidecar-${version}-linux-x64.tar.gz`,
    ];
    for (const name of names) {
      await writeFile(resolve(directory, name), name);
    }
    const outputPath = resolve(directory, "one-status.rb");
    execFileSync(process.execPath, [
      resolve(root, "scripts", "generate-homebrew-formula.mjs"),
      directory,
      outputPath,
      `https://downloads.example.test/v${version}`,
    ]);

    const formula = await readFile(outputPath, "utf8");
    expect(formula).toContain("on_macos do");
    expect(formula).toContain("on_linux do");
    expect(formula).toContain("depends_on arch: :x86_64");
    expect(formula).toContain(
      `one-status-device-sidecar-${version}-mac-arm64.tar.gz`,
    );
    expect(formula).toContain(
      "ONE_STATUS_DEVICE_SIDECAR: (opt_libexec/\"one-status-device-sidecar\").to_s",
    );
    expect(formula.match(/sha256 \"[a-f0-9]{64}\"/g)).toHaveLength(4);
  });

  it.runIf(process.platform !== "win32")(
    "installs the CLI and matching Sidecar from a verified release manifest",
    async () => {
      const directory = await temporaryDirectory();
      const assets = resolve(directory, "assets");
      const cliStage = resolve(directory, "cli-stage", "package", "dist");
      const sidecarStage = resolve(directory, "sidecar-stage");
      const installDirectory = resolve(directory, "install");
      await mkdir(assets, { recursive: true });
      await mkdir(cliStage, { recursive: true });
      await mkdir(sidecarStage, { recursive: true });
      await mkdir(resolve(sidecarStage, "licenses", "cc-switch"), {
        recursive: true,
      });
      const version = "0.8.0";
      const platform = process.platform === "darwin" ? "mac" : "linux";
      const arch = process.arch === "arm64" ? "arm64" : "x64";
      const cliName = `one-status-${version}.tgz`;
      const sidecarName =
        `one-status-device-sidecar-${version}-${platform}-${arch}.tar.gz`;
      await writeFile(
        resolve(cliStage, "one-status.js"),
        "#!/usr/bin/env node\nconsole.log('fixture')\n",
      );
      await writeFile(
        resolve(sidecarStage, "one-status-device-sidecar"),
        "sidecar-fixture",
      );
      await chmod(resolve(sidecarStage, "one-status-device-sidecar"), 0o755);
      await writeFile(
        resolve(sidecarStage, "THIRD_PARTY_NOTICES.device-sidecar.md"),
        "notice-fixture",
      );
      await writeFile(
        resolve(sidecarStage, "licenses", "cc-switch", "LICENSE"),
        "license-fixture",
      );
      execFileSync("tar", [
        "-czf",
        resolve(assets, cliName),
        "-C",
        resolve(directory, "cli-stage"),
        "package",
      ]);
      execFileSync("tar", [
        "-czf",
        resolve(assets, sidecarName),
        "-C",
        sidecarStage,
        "one-status-device-sidecar",
        "THIRD_PARTY_NOTICES.device-sidecar.md",
        "licenses",
      ]);
      const checksums = [cliName, sidecarName].map(async (name) =>
        `${await sha256(resolve(assets, name))}  ${name}`);
      const checksumName = "SHA256SUMS.txt";
      await writeFile(
        resolve(assets, checksumName),
        `${(await Promise.all(checksums)).join("\n")}\n`,
      );
      const release = {
        tag_name: `v${version}`,
        assets: [checksumName, cliName, sidecarName].map((name) => ({
          name,
          browser_download_url: pathToFileURL(resolve(assets, name)).href,
        })),
      };
      const manifest = resolve(directory, "release.json");
      await writeFile(manifest, `${JSON.stringify(release, null, 2)}\n`);

      execFileSync(
        "bash",
        [resolve(root, "apps", "site", "public", "install.sh"), "--cli"],
        {
          env: {
            ...process.env,
            ONE_STATUS_INSTALL_DIR: installDirectory,
            ONE_STATUS_RELEASE_API_URL: pathToFileURL(manifest).href,
          },
        },
      );

      await expect(readFile(resolve(installDirectory, "one-status"), "utf8"))
        .resolves.toContain("fixture");
      await expect(readFile(
        resolve(installDirectory, "one-status-device-sidecar"),
        "utf8",
      )).resolves.toBe("sidecar-fixture");
      expect((await stat(resolve(
        installDirectory,
        "one-status-device-sidecar",
      ))).mode & 0o777).toBe(0o755);
      await expect(readFile(
        resolve(directory, "share", "one-status", "licenses", "cc-switch", "LICENSE"),
        "utf8",
      )).resolves.toBe("license-fixture");
    },
  );
});
