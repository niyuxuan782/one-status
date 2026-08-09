# One Status Handoff

Generated: 2026-08-09T14:46:08.102Z

## Current Goal

Configure OAuth Apps and complete real-account acceptance for the 11 new providers, reauthorize Google Workspace and Slack scopes, then validate Open and Continue on a second physical device.

## Current Context

One Status v0.6.0 is released and deployed. Source/tag commit: 11d9e9fa9de32bd4d87c0ebd28a7de6665fa7124. GitHub Actions CI run 31317955613 and Release run 31318055640 passed; the release publishes 12 CLI/macOS/Windows/Linux assets and GHCR digest sha256:9cbad1c5844a3a636ff93db9fbd7ae50b568caa7ab9d43c37deb89436123d019. GitHub Pages presents 14 Capability Packs and 69 controlled actions. Homebrew tap commit 338689731ed1df95894936cd985ebca50a34baa5 publishes Formula and Cask 0.6.0; local Formula install, brew test, style and strict audits passed. Tencent Cloud now runs release 20260809T143804Z with API 0.6.0; public HTTPS, redirect, auth denial, non-root/read-only containers, SQLite quick_check, foreign keys and agent_credentials migration passed. Local Homebrew LaunchAgent is healthy at 127.0.0.1:8787. Fresh Codex and Claude Code MCP processes used bound Agent credentials, read status version 77, listed 14 packs and the existing GitHub, Google and Slack grants. All 14 packs are installed for Codex and Claude Code. Real OAuth acceptance is complete for Google Workspace, GitHub and Slack; Google requires reauthorization for Gmail, Drive and Docs scopes, Slack requires history, search and chat scopes. Microsoft 365, Notion, Dropbox, Zoom, Canva, Asana, Trello, Airtable, Linear, Figma and Box have code-complete OAuth/action implementations and still need Provider App credentials plus real-account acceptance. ChatGPT Apps SDK/hosted Remote MCP and second-device Open and Continue remain next-stage validation.

## Architecture Decisions

- Capability Pack is the platform-neutral capability unit; adapters compile it for each Agent.
- Codex and Claude Code are the fully installed MVP targets; Cursor manifest exists, while ChatGPT Apps SDK and hosted Remote MCP remain on the roadmap.
- Provider credentials remain in the encrypted local Permission Vault; Agent tool calls use short-lived bound credentials and exact Dashboard approval for writes.
- One Status Cloud stores encrypted Status and permission bundles; GitHub stores project code and release artifacts.

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
- Google Workspace, GitHub and Slack real-account flows verified
- 14 Provider catalogs and 69 fixed actions released
- Per-Agent grants, bound credentials and write approvals verified
- Two-device encrypted Demo passed
- Codex and Claude Code adapters installed locally

## Next

- Complete Apple Developer ID signing and notarization
- Validate Windows and Linux installers on native devices
- Validate Open and Continue on a second physical device
- Monitor post-release regression reports; ship patch v0.4.x if needed
- Reauthorize the existing Slack connection for history, search, and chat scopes
- Choose additional read actions for Codex and Claude Code in Connections
- Complete OAuth acceptance for v0.6.0 Providers
- Reauthorize Google Workspace for Gmail, Drive and Docs
- Reauthorize Slack for history, search and chat
- Create OAuth Apps and validate Microsoft 365, Notion, Dropbox, Zoom, Canva, Asana, Airtable, Linear, Figma and Box
- Configure Trello API key and user Token
- Install One Status 0.6.0 on Mac B
- Login with recovery key
- Open published Handoff at exact Git commit
- Confirm Codex restores current context

## Blocked

- None

## Git State

- Branch: main
- Commit: 11d9e9fa9de32bd4d87c0ebd28a7de6665fa7124
- Dirty: no
- Tests: not run
