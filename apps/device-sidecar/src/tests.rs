use std::fs;
use std::path::Path;

use serde_json::{json, Value};
use tempfile::TempDir;

use crate::execute;
use crate::models::CommandName;

#[test]
fn rejects_plaintext_credentials_without_echoing_the_value() {
    let request = json!({
        "tool": "codex",
        "profile": {
            "id": "example",
            "displayName": "Example",
            "modelId": "gpt-5.4",
            "source": "official-api",
            "apiProtocol": "openai-responses",
            "apiKey": "secret-must-never-appear"
        }
    });
    let (exit, response) = run(CommandName::Preview, request);
    assert_eq!(exit, 1);
    assert_eq!(response["error"]["code"], "plaintext_credential_rejected");
    assert!(!response.to_string().contains("secret-must-never-appear"));
}

#[test]
fn codex_apply_preserves_unrelated_fields_and_rollback_restores_exact_bytes() {
    let home = TempDir::new().unwrap();
    let config_path = home.path().join(".codex/config.toml");
    write(
        &config_path,
        br#"# keep this comment
model = "old-model"
model_provider = "old-provider"
personality = "direct"

[model_providers.old-provider]
name = "Old"
base_url = "https://old.example.test/v1"
experimental_bearer_token = "existing-secret"
wire_api = "responses"

[mcp_servers.one-status]
command = "one-status"
args = ["mcp"]
"#,
    );
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(&config_path, fs::Permissions::from_mode(0o640)).unwrap();
    }
    let original = fs::read(&config_path).unwrap();
    let request = codex_request(home.path());
    let (_, preview) = run(CommandName::Preview, request.clone());
    assert!(preview["ok"].as_bool().unwrap());
    assert!(!preview.to_string().contains("existing-secret"));
    assert!(!preview.to_string().contains("vault-test-secret"));
    let plan_id = preview["data"]["planId"].as_str().unwrap();
    #[cfg(unix)]
    {
        assert_eq!(preview["data"]["targets"][0]["beforeMode"], 0o640);
        assert_eq!(preview["data"]["targets"][0]["afterMode"], 0o600);
    }
    let mut apply_request = request;
    apply_request["expectedPlanId"] = Value::String(plan_id.to_string());
    let (exit, applied) = run(CommandName::Apply, apply_request);
    assert_eq!(exit, 0, "{applied}");
    let updated = fs::read_to_string(&config_path).unwrap();
    assert!(updated.contains("# keep this comment"));
    assert!(updated.contains("[mcp_servers.one-status]"));
    assert!(updated.contains("personality = \"direct\""));
    assert!(updated.contains("experimental_bearer_token = \"existing-secret\""));
    assert!(updated.contains("model = \"gpt-5.4\""));
    assert!(updated.contains("model_provider = \"one-status-third-party-a\""));
    assert!(updated.contains("env_key = \"ONE_STATUS_TEST_API_KEY\""));
    #[cfg(unix)]
    assert_eq!(mode(&config_path), 0o600);

    let transaction_id = applied["data"]["transactionId"].as_str().unwrap();
    let transaction_dir = transaction_dir(home.path(), transaction_id);
    #[cfg(unix)]
    {
        assert_eq!(mode(&transaction_dir), 0o700);
        assert_eq!(mode(&transaction_dir.join("manifest.json")), 0o600);
        assert_eq!(mode(&transaction_dir.join("backup-0.bin")), 0o600);
        assert_eq!(mode(&transaction_dir.join("backup-1.bin")), 0o600);
    }
    let (exit, rolled_back) = run(
        CommandName::Rollback,
        json!({ "home": home.path(), "transactionId": transaction_id }),
    );
    assert_eq!(exit, 0, "{rolled_back}");
    assert_eq!(fs::read(&config_path).unwrap(), original);
    #[cfg(unix)]
    assert_eq!(mode(&config_path), 0o640);
    assert!(!home
        .path()
        .join(".one-status/device-sidecar/active/codex.json")
        .exists());
}

