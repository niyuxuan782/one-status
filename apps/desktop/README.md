# One Status Desktop

Electron desktop shell for the local One Status control center. It starts the
loopback API on port `8787`, or reuses an already-running One Status instance
after validating its `/health` response.

## Development

From the repository root:

```bash
pnpm install
pnpm --filter @one-status/desktop dev
```

Override the loopback port when needed:

```bash
ONE_STATUS_PORT=8877 pnpm --filter @one-status/desktop dev
```

## Packages

```bash
pnpm --filter @one-status/desktop dist:mac
pnpm --filter @one-status/desktop dist:win
pnpm --filter @one-status/desktop dist:linux
```

Outputs are written to `apps/desktop/release`:

- macOS: arm64/x64 `.app`, `.dmg`, and `.zip`
- Windows: x64 NSIS installer and portable `.exe`
- Linux: arm64/x64 AppImage and `.deb`

Cross-platform packages should be built on their native operating system in
release automation. Production distribution also requires the corresponding
Apple Developer ID and Windows code-signing credentials.

## Runtime security

The renderer has no Node.js integration or preload bridge. Context isolation,
Chromium sandboxing, and web security stay enabled. Permission requests are
denied, untrusted popup windows are blocked, and external HTTP(S) navigation is
opened in the operating system browser. The embedded API binds only to
`127.0.0.1`.
