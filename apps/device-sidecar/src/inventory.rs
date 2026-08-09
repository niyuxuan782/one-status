use std::collections::BTreeMap;
use std::env;
use std::path::{Path, PathBuf};
use std::str::FromStr;

use serde::Deserialize;
use serde_json::Value;
use toml_edit::{DocumentMut, Item};
use url::Url;

use crate::atomic::read_optional;
use crate::error::SidecarResult;
use crate::models::{
    ApiProtocol, ConfigHealth, ConfigurationMode, DeviceScan, DiscoveredModel, ModelStatus,
    ProfileSummary, ScanRequest, SourceDetection, SourceType, ToolId, ToolInventory,
};
use crate::paths::ResolvedPaths;

pub(crate) fn scan(request: ScanRequest) -> SidecarResult<DeviceScan> {
    let paths = ResolvedPaths::resolve(request.home, &request.path_overrides)?;
    let mut warnings = Vec::new();
    let tools = vec![
        scan_codex(&paths, request.include_models, &mut warnings),
        scan_claude(&paths, request.include_models),
        scan_cursor(&paths, request.include_models),
    ];
    Ok(DeviceScan {
        os: std::env::consts::OS.to_string(),
        architecture: std::env::consts::ARCH.to_string(),
        sidecar_version: env!("CARGO_PKG_VERSION").to_string(),
        tools,
        warnings,
    })
}

fn scan_codex(
    paths: &ResolvedPaths,
    include_models: bool,
    warnings: &mut Vec<String>,
) -> ToolInventory {
    let installed = paths.executable(ToolId::Codex).is_some() || paths.codex_config.exists();
    let managed = read_active_profile(paths, ToolId::Codex);
    let bytes = match read_optional(&paths.codex_config) {
        Ok(bytes) => bytes,
        Err(_) => {
            return tool_inventory(
                paths,
                ToolId::Codex,
                installed,
                ConfigHealth::Invalid,
                None,
                Vec::new(),
            );
        }
    };
    let Some(bytes) = bytes else {
        return tool_inventory(
            paths,
            ToolId::Codex,
            installed,
            ConfigHealth::Missing,
            None,
            Vec::new(),
        );
    };
    let Ok(text) = std::str::from_utf8(&bytes) else {
        return tool_inventory(
            paths,
            ToolId::Codex,
            installed,
            ConfigHealth::Invalid,
            None,
            Vec::new(),
        );
    };
    let Ok(document) = DocumentMut::from_str(text) else {
        return tool_inventory(
            paths,
            ToolId::Codex,
            installed,
            ConfigHealth::Invalid,
            None,
            Vec::new(),
        );
    };
    let model_id = document
        .get("model")
        .and_then(Item::as_str)
        .filter(|value| !value.trim().is_empty())
        .map(str::to_string);
    let provider_id = document
        .get("model_provider")
        .and_then(Item::as_str)
        .filter(|value| !value.trim().is_empty());
    let provider = provider_id.and_then(|provider_id| {
        document
            .get("model_providers")
            .and_then(Item::as_table_like)
            .and_then(|providers| providers.get(provider_id))
            .and_then(Item::as_table_like)
    });
    let endpoint = provider
        .and_then(|provider| provider.get("base_url"))
        .and_then(Item::as_str);
    let env_var = provider
        .and_then(|provider| provider.get("env_key"))
        .and_then(Item::as_str);
    let embedded_bearer = provider
        .and_then(|provider| provider.get("experimental_bearer_token"))
        .is_some();
    let protocol = match provider
        .and_then(|provider| provider.get("wire_api"))
        .and_then(Item::as_str)
    {
        Some("chat") => ApiProtocol::OpenaiChatCompletions,
        _ => ApiProtocol::OpenaiResponses,
    };
    let credential_available = if provider_id.is_some() {
        env_var.is_some_and(environment_has_value) || embedded_bearer
    } else {
        codex_auth_has_material(&paths.codex_auth)
    };
    let current_model = model_id.as_ref().map(|model_id| {
        model_status(
            model_id,
            managed.as_ref(),
            endpoint,
            protocol,
            env_var,
            credential_available,
            ToolId::Codex,
        )
    });
    let health = health_for(current_model.as_ref());
    let mut models = BTreeMap::new();
    if let Some(model_id) = model_id {
        add_model(&mut models, model_id, None, "current-config");
    }
    if include_models {
        discover_codex_catalogs(paths, &document, &mut models, warnings);
    }
    tool_inventory(
        paths,
        ToolId::Codex,
        installed,
        health,
        current_model,
        models.into_values().collect(),
    )
}