#[test]
fn claude_apply_removes_embedded_key_and_preserves_other_sections() {
    let home = TempDir::new().unwrap();
    std::env::set_var("ANTHROPIC_AUTH_TOKEN", "vault-test-secret");
    let settings_path = home.path().join(".claude/settings.json");
    let original = br#"{
  "model": "old-model",
  "env": {
    "ANTHROPIC_BASE_URL": "https://old.example.test",
    "ANTHROPIC_AUTH_TOKEN": "embedded-secret",
    "KEEP_ME": "yes"
  },
  "permissions": { "allow": ["mcp__one_status"] },
  "hooks": { "SessionStart": [] },
  "mcpServers": { "one-status": { "command": "one-status" } }
}
"#;
    write(&settings_path, original);
    let request = json!({
        "home": home.path(),
        "tool": "claude-code",
        "profile": {
            "id": "third-party-a",
            "displayName": "Third-party A",
            "modelId": "claude-compatible-model",
            "source": "third-party-compatible-api",
            "apiProtocol": "anthropic",
            "endpoint": "https://anthropic.example.test/v1",
            "credentialEnvVar": "ANTHROPIC_AUTH_TOKEN"
        }
    });
    let (_, preview) = run(CommandName::Preview, request.clone());
    assert!(!preview.to_string().contains("embedded-secret"));
    assert!(!preview.to_string().contains("vault-test-secret"));
    let mut apply_request = request;
    apply_request["expectedPlanId"] = preview["data"]["planId"].clone();
    let (exit, applied) = run(CommandName::Apply, apply_request);
    assert_eq!(exit, 0, "{applied}");

    let updated: Value = serde_json::from_slice(&fs::read(&settings_path).unwrap()).unwrap();
    assert_eq!(updated["model"], "claude-compatible-model");
    assert_eq!(updated["env"]["ANTHROPIC_MODEL"], "claude-compatible-model");
    assert_eq!(updated["env"]["KEEP_ME"], "yes");
    assert_eq!(updated["env"]["ANTHROPIC_AUTH_TOKEN"], "vault-test-secret");
    assert_eq!(updated["permissions"]["allow"][0], "mcp__one_status");
    assert_eq!(updated["mcpServers"]["one-status"]["command"], "one-status");
    assert!(updated.get("hooks").is_some());
}

#[test]
fn apply_rejects_a_stale_preview() {
    let home = TempDir::new().unwrap();
    let config_path = home.path().join(".codex/config.toml");
    write(&config_path, b"model = \"old\"\n");
    let request = codex_request(home.path());
    let (_, preview) = run(CommandName::Preview, request.clone());
    write(&config_path, b"model = \"changed-after-preview\"\n");
    let mut apply_request = request;
    apply_request["expectedPlanId"] = preview["data"]["planId"].clone();
    let (exit, response) = run(CommandName::Apply, apply_request);
    assert_eq!(exit, 1);
    assert_eq!(response["error"]["code"], "plan_conflict");
    assert_eq!(
        fs::read_to_string(config_path).unwrap(),
        "model = \"changed-after-preview\"\n"
    );
}

#[test]
fn codex_official_account_clears_legacy_top_level_routing() {
    let home = TempDir::new().unwrap();
    let config_path = home.path().join(".codex/config.toml");
    write(
        &config_path,
        br#"model = "legacy"
model_provider = "legacy-provider"
base_url = "https://legacy.example.test/v1"
env_key = "LEGACY_KEY"
wire_api = "chat"
experimental_bearer_token = "legacy-secret"

[mcp_servers.one-status]
command = "one-status"
"#,
    );
    let request = json!({
        "home": home.path(),
        "tool": "codex",
        "profile": {
            "id": "openai-account",
            "displayName": "OpenAI account",
            "modelId": "gpt-5.4",
            "source": "official-account",
            "apiProtocol": "openai-responses"
        }
    });
    let (_, preview) = run(CommandName::Preview, request.clone());
    assert!(!preview.to_string().contains("legacy-secret"));
    let mut apply_request = request;
    apply_request["expectedPlanId"] = preview["data"]["planId"].clone();
    let (exit, response) = run(CommandName::Apply, apply_request);
    assert_eq!(exit, 0, "{response}");
    let updated = fs::read_to_string(config_path).unwrap();
    assert!(updated.contains("model = \"gpt-5.4\""));
    assert!(updated.contains("[mcp_servers.one-status]"));
    for removed in [
        "model_provider",
        "base_url",
        "env_key",
        "wire_api",
        "experimental_bearer_token",
    ] {
        assert!(
            !updated.contains(removed),
            "{removed} remained in {updated}"
        );
    }
}

