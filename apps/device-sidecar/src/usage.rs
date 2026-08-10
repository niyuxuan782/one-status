use std::collections::{BTreeMap, HashMap, HashSet};
use std::fs::{self, File};
use std::io::{BufRead, BufReader, Seek, SeekFrom};
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

use serde_json::Value;

use crate::error::{SidecarError, SidecarResult};
use crate::models::{ModelUsage, ToolId, UsageRequest, UsageScan};

const MAX_DISCOVERED_FILES: usize = 5_000;
const MAX_FILE_BYTES: u64 = 32 * 1024 * 1024;
const MAX_TOTAL_BYTES_PER_TOOL: u64 = 256 * 1024 * 1024;
const MAX_CLAUDE_MESSAGES: usize = 100_000;

#[derive(Clone, Copy, Debug, Default, Eq, PartialEq)]
struct Tokens {
    input: u64,
    cached_input: u64,
    cache_creation_input: u64,
    output: u64,
}

impl Tokens {
    fn is_zero(self) -> bool {
        self.input == 0
            && self.cached_input == 0
            && self.cache_creation_input == 0
            && self.output == 0
    }

    fn saturating_delta(self, previous: Self) -> Self {
        Self {
            input: self.input.saturating_sub(previous.input),
            cached_input: self.cached_input.saturating_sub(previous.cached_input),
            cache_creation_input: self
                .cache_creation_input
                .saturating_sub(previous.cache_creation_input),
            output: self.output.saturating_sub(previous.output),
        }
    }

    fn update_high_water(&mut self, current: Self) {
        self.input = self.input.max(current.input);
        self.cached_input = self.cached_input.max(current.cached_input);
        self.cache_creation_input = self.cache_creation_input.max(current.cache_creation_input);
        self.output = self.output.max(current.output);
    }
}

#[derive(Debug)]
struct Candidate {
    path: PathBuf,
    modified: SystemTime,
    size: u64,
}

#[derive(Debug)]
struct ClaudeMessage {
    model: String,
    tokens: Tokens,
    timestamp: Option<String>,
    complete: bool,
}

pub(crate) fn scan(request: UsageRequest) -> SidecarResult<UsageScan> {
    let max_files = request.max_files_per_tool.clamp(1, 500);
    let home = request.home.or_else(dirs::home_dir).ok_or_else(|| {
        SidecarError::InvalidRequest("Home directory is unavailable.".to_string())
    })?;
    let mut aggregate = BTreeMap::<(ToolId, String), ModelUsage>::new();
    let mut warnings = Vec::new();
    let mut files_scanned = 0;
    let mut truncated = false;

    let codex_root = std::env::var_os("CODEX_HOME")
        .map(PathBuf::from)
        .unwrap_or_else(|| home.join(".codex"));
    let codex_roots = [
        codex_root.join("sessions"),
        codex_root.join("archived_sessions"),
    ];
    let selection = select_files(&codex_roots, 6, max_files, &mut warnings)?;
    truncated |= selection.truncated;
    for candidate in selection.files {
        files_scanned += 1;
        if let Err(error) = scan_codex_file(&candidate.path, &mut aggregate) {
            warnings.push(public_scan_warning("Codex", error));
        }
    }

    let claude_root = std::env::var_os("CLAUDE_CONFIG_DIR")
        .map(PathBuf::from)
        .unwrap_or_else(|| home.join(".claude"))
        .join("projects");
    let selection = select_files(&[claude_root], 6, max_files, &mut warnings)?;
    truncated |= selection.truncated;
    let mut messages = HashMap::<String, ClaudeMessage>::new();
    for candidate in selection.files {
        files_scanned += 1;
        if let Err(error) = scan_claude_file(&candidate.path, &mut messages, &mut truncated) {
            warnings.push(public_scan_warning("Claude Code", error));
        }
    }
    for message in messages.into_values() {
        add_usage(
            &mut aggregate,
            ToolId::ClaudeCode,
            message.model,
            "claude-session",
            message.tokens,
            message.timestamp,
        );
    }

    let mut entries = aggregate.into_values().collect::<Vec<_>>();
    entries.sort_by(|left, right| {
        total_tokens(right)
            .cmp(&total_tokens(left))
            .then_with(|| left.tool.as_str().cmp(right.tool.as_str()))
            .then_with(|| left.model_id.cmp(&right.model_id))
    });

    Ok(UsageScan {
        scanned_at: system_time_to_rfc3339(SystemTime::now()),
        scope: format!("latest-{max_files}-session-files-per-tool"),
        files_scanned,
        truncated,
        entries,
        warnings,
    })
}

