# One Status Handoff

Generated: 2026-08-09T09:34:44.830Z

## Current Goal

Publish and verify One Status v0.5.0 with the Gateway-first MCP experience.

## Current Context

One Status v0.5.0 implementation is ready for publication. The local Formula, API, GUI, Codex MCP, and Claude Code MCP run version 0.5.0. Gateway catalog: Calendar 4, GitHub 6, Slack 4 actions. tools_list returns compact inputSchema/readOnly/requiresConfirmation metadata; tools_execute enforces grants, scopes, confirmation, refresh, response normalization, and audit. Real checks passed: 161/161 tests, encrypted two-device demo, desktop/mobile GUI with no console errors, live GitHub viewer, live Google Calendar query with token refresh, and Claude Code using only One Status tools_list. Next: publish Handoff, tag v0.5.0, verify GitHub Release/CI/Pages/Homebrew.

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
- Added 14 controlled Calendar, GitHub, and Slack actions
- Added Gateway-first MCP instructions and per-action input schemas
- Enforced confirmed writes with stable API errors and audit events
- Added one-status handoff preview/publish command
- Validated 161 tests, encrypted demo, GUI desktop/mobile, live Calendar/GitHub, and Claude Code

## Next

- Complete Apple Developer ID signing and notarization
- Validate Windows and Linux installers on native devices
- Validate Open and Continue on a second physical device
- Monitor post-release regression reports; ship patch v0.4.x if needed
- Publish One Status v0.5.0
- Publish Handoff commit to main
- Tag v0.5.0 and verify Release, CI, Pages, and Homebrew tap

## Blocked

- None

## Git State

- Branch: main
- Commit: f8c4c487ada883c7b0961a121349122d6e0854ce
- Dirty: yes
- Tests: not run