#[test]
fn rollback_validates_every_backup_before_restoring_any_file() {
    let home = TempDir::new().unwrap();
    let config_path = home.path().join(".codex/config.toml");
    write(&config_path, b"model = \"old\"\n");
    let request = codex_request(home.path());
    let (_, preview) = run(CommandName::Preview, request.clone());
    let mut apply_request = request;
    apply_request["expectedPlanId"] = preview["data"]["planId"].clone();
    let (_, applied) = run(CommandName::Apply, apply_request);
    let transaction_id = applied["data"]["transactionId"].as_str().unwrap();
    let applied_config = fs::read(&config_path).unwrap();
    let transaction_dir = home
        .path()
        .join(".one-status/device-sidecar/transactions")
        .join(transaction_id);
    fs::remove_file(transaction_dir.join("backup-0.bin")).unwrap();

    let (exit, response) = run(
        CommandName::Rollback,
        json!({ "home": home.path(), "transactionId": transaction_id }),
    );
    assert_eq!(exit, 1);
    assert_eq!(response["error"]["code"], "invalid_local_configuration");
    assert_eq!(fs::read(config_path).unwrap(), applied_config);
    assert!(home
        .path()
        .join(".one-status/device-sidecar/active/codex.json")
        .exists());
}

#[test]
fn apply_recovers_a_partially_applied_prepared_transaction_with_permissions() {
    let home = TempDir::new().unwrap();
    let config_path = home.path().join(".codex/config.toml");
    let active_path = home
        .path()
        .join(".one-status/device-sidecar/active/codex.json");
    write(&config_path, b"model = \"old\"\n");
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(&config_path, fs::Permissions::from_mode(0o640)).unwrap();
    }
    let original = fs::read(&config_path).unwrap();
    let request = codex_request(home.path());
    let (_, preview) = run(CommandName::Preview, request.clone());
    let mut apply_request = request.clone();
    apply_request["expectedPlanId"] = preview["data"]["planId"].clone();
    let (_, applied) = run(CommandName::Apply, apply_request);
    let transaction_id = applied["data"]["transactionId"].as_str().unwrap();
    let transaction_dir = transaction_dir(home.path(), transaction_id);

    // Simulate a crash after the tool config reached `after`, while active
    // profile state still has its `before` state.
    fs::remove_file(&active_path).unwrap();
    mark_transaction_prepared(&transaction_dir);
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(&config_path, fs::Permissions::from_mode(0o644)).unwrap();
    }

    let (_, stale_preview) = run(CommandName::Preview, request.clone());
    let mut next_apply = request;
    next_apply["expectedPlanId"] = stale_preview["data"]["planId"].clone();
    let (exit, response) = run(CommandName::Apply, next_apply);
    assert_eq!(exit, 1);
    assert_eq!(response["error"]["code"], "plan_conflict");
    assert_eq!(fs::read(&config_path).unwrap(), original);
    assert!(!active_path.exists());
    assert_eq!(manifest_state(&transaction_dir), "rolledback");
    #[cfg(unix)]
    {
        assert_eq!(mode(&config_path), 0o640);
        assert_eq!(mode(&transaction_dir.join("manifest.json")), 0o600);
    }
}

#[test]
fn prepared_recovery_stops_before_writes_on_external_content_conflict() {
    let home = TempDir::new().unwrap();
    let config_path = home.path().join(".codex/config.toml");
    let active_path = home
        .path()
        .join(".one-status/device-sidecar/active/codex.json");
    write(&config_path, b"model = \"old\"\n");
    let request = codex_request(home.path());
    let (_, preview) = run(CommandName::Preview, request.clone());
    let mut apply_request = request.clone();
    apply_request["expectedPlanId"] = preview["data"]["planId"].clone();
    let (_, applied) = run(CommandName::Apply, apply_request);
    let transaction_id = applied["data"]["transactionId"].as_str().unwrap();
    let transaction_dir = transaction_dir(home.path(), transaction_id);
    let active_after = fs::read(&active_path).unwrap();
    mark_transaction_prepared(&transaction_dir);
    let external = b"model = \"external-change\"\n";
    write(&config_path, external);

    let (_, stale_preview) = run(CommandName::Preview, request.clone());
    let mut next_apply = request;
    next_apply["expectedPlanId"] = stale_preview["data"]["planId"].clone();
    let (exit, response) = run(CommandName::Apply, next_apply);
    assert_eq!(exit, 1);
    assert_eq!(response["error"]["code"], "prepared_transaction_conflict");
    assert_eq!(fs::read(&config_path).unwrap(), external);
    assert_eq!(fs::read(active_path).unwrap(), active_after);
    assert_eq!(manifest_state(&transaction_dir), "prepared");
}