struct Selection {
    files: Vec<Candidate>,
    truncated: bool,
}

fn select_files(
    roots: &[PathBuf],
    max_depth: usize,
    max_files: usize,
    warnings: &mut Vec<String>,
) -> SidecarResult<Selection> {
    let mut candidates = Vec::new();
    for root in roots.iter().filter(|root| root.exists()) {
        collect_jsonl(root, max_depth, &mut candidates)?;
    }
    candidates.sort_by_key(|candidate| std::cmp::Reverse(candidate.modified));

    let mut selected = Vec::new();
    let mut selected_bytes = 0u64;
    let mut truncated = candidates.len() > max_files;
    let mut partial_files = 0usize;
    for candidate in candidates.into_iter().take(max_files) {
        let scan_bytes = candidate.size.min(MAX_FILE_BYTES);
        if selected_bytes.saturating_add(scan_bytes) > MAX_TOTAL_BYTES_PER_TOOL {
            truncated = true;
            break;
        }
        if candidate.size > MAX_FILE_BYTES {
            truncated = true;
            partial_files += 1;
        }
        selected_bytes += scan_bytes;
        selected.push(candidate);
    }
    if partial_files > 0 {
        warnings.push(format!(
            "{partial_files} large session files were limited to their newest 32 MiB."
        ));
    }
    Ok(Selection {
        files: selected,
        truncated,
    })
}

fn collect_jsonl(root: &Path, max_depth: usize, output: &mut Vec<Candidate>) -> SidecarResult<()> {
    let mut pending = vec![(root.to_path_buf(), 0usize)];
    while let Some((directory, depth)) = pending.pop() {
        let entries = fs::read_dir(&directory)
            .map_err(|error| SidecarError::io("read directory", &directory, error))?;
        for entry in entries.flatten() {
            if output.len() >= MAX_DISCOVERED_FILES {
                return Ok(());
            }
            let Ok(file_type) = entry.file_type() else {
                continue;
            };
            let path = entry.path();
            if file_type.is_symlink() {
                continue;
            }
            if file_type.is_dir() && depth < max_depth {
                pending.push((path, depth + 1));
                continue;
            }
            if !file_type.is_file()
                || path.extension().and_then(|value| value.to_str()) != Some("jsonl")
            {
                continue;
            }
            let Ok(metadata) = entry.metadata() else {
                continue;
            };
            output.push(Candidate {
                path,
                modified: metadata.modified().unwrap_or(UNIX_EPOCH),
                size: metadata.len(),
            });
        }
    }
    Ok(())
}

