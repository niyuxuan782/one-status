use std::path::PathBuf;

use serde::{Deserialize, Serialize};
use serde_json::Value;

#[derive(Clone, Copy, Debug, Deserialize, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum CommandName {
    Scan,
    Usage,
    Preview,
    Apply,
    Rollback,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, Hash, Ord, PartialEq, PartialOrd, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum ToolId {
    Codex,
    ClaudeCode,
    Cursor,
}

impl ToolId {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Codex => "codex",
            Self::ClaudeCode => "claude-code",
            Self::Cursor => "cursor",
        }
    }

    pub fn display_name(self) -> &'static str {
        match self {
            Self::Codex => "Codex",
            Self::ClaudeCode => "Claude Code",
            Self::Cursor => "Cursor",
        }
    }
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum SourceType {
    OfficialAccount,
    OfficialApi,
    ThirdPartyCompatibleApi,
    LocalModelService,
    CustomEndpoint,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum ApiProtocol {
    OpenaiResponses,
    OpenaiChatCompletions,
    Anthropic,
}

impl ApiProtocol {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::OpenaiResponses => "openai-responses",
            Self::OpenaiChatCompletions => "openai-chat-completions",
            Self::Anthropic => "anthropic",
        }
    }
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ModelProfile {
    pub id: String,
    pub display_name: String,
    pub model_id: String,
    #[serde(default)]
    pub model_name: Option<String>,
    pub source: SourceType,
    pub api_protocol: ApiProtocol,
    #[serde(default)]
    pub endpoint: Option<String>,
    #[serde(default)]
    pub credential_env_var: Option<String>,
}

#[derive(Clone, Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PathOverrides {
    #[serde(default)]
    pub codex_config: Option<PathBuf>,
    #[serde(default)]
    pub codex_auth: Option<PathBuf>,
    #[serde(default)]
    pub claude_settings: Option<PathBuf>,
    #[serde(default)]
    pub cursor_manifest: Option<PathBuf>,
    #[serde(default)]
    pub state_root: Option<PathBuf>,
    #[serde(default)]
    pub codex_executable: Option<PathBuf>,
    #[serde(default)]
    pub claude_executable: Option<PathBuf>,
    #[serde(default)]
    pub cursor_executable: Option<PathBuf>,
}

#[derive(Clone, Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ScanRequest {
    #[serde(default)]
    pub home: Option<PathBuf>,
    #[serde(default)]
    pub path_overrides: PathOverrides,
    #[serde(default = "default_true")]
    pub include_models: bool,
}

#[derive(Clone, Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct UsageRequest {
    #[serde(default)]
    pub home: Option<PathBuf>,
    #[serde(default = "default_usage_file_limit")]
    pub max_files_per_tool: usize,
}

fn default_usage_file_limit() -> usize {
    100
}