#[test]
fn prepared_recovery_validates_all_backup_hashes_before_writes() {
    let home = TempDir::new().unwrap();
    let config_path = home.path().join(".codex/config.toml");
    let active_path = home
        .path()
        .join(".one-status/device-sidecar/active/codex.json");
    write(&config_path, b"model = \"old\"\n");
    let request = codex_request(home.path());
    let (_, preview) = run(CommandName::Preview, request.clone());
    let mut apply_request = request.clone();
    apply_request["expectedPlanId"] = preview["data"]["planId"].clone();
    let (_, applied) = run(CommandName::Apply, apply_request);
    let transaction_id = applied["data"]["transactionId"].as_str().unwrap();
    let transaction_dir = transaction_dir(home.path(), transaction_id);
    let applied_config = fs::read(&config_path).unwrap();
    let applied_state = fs::read(&active_path).unwrap();
    mark_transaction_prepared(&transaction_dir);
    fs::write(transaction_dir.join("backup-0.bin"), b"tampered-backup").unwrap();

    let (_, stale_preview) = run(CommandName::Preview, request.clone());
    let mut next_apply = request;
    next_apply["expectedPlanId"] = stale_preview["data"]["planId"].clone();
    let (exit, response) = run(CommandName::Apply, next_apply);
    assert_eq!(exit, 1);
    assert_eq!(response["error"]["code"], "invalid_local_configuration");
    assert_eq!(fs::read(config_path).unwrap(), applied_config);
    assert_eq!(fs::read(active_path).unwrap(), applied_state);
    assert_eq!(manifest_state(&transaction_dir), "prepared");
}

#[test]
fn prepared_recovery_is_bounded_per_apply_invocation() {
    let home = TempDir::new().unwrap();
    let config_path = home.path().join(".codex/config.toml");
    write(&config_path, b"model = \"old\"\n");
    let request = codex_request(home.path());
    let (_, preview) = run(CommandName::Preview, request.clone());
    let mut apply_request = request.clone();
    apply_request["expectedPlanId"] = preview["data"]["planId"].clone();
    let (_, applied) = run(CommandName::Apply, apply_request);
    let transaction_id = applied["data"]["transactionId"].as_str().unwrap();
    let source_dir = transaction_dir(home.path(), transaction_id);
    let mut manifest: Value =
        serde_json::from_slice(&fs::read(source_dir.join("manifest.json")).unwrap()).unwrap();
    let backup_0 = fs::read(source_dir.join("backup-0.bin")).unwrap();
    let backup_1 = fs::read(source_dir.join("backup-1.bin")).unwrap();
    fs::remove_dir_all(&source_dir).unwrap();

    let transaction_root = home.path().join(".one-status/device-sidecar/transactions");
    for index in 0..17 {
        let id = format!("tx-0000000000000-recovery{index:02}");
        let directory = transaction_root.join(&id);
        fs::create_dir(&directory).unwrap();
        manifest["transactionId"] = Value::String(id);
        manifest["state"] = Value::String("prepared".to_string());
        fs::write(
            directory.join("manifest.json"),
            serde_json::to_vec_pretty(&manifest).unwrap(),
        )
        .unwrap();
        fs::write(directory.join("backup-0.bin"), &backup_0).unwrap();
        fs::write(directory.join("backup-1.bin"), &backup_1).unwrap();
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            fs::set_permissions(&directory, fs::Permissions::from_mode(0o700)).unwrap();
            for name in ["manifest.json", "backup-0.bin", "backup-1.bin"] {
                fs::set_permissions(directory.join(name), fs::Permissions::from_mode(0o600))
                    .unwrap();
            }
        }
    }

    let (_, stale_preview) = run(CommandName::Preview, request.clone());
    let mut next_apply = request;
    next_apply["expectedPlanId"] = stale_preview["data"]["planId"].clone();
    let (exit, response) = run(CommandName::Apply, next_apply);
    assert_eq!(exit, 1);
    assert_eq!(response["error"]["code"], "plan_conflict");

    let states = fs::read_dir(transaction_root)
        .unwrap()
        .map(|entry| manifest_state(&entry.unwrap().path()))
        .collect::<Vec<_>>();
    assert_eq!(
        states.iter().filter(|state| *state == "rolledback").count(),
        16
    );
    assert_eq!(
        states.iter().filter(|state| *state == "prepared").count(),
        1
    );
}