fn scan_claude(paths: &ResolvedPaths, include_models: bool) -> ToolInventory {
    let installed =
        paths.executable(ToolId::ClaudeCode).is_some() || paths.claude_settings.exists();
    let managed = read_active_profile(paths, ToolId::ClaudeCode);
    let bytes = match read_optional(&paths.claude_settings) {
        Ok(bytes) => bytes,
        Err(_) => {
            return tool_inventory(
                paths,
                ToolId::ClaudeCode,
                installed,
                ConfigHealth::Invalid,
                None,
                Vec::new(),
            );
        }
    };
    let Some(bytes) = bytes else {
        return tool_inventory(
            paths,
            ToolId::ClaudeCode,
            installed,
            ConfigHealth::Missing,
            None,
            Vec::new(),
        );
    };
    let Ok(root) = serde_json::from_slice::<Value>(&bytes) else {
        return tool_inventory(
            paths,
            ToolId::ClaudeCode,
            installed,
            ConfigHealth::Invalid,
            None,
            Vec::new(),
        );
    };
    let Some(object) = root.as_object() else {
        return tool_inventory(
            paths,
            ToolId::ClaudeCode,
            installed,
            ConfigHealth::Invalid,
            None,
            Vec::new(),
        );
    };
    let env_object = object.get("env").and_then(Value::as_object);
    let model_id = object
        .get("model")
        .and_then(Value::as_str)
        .or_else(|| {
            env_object
                .and_then(|env| env.get("ANTHROPIC_MODEL"))
                .and_then(Value::as_str)
        })
        .filter(|value| !value.trim().is_empty())
        .map(str::to_string);
    let endpoint = env_object
        .and_then(|env| env.get("ANTHROPIC_BASE_URL"))
        .and_then(Value::as_str);
    let embedded_credential = env_object.is_some_and(|env| {
        ["ANTHROPIC_AUTH_TOKEN", "ANTHROPIC_API_KEY"]
            .iter()
            .any(|key| {
                env.get(*key)
                    .and_then(Value::as_str)
                    .is_some_and(|value| !value.is_empty())
            })
    });
    let managed_env = managed
        .as_ref()
        .and_then(|profile| profile.credential_env_var.as_deref());
    let credential_available = embedded_credential
        || managed_env.is_some_and(environment_has_value)
        || (endpoint.is_none()
            && paths
                .home
                .join(".claude")
                .join(".credentials.json")
                .exists());
    let current_model = model_id.as_ref().map(|model_id| {
        model_status(
            model_id,
            managed.as_ref(),
            endpoint,
            ApiProtocol::Anthropic,
            managed_env,
            credential_available,
            ToolId::ClaudeCode,
        )
    });
    let health = health_for(current_model.as_ref());
    let mut models = BTreeMap::new();
    if let Some(model_id) = model_id {
        add_model(&mut models, model_id, None, "current-config");
    }
    if include_models {
        if let Some(env) = env_object {
            for key in [
                "ANTHROPIC_DEFAULT_HAIKU_MODEL",
                "ANTHROPIC_DEFAULT_OPUS_MODEL",
                "ANTHROPIC_DEFAULT_SONNET_MODEL",
                "ANTHROPIC_MODEL",
            ] {
                if let Some(id) = env
                    .get(key)
                    .and_then(Value::as_str)
                    .filter(|id| !id.is_empty())
                {
                    add_model(&mut models, id.to_string(), None, "configured-default");
                }
            }
        }
    }
    tool_inventory(
        paths,
        ToolId::ClaudeCode,
        installed,
        health,
        current_model,
        models.into_values().collect(),
    )
}