fn scan_codex_file(
    path: &Path,
    aggregate: &mut BTreeMap<(ToolId, String), ModelUsage>,
) -> SidecarResult<()> {
    let reader = open_bounded(path)?;
    let mut current_model = "unknown".to_string();
    let mut high_water = Tokens::default();
    let mut has_high_water = false;
    let mut previous_signature = None::<String>;
    let mut session_id = path
        .file_stem()
        .and_then(|value| value.to_str())
        .unwrap_or("unknown")
        .to_string();
    let mut seen_events = HashSet::new();

    for line in reader.lines() {
        let Ok(line) = line else { continue };
        if line.len() > 4 * 1024 * 1024 || line.trim().is_empty() {
            continue;
        }
        if !line.contains("\"turn_context\"")
            && !line.contains("\"token_count\"")
            && !line.contains("\"session_meta\"")
        {
            continue;
        }
        let Ok(value) = serde_json::from_str::<Value>(&line) else {
            continue;
        };
        match value.get("type").and_then(Value::as_str) {
            Some("session_meta") => {
                if let Some(id) = value
                    .get("payload")
                    .and_then(|payload| payload.get("id").or_else(|| payload.get("thread_id")))
                    .and_then(Value::as_str)
                    .filter(|id| !id.is_empty())
                {
                    session_id = id.to_string();
                }
            }
            Some("turn_context") => {
                if let Some(model) = value
                    .get("payload")
                    .and_then(|payload| {
                        payload
                            .get("model")
                            .or_else(|| payload.get("info").and_then(|info| info.get("model")))
                    })
                    .and_then(Value::as_str)
                    .filter(|model| !model.is_empty())
                {
                    current_model = model.to_string();
                }
            }
            Some("event_msg") => {
                let Some(payload) = value.get("payload") else {
                    continue;
                };
                if payload.get("type").and_then(Value::as_str) != Some("token_count") {
                    continue;
                }
                let Some(info) = payload.get("info").filter(|info| !info.is_null()) else {
                    continue;
                };
                if let Some(model) = info
                    .get("model")
                    .or_else(|| info.get("model_name"))
                    .or_else(|| payload.get("model"))
                    .and_then(Value::as_str)
                    .filter(|model| !model.is_empty())
                {
                    current_model = model.to_string();
                }
                let last = parse_tokens(info.get("last_token_usage"));
                let total = parse_tokens(info.get("total_token_usage"));
                let Some(signature_value) = info
                    .get("last_token_usage")
                    .or_else(|| info.get("total_token_usage"))
                else {
                    continue;
                };
                let signature = signature_value.to_string();
                let timestamp = value
                    .get("timestamp")
                    .and_then(Value::as_str)
                    .map(str::to_string);
                let event_key = format!(
                    "{}|{}|{}|{}",
                    session_id,
                    timestamp.as_deref().unwrap_or(""),
                    current_model,
                    signature
                );
                if previous_signature.as_ref() == Some(&signature) || !seen_events.insert(event_key)
                {
                    continue;
                }
                previous_signature = Some(signature);
                let tokens = if let Some(last) = last {
                    last
                } else if let Some(total) = total {
                    let delta = if has_high_water {
                        total.saturating_delta(high_water)
                    } else {
                        total
                    };
                    high_water.update_high_water(total);
                    has_high_water = true;
                    delta
                } else {
                    continue;
                };
                if let Some(total) = total {
                    high_water.update_high_water(total);
                    has_high_water = true;
                }
                add_usage(
                    aggregate,
                    ToolId::Codex,
                    current_model.clone(),
                    "codex-session",
                    tokens,
                    timestamp,
                );
            }
            _ => {}
        }
    }
    Ok(())
}

fn scan_claude_file(
    path: &Path,
    messages: &mut HashMap<String, ClaudeMessage>,
    truncated: &mut bool,
) -> SidecarResult<()> {
    for line in open_bounded(path)?.lines() {
        if messages.len() >= MAX_CLAUDE_MESSAGES {
            *truncated = true;
            break;
        }
        let Ok(line) = line else { continue };
        if line.len() > 4 * 1024 * 1024 || !line.contains("\"assistant\"") {
            continue;
        }
        let Ok(value) = serde_json::from_str::<Value>(&line) else {
            continue;
        };
        if value.get("type").and_then(Value::as_str) != Some("assistant") {
            continue;
        }
        let Some(message) = value.get("message") else {
            continue;
        };
        let Some(id) = message.get("id").and_then(Value::as_str) else {
            continue;
        };
        let Some(tokens) = parse_tokens(message.get("usage")) else {
            continue;
        };
        if tokens.is_zero() {
            continue;
        }
        let parsed = ClaudeMessage {
            model: message
                .get("model")
                .and_then(Value::as_str)
                .filter(|model| !model.is_empty())
                .unwrap_or("unknown")
                .to_string(),
            tokens,
            timestamp: value
                .get("timestamp")
                .and_then(Value::as_str)
                .map(str::to_string),
            complete: message
                .get("stop_reason")
                .is_some_and(|value| !value.is_null()),
        };
        let replace = messages.get(id).is_none_or(|existing| {
            (parsed.complete && !existing.complete)
                || (parsed.complete == existing.complete
                    && parsed.tokens.output > existing.tokens.output)
        });
        if replace {
            messages.insert(id.to_string(), parsed);
        }
    }
    Ok(())
}

fn open_bounded(path: &Path) -> SidecarResult<BufReader<File>> {
    let mut file = File::open(path).map_err(|error| SidecarError::io("open", path, error))?;
    let size = file
        .metadata()
        .map_err(|error| SidecarError::io("inspect", path, error))?
        .len();
    let mut reader = if size > MAX_FILE_BYTES {
        file.seek(SeekFrom::Start(size - MAX_FILE_BYTES))
            .map_err(|error| SidecarError::io("seek", path, error))?;
        BufReader::new(file)
    } else {
        BufReader::new(file)
    };
    if size > MAX_FILE_BYTES {
        let mut partial_line = Vec::new();
        reader
            .read_until(b'\n', &mut partial_line)
            .map_err(|error| SidecarError::io("read", path, error))?;
    }
    Ok(reader)
}