#[test]
fn scan_reports_models_without_serializing_credentials() {
    let home = TempDir::new().unwrap();
    write(
        &home.path().join(".codex/config.toml"),
        br#"model = "gpt-5.4"
model_provider = "third-party"

[model_providers.third-party]
base_url = "https://api.example.test/v1"
experimental_bearer_token = "scan-secret"
wire_api = "responses"
"#,
    );
    write(
        &home.path().join(".codex/models_cache.json"),
        br#"{"models":[{"slug":"gpt-5.4","display_name":"GPT-5.4"},{"id":"gpt-5.5"}]}"#,
    );
    let (exit, response) = run(CommandName::Scan, json!({ "home": home.path() }));
    assert_eq!(exit, 0, "{response}");
    assert!(!response.to_string().contains("scan-secret"));
    let codex = &response["data"]["tools"][0];
    assert_eq!(codex["currentModel"]["modelId"], "gpt-5.4");
    assert_eq!(codex["currentModel"]["endpointDomain"], "api.example.test");
    assert_eq!(codex["currentModel"]["credentialAvailable"], true);
    assert_eq!(codex["discoveredModels"].as_array().unwrap().len(), 2);
}

#[test]
fn usage_aggregates_codex_and_claude_sessions_without_returning_content() {
    let home = TempDir::new().unwrap();
    let codex_session = home.path().join(".codex/sessions/2026/08/10/rollout.jsonl");
    let codex_lines = [
        json!({"type":"session_meta","payload":{"id":"thread-1"}}),
        json!({"type":"turn_context","payload":{"model":"gpt-5.4"}}),
        json!({"type":"event_msg","timestamp":"2026-08-10T01:00:00Z","payload":{"type":"token_count","info":{"total_token_usage":{"input_tokens":100,"cached_input_tokens":50,"output_tokens":10},"last_token_usage":{"input_tokens":100,"cached_input_tokens":50,"output_tokens":10}}}}),
        json!({"type":"event_msg","timestamp":"2026-08-10T01:01:00Z","payload":{"type":"token_count","info":{"total_token_usage":{"input_tokens":200,"cached_input_tokens":100,"output_tokens":20}}}}),
    ];
    write(
        &codex_session,
        codex_lines
            .iter()
            .map(Value::to_string)
            .collect::<Vec<_>>()
            .join("\n")
            .as_bytes(),
    );

    let claude_session = home.path().join(".claude/projects/project-a/session.jsonl");
    let claude_lines = [
        json!({"type":"assistant","timestamp":"2026-08-10T02:00:00Z","message":{"id":"msg-1","model":"claude-opus-4-6","usage":{"input_tokens":3,"output_tokens":10,"cache_read_input_tokens":20,"cache_creation_input_tokens":30}}}),
        json!({"type":"assistant","timestamp":"2026-08-10T02:01:00Z","message":{"id":"msg-1","model":"claude-opus-4-6","stop_reason":"end_turn","usage":{"input_tokens":3,"output_tokens":15,"cache_read_input_tokens":20,"cache_creation_input_tokens":30}}}),
    ];
    write(
        &claude_session,
        claude_lines
            .iter()
            .map(Value::to_string)
            .collect::<Vec<_>>()
            .join("\n")
            .as_bytes(),
    );

    let (exit, response) = run(
        CommandName::Usage,
        json!({"home": home.path(), "maxFilesPerTool": 20}),
    );
    assert_eq!(exit, 0, "{response}");
    assert_eq!(response["data"]["filesScanned"], 2);
    assert_eq!(response["data"]["entries"].as_array().unwrap().len(), 2);
    let serialized = response.to_string();
    assert!(!serialized.contains("thread-1"));
    assert!(!serialized.contains("msg-1"));
    assert!(serialized.contains("gpt-5.4"));
    assert!(serialized.contains("claude-opus-4-6"));
    let codex = response["data"]["entries"]
        .as_array()
        .unwrap()
        .iter()
        .find(|entry| entry["tool"] == "codex")
        .unwrap();
    assert_eq!(codex["inputTokens"], 200);
    assert_eq!(codex["cachedInputTokens"], 100);
    assert_eq!(codex["outputTokens"], 20);
    assert_eq!(codex["requests"], 2);
    let claude = response["data"]["entries"]
        .as_array()
        .unwrap()
        .iter()
        .find(|entry| entry["tool"] == "claude-code")
        .unwrap();
    assert_eq!(claude["inputTokens"], 3);
    assert_eq!(claude["cachedInputTokens"], 20);
    assert_eq!(claude["cacheCreationInputTokens"], 30);
    assert_eq!(claude["outputTokens"], 15);
    assert_eq!(claude["requests"], 1);
}

