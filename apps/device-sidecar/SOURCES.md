# Upstream source record

## CC Switch

- Repository: <https://github.com/farion1231/cc-switch>
- Fixed commit: `413c09e0790c304506888ae24b9be72820aca126`
- Commit date: `2026-08-06T16:19:04+08:00`
- Commit subject: `fix(codex): respect user-owned model_catalog_json when generating catalog (#6087)`
- Upstream package version at that commit: `3.19.2`
- License: MIT
- Copyright: `Copyright (c) 2025 Jason Young`

The One Status sidecar contains a focused adaptation of these upstream areas:

| Upstream path | Used concept | One Status destination |
| --- | --- | --- |
| `src-tauri/src/config.rs` | Claude paths, temporary-file replacement, permission preservation | `src/paths.rs`, `src/atomic.rs` |
| `src-tauri/src/codex_config.rs` | Codex paths, TOML validation, provider field placement, config-only switching | `src/paths.rs`, `src/adapters/codex.rs` |
| `src-tauri/src/services/provider/live.rs` | Claude/Codex live projection and preservation of unrelated settings | `src/adapters/claude.rs`, `src/adapters/codex.rs` |
| `src-tauri/src/app_config.rs` | Typed application identifiers and provider/profile separation | `src/models.rs` |
| `src-tauri/src/provider.rs` | Provider/profile metadata concepts | `src/models.rs`, `src/inventory.rs` |

No CC Switch proxy, OAuth reverse proxy, failover, balance/usage, marketplace, advertising, billing, or provider recommendation code is included.

Reference SHA-256 values from the fixed commit:

```text
912b6a597d10c43b40a0909349ed95b052b17efb6502b4898e1b35dafb896755  LICENSE
f1d00f3ded96a520463e2c18b0c66d1071fb01181da6412d3a1dcc06dce7263f  src-tauri/src/config.rs
e6bf8d5b263b0a5231211c2bfbb65acebc6c152fbebeb270a13721c0a9a6bfc4  src-tauri/src/codex_config.rs
806177e5c05e8e0adc45882f3085695f22249747d2c3b3b75b6f8c7e490ead55  src-tauri/src/app_config.rs
6061389159fc917664d2d6278b3cf48c5c4ab06415ddb2fb407dcf8dbc58900f  src-tauri/src/provider.rs
fcbbc8ee2d5e52f60fe31ab14d540c0ad81c54689acdede0bc0eef04cc40993d  src-tauri/src/services/provider/live.rs
```
