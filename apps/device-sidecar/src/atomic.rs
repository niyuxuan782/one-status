//! Atomic configuration writes and the cross-process operation lock.
//!
//! The temporary-file, permission-preservation, and platform replacement flow
//! is adapted from CC Switch `src-tauri/src/config.rs` at commit
//! `413c09e0790c304506888ae24b9be72820aca126` (MIT, Jason Young, 2025).

use std::fs::{self, File, OpenOptions};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{SystemTime, UNIX_EPOCH};

use fs2::FileExt;

use crate::error::{SidecarError, SidecarResult};

const MAX_CONFIG_BYTES: u64 = 8 * 1024 * 1024;
static TEMP_COUNTER: AtomicU64 = AtomicU64::new(0);

pub(crate) struct OperationLock {
    file: File,
}

impl OperationLock {
    pub fn acquire(path: &Path) -> SidecarResult<Self> {
        create_parent(path)?;
        let file = secure_open(path)?;
        file.lock_exclusive()
            .map_err(|error| SidecarError::io("lock", path, error))?;
        Ok(Self { file })
    }
}

impl Drop for OperationLock {
    fn drop(&mut self) {
        let _ = FileExt::unlock(&self.file);
    }
}

pub(crate) fn read_optional(path: &Path) -> SidecarResult<Option<Vec<u8>>> {
    if !path.exists() {
        return Ok(None);
    }
    let metadata = fs::metadata(path).map_err(|error| SidecarError::io("stat", path, error))?;
    if !metadata.is_file() || metadata.len() > MAX_CONFIG_BYTES {
        return Err(SidecarError::InvalidConfiguration(format!(
            "{} is not a regular configuration file under 8 MiB.",
            path.display()
        )));
    }
    fs::read(path)
        .map(Some)
        .map_err(|error| SidecarError::io("read", path, error))
}

pub(crate) fn atomic_write(path: &Path, data: &[u8]) -> SidecarResult<()> {
    let target_mode = file_mode(path)?;
    atomic_write_with_mode(path, data, target_mode)
}

pub(crate) fn atomic_write_private(path: &Path, data: &[u8]) -> SidecarResult<()> {
    #[cfg(unix)]
    let target_mode = Some(0o600);
    #[cfg(not(unix))]
    let target_mode = None;
    atomic_write_with_mode(path, data, target_mode)
}

pub(crate) fn atomic_write_with_mode(
    path: &Path,
    data: &[u8],
    target_mode: Option<u32>,
) -> SidecarResult<()> {
    if data.len() as u64 > MAX_CONFIG_BYTES {
        return Err(SidecarError::InvalidConfiguration(
            "Generated configuration exceeds 8 MiB.".to_string(),
        ));
    }
    if path
        .symlink_metadata()
        .is_ok_and(|metadata| metadata.file_type().is_symlink())
    {
        return Err(SidecarError::InvalidConfiguration(format!(
            "Refusing to replace symbolic-link configuration {}.",
            path.display()
        )));
    }
    create_parent(path)?;
    let parent = path.parent().ok_or_else(|| {
        SidecarError::InvalidConfiguration(
            "Configuration path has no parent directory.".to_string(),
        )
    })?;
    let file_name = path.file_name().ok_or_else(|| {
        SidecarError::InvalidConfiguration("Configuration path has no file name.".to_string())
    })?;

    let (temporary_path, mut temporary_file) = create_temporary(parent, file_name)?;
    let result = (|| -> SidecarResult<()> {
        temporary_file
            .write_all(data)
            .and_then(|_| temporary_file.flush())
            .and_then(|_| temporary_file.sync_all())
            .map_err(|error| SidecarError::io("write temporary file", &temporary_path, error))?;
        drop(temporary_file);
        replace_file(&temporary_path, path)?;
        set_file_mode(path, target_mode)?;
        sync_file(path);
        sync_parent(parent);
        Ok(())
    })();

    if result.is_err() {
        let _ = fs::remove_file(&temporary_path);
    }
    result
}

pub(crate) fn remove_file(path: &Path) -> SidecarResult<()> {
    if path.exists() {
        fs::remove_file(path).map_err(|error| SidecarError::io("remove", path, error))?;
        if let Some(parent) = path.parent() {
            sync_parent(parent);
        }
    }
    Ok(())
}

pub(crate) fn write_secure_json<T: serde::Serialize>(path: &Path, value: &T) -> SidecarResult<()> {
    let bytes = serde_json::to_vec_pretty(value).map_err(SidecarError::serialize)?;
    atomic_write_private(path, &bytes)
}

pub(crate) fn file_mode(path: &Path) -> SidecarResult<Option<u32>> {
    if !path.exists() {
        return Ok(None);
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let metadata = fs::metadata(path)
            .map_err(|error| SidecarError::io("read permissions", path, error))?;
        Ok(Some(metadata.permissions().mode() & 0o777))
    }
    #[cfg(not(unix))]
    {
        Ok(None)
    }
}

fn set_file_mode(path: &Path, mode: Option<u32>) -> SidecarResult<()> {
    #[cfg(unix)]
    if let Some(mode) = mode {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(path, fs::Permissions::from_mode(mode & 0o777))
            .map_err(|error| SidecarError::io("restore permissions", path, error))?;
    }
    #[cfg(not(unix))]
    let _ = (path, mode);
    Ok(())
}

