use std::fs;
use std::path::Path;
use std::time::{SystemTime, UNIX_EPOCH};

use sha2::{Digest, Sha256};

use crate::adapters;
use crate::atomic::{
    atomic_write, atomic_write_private, atomic_write_with_mode, file_mode, read_optional,
    remove_file, write_secure_json, OperationLock,
};
use crate::error::{SidecarError, SidecarResult};
use crate::models::{
    ApplyRequest, ApplyResult, ApplyState, InternalPlan, MutationPurpose, PlanTarget,
    PlannedMutation, PreviewRequest, PreviewResult, RollbackRequest, RollbackResult,
    TransactionManifest, TransactionMutation, TransactionState,
};
use crate::paths::ResolvedPaths;

const MAX_PREPARED_RECOVERIES: usize = 16;

pub(crate) fn preview(request: PreviewRequest) -> SidecarResult<PreviewResult> {
    let paths = ResolvedPaths::resolve(request.home.clone(), &request.path_overrides)?;
    Ok(build_plan(&paths, &request)?.preview)
}

pub(crate) fn apply(request: ApplyRequest) -> SidecarResult<ApplyResult> {
    let paths = ResolvedPaths::resolve(request.home.clone(), &request.path_overrides)?;
    let _lock = OperationLock::acquire(&paths.lock_path())?;
    recover_prepared_transactions(&paths)?;
    let preview_request = PreviewRequest::from(&request);
    let plan = build_plan(&paths, &preview_request)?;
    if plan.preview.plan_id != request.expected_plan_id {
        return Err(SidecarError::PlanConflict);
    }

    let (transaction_id, transaction_dir) = create_transaction_dir(&paths, &plan.preview.plan_id)?;

    let mut manifest = TransactionManifest {
        schema_version: 2,
        transaction_id: transaction_id.clone(),
        plan_id: plan.preview.plan_id.clone(),
        tool: plan.preview.tool,
        created_at_unix_ms: now_unix_ms(),
        state: TransactionState::Prepared,
        mutations: Vec::new(),
    };

    for (index, mutation) in plan.mutations.iter().enumerate() {
        let backup_file = format!("backup-{index}.bin");
        let backup_path = transaction_dir.join(&backup_file);
        atomic_write_private(&backup_path, mutation.before.as_deref().unwrap_or_default())?;
        manifest.mutations.push(TransactionMutation {
            purpose: mutation.purpose,
            path: mutation.path.clone(),
            existed: mutation.before.is_some(),
            before_sha256: sha256(mutation.before.as_deref().unwrap_or_default()),
            after_sha256: sha256(&mutation.after),
            backup_file,
            before_mode: mutation.before_mode,
            after_mode: after_mode(mutation),
        });
    }
    let manifest_path = transaction_dir.join("manifest.json");
    write_secure_json(&manifest_path, &manifest)?;

    for (applied_count, mutation) in plan.mutations.iter().enumerate() {
        let current = match read_optional(&mutation.path) {
            Ok(current) => current,
            Err(error) => {
                let restored = restore_mutations(&plan.mutations[..applied_count]);
                manifest.state = TransactionState::Failed;
                let _ = write_secure_json(&manifest_path, &manifest);
                restored?;
                return if applied_count > 0 {
                    Err(SidecarError::ApplyFailedRolledBack)
                } else {
                    Err(error)
                };
            }
        };
        let current_mode = match file_mode(&mutation.path) {
            Ok(mode) => mode,
            Err(error) => {
                let restored = restore_mutations(&plan.mutations[..applied_count]);
                manifest.state = TransactionState::Failed;
                let _ = write_secure_json(&manifest_path, &manifest);
                restored?;
                return if applied_count > 0 {
                    Err(SidecarError::ApplyFailedRolledBack)
                } else {
                    Err(error)
                };
            }
        };
        if sha256(current.as_deref().unwrap_or_default())
            != sha256(mutation.before.as_deref().unwrap_or_default())
            || current.is_some() != mutation.before.is_some()
            || current_mode != mutation.before_mode
        {
            let restored = restore_mutations(&plan.mutations[..applied_count]);
            manifest.state = TransactionState::Failed;
            let _ = write_secure_json(&manifest_path, &manifest);
            restored?;
            if applied_count > 0 {
                return Err(SidecarError::ApplyFailedRolledBack);
            }
            return Err(SidecarError::PlanConflict);
        }
        if let Err(error) = apply_mutation(mutation) {
            let restored = restore_mutations(&plan.mutations[..=applied_count]);
            manifest.state = TransactionState::Failed;
            let _ = write_secure_json(&manifest_path, &manifest);
            restored?;
            let _ = error;
            return Err(SidecarError::ApplyFailedRolledBack);
        }
    }

    manifest.state = TransactionState::Applied;
    if let Err(error) = write_secure_json(&manifest_path, &manifest) {
        restore_mutations(&plan.mutations)?;
        let _ = error;
        return Err(SidecarError::ApplyFailedRolledBack);
    }

    Ok(ApplyResult {
        transaction_id,
        plan_id: plan.preview.plan_id,
        tool: plan.preview.tool,
        state: ApplyState::Applied,
        targets: plan.preview.targets,
    })
}

