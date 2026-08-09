use serde_json::json;

use super::AdapterOutput;
use crate::atomic::{file_mode, read_optional};
use crate::error::{SidecarError, SidecarResult};
use crate::models::{
    ChangeOperation, ConfigChange, MutationPurpose, PlannedMutation, ProfileSummary,
};
use crate::paths::ResolvedPaths;

pub(crate) fn plan(
    paths: &ResolvedPaths,
    profile: &ProfileSummary,
) -> SidecarResult<AdapterOutput> {
    let path = paths.cursor_manifest.clone();
    let before_mode = file_mode(&path)?;
    let before = read_optional(&path)?;
    if let Some(bytes) = before.as_deref() {
        serde_json::from_slice::<serde_json::Value>(bytes).map_err(|_| {
            SidecarError::InvalidConfiguration(
                "Cursor One Status model manifest contains invalid JSON.".to_string(),
            )
        })?;
    }
    let manifest = json!({
        "schemaVersion": 1,
        "managedBy": "one-status-device-sidecar",
        "adapter": "cursor-extension",
        "requiredExtension": "top.furesta.one-status",
        "profile": profile,
    });
    let mut after = serde_json::to_vec_pretty(&manifest).map_err(SidecarError::serialize)?;
    after.push(b'\n');

    Ok(AdapterOutput {
        mutation: PlannedMutation {
            purpose: MutationPurpose::ToolConfiguration,
            path,
            before: before.clone(),
            after,
            before_mode,
            private: true,
        },
        changes: vec![ConfigChange {
            path: "profile".to_string(),
            operation: if before.is_some() {
                ChangeOperation::Update
            } else {
                ChangeOperation::Add
            },
            before: before.map(|_| serde_json::Value::String("<existing-profile>".to_string())),
            after: Some(serde_json::json!({
                "id": profile.id,
                "modelId": profile.model_id,
                "source": profile.source,
            })),
            sensitive: false,
        }],
        warnings: vec![
            "Cursor does not expose native model switching through its public settings file. The sidecar writes an isolated manifest for the One Status Cursor extension and leaves Cursor Rules, MCP, and user settings untouched."
                .to_string(),
        ],
    })
}
