export const deviceSidecarTargets = Object.freeze([
  Object.freeze({ platform: "mac", arch: "arm64" }),
  Object.freeze({ platform: "mac", arch: "x64" }),
  Object.freeze({ platform: "windows", arch: "x64" }),
  Object.freeze({ platform: "linux", arch: "x64" }),
]);

export function deviceSidecarArtifactName(version, platform, arch) {
  assertTarget(platform, arch);
  return `one-status-device-sidecar-${version}-${platform}-${arch}.tar.gz`;
}

export function deviceSidecarExecutableName(platform) {
  return platform === "windows"
    ? "one-status-device-sidecar.exe"
    : "one-status-device-sidecar";
}

export function deviceSidecarAssetNames(version) {
  return deviceSidecarTargets.map(({ platform, arch }) =>
    deviceSidecarArtifactName(version, platform, arch));
}

export function assertTarget(platform, arch) {
  if (!deviceSidecarTargets.some(
    (target) => target.platform === platform && target.arch === arch,
  )) {
    throw new Error(`Unsupported Device Sidecar target: ${platform}-${arch}`);
  }
}