pub(crate) fn rollback(request: RollbackRequest) -> SidecarResult<RollbackResult> {
    validate_transaction_id(&request.transaction_id)?;
    let paths = ResolvedPaths::resolve(request.home.clone(), &request.path_overrides)?;
    let _lock = OperationLock::acquire(&paths.lock_path())?;
    let transaction_dir = paths.transaction_dir(&request.transaction_id);
    let manifest_path = transaction_dir.join("manifest.json");
    let manifest_bytes = read_optional(&manifest_path)?.ok_or(SidecarError::TransactionNotFound)?;
    let mut manifest: TransactionManifest =
        serde_json::from_slice(&manifest_bytes).map_err(|_| {
            SidecarError::InvalidConfiguration(
                "Rollback manifest contains invalid JSON.".to_string(),
            )
        })?;
    validate_manifest(&paths, &request.transaction_id, &manifest)?;
    if !matches!(manifest.state, TransactionState::Applied) {
        return Err(SidecarError::RollbackConflict);
    }

    let mut current_snapshots: Vec<(Vec<u8>, Option<u32>)> = Vec::new();
    for mutation in &manifest.mutations {
        let current = read_optional(&mutation.path)?;
        if current.is_none()
            || sha256(current.as_deref().unwrap_or_default()) != mutation.after_sha256
            || file_mode(&mutation.path)? != mutation.after_mode
        {
            return Err(SidecarError::RollbackConflict);
        }
        current_snapshots.push((current.expect("checked above"), mutation.after_mode));
    }

    let mut backups = Vec::new();
    for mutation in &manifest.mutations {
        let backup_path = transaction_dir.join(&mutation.backup_file);
        let backup = read_optional(&backup_path)?.ok_or_else(|| {
            SidecarError::InvalidConfiguration("Rollback backup is missing.".to_string())
        })?;
        if sha256(&backup) != mutation.before_sha256 {
            return Err(SidecarError::InvalidConfiguration(
                "Rollback backup hash does not match its manifest.".to_string(),
            ));
        }
        backups.push(backup);
    }

    let mut restored_indices: Vec<usize> = Vec::new();
    for index in (0..manifest.mutations.len()).rev() {
        let mutation = &manifest.mutations[index];
        let result = restore_path(
            &mutation.path,
            mutation.existed.then_some(backups[index].as_slice()),
            mutation.before_mode,
        );
        if let Err(error) = result {
            for restored_index in restored_indices.iter().rev().copied() {
                let restored = &manifest.mutations[restored_index];
                let (bytes, mode) = &current_snapshots[restored_index];
                let _ = restore_path(&restored.path, Some(bytes.as_slice()), *mode);
            }
            return Err(error);
        }
        restored_indices.push(index);
    }

    manifest.state = TransactionState::RolledBack;
    write_secure_json(&manifest_path, &manifest)?;
    Ok(RollbackResult {
        transaction_id: request.transaction_id,
        tool: manifest.tool,
        state: ApplyState::Rollback,
        restored_targets: manifest
            .mutations
            .iter()
            .map(|mutation| mutation.path.clone())
            .collect(),
    })
}

