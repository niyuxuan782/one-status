# One Status Desktop

Electron desktop shell for the local One Status control center. The main
process owns the loopback API on port `8787`, or reuses an already-running One
Status instance after validating its `/health` response.

The executable has two launch modes:

- `one-status --background` starts the local service and heartbeat without a
  window. It keeps the single-instance lock so a later normal App launch can
  show the control center in the same process.
- A normal launch starts the service when needed and opens the window. Closing
  the window releases Renderer resources while the local service remains
  available to MCP and model Gateway calls.

The overview startup switch manages a per-user login item. macOS writes
`~/Library/LaunchAgents/top.furesta.onestatus.background.plist`, Windows uses
the current user's `Run` registry key, and Linux writes a hidden XDG Autostart
entry. Every login item passes only `--background`, so system login never opens
the graphical interface.

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
opened in the operating system browser. The local API binds only to
`127.0.0.1`. On macOS, each Status or Gateway operation loads the current
device session and Status Key from Keychain through the local profile layer.
