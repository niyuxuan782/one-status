use std::collections::HashSet;
use std::env;
use std::path::{Path, PathBuf};

use crate::error::{SidecarError, SidecarResult};
use crate::models::{PathOverrides, ToolId};

#[derive(Clone, Debug)]
pub(crate) struct ResolvedPaths {
    pub home: PathBuf,
    pub codex_config: PathBuf,
    pub codex_auth: PathBuf,
    pub claude_settings: PathBuf,
    pub cursor_manifest: PathBuf,
    pub state_root: PathBuf,
    pub codex_executable: Option<PathBuf>,
    pub claude_executable: Option<PathBuf>,
    pub cursor_executable: Option<PathBuf>,
}

impl ResolvedPaths {
    pub fn resolve(home: Option<PathBuf>, overrides: &PathOverrides) -> SidecarResult<Self> {
        let home = match home {
            Some(home) => absolute(home, "home")?,
            None => dirs::home_dir().ok_or_else(|| {
                SidecarError::InvalidRequest(
                    "The user home directory could not be resolved.".to_string(),
                )
            })?,
        };

        let codex_dir = env_path("CODEX_HOME").unwrap_or_else(|| home.join(".codex"));
        let claude_dir = env_path("CLAUDE_CONFIG_DIR").unwrap_or_else(|| home.join(".claude"));
        let claude_default = claude_dir.join("settings.json");
        let claude_legacy = claude_dir.join("claude.json");
        let claude_settings = overrides.claude_settings.clone().unwrap_or_else(|| {
            if claude_default.exists() || !claude_legacy.exists() {
                claude_default
            } else {
                claude_legacy
            }
        });

        let cursor_manifest = overrides.cursor_manifest.clone().unwrap_or_else(|| {
            home.join(".cursor")
                .join("one-status")
                .join("model-profile.json")
        });
        let state_root = overrides
            .state_root
            .clone()
            .unwrap_or_else(|| home.join(".one-status").join("device-sidecar"));

        let mut result = Self {
            codex_config: overrides
                .codex_config
                .clone()
                .unwrap_or_else(|| codex_dir.join("config.toml")),
            codex_auth: overrides
                .codex_auth
                .clone()
                .unwrap_or_else(|| codex_dir.join("auth.json")),
            claude_settings,
            cursor_manifest,
            state_root,
            codex_executable: executable_override_or_detect(
                overrides.codex_executable.as_ref(),
                "codex",
                &home,
            ),
            claude_executable: executable_override_or_detect(
                overrides.claude_executable.as_ref(),
                "claude",
                &home,
            ),
            cursor_executable: executable_override_or_detect(
                overrides.cursor_executable.as_ref(),
                "cursor",
                &home,
            ),
            home,
        };

        result.codex_config = absolute(result.codex_config, "codexConfig")?;
        result.codex_auth = absolute(result.codex_auth, "codexAuth")?;
        result.claude_settings = absolute(result.claude_settings, "claudeSettings")?;
        result.cursor_manifest = absolute(result.cursor_manifest, "cursorManifest")?;
        result.state_root = absolute(result.state_root, "stateRoot")?;
        Ok(result)
    }

    pub fn config_path(&self, tool: ToolId) -> &Path {
        match tool {
            ToolId::Codex => &self.codex_config,
            ToolId::ClaudeCode => &self.claude_settings,
            ToolId::Cursor => &self.cursor_manifest,
        }
    }

    pub fn active_profile_path(&self, tool: ToolId) -> PathBuf {
        self.state_root
            .join("active")
            .join(format!("{}.json", tool.as_str()))
    }

    pub fn transaction_dir(&self, transaction_id: &str) -> PathBuf {
        self.state_root.join("transactions").join(transaction_id)
    }

    pub fn lock_path(&self) -> PathBuf {
        self.state_root.join("operation.lock")
    }

    pub fn executable(&self, tool: ToolId) -> Option<&PathBuf> {
        match tool {
            ToolId::Codex => self.codex_executable.as_ref(),
            ToolId::ClaudeCode => self.claude_executable.as_ref(),
            ToolId::Cursor => self.cursor_executable.as_ref(),
        }
    }
}

fn absolute(path: PathBuf, field: &str) -> SidecarResult<PathBuf> {
    if path.is_absolute() {
        return Ok(path);
    }
    Err(SidecarError::InvalidRequest(format!(
        "{field} must be an absolute path."
    )))
}

fn env_path(key: &str) -> Option<PathBuf> {
    env::var_os(key)
        .filter(|value| !value.is_empty())
        .map(PathBuf::from)
        .filter(|path| path.is_absolute())
}

fn executable_override_or_detect(
    override_path: Option<&PathBuf>,
    name: &str,
    home: &Path,
) -> Option<PathBuf> {
    if let Some(path) = override_path {
        return path.exists().then(|| path.clone());
    }

    let mut candidates = Vec::new();
    if let Some(path) = env::var_os("PATH") {
        candidates
            .extend(env::split_paths(&path).map(|directory| directory.join(executable_name(name))));
    }
    candidates.extend([
        home.join(".local").join("bin").join(executable_name(name)),
        home.join(".volta").join("bin").join(executable_name(name)),
        PathBuf::from("/opt/homebrew/bin").join(executable_name(name)),
        PathBuf::from("/usr/local/bin").join(executable_name(name)),
    ]);

    #[cfg(target_os = "macos")]
    match name {
        "codex" => candidates.extend([
            PathBuf::from("/Applications/ChatGPT.app/Contents/Resources/codex"),
            PathBuf::from("/Applications/Codex.app/Contents/Resources/codex"),
        ]),
        "cursor" => candidates.push(PathBuf::from(
            "/Applications/Cursor.app/Contents/MacOS/Cursor",
        )),
        _ => {}
    }

    let mut seen = HashSet::new();
    candidates
        .into_iter()
        .find(|candidate| seen.insert(candidate.clone()) && is_executable(candidate))
}

#[cfg(windows)]
fn executable_name(name: &str) -> String {
    format!("{name}.exe")
}

#[cfg(not(windows))]
fn executable_name(name: &str) -> String {
    name.to_string()
}

fn is_executable(path: &Path) -> bool {
    let Ok(metadata) = path.metadata() else {
        return false;
    };
    if !metadata.is_file() {
        return false;
    }

    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        metadata.permissions().mode() & 0o111 != 0
    }
    #[cfg(not(unix))]
    {
        true
    }
}