fn parse_tokens(value: Option<&Value>) -> Option<Tokens> {
    let object = value?.as_object()?;
    let known = [
        "input_tokens",
        "cached_input_tokens",
        "cache_read_input_tokens",
        "cache_creation_input_tokens",
        "output_tokens",
    ]
    .iter()
    .any(|field| object.contains_key(*field));
    known.then(|| Tokens {
        input: object
            .get("input_tokens")
            .and_then(Value::as_u64)
            .unwrap_or(0),
        cached_input: object
            .get("cached_input_tokens")
            .or_else(|| object.get("cache_read_input_tokens"))
            .and_then(Value::as_u64)
            .unwrap_or(0),
        cache_creation_input: object
            .get("cache_creation_input_tokens")
            .and_then(Value::as_u64)
            .unwrap_or(0),
        output: object
            .get("output_tokens")
            .and_then(Value::as_u64)
            .unwrap_or(0),
    })
}

fn add_usage(
    aggregate: &mut BTreeMap<(ToolId, String), ModelUsage>,
    tool: ToolId,
    model_id: String,
    data_source: &str,
    tokens: Tokens,
    latest_at: Option<String>,
) {
    if tokens.is_zero() {
        return;
    }
    let entry = aggregate
        .entry((tool, model_id.clone()))
        .or_insert_with(|| ModelUsage {
            tool,
            model_id,
            data_source: data_source.to_string(),
            input_tokens: 0,
            cached_input_tokens: 0,
            cache_creation_input_tokens: 0,
            output_tokens: 0,
            requests: 0,
            latest_at: None,
        });
    entry.input_tokens = entry.input_tokens.saturating_add(tokens.input);
    entry.cached_input_tokens = entry
        .cached_input_tokens
        .saturating_add(tokens.cached_input);
    entry.cache_creation_input_tokens = entry
        .cache_creation_input_tokens
        .saturating_add(tokens.cache_creation_input);
    entry.output_tokens = entry.output_tokens.saturating_add(tokens.output);
    entry.requests = entry.requests.saturating_add(1);
    if latest_at.as_ref() > entry.latest_at.as_ref() {
        entry.latest_at = latest_at;
    }
}

fn total_tokens(entry: &ModelUsage) -> u64 {
    entry
        .input_tokens
        .saturating_add(entry.cached_input_tokens)
        .saturating_add(entry.cache_creation_input_tokens)
        .saturating_add(entry.output_tokens)
}

fn system_time_to_rfc3339(time: SystemTime) -> String {
    let seconds = time
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs() as i64;
    let days = seconds.div_euclid(86_400);
    let seconds_of_day = seconds.rem_euclid(86_400);
    let (year, month, day) = civil_from_days(days);
    let hour = seconds_of_day / 3_600;
    let minute = (seconds_of_day % 3_600) / 60;
    let second = seconds_of_day % 60;
    format!("{year:04}-{month:02}-{day:02}T{hour:02}:{minute:02}:{second:02}Z")
}

fn civil_from_days(days_since_epoch: i64) -> (i64, i64, i64) {
    let shifted = days_since_epoch + 719_468;
    let era = shifted.div_euclid(146_097);
    let day_of_era = shifted - era * 146_097;
    let year_of_era =
        (day_of_era - day_of_era / 1_460 + day_of_era / 36_524 - day_of_era / 146_096) / 365;
    let mut year = year_of_era + era * 400;
    let day_of_year = day_of_era - (365 * year_of_era + year_of_era / 4 - year_of_era / 100);
    let month_part = (5 * day_of_year + 2) / 153;
    let day = day_of_year - (153 * month_part + 2) / 5 + 1;
    let month = month_part + if month_part < 10 { 3 } else { -9 };
    year += i64::from(month <= 2);
    (year, month, day)
}

fn public_scan_warning(tool: &str, error: SidecarError) -> String {
    format!(
        "{tool} usage scan skipped one unreadable session file ({})",
        error.code()
    )
}
