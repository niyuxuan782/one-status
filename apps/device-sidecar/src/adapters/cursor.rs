use serde_json::json;

use super::AdapterOutput;
use crate::atomic::{file_mode, read_optional};
use crate::error::{SidecarError, SidecarResult};
use crate::models::{
    ChangeOperation, ConfigChange, MutationPurpose, PlannedMutation, ProfileSummary,
};
use crate::paths::ResolvedPaths;

const CURSOR_EXTENSION_PREFIX: &str = "top.furesta.one-status-";

pub(crate) fn plan(
    paths: &ResolvedPaths,
    profile: &ProfileSummary,
) -> SidecarResult<AdapterOutput> {
    if !one_status_extension_installed(paths) {
        return Err(SidecarError::Unsupported(
            "Cursor model switching requires the One Status Cursor extension, which is not installed on this device."
                .to_string(),
        ));
    }
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

fn one_status_extension_installed(paths: &ResolvedPaths) -> bool {
    let extension_root = paths.home.join(".cursor").join("extensions");
    std::fs::read_dir(extension_root).is_ok_and(|entries| {
        entries.filter_map(Result::ok).any(|entry| {
            entry
                .file_name()
                .to_str()
                .is_some_and(|name| name.starts_with(CURSOR_EXTENSION_PREFIX))
                && entry.path().is_dir()
        })
    })
}