fn recover_prepared_transactions(paths: &ResolvedPaths) -> SidecarResult<usize> {
    let transaction_root = paths.state_root.join("transactions");
    if !transaction_root.exists() {
        return Ok(0);
    }
    let mut directories = Vec::new();
    for entry in fs::read_dir(&transaction_root)
        .map_err(|error| SidecarError::io("read transaction root", &transaction_root, error))?
    {
        let entry = entry.map_err(|error| {
            SidecarError::io("read transaction entry", &transaction_root, error)
        })?;
        let file_type = entry
            .file_type()
            .map_err(|error| SidecarError::io("inspect transaction entry", &entry.path(), error))?;
        if !file_type.is_dir() {
            continue;
        }
        let Ok(name) = entry.file_name().into_string() else {
            continue;
        };
        directories.push((name, entry.path()));
    }
    directories.sort_by(|left, right| left.0.cmp(&right.0));

    let mut recovered = 0;
    for (transaction_id, transaction_dir) in directories {
        if recovered >= MAX_PREPARED_RECOVERIES {
            break;
        }
        if validate_transaction_id(&transaction_id).is_err() {
            continue;
        }
        let manifest_path = transaction_dir.join("manifest.json");
        if manifest_path
            .symlink_metadata()
            .is_ok_and(|metadata| metadata.file_type().is_symlink())
        {
            return Err(SidecarError::InvalidConfiguration(
                "Prepared transaction manifest cannot be a symbolic link.".to_string(),
            ));
        }
        let Some(manifest_bytes) = read_optional(&manifest_path)? else {
            // The manifest is persisted before any target mutation. A directory
            // without one can be ignored after a crash during transaction setup.
            continue;
        };
        let raw: serde_json::Value = serde_json::from_slice(&manifest_bytes).map_err(|_| {
            SidecarError::InvalidConfiguration(
                "Transaction manifest contains invalid JSON.".to_string(),
            )
        })?;
        let state = raw
            .get("state")
            .and_then(serde_json::Value::as_str)
            .ok_or_else(|| {
                SidecarError::InvalidConfiguration(
                    "Transaction manifest is missing its state.".to_string(),
                )
            })?;
        if state != "prepared" {
            continue;
        }
        #[cfg(unix)]
        {
            if file_mode(&transaction_dir)? != Some(0o700) {
                return Err(SidecarError::InvalidConfiguration(
                    "Prepared transaction directory permissions are not private.".to_string(),
                ));
            }
            if file_mode(&manifest_path)? != Some(0o600) {
                return Err(SidecarError::InvalidConfiguration(
                    "Prepared transaction manifest permissions are not private.".to_string(),
                ));
            }
        }
        let mut manifest: TransactionManifest = serde_json::from_value(raw).map_err(|_| {
            SidecarError::InvalidConfiguration(
                "Prepared transaction manifest has an unsupported structure.".to_string(),
            )
        })?;
        validate_manifest(paths, &transaction_id, &manifest)?;
        recover_prepared_transaction(&transaction_dir, &manifest)?;
        manifest.state = TransactionState::RolledBack;
        write_secure_json(&manifest_path, &manifest)?;
        recovered += 1;
    }
    Ok(recovered)
}

fn recover_prepared_transaction(
    transaction_dir: &Path,
    manifest: &TransactionManifest,
) -> SidecarResult<()> {
    let mut backups = Vec::with_capacity(manifest.mutations.len());
    let mut current_snapshots = Vec::with_capacity(manifest.mutations.len());

    // Validate every artifact and target before changing any target.
    for mutation in &manifest.mutations {
        let backup_path = transaction_dir.join(&mutation.backup_file);
        if backup_path
            .symlink_metadata()
            .is_ok_and(|metadata| metadata.file_type().is_symlink())
        {
            return Err(SidecarError::InvalidConfiguration(
                "Prepared transaction backup cannot be a symbolic link.".to_string(),
            ));
        }
        let backup = read_optional(&backup_path)?.ok_or_else(|| {
            SidecarError::InvalidConfiguration(
                "Prepared transaction backup is missing.".to_string(),
            )
        })?;
        if sha256(&backup) != mutation.before_sha256 {
            return Err(SidecarError::InvalidConfiguration(
                "Prepared transaction backup hash does not match its manifest.".to_string(),
            ));
        }
        #[cfg(unix)]
        if file_mode(&backup_path)? != Some(0o600) {
            return Err(SidecarError::InvalidConfiguration(
                "Prepared transaction backup permissions are not private.".to_string(),
            ));
        }

        if mutation
            .path
            .symlink_metadata()
            .is_ok_and(|metadata| metadata.file_type().is_symlink())
        {
            return Err(SidecarError::InvalidConfiguration(
                "Prepared transaction target cannot be a symbolic link.".to_string(),
            ));
        }
        let current = read_optional(&mutation.path)?;
        let current_hash = sha256(current.as_deref().unwrap_or_default());
        let matches_before =
            current.is_some() == mutation.existed && current_hash == mutation.before_sha256;
        let matches_after = current.is_some() && current_hash == mutation.after_sha256;
        if !matches_before && !matches_after {
            return Err(SidecarError::PreparedTransactionConflict);
        }
        current_snapshots.push((current, file_mode(&mutation.path)?));
        backups.push(backup);
    }

    let mut restored_indices: Vec<usize> = Vec::new();
    for index in (0..manifest.mutations.len()).rev() {
        let mutation = &manifest.mutations[index];
        let result = restore_path(
            &mutation.path,
            mutation.existed.then_some(backups[index].as_slice()),
            mutation.before_mode,
        );
        if let Err(error) = result {
            for restored_index in restored_indices.iter().rev().copied() {
                let restored = &manifest.mutations[restored_index];
                let (bytes, mode) = &current_snapshots[restored_index];
                let _ = restore_path(&restored.path, bytes.as_deref(), *mode);
            }
            return Err(error);
        }
        restored_indices.push(index);
    }
    Ok(())
}

