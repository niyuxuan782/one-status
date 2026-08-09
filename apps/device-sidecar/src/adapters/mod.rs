mod claude;
mod codex;
mod cursor;

use serde_json::Value;
use url::Url;

use crate::error::{SidecarError, SidecarResult};
use crate::models::{
    ApiProtocol, ConfigChange, ModelProfile, PlannedMutation, ProfileSummary, SourceType, ToolId,
};
use crate::paths::ResolvedPaths;

pub(crate) struct AdapterOutput {
    pub mutation: PlannedMutation,
    pub changes: Vec<ConfigChange>,
    pub warnings: Vec<String>,
}

pub(crate) fn plan(
    paths: &ResolvedPaths,
    tool: ToolId,
    profile: &ModelProfile,
) -> SidecarResult<(ProfileSummary, AdapterOutput)> {
    let summary = validate_profile(tool, profile)?;
    let output = match tool {
        ToolId::Codex => codex::plan(paths, &summary),
        ToolId::ClaudeCode => claude::plan(paths, &summary),
        ToolId::Cursor => cursor::plan(paths, &summary),
    }?;
    Ok((summary, output))
}

fn validate_profile(tool: ToolId, profile: &ModelProfile) -> SidecarResult<ProfileSummary> {
    validate_identifier("profile.id", &profile.id, 64)?;
    validate_text("profile.displayName", &profile.display_name, 200)?;
    validate_text("profile.modelId", &profile.model_id, 500)?;
    if let Some(name) = profile.model_name.as_ref() {
        validate_text("profile.modelName", name, 500)?;
    }

    match (tool, profile.api_protocol) {
        (ToolId::Codex, ApiProtocol::OpenaiResponses | ApiProtocol::OpenaiChatCompletions)
        | (ToolId::ClaudeCode, ApiProtocol::Anthropic)
        | (ToolId::Cursor, _) => {}
        (ToolId::Codex, ApiProtocol::Anthropic) => {
            return Err(SidecarError::Unsupported(
                "Codex requires an OpenAI Responses or Chat Completions endpoint; protocol translation is outside this sidecar.".to_string(),
            ));
        }
        (ToolId::ClaudeCode, _) => {
            return Err(SidecarError::Unsupported(
                "Claude Code requires an Anthropic-compatible endpoint; protocol translation is outside this sidecar.".to_string(),
            ));
        }
    }

    if let Some(variable) = profile.credential_env_var.as_ref() {
        validate_environment_variable(variable)?;
        if tool == ToolId::ClaudeCode
            && variable != "ANTHROPIC_AUTH_TOKEN"
            && variable != "ANTHROPIC_API_KEY"
        {
            return Err(SidecarError::InvalidRequest(
                "Claude Code credentialEnvVar must be ANTHROPIC_AUTH_TOKEN or ANTHROPIC_API_KEY."
                    .to_string(),
            ));
        }
    }

    let default_endpoint = match (profile.source, profile.api_protocol) {
        (SourceType::OfficialApi, ApiProtocol::Anthropic) => Some("https://api.anthropic.com"),
        (SourceType::OfficialApi, _) => Some("https://api.openai.com/v1"),
        _ => None,
    };
    let endpoint = profile
        .endpoint
        .as_deref()
        .or(default_endpoint)
        .map(normalize_endpoint)
        .transpose()?;

    match profile.source {
        SourceType::OfficialAccount => {
            if profile.endpoint.is_some() || profile.credential_env_var.is_some() {
                return Err(SidecarError::InvalidRequest(
                    "Official-account profiles cannot include endpoint or credentialEnvVar."
                        .to_string(),
                ));
            }
        }
        SourceType::OfficialApi
        | SourceType::ThirdPartyCompatibleApi
        | SourceType::CustomEndpoint => {
            if endpoint.is_none() || profile.credential_env_var.is_none() {
                return Err(SidecarError::InvalidRequest(
                    "This source requires endpoint and credentialEnvVar (official endpoints may be omitted)."
                        .to_string(),
                ));
            }
        }
        SourceType::LocalModelService => {
            let endpoint_value = endpoint.as_ref().ok_or_else(|| {
                SidecarError::InvalidRequest(
                    "Local-model-service profiles require a loopback endpoint.".to_string(),
                )
            })?;
            let url = Url::parse(endpoint_value).map_err(|_| {
                SidecarError::InvalidRequest("endpoint must be a valid URL.".to_string())
            })?;
            if !is_loopback_host(url.host_str()) {
                return Err(SidecarError::InvalidRequest(
                    "Local-model-service endpoint must use localhost or a loopback IP address."
                        .to_string(),
                ));
            }
        }
    }

    if tool != ToolId::Cursor
        && profile.source != SourceType::OfficialAccount
        && profile.source != SourceType::LocalModelService
    {
        let variable = profile
            .credential_env_var
            .as_deref()
            .expect("validated above");
        credential_from_environment(variable)?;
    }

    let endpoint_domain = endpoint
        .as_ref()
        .and_then(|value| Url::parse(value).ok())
        .and_then(|url| url.host_str().map(str::to_string));

    Ok(ProfileSummary {
        id: profile.id.clone(),
        display_name: profile.display_name.clone(),
        model_id: profile.model_id.clone(),
        model_name: profile.model_name.clone(),
        source: profile.source,
        api_protocol: profile.api_protocol,
        endpoint,
        endpoint_domain,
        credential_env_var: profile.credential_env_var.clone(),
    })
}