fn create_parent(path: &Path) -> SidecarResult<()> {
    let parent = path.parent().ok_or_else(|| {
        SidecarError::InvalidConfiguration("File path has no parent directory.".to_string())
    })?;
    fs::create_dir_all(parent).map_err(|error| SidecarError::io("create directory", parent, error))
}

fn secure_open(path: &Path) -> SidecarResult<File> {
    let mut options = OpenOptions::new();
    options.create(true).read(true).write(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    options
        .open(path)
        .map_err(|error| SidecarError::io("open", path, error))
}

fn create_temporary(parent: &Path, file_name: &std::ffi::OsStr) -> SidecarResult<(PathBuf, File)> {
    let timestamp = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_nanos();
    for _ in 0..32 {
        let counter = TEMP_COUNTER.fetch_add(1, Ordering::Relaxed);
        let candidate = parent.join(format!(
            "{}.one-status.tmp.{}.{}.{}",
            file_name.to_string_lossy(),
            std::process::id(),
            timestamp,
            counter
        ));
        let mut options = OpenOptions::new();
        options.create_new(true).write(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.mode(0o600);
        }
        match options.open(&candidate) {
            Ok(file) => return Ok((candidate, file)),
            Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => continue,
            Err(error) => return Err(SidecarError::io("create temporary file", &candidate, error)),
        }
    }
    Err(SidecarError::Io(
        "Could not allocate a unique temporary file.".to_string(),
    ))
}

#[cfg(not(windows))]
fn replace_file(temporary: &Path, target: &Path) -> SidecarResult<()> {
    fs::rename(temporary, target)
        .map_err(|error| SidecarError::io("replace configuration", target, error))
}

#[cfg(windows)]
fn replace_file(temporary: &Path, target: &Path) -> SidecarResult<()> {
    use std::os::windows::ffi::OsStrExt;
    use windows_sys::Win32::Storage::FileSystem::{
        MoveFileExW, ReplaceFileW, MOVEFILE_REPLACE_EXISTING, MOVEFILE_WRITE_THROUGH,
    };

    let target_wide: Vec<u16> = target.as_os_str().encode_wide().chain(Some(0)).collect();
    let temporary_wide: Vec<u16> = temporary.as_os_str().encode_wide().chain(Some(0)).collect();
    let result = unsafe {
        if target.exists() {
            ReplaceFileW(
                target_wide.as_ptr(),
                temporary_wide.as_ptr(),
                std::ptr::null(),
                0,
                std::ptr::null(),
                std::ptr::null(),
            )
        } else {
            MoveFileExW(
                temporary_wide.as_ptr(),
                target_wide.as_ptr(),
                MOVEFILE_REPLACE_EXISTING | MOVEFILE_WRITE_THROUGH,
            )
        }
    };
    if result == 0 {
        return Err(SidecarError::io(
            "replace configuration",
            target,
            std::io::Error::last_os_error(),
        ));
    }
    Ok(())
}

#[cfg(unix)]
fn sync_parent(parent: &Path) {
    if let Ok(directory) = File::open(parent) {
        let _ = directory.sync_all();
    }
}

#[cfg(not(unix))]
fn sync_parent(_: &Path) {}

fn sync_file(path: &Path) {
    if let Ok(file) = File::open(path) {
        let _ = file.sync_all();
    }
}

#[cfg(all(test, unix))]
mod tests {
    use std::os::unix::fs::PermissionsExt;

    use tempfile::TempDir;

    use super::*;

    #[test]
    fn temporary_and_private_target_are_never_group_readable() {
        let directory = TempDir::new().unwrap();
        let target = directory.path().join("credential.json");
        fs::write(&target, b"old").unwrap();
        fs::set_permissions(&target, fs::Permissions::from_mode(0o644)).unwrap();

        let (temporary_path, temporary_file) =
            create_temporary(directory.path(), target.file_name().unwrap()).unwrap();
        assert_eq!(
            temporary_file.metadata().unwrap().permissions().mode() & 0o777,
            0o600
        );
        drop(temporary_file);
        fs::remove_file(temporary_path).unwrap();

        atomic_write_private(&target, b"projected-credential").unwrap();
        assert_eq!(
            fs::metadata(&target).unwrap().permissions().mode() & 0o777,
            0o600
        );
        assert_eq!(fs::read(target).unwrap(), b"projected-credential");
    }

    #[test]
    fn preserved_public_mode_is_applied_only_to_the_replaced_target() {
        let directory = TempDir::new().unwrap();
        let target = directory.path().join("public.json");
        fs::write(&target, b"old").unwrap();
        fs::set_permissions(&target, fs::Permissions::from_mode(0o644)).unwrap();

        atomic_write(&target, b"new").unwrap();
        assert_eq!(
            fs::metadata(&target).unwrap().permissions().mode() & 0o777,
            0o644
        );
        assert!(fs::read_dir(directory.path()).unwrap().all(|entry| !entry
            .unwrap()
            .file_name()
            .to_string_lossy()
            .contains(".tmp.")));
    }
}