#[test]
fn cursor_writes_only_the_extension_manifest() {
    let home = TempDir::new().unwrap();
    let settings = home
        .path()
        .join("Library/Application Support/Cursor/User/settings.json");
    write(&settings, br#"{"mcp":{"keep":true},"rules":"keep"}"#);
    let request = json!({
        "home": home.path(),
        "tool": "cursor",
        "profile": {
            "id": "local",
            "displayName": "Local",
            "modelId": "qwen-local",
            "source": "local-model-service",
            "apiProtocol": "openai-chat-completions",
            "endpoint": "http://127.0.0.1:11434/v1"
        }
    });
    let (_, preview) = run(CommandName::Preview, request.clone());
    assert!(preview["data"]["warnings"][0]
        .as_str()
        .unwrap()
        .contains("Cursor"));
    let mut apply_request = request;
    apply_request["expectedPlanId"] = preview["data"]["planId"].clone();
    let (exit, applied) = run(CommandName::Apply, apply_request);
    assert_eq!(exit, 0, "{applied}");
    assert_eq!(
        fs::read_to_string(settings).unwrap(),
        "{\"mcp\":{\"keep\":true},\"rules\":\"keep\"}"
    );
    assert!(home
        .path()
        .join(".cursor/one-status/model-profile.json")
        .exists());
}

fn codex_request(home: &Path) -> Value {
    std::env::set_var("ONE_STATUS_TEST_API_KEY", "vault-test-secret");
    json!({
        "home": home,
        "tool": "codex",
        "profile": {
            "id": "third-party-a",
            "displayName": "Third-party A",
            "modelId": "gpt-5.4",
            "modelName": "GPT-5.4",
            "source": "third-party-compatible-api",
            "apiProtocol": "openai-responses",
            "endpoint": "https://api.example.test/v1",
            "credentialEnvVar": "ONE_STATUS_TEST_API_KEY"
        }
    })
}

fn run(command: CommandName, request: Value) -> (i32, Value) {
    execute(command, &serde_json::to_vec(&request).unwrap())
}

fn write(path: &Path, bytes: &[u8]) {
    fs::create_dir_all(path.parent().unwrap()).unwrap();
    fs::write(path, bytes).unwrap();
}

fn transaction_dir(home: &Path, transaction_id: &str) -> std::path::PathBuf {
    home.join(".one-status/device-sidecar/transactions")
        .join(transaction_id)
}

fn mark_transaction_prepared(transaction_dir: &Path) {
    let manifest_path = transaction_dir.join("manifest.json");
    let mut manifest: Value = serde_json::from_slice(&fs::read(&manifest_path).unwrap()).unwrap();
    manifest["state"] = Value::String("prepared".to_string());
    fs::write(manifest_path, serde_json::to_vec_pretty(&manifest).unwrap()).unwrap();
}

fn manifest_state(transaction_dir: &Path) -> String {
    let manifest: Value =
        serde_json::from_slice(&fs::read(transaction_dir.join("manifest.json")).unwrap()).unwrap();
    manifest["state"].as_str().unwrap().to_string()
}

#[cfg(unix)]
fn mode(path: &Path) -> u32 {
    use std::os::unix::fs::PermissionsExt;
    fs::metadata(path).unwrap().permissions().mode() & 0o777
}