pub(crate) fn credential_from_environment(variable: &str) -> SidecarResult<String> {
    let value = std::env::var(variable).map_err(|_| {
        SidecarError::InvalidRequest(
            "The Permission Vault credential environment variable is unavailable.".to_string(),
        )
    })?;
    if value.is_empty() || value.len() > 64 * 1024 {
        return Err(SidecarError::InvalidRequest(
            "The Permission Vault credential environment variable is unavailable.".to_string(),
        ));
    }
    Ok(value)
}

fn validate_identifier(field: &str, value: &str, max: usize) -> SidecarResult<()> {
    if value.is_empty()
        || value.len() > max
        || !value.chars().all(|character| {
            character.is_ascii_alphanumeric() || matches!(character, '-' | '_' | '.')
        })
    {
        return Err(SidecarError::InvalidRequest(format!(
            "{field} must contain 1-{max} ASCII letters, digits, dot, dash, or underscore characters."
        )));
    }
    Ok(())
}

fn validate_text(field: &str, value: &str, max: usize) -> SidecarResult<()> {
    if value.trim().is_empty() || value.len() > max || value.chars().any(char::is_control) {
        return Err(SidecarError::InvalidRequest(format!(
            "{field} must contain 1-{max} visible characters."
        )));
    }
    Ok(())
}

fn validate_environment_variable(value: &str) -> SidecarResult<()> {
    let mut characters = value.chars();
    let first = characters.next();
    if !matches!(first, Some('_'))
        && !first.is_some_and(|character| character.is_ascii_alphabetic())
        || !characters.all(|character| character == '_' || character.is_ascii_alphanumeric())
        || value.len() > 128
    {
        return Err(SidecarError::InvalidRequest(
            "credentialEnvVar must be a valid environment-variable name.".to_string(),
        ));
    }
    Ok(())
}

fn normalize_endpoint(value: &str) -> SidecarResult<String> {
    let mut url = Url::parse(value)
        .map_err(|_| SidecarError::InvalidRequest("endpoint must be a valid URL.".to_string()))?;
    if !matches!(url.scheme(), "http" | "https")
        || url.host_str().is_none()
        || !url.username().is_empty()
        || url.password().is_some()
        || url.query().is_some()
        || url.fragment().is_some()
    {
        return Err(SidecarError::InvalidRequest(
            "endpoint must be an HTTP(S) URL without user info, query, or fragment.".to_string(),
        ));
    }
    let trimmed_path = url.path().trim_end_matches('/').to_string();
    url.set_path(if trimmed_path.is_empty() {
        "/"
    } else {
        &trimmed_path
    });
    let normalized = url.to_string();
    Ok(normalized.trim_end_matches('/').to_string())
}

fn is_loopback_host(host: Option<&str>) -> bool {
    matches!(host, Some("localhost") | Some("127.0.0.1") | Some("::1"))
        || host.is_some_and(|host| host.starts_with("127."))
}

pub(crate) fn safe_value(value: Option<&str>) -> Option<Value> {
    value.map(|value| Value::String(value.to_string()))
}