fn default_true() -> bool {
    true
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PreviewRequest {
    #[serde(default)]
    pub home: Option<PathBuf>,
    #[serde(default)]
    pub path_overrides: PathOverrides,
    pub tool: ToolId,
    pub profile: ModelProfile,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ApplyRequest {
    #[serde(default)]
    pub home: Option<PathBuf>,
    #[serde(default)]
    pub path_overrides: PathOverrides,
    pub tool: ToolId,
    pub profile: ModelProfile,
    pub expected_plan_id: String,
}

impl From<&ApplyRequest> for PreviewRequest {
    fn from(value: &ApplyRequest) -> Self {
        Self {
            home: value.home.clone(),
            path_overrides: value.path_overrides.clone(),
            tool: value.tool,
            profile: value.profile.clone(),
        }
    }
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RollbackRequest {
    #[serde(default)]
    pub home: Option<PathBuf>,
    #[serde(default)]
    pub path_overrides: PathOverrides,
    pub transaction_id: String,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DeviceScan {
    pub os: String,
    pub architecture: String,
    pub sidecar_version: String,
    pub tools: Vec<ToolInventory>,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub warnings: Vec<String>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UsageScan {
    pub scanned_at: String,
    pub scope: String,
    pub files_scanned: usize,
    pub truncated: bool,
    pub entries: Vec<ModelUsage>,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub warnings: Vec<String>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ModelUsage {
    pub tool: ToolId,
    pub model_id: String,
    pub data_source: String,
    pub input_tokens: u64,
    pub cached_input_tokens: u64,
    pub cache_creation_input_tokens: u64,
    pub output_tokens: u64,
    pub requests: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub latest_at: Option<String>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ToolInventory {
    pub id: ToolId,
    pub name: String,
    pub installed: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub executable_path: Option<PathBuf>,
    pub config_path: PathBuf,
    pub configuration_mode: ConfigurationMode,
    pub config_health: ConfigHealth,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub current_model: Option<ModelStatus>,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub discovered_models: Vec<DiscoveredModel>,
}

#[derive(Clone, Copy, Debug, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum ConfigurationMode {
    NativeFile,
    ExtensionManifest,
}

#[derive(Clone, Copy, Debug, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum ConfigHealth {
    Healthy,
    Missing,
    Invalid,
    Unconfigured,
    NeedsCredential,
    PendingExtension,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ModelStatus {
    pub model_id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub model_name: Option<String>,
    pub source: SourceType,
    pub source_detection: SourceDetection,
    pub api_protocol: ApiProtocol,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub endpoint_domain: Option<String>,
    pub credential_available: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub credential_env_var: Option<String>,
}

#[derive(Clone, Copy, Debug, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum SourceDetection {
    Managed,
    Inferred,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DiscoveredModel {
    pub id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
    pub source: String,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PreviewResult {
    pub plan_id: String,
    pub tool: ToolId,
    pub profile: ProfileSummary,
    pub targets: Vec<PlanTarget>,
    pub changes: Vec<ConfigChange>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub requires_credential_env: Option<String>,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub warnings: Vec<String>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProfileSummary {
    pub id: String,
    pub display_name: String,
    pub model_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub model_name: Option<String>,
    pub source: SourceType,
    pub api_protocol: ApiProtocol,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub endpoint: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub endpoint_domain: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub credential_env_var: Option<String>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PlanTarget {
    pub purpose: MutationPurpose,
    pub path: PathBuf,
    pub existed: bool,
    pub before_sha256: String,
    pub after_sha256: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub before_mode: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub after_mode: Option<u32>,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum MutationPurpose {
    ToolConfiguration,
    ActiveProfileState,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ConfigChange {
    pub path: String,
    pub operation: ChangeOperation,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub before: Option<Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub after: Option<Value>,
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub sensitive: bool,
}

#[derive(Clone, Copy, Debug, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum ChangeOperation {
    Add,
    Update,
    Remove,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ApplyResult {
    pub transaction_id: String,
    pub plan_id: String,
    pub tool: ToolId,
    pub state: ApplyState,
    pub targets: Vec<PlanTarget>,
}

#[derive(Clone, Copy, Debug, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum ApplyState {
    Applied,
    Rollback,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RollbackResult {
    pub transaction_id: String,
    pub tool: ToolId,
    pub state: ApplyState,
    pub restored_targets: Vec<PathBuf>,
}

#[derive(Clone, Debug)]
pub(crate) struct PlannedMutation {
    pub purpose: MutationPurpose,
    pub path: PathBuf,
    pub before: Option<Vec<u8>>,
    pub after: Vec<u8>,
    pub before_mode: Option<u32>,
    pub private: bool,
}

#[derive(Clone, Debug)]
pub(crate) struct InternalPlan {
    pub preview: PreviewResult,
    pub mutations: Vec<PlannedMutation>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct TransactionManifest {
    pub schema_version: u32,
    pub transaction_id: String,
    pub plan_id: String,
    pub tool: ToolId,
    pub created_at_unix_ms: u128,
    pub state: TransactionState,
    pub mutations: Vec<TransactionMutation>,
}

#[derive(Clone, Copy, Debug, Deserialize, Serialize)]
#[serde(rename_all = "lowercase")]
pub(crate) enum TransactionState {
    Prepared,
    Applied,
    Failed,
    RolledBack,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct TransactionMutation {
    pub purpose: MutationPurpose,
    pub path: PathBuf,
    pub existed: bool,
    pub before_sha256: String,
    pub after_sha256: String,
    pub backup_file: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub before_mode: Option<u32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub after_mode: Option<u32>,
}
