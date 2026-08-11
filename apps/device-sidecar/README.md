# One Status Device Sidecar

`one-status-device-sidecar` is the local, privilege-limited configuration process for One Status v0.9.0. It scans Codex, Claude Code, and Cursor model state, then previews and applies narrow model-routing changes with atomic writes and rollback records.

## JSON protocol

All responses use one JSON object on stdout. Errors also use stdout so callers never need to expose stderr. Requests can be piped through stdin or passed with `--input PATH`.

```bash
cargo run --manifest-path apps/device-sidecar/Cargo.toml -- scan <<<'{}'
```

The write flow is mandatory:

1. Run `preview` with a model profile.
2. Show `changes`, `warnings`, and target hashes to the user.
3. Run `apply` with the same request plus the returned `expectedPlanId`.
4. Store the returned `transactionId` for an explicit `rollback` operation.

Example profile:

```json
{
  "tool": "codex",
  "profile": {
    "id": "third-party-a",
    "displayName": "Third-party A",
    "modelId": "gpt-5.4",
    "source": "third-party-compatible-api",
    "apiProtocol": "openai-responses",
    "endpoint": "https://api.example.test/v1",
    "credentialEnvVar": "ONE_STATUS_MODEL_A_API_KEY"
  }
}
```

Plaintext fields such as `apiKey`, `accessToken`, `password`, and `secret` are rejected before command deserialization. One Status resolves `credentialEnvVar` from Permission Vault into the sidecar process environment. The value never enters JSON, command-line arguments, stdout, logs, synchronized intent, or active-profile state.

Codex always receives an OpenAI Responses endpoint and Claude Code always receives an Anthropic Messages endpoint. For non-account sources, the API process supplies a source-bound loopback Model Gateway URL and an agent-scoped Gateway token. The upstream API key remains in Permission Vault. Direct credential projection remains available only for an explicit native profile without Gateway routing. Credential-bearing temporary files are created as `0600`, fully written and synced while private, then atomically renamed. A prior broader mode is never applied to the temporary credential file. Newly projected credential targets, manifests, and backups use `0600`, while transaction directories use `0700`. Rollback may restore an older target's recorded mode, but applies it only after the private temporary file has replaced the target. Cursor receives only a credential reference for its One Status extension.

## Adapter boundaries

- Codex: syntax-preserving edits to top-level `model`, `model_provider`, and the selected `model_providers.one-status-*` table. Gateway profiles write `base_url`, `wire_api = "responses"`, and a redacted local bearer token while preserving `mcp_servers`, projects, rules, comments, and unrelated provider tables.
- Claude Code: field-preserving JSON edits to `model` and model-routing keys in `env`. Gateway profiles write `ANTHROPIC_MODEL`, `ANTHROPIC_BASE_URL`, and a redacted local `ANTHROPIC_AUTH_TOKEN` while preserving unrelated settings.
- Cursor: writes `~/.cursor/one-status/model-profile.json` only when the One Status Cursor extension is installed. Without the extension, preview and apply fail closed and leave Cursor settings untouched.

Transaction backups live under `~/.one-status/device-sidecar/transactions` with owner-only permissions. Rollback restores both bytes and the recorded pre-transaction permissions, and refuses to overwrite files whose hash or expected applied mode changed after apply.

`apply` also performs bounded crash recovery while holding the sidecar operation lock. It recovers at most 16 `Prepared` transactions per invocation. Before any recovery write, the sidecar validates the manifest schema, exact target paths, mutation order, backup names, backup SHA-256 values, and private backup permissions. Every current target must match either its recorded before hash or after hash. A valid transaction is restored to its before bytes and permissions and marked `RolledBack`; any unknown content stops recovery without modifying that transaction's targets.

## Development

```bash
cargo fmt --manifest-path apps/device-sidecar/Cargo.toml --check
cargo clippy --manifest-path apps/device-sidecar/Cargo.toml --all-targets -- -D warnings
cargo test --manifest-path apps/device-sidecar/Cargo.toml
```

See `SOURCES.md` and `THIRD_PARTY_NOTICES.md` for CC Switch provenance.