fn scan_cursor(paths: &ResolvedPaths, include_models: bool) -> ToolInventory {
    let installed = paths.executable(ToolId::Cursor).is_some() || paths.cursor_manifest.exists();
    let managed = read_active_profile(paths, ToolId::Cursor);
    let manifest_bytes = match read_optional(&paths.cursor_manifest) {
        Ok(bytes) => bytes,
        Err(_) => {
            return tool_inventory(
                paths,
                ToolId::Cursor,
                installed,
                ConfigHealth::Invalid,
                None,
                Vec::new(),
            );
        }
    };
    let manifest_valid = manifest_bytes
        .as_deref()
        .map(serde_json::from_slice::<Value>)
        .transpose()
        .is_ok();
    if !manifest_valid {
        return tool_inventory(
            paths,
            ToolId::Cursor,
            installed,
            ConfigHealth::Invalid,
            None,
            Vec::new(),
        );
    }
    let current_model = managed.as_ref().map(|profile| ModelStatus {
        model_id: profile.model_id.clone(),
        model_name: profile.model_name.clone(),
        source: profile.source,
        source_detection: SourceDetection::Managed,
        api_protocol: profile.api_protocol,
        endpoint_domain: profile.endpoint_domain.clone(),
        credential_available: profile
            .credential_env_var
            .as_deref()
            .map(environment_has_value)
            .unwrap_or(profile.source == SourceType::OfficialAccount),
        credential_env_var: profile.credential_env_var.clone(),
    });
    let mut discovered_models = Vec::new();
    if include_models {
        if let Some(profile) = managed.as_ref() {
            discovered_models.push(DiscoveredModel {
                id: profile.model_id.clone(),
                name: profile.model_name.clone(),
                source: "one-status-manifest".to_string(),
            });
        }
    }
    let health = if manifest_bytes.is_none() {
        ConfigHealth::Missing
    } else {
        ConfigHealth::PendingExtension
    };
    tool_inventory(
        paths,
        ToolId::Cursor,
        installed,
        health,
        current_model,
        discovered_models,
    )
}

fn tool_inventory(
    paths: &ResolvedPaths,
    tool: ToolId,
    installed: bool,
    config_health: ConfigHealth,
    current_model: Option<ModelStatus>,
    discovered_models: Vec<DiscoveredModel>,
) -> ToolInventory {
    ToolInventory {
        id: tool,
        name: tool.display_name().to_string(),
        installed,
        executable_path: paths.executable(tool).cloned(),
        config_path: paths.config_path(tool).to_path_buf(),
        configuration_mode: if tool == ToolId::Cursor {
            ConfigurationMode::ExtensionManifest
        } else {
            ConfigurationMode::NativeFile
        },
        config_health,
        current_model,
        discovered_models,
    }
}

fn model_status(
    model_id: &str,
    managed: Option<&ProfileSummary>,
    endpoint: Option<&str>,
    protocol: ApiProtocol,
    credential_env_var: Option<&str>,
    credential_available: bool,
    tool: ToolId,
) -> ModelStatus {
    let matching_managed = managed.filter(|profile| profile.model_id == model_id);
    let source = matching_managed
        .map(|profile| profile.source)
        .unwrap_or_else(|| infer_source(endpoint, tool));
    ModelStatus {
        model_id: model_id.to_string(),
        model_name: matching_managed.and_then(|profile| profile.model_name.clone()),
        source,
        source_detection: if matching_managed.is_some() {
            SourceDetection::Managed
        } else {
            SourceDetection::Inferred
        },
        api_protocol: matching_managed
            .map(|profile| profile.api_protocol)
            .unwrap_or(protocol),
        endpoint_domain: matching_managed
            .and_then(|profile| profile.endpoint_domain.clone())
            .or_else(|| endpoint.and_then(endpoint_domain)),
        credential_available,
        credential_env_var: matching_managed
            .and_then(|profile| profile.credential_env_var.clone())
            .or_else(|| credential_env_var.map(str::to_string)),
    }
}

fn health_for(model: Option<&ModelStatus>) -> ConfigHealth {
    match model {
        None => ConfigHealth::Unconfigured,
        Some(model)
            if model.source != SourceType::OfficialAccount
                && model.source != SourceType::LocalModelService
                && !model.credential_available =>
        {
            ConfigHealth::NeedsCredential
        }
        Some(_) => ConfigHealth::Healthy,
    }
}

fn infer_source(endpoint: Option<&str>, tool: ToolId) -> SourceType {
    let Some(endpoint) = endpoint else {
        return SourceType::OfficialAccount;
    };
    let host = endpoint_domain(endpoint).unwrap_or_default();
    if host == "localhost" || host == "::1" || host.starts_with("127.") {
        return SourceType::LocalModelService;
    }
    let official = match tool {
        ToolId::Codex => host == "api.openai.com",
        ToolId::ClaudeCode => host == "api.anthropic.com",
        ToolId::Cursor => false,
    };
    if official {
        SourceType::OfficialApi
    } else {
        SourceType::ThirdPartyCompatibleApi
    }
}

