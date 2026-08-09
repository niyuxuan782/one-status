//! Field-preserving Claude Code `settings.json` adapter.
//!
//! Config path selection and provider environment conventions are based on CC
//! Switch `config.rs` and `services/provider/live.rs` at commit
//! `413c09e0790c304506888ae24b9be72820aca126` (MIT, Jason Young, 2025).

use serde_json::{Map, Value};

use super::{credential_from_environment, safe_value, AdapterOutput};
use crate::atomic::{file_mode, read_optional};
use crate::error::{SidecarError, SidecarResult};
use crate::models::{
    ChangeOperation, ConfigChange, MutationPurpose, PlannedMutation, ProfileSummary, SourceType,
};
use crate::paths::ResolvedPaths;
use crate::security::redacted_presence;

pub(crate) fn plan(
    paths: &ResolvedPaths,
    profile: &ProfileSummary,
) -> SidecarResult<AdapterOutput> {
    let path = paths.claude_settings.clone();
    let before_mode = file_mode(&path)?;
    let before = read_optional(&path)?;
    let mut root = match before.as_deref() {
        Some(bytes) => serde_json::from_slice::<Value>(bytes).map_err(|_| {
            SidecarError::InvalidConfiguration(
                "Claude Code settings file contains invalid JSON.".to_string(),
            )
        })?,
        None => Value::Object(Map::new()),
    };
    let object = root.as_object_mut().ok_or_else(|| {
        SidecarError::InvalidConfiguration(
            "Claude Code settings root must be a JSON object.".to_string(),
        )
    })?;
    let mut changes = Vec::new();

    replace_string(object, "model", &profile.model_id, "model", &mut changes);

    let needs_env = profile.source != SourceType::OfficialAccount;
    if needs_env && !object.contains_key("env") {
        object.insert("env".to_string(), Value::Object(Map::new()));
    }
    let env = match object.get_mut("env") {
        Some(Value::Object(env)) => Some(env),
        Some(_) => {
            return Err(SidecarError::InvalidConfiguration(
                "Claude Code settings env field must be a JSON object.".to_string(),
            ));
        }
        None => None,
    };

    if let Some(env) = env {
        if matches!(
            profile.source,
            SourceType::ThirdPartyCompatibleApi
                | SourceType::LocalModelService
                | SourceType::CustomEndpoint
        ) {
            replace_string(
                env,
                "ANTHROPIC_MODEL",
                &profile.model_id,
                "env.ANTHROPIC_MODEL",
                &mut changes,
            );
            replace_string(
                env,
                "ANTHROPIC_BASE_URL",
                profile.endpoint.as_deref().expect("validated endpoint"),
                "env.ANTHROPIC_BASE_URL",
                &mut changes,
            );
        } else {
            remove_safe(env, "ANTHROPIC_MODEL", "env.ANTHROPIC_MODEL", &mut changes);
            remove_safe(
                env,
                "ANTHROPIC_BASE_URL",
                "env.ANTHROPIC_BASE_URL",
                &mut changes,
            );
        }

        if let Some(variable) = profile.credential_env_var.as_deref() {
            let credential = credential_from_environment(variable)?;
            let other = if variable == "ANTHROPIC_API_KEY" {
                "ANTHROPIC_AUTH_TOKEN"
            } else {
                "ANTHROPIC_API_KEY"
            };
            replace_sensitive(
                env,
                variable,
                &credential,
                &format!("env.{variable}"),
                &mut changes,
            );
            remove_sensitive(env, other, &format!("env.{other}"), &mut changes);
        } else {
            remove_sensitive(
                env,
                "ANTHROPIC_AUTH_TOKEN",
                "env.ANTHROPIC_AUTH_TOKEN",
                &mut changes,
            );
            remove_sensitive(
                env,
                "ANTHROPIC_API_KEY",
                "env.ANTHROPIC_API_KEY",
                &mut changes,
            );
        }
    }

    let mut after = serde_json::to_vec_pretty(&root).map_err(SidecarError::serialize)?;
    after.push(b'\n');
    Ok(AdapterOutput {
        mutation: PlannedMutation {
            purpose: MutationPurpose::ToolConfiguration,
            path,
            before,
            after,
            before_mode,
            private: profile.credential_env_var.is_some(),
        },
        changes,
        warnings: profile
            .credential_env_var
            .as_ref()
            .map(|variable| {
                vec![format!(
                    "One Status projected {variable} from Permission Vault into Claude Code's local native credential field; it is excluded from every sidecar response and synchronized state."
                )]
            })
            .unwrap_or_default(),
    })
}

fn replace_sensitive(
    object: &mut Map<String, Value>,
    key: &str,
    next: &str,
    path: &str,
    changes: &mut Vec<ConfigChange>,
) {
    let had_previous = object.contains_key(key);
    object.insert(key.to_string(), Value::String(next.to_string()));
    changes.push(ConfigChange {
        path: path.to_string(),
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

fn replace_string(
    object: &mut Map<String, Value>,
    key: &str,
    next: &str,
    path: &str,
    changes: &mut Vec<ConfigChange>,
) {
    let previous = object.get(key).and_then(Value::as_str).map(str::to_string);
    if previous.as_deref() == Some(next) {
        return;
    }
    object.insert(key.to_string(), Value::String(next.to_string()));
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

fn remove_safe(
    object: &mut Map<String, Value>,
    key: &str,
    path: &str,
    changes: &mut Vec<ConfigChange>,
) {
    let previous = object.get(key).and_then(Value::as_str).map(str::to_string);
    if object.remove(key).is_some() {
        changes.push(ConfigChange {
            path: path.to_string(),
            operation: ChangeOperation::Remove,
            before: safe_value(previous.as_deref()),
            after: None,
            sensitive: false,
        });
    }
}

fn remove_sensitive(
    object: &mut Map<String, Value>,
    key: &str,
    path: &str,
    changes: &mut Vec<ConfigChange>,
) {
    let previous = object.get(key);
    if previous.is_some() {
        changes.push(ConfigChange {
            path: path.to_string(),
            operation: ChangeOperation::Remove,
            before: redacted_presence(previous),
            after: None,
            sensitive: true,
        });
        object.remove(key);
    }
}
