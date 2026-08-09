# One Status Handoff

Generated: 2026-08-09T09:53:23.528Z

## Current Goal

Reauthorize and grant the new Gateway actions, then validate Open and Continue on a second physical device.

## Current Context

One Status v0.5.0 is fully released and deployed. Source/tag: 92c2e3ecb8d54b4afa14864eee88125fe37874d9. Release workflow 31306306609 passed all jobs and published 12 assets plus GHCR digest sha256:87cd1f711212d3d5fc8b0a0aacba4870ca41152fa4e9275b3682b8c1b7014989. GitHub Pages shows v0.5.0 and 14 Gateway actions. Homebrew tap commit ab69ba134b84f14da9a75d397139684d315edb4a publishes Formula/Cask 0.5.0; fetch, style, and strict audit passed. Tencent Cloud runs release 20260809T094657Z with API version 0.5.0; public HTTPS, redirect, auth denial, container health, read-only rootfs, non-root user, and SQLite quick_check passed. Local Codex and Claude Code MCP are connected; a real Claude Qwen session used only One Status tools_list. Next: reauthorize Slack for new scopes, grant desired new actions, and validate second-device Open and Continue.

## Architecture Decisions

- None

## Completed

- Release One Status v0.2.0
- Status schema v2 and legacy migration
- Memory candidate confirmation and provenance
- Task State and local project path registration
- Activity and Agent Permission Firewall
- GitHub, Google Calendar, and Slack live OAuth
- Multi-device Slack refresh reconciliation
- GitHub Release and public Homebrew tap
- Tencent Cloud release 20260809T033046Z
- 129 tests and two-Agent demo
- Release One Status v0.3.0 Open Core
- Cross-platform Electron GUI packages for macOS, Windows, and Linux
- GitHub Pages website and static asset delivery
- GitHub Releases with 12 assets and SHA-256 manifest
- One-click CLI and desktop installers using a GitHub-hosted release manifest
- Public Homebrew Formula and working Cask app-bundle mapping
- Tencent Cloud dynamic-only API deployment at release 20260809T051548Z
- Codex and Claude Code MCP continuity
- OAuth Permission Vault for GitHub, Google Calendar, and Slack
- 145 tests, two-device demo, CI, Pages, SQLite, and public HTTPS verification
- Release v0.4.0
- worktree clean; HEAD == tag v0.4.0 == origin/main == remote tag: 64430d29e3bf30f5abbcc87537253f2c3c819e90
- GitHub Release v0.4.0 published 2026-08-09T07:43:38Z with 12 assets: https://github.com/niyuxuan782/one-status/releases/tag/v0.4.0
- Release workflow success on tag v0.4.0 (run 31301582002)
- CI workflow success on main 64430d29 (run 31301580210)
- Pages workflow success on main 64430d29 (run 31301580227)
- Publish One Status v0.5.0
- Published code and Handoff at commit 92c2e3ecb8d54b4afa14864eee88125fe37874d9
- Published GitHub Release v0.5.0 with 12 checksum-listed assets
- Release workflow 31306306609 passed verify, four desktop builds, release, and container
- Published GHCR image digest sha256:87cd1f711212d3d5fc8b0a0aacba4870ca41152fa4e9275b3682b8c1b7014989
- Updated Homebrew Formula and Cask at tap commit ab69ba134b84f14da9a75d397139684d315edb4a
- Deployed Tencent Cloud release 20260809T094657Z; API 0.5.0 healthy and SQLite quick_check passed
- Verified local Codex and Claude Code MCP connections and real Claude tools_list call

## Next

- Complete Apple Developer ID signing and notarization
- Validate Windows and Linux installers on native devices
- Validate Open and Continue on a second physical device
- Monitor post-release regression reports; ship patch v0.4.x if needed
- Reauthorize the existing Slack connection for history, search, and chat scopes
- Choose additional read actions for Codex and Claude Code in Connections

## Blocked

- None

## Git State

- Branch: main
- Commit: 92c2e3ecb8d54b4afa14864eee88125fe37874d9
- Dirty: no
- Tests: not run