fn endpoint_domain(endpoint: &str) -> Option<String> {
    Url::parse(endpoint)
        .ok()
        .and_then(|url| url.host_str().map(str::to_string))
}

fn environment_has_value(variable: &str) -> bool {
    env::var_os(variable).is_some_and(|value| !value.is_empty())
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ActiveProfileState {
    schema_version: u32,
    tool: ToolId,
    profile: ProfileSummary,
}

fn read_active_profile(paths: &ResolvedPaths, tool: ToolId) -> Option<ProfileSummary> {
    let bytes = read_optional(&paths.active_profile_path(tool)).ok()??;
    let state: ActiveProfileState = serde_json::from_slice(&bytes).ok()?;
    (state.schema_version == 1 && state.tool == tool).then_some(state.profile)
}

fn codex_auth_has_material(path: &Path) -> bool {
    let Ok(Some(bytes)) = read_optional(path) else {
        return false;
    };
    let Ok(value) = serde_json::from_slice::<Value>(&bytes) else {
        return false;
    };
    value.as_object().is_some_and(|object| {
        ["OPENAI_API_KEY", "tokens", "access_token", "refresh_token"]
            .iter()
            .any(|key| object.get(*key).is_some_and(nonempty_json_value))
    })
}

fn nonempty_json_value(value: &Value) -> bool {
    match value {
        Value::Null => false,
        Value::Bool(value) => *value,
        Value::Number(_) => true,
        Value::String(value) => !value.is_empty(),
        Value::Array(value) => !value.is_empty(),
        Value::Object(value) => !value.is_empty(),
    }
}

fn discover_codex_catalogs(
    paths: &ResolvedPaths,
    document: &DocumentMut,
    models: &mut BTreeMap<String, DiscoveredModel>,
    warnings: &mut Vec<String>,
) {
    let mut candidates = vec![paths.codex_config.with_file_name("models_cache.json")];
    if let Some(configured) = document.get("model_catalog_json").and_then(Item::as_str) {
        if let Some(path) = safe_catalog_path(&paths.codex_config, configured) {
            candidates.push(path);
        } else {
            warnings.push(
                "Codex model_catalog_json outside the Codex config directory was ignored."
                    .to_string(),
            );
        }
    }
    candidates.sort();
    candidates.dedup();
    for path in candidates {
        let Ok(Some(bytes)) = read_optional(&path) else {
            continue;
        };
        let Ok(value) = serde_json::from_slice::<Value>(&bytes) else {
            warnings
                .push("A Codex model catalog contains invalid JSON and was ignored.".to_string());
            continue;
        };
        extract_catalog_models(&value, models);
    }
}

fn safe_catalog_path(config_path: &Path, configured: &str) -> Option<PathBuf> {
    let base = config_path.parent()?;
    let candidate = PathBuf::from(configured);
    let candidate = if candidate.is_absolute() {
        candidate
    } else {
        base.join(candidate)
    };
    let base = base.canonicalize().ok()?;
    let candidate = candidate.canonicalize().ok()?;
    candidate.starts_with(base).then_some(candidate)
}

fn extract_catalog_models(value: &Value, models: &mut BTreeMap<String, DiscoveredModel>) {
    let arrays = match value {
        Value::Array(array) => vec![array],
        Value::Object(object) => ["models", "data"]
            .iter()
            .filter_map(|key| object.get(*key).and_then(Value::as_array))
            .collect(),
        _ => Vec::new(),
    };
    for array in arrays {
        for entry in array.iter().take(500) {
            let Some(object) = entry.as_object() else {
                continue;
            };
            let id = ["id", "slug", "model"]
                .iter()
                .find_map(|key| object.get(*key).and_then(Value::as_str))
                .filter(|id| !id.is_empty() && id.len() <= 500);
            let Some(id) = id else {
                continue;
            };
            let name = ["display_name", "displayName", "name"]
                .iter()
                .find_map(|key| object.get(*key).and_then(Value::as_str))
                .filter(|name| name.len() <= 500)
                .map(str::to_string);
            add_model(models, id.to_string(), name, "codex-catalog");
            if models.len() >= 500 {
                return;
            }
        }
    }
}

fn add_model(
    models: &mut BTreeMap<String, DiscoveredModel>,
    id: String,
    name: Option<String>,
    source: &str,
) {
    models.entry(id.clone()).or_insert(DiscoveredModel {
        id,
        name,
        source: source.to_string(),
    });
}
