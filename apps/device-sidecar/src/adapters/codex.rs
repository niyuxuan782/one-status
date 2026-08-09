//! Syntax-preserving Codex `config.toml` adapter.
//!
//! Config path and live-provider field behavior are based on CC Switch
//! `codex_config.rs` and `services/provider/live.rs` at commit
//! `413c09e0790c304506888ae24b9be72820aca126` (MIT, Jason Young, 2025).

use std::str::FromStr;

use serde_json::Value;
use toml_edit::{value, DocumentMut, Item, Table};

use super::{credential_from_environment, safe_value, AdapterOutput};
use crate::atomic::{file_mode, read_optional};
use crate::error::{SidecarError, SidecarResult};
use crate::models::{
    ApiProtocol, ChangeOperation, ConfigChange, MutationPurpose, PlannedMutation, ProfileSummary,
    SourceType,
};
use crate::paths::ResolvedPaths;
use crate::security::redacted_presence;

pub(crate) fn plan(
    paths: &ResolvedPaths,
    profile: &ProfileSummary,
) -> SidecarResult<AdapterOutput> {
    let path = paths.codex_config.clone();
    let before_mode = file_mode(&path)?;
    let before = read_optional(&path)?;
    let text = before
        .as_deref()
        .map(std::str::from_utf8)
        .transpose()
        .map_err(|_| {
            SidecarError::InvalidConfiguration("Codex config.toml is not valid UTF-8.".to_string())
        })?
        .unwrap_or("");
    let mut document = if text.trim().is_empty() {
        DocumentMut::new()
    } else {
        DocumentMut::from_str(text).map_err(|_| {
            SidecarError::InvalidConfiguration(
                "Codex config.toml contains invalid TOML.".to_string(),
            )
        })?
    };
    let mut changes = Vec::new();

    replace_top_level(
        &mut document,
        "model",
        &profile.model_id,
        "model",
        &mut changes,
    );

    if profile.source == SourceType::OfficialAccount {
        let previous_provider = document
            .get("model_provider")
            .and_then(Item::as_str)
            .map(str::to_string);
        if document.remove("model_provider").is_some() {
            changes.push(ConfigChange {
                path: "model_provider".to_string(),
                operation: ChangeOperation::Remove,
                before: safe_value(previous_provider.as_deref()),
                after: None,
                sensitive: false,
            });
        }
        remove_top_level_safe(&mut document, "base_url", &mut changes);
        remove_top_level_safe(&mut document, "env_key", &mut changes);
        remove_top_level_safe(&mut document, "wire_api", &mut changes);
        remove_top_level_sensitive(&mut document, "experimental_bearer_token", &mut changes);
        remove_top_level_sensitive(&mut document, "api_key", &mut changes);
    } else {
        let provider_id = format!("one-status-{}", profile.id);
        replace_top_level(
            &mut document,
            "model_provider",
            &provider_id,
            "model_provider",
            &mut changes,
        );

        let providers = document
            .entry("model_providers")
            .or_insert(Item::Table(Table::new()))
            .as_table_mut()
            .ok_or_else(|| {
                SidecarError::InvalidConfiguration(
                    "Codex model_providers must be a TOML table.".to_string(),
                )
            })?;
        let provider = providers
            .entry(&provider_id)
            .or_insert(Item::Table(Table::new()))
            .as_table_mut()
            .ok_or_else(|| {
                SidecarError::InvalidConfiguration(format!(
                    "Codex model_providers.{provider_id} must be a TOML table."
                ))
            })?;

        replace_table_string(
            provider,
            "name",
            &profile.display_name,
            format!("model_providers.{provider_id}.name"),
            &mut changes,
        );
        replace_table_string(
            provider,
            "base_url",
            profile.endpoint.as_deref().expect("validated endpoint"),
            format!("model_providers.{provider_id}.base_url"),
            &mut changes,
        );
        let wire_api = match profile.api_protocol {
            ApiProtocol::OpenaiResponses => "responses",
            ApiProtocol::OpenaiChatCompletions => "chat",
            ApiProtocol::Anthropic => unreachable!("validated by adapter dispatch"),
        };
        replace_table_string(
            provider,
            "wire_api",
            wire_api,
            format!("model_providers.{provider_id}.wire_api"),
            &mut changes,
        );
        if let Some(variable) = profile.credential_env_var.as_deref() {
            replace_table_string(
                provider,
                "env_key",
                variable,
                format!("model_providers.{provider_id}.env_key"),
                &mut changes,
            );
            let credential = credential_from_environment(variable)?;
            replace_table_sensitive(
                provider,
                "experimental_bearer_token",
                &credential,
                format!("model_providers.{provider_id}.experimental_bearer_token"),
                &mut changes,
            );
        } else if provider.remove("env_key").is_some() {
            changes.push(ConfigChange {
                path: format!("model_providers.{provider_id}.env_key"),
                operation: ChangeOperation::Remove,
                before: Some(Value::String("<environment-variable-name>".to_string())),
                after: None,
                sensitive: false,
            });
        }
        let previous_bearer = provider.get("experimental_bearer_token");
        if profile.credential_env_var.is_none() && previous_bearer.is_some() {
            changes.push(ConfigChange {
                path: format!("model_providers.{provider_id}.experimental_bearer_token"),
                operation: ChangeOperation::Remove,
                before: redacted_presence(previous_bearer.map(|_| &Value::Null)),
                after: None,
                sensitive: true,
            });
            provider.remove("experimental_bearer_token");
        }
    }

    let mut after = document.to_string();
    if !after.ends_with('\n') {
        after.push('\n');
    }
    Ok(AdapterOutput {
        mutation: PlannedMutation {
            purpose: MutationPurpose::ToolConfiguration,
            path,
            before,
            after: after.into_bytes(),
            before_mode,
            private: profile.credential_env_var.is_some(),
        },
        changes,
        warnings: Vec::new(),
    })
}