fn build_plan(paths: &ResolvedPaths, request: &PreviewRequest) -> SidecarResult<InternalPlan> {
    let (profile, adapter_output) = adapters::plan(paths, request.tool, &request.profile)?;
    let state_path = paths.active_profile_path(request.tool);
    if state_path == *paths.config_path(request.tool) {
        return Err(SidecarError::InvalidRequest(
            "The tool configuration and sidecar state paths must be different.".to_string(),
        ));
    }
    let state_before = read_optional(&state_path)?;
    let state_before_mode = file_mode(&state_path)?;
    let mut state_after = serde_json::to_vec_pretty(&serde_json::json!({
        "schemaVersion": 1,
        "tool": request.tool,
        "profile": profile,
    }))
    .map_err(SidecarError::serialize)?;
    state_after.push(b'\n');

    let mut mutations = vec![adapter_output.mutation];
    mutations.push(PlannedMutation {
        purpose: MutationPurpose::ActiveProfileState,
        path: state_path,
        before: state_before,
        after: state_after,
        before_mode: state_before_mode,
        private: true,
    });
    let plan_id = calculate_plan_id(request.tool.as_str(), &profile, &mutations)?;
    let targets = mutations
        .iter()
        .map(|mutation| PlanTarget {
            purpose: mutation.purpose,
            path: mutation.path.clone(),
            existed: mutation.before.is_some(),
            before_sha256: sha256(mutation.before.as_deref().unwrap_or_default()),
            after_sha256: sha256(&mutation.after),
            before_mode: mutation.before_mode,
            after_mode: after_mode(mutation),
        })
        .collect();
    let preview = PreviewResult {
        plan_id,
        tool: request.tool,
        profile,
        targets,
        changes: adapter_output.changes,
        requires_credential_env: request.profile.credential_env_var.clone(),
        warnings: adapter_output.warnings,
    };
    Ok(InternalPlan { preview, mutations })
}

fn calculate_plan_id(
    tool: &str,
    profile: &crate::models::ProfileSummary,
    mutations: &[PlannedMutation],
) -> SidecarResult<String> {
    let mut hasher = Sha256::new();
    hasher.update(b"one-status-device-sidecar-plan-v1\0");
    hasher.update(tool.as_bytes());
    hasher.update([0]);
    hasher.update(serde_json::to_vec(profile).map_err(SidecarError::serialize)?);
    for mutation in mutations {
        hasher.update([0]);
        hasher.update(format!("{:?}", mutation.purpose).as_bytes());
        hasher.update([0]);
        hasher.update(mutation.path.to_string_lossy().as_bytes());
        hasher.update([0]);
        hasher.update(sha256(mutation.before.as_deref().unwrap_or_default()).as_bytes());
        hasher.update(sha256(&mutation.after).as_bytes());
        hasher.update([0]);
        hasher.update(format!("{:?}", mutation.before_mode).as_bytes());
        hasher.update(format!("{:?}", after_mode(mutation)).as_bytes());
    }
    Ok(format!("plan_{}", hex::encode(hasher.finalize())))
}

fn restore_mutations(mutations: &[PlannedMutation]) -> SidecarResult<()> {
    let mut first_error = None;
    for mutation in mutations.iter().rev() {
        let result = restore_path(
            &mutation.path,
            mutation.before.as_deref(),
            mutation.before_mode,
        );
        if first_error.is_none() {
            first_error = result.err();
        }
    }
    match first_error {
        Some(error) => Err(error),
        None => Ok(()),
    }
}

fn apply_mutation(mutation: &PlannedMutation) -> SidecarResult<()> {
    if mutation.private {
        atomic_write_private(&mutation.path, &mutation.after)
    } else {
        atomic_write(&mutation.path, &mutation.after)
    }
}

