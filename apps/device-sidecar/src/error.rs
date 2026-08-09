use std::path::Path;

use thiserror::Error;

pub type SidecarResult<T> = Result<T, SidecarError>;

#[derive(Debug, Error)]
pub enum SidecarError {
    #[error("invalid request: {0}")]
    InvalidRequest(String),
    #[error("plaintext credential rejected")]
    PlaintextCredential,
    #[error("unsupported configuration: {0}")]
    Unsupported(String),
    #[error("configuration is invalid: {0}")]
    InvalidConfiguration(String),
    #[error("configuration changed after preview")]
    PlanConflict,
    #[error("configuration apply failed and prior state was restored")]
    ApplyFailedRolledBack,
    #[error("transaction was not found")]
    TransactionNotFound,
    #[error("transaction state conflicts with the current configuration")]
    RollbackConflict,
    #[error("prepared transaction conflicts with the current configuration")]
    PreparedTransactionConflict,
    #[error("local I/O operation failed: {0}")]
    Io(String),
    #[error("response serialization failed")]
    Serialize,
}

impl SidecarError {
    pub fn code(&self) -> &'static str {
        match self {
            Self::InvalidRequest(_) => "invalid_request",
            Self::PlaintextCredential => "plaintext_credential_rejected",
            Self::Unsupported(_) => "unsupported_configuration",
            Self::InvalidConfiguration(_) => "invalid_local_configuration",
            Self::PlanConflict => "plan_conflict",
            Self::ApplyFailedRolledBack => "apply_failed_rolled_back",
            Self::TransactionNotFound => "transaction_not_found",
            Self::RollbackConflict => "rollback_conflict",
            Self::PreparedTransactionConflict => "prepared_transaction_conflict",
            Self::Io(_) => "io_error",
            Self::Serialize => "serialization_error",
        }
    }

    pub fn public_message(&self) -> String {
        match self {
            Self::InvalidRequest(message)
            | Self::Unsupported(message)
            | Self::InvalidConfiguration(message) => message.clone(),
            Self::PlaintextCredential => "Plaintext credentials are not accepted. Pass a Permission Vault environment-variable reference with credentialEnvVar.".to_string(),
            Self::PlanConflict => "The local configuration changed after preview. Generate a new preview before applying.".to_string(),
            Self::ApplyFailedRolledBack => "The configuration write failed and all changed files were restored.".to_string(),
            Self::TransactionNotFound => "The requested rollback transaction does not exist.".to_string(),
            Self::RollbackConflict => "The configured files changed after this transaction. Rollback was not applied.".to_string(),
            Self::PreparedTransactionConflict => "A prepared transaction conflicts with local files. Recovery stopped without changing those files.".to_string(),
            Self::Io(_) => "A local file operation failed. No credential or file content was included in this response.".to_string(),
            Self::Serialize => "The sidecar could not serialize its response.".to_string(),
        }
    }

    pub fn io(operation: &str, path: &Path, error: std::io::Error) -> Self {
        Self::Io(format!("{operation} {}: {error}", path.display()))
    }

    pub fn serialize(_: serde_json::Error) -> Self {
        Self::Serialize
    }

    pub fn rolled_back(&self) -> bool {
        matches!(self, Self::ApplyFailedRolledBack)
    }
}