fn replace_table_sensitive(
    table: &mut Table,
    key: &str,
    next: &str,
    path: String,
    changes: &mut Vec<ConfigChange>,
) {
    let had_previous = table.get(key).is_some();
    table[key] = value(next);
    changes.push(ConfigChange {
        path,
        operation: if had_previous {
            ChangeOperation::Update
        } else {
            ChangeOperation::Add
        },
        before: had_previous.then(|| Value::String("<redacted>".to_string())),
        after: Some(Value::String("<redacted>".to_string())),
        sensitive: true,
    });
}

fn remove_top_level_safe(document: &mut DocumentMut, key: &str, changes: &mut Vec<ConfigChange>) {
    let previous = document.get(key).and_then(Item::as_str).map(str::to_string);
    if document.remove(key).is_some() {
        changes.push(ConfigChange {
            path: key.to_string(),
            operation: ChangeOperation::Remove,
            before: safe_value(previous.as_deref()),
            after: None,
            sensitive: false,
        });
    }
}

fn remove_top_level_sensitive(
    document: &mut DocumentMut,
    key: &str,
    changes: &mut Vec<ConfigChange>,
) {
    if document.get(key).is_some() {
        changes.push(ConfigChange {
            path: key.to_string(),
            operation: ChangeOperation::Remove,
            before: Some(Value::String("<redacted>".to_string())),
            after: None,
            sensitive: true,
        });
        document.remove(key);
    }
}

fn replace_top_level(
    document: &mut DocumentMut,
    key: &str,
    next: &str,
    path: &str,
    changes: &mut Vec<ConfigChange>,
) {
    let previous = document.get(key).and_then(Item::as_str).map(str::to_string);
    if previous.as_deref() == Some(next) {
        return;
    }
    document[key] = value(next);
    changes.push(ConfigChange {
        path: path.to_string(),
        operation: if previous.is_some() {
            ChangeOperation::Update
        } else {
            ChangeOperation::Add
        },
        before: safe_value(previous.as_deref()),
        after: safe_value(Some(next)),
        sensitive: false,
    });
}

fn replace_table_string(
    table: &mut Table,
    key: &str,
    next: &str,
    path: String,
    changes: &mut Vec<ConfigChange>,
) {
    let previous = table.get(key).and_then(Item::as_str).map(str::to_string);
    if previous.as_deref() == Some(next) {
        return;
    }
    table[key] = value(next);
    changes.push(ConfigChange {
        path,
        operation: if previous.is_some() {
            ChangeOperation::Update
        } else {
            ChangeOperation::Add
        },
        before: safe_value(previous.as_deref()),
        after: safe_value(Some(next)),
        sensitive: false,
    });
}