fn restore_path(path: &Path, bytes: Option<&[u8]>, mode: Option<u32>) -> SidecarResult<()> {
    match bytes {
        Some(bytes) => atomic_write_with_mode(path, bytes, mode),
        None => remove_file(path),
    }
}

fn after_mode(mutation: &PlannedMutation) -> Option<u32> {
    #[cfg(unix)]
    {
        Some(if mutation.private {
            0o600
        } else {
            mutation.before_mode.unwrap_or(0o600)
        })
    }
    #[cfg(not(unix))]
    {
        None
    }
}

fn validate_manifest(
    paths: &ResolvedPaths,
    expected_id: &str,
    manifest: &TransactionManifest,
) -> SidecarResult<()> {
    if manifest.schema_version != 2
        || manifest.transaction_id != expected_id
        || manifest.mutations.len() != 2
    {
        return Err(SidecarError::InvalidConfiguration(
            "Rollback manifest has an unsupported structure.".to_string(),
        ));
    }
    let expected_paths = [
        paths.config_path(manifest.tool).to_path_buf(),
        paths.active_profile_path(manifest.tool),
    ];
    for (index, mutation) in manifest.mutations.iter().enumerate() {
        let expected_purpose = if index == 0 {
            MutationPurpose::ToolConfiguration
        } else {
            MutationPurpose::ActiveProfileState
        };
        if mutation.path != expected_paths[index]
            || mutation.purpose != expected_purpose
            || mutation.backup_file != format!("backup-{index}.bin")
            || mutation.before_mode.is_some_and(|mode| mode > 0o777)
            || mutation.after_mode.is_some_and(|mode| mode > 0o777)
        {
            return Err(SidecarError::InvalidConfiguration(
                "Rollback manifest references an unexpected path.".to_string(),
            ));
        }
    }
    #[cfg(unix)]
    for mutation in &manifest.mutations {
        if mutation.before_mode.is_some() != mutation.existed || mutation.after_mode.is_none() {
            return Err(SidecarError::InvalidConfiguration(
                "Rollback manifest has incomplete permission metadata.".to_string(),
            ));
        }
    }
    Ok(())
}

fn validate_transaction_id(value: &str) -> SidecarResult<()> {
    if value.len() < 20
        || value.len() > 96
        || !value
            .chars()
            .all(|character| character.is_ascii_alphanumeric() || character == '-')
    {
        return Err(SidecarError::InvalidRequest(
            "transactionId has an invalid format.".to_string(),
        ));
    }
    Ok(())
}

fn new_transaction_id(plan_id: &str) -> String {
    let suffix = plan_id
        .strip_prefix("plan_")
        .unwrap_or(plan_id)
        .chars()
        .take(16)
        .collect::<String>();
    format!("tx-{}-{suffix}", now_unix_ms())
}

fn create_transaction_dir(
    paths: &ResolvedPaths,
    plan_id: &str,
) -> SidecarResult<(String, std::path::PathBuf)> {
    let transaction_root = paths.state_root.join("transactions");
    fs::create_dir_all(&transaction_root)
        .map_err(|error| SidecarError::io("create transaction root", &transaction_root, error))?;
    set_private_directory_permissions(&transaction_root)?;
    let base = new_transaction_id(plan_id);
    for suffix in 0..32_u8 {
        let transaction_id = if suffix == 0 {
            base.clone()
        } else {
            format!("{base}-{suffix}")
        };
        let path = paths.transaction_dir(&transaction_id);
        match fs::create_dir(&path) {
            Ok(()) => {
                set_private_directory_permissions(&path)?;
                return Ok((transaction_id, path));
            }
            Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => continue,
            Err(error) => {
                return Err(SidecarError::io(
                    "create transaction directory",
                    &path,
                    error,
                ));
            }
        }
    }
    Err(SidecarError::Io(
        "Could not allocate a unique transaction directory.".to_string(),
    ))
}

fn now_unix_ms() -> u128 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis()
}

fn sha256(bytes: &[u8]) -> String {
    hex::encode(Sha256::digest(bytes))
}

#[cfg(unix)]
fn set_private_directory_permissions(path: &Path) -> SidecarResult<()> {
    use std::os::unix::fs::PermissionsExt;
    fs::set_permissions(path, fs::Permissions::from_mode(0o700))
        .map_err(|error| SidecarError::io("set transaction permissions", path, error))
}

#[cfg(not(unix))]
fn set_private_directory_permissions(_: &Path) -> SidecarResult<()> {
    Ok(())
}
