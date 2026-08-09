mod adapters;
mod atomic;
mod error;
mod inventory;
mod models;
mod operation;
mod paths;
mod security;

pub use error::{SidecarError, SidecarResult};
pub use models::{ApplyRequest, CommandName, PreviewRequest, RollbackRequest, ScanRequest};

use serde::de::DeserializeOwned;
use serde_json::{json, Value};

const MAX_INPUT_BYTES: usize = 1_048_576;

pub fn execute(command: CommandName, raw_input: &[u8]) -> (i32, Value) {
    match execute_inner(command, raw_input) {
        Ok(data) => (
            0,
            json!({
                "schemaVersion": 1,
                "ok": true,
                "command": command,
                "data": data,
            }),
        ),
        Err(error) => {
            let mut error_body = json!({
                "code": error.code(),
                "message": error.public_message(),
            });
            if error.rolled_back() {
                error_body["rolledBack"] = Value::Bool(true);
            }
            (
                1,
                json!({
                    "schemaVersion": 1,
                    "ok": false,
                    "command": command,
                    "error": error_body,
                }),
            )
        }
    }
}

fn execute_inner(command: CommandName, raw_input: &[u8]) -> SidecarResult<Value> {
    if raw_input.len() > MAX_INPUT_BYTES {
        return Err(SidecarError::InvalidRequest(
            "Request exceeds the 1 MiB input limit.".to_string(),
        ));
    }

    let bytes = if raw_input.iter().all(u8::is_ascii_whitespace) {
        b"{}".as_slice()
    } else {
        raw_input
    };
    let input: Value = serde_json::from_slice(bytes)
        .map_err(|_| SidecarError::InvalidRequest("Request must be valid JSON.".to_string()))?;
    security::reject_plaintext_credentials(&input)?;

    match command {
        CommandName::Scan => {
            serde_json::to_value(inventory::scan(parse(input)?)?).map_err(SidecarError::serialize)
        }
        CommandName::Preview => serde_json::to_value(operation::preview(parse(input)?)?)
            .map_err(SidecarError::serialize),
        CommandName::Apply => {
            serde_json::to_value(operation::apply(parse(input)?)?).map_err(SidecarError::serialize)
        }
        CommandName::Rollback => serde_json::to_value(operation::rollback(parse(input)?)?)
            .map_err(SidecarError::serialize),
    }
}

fn parse<T: DeserializeOwned>(input: Value) -> SidecarResult<T> {
    serde_json::from_value(input).map_err(|error| {
        SidecarError::InvalidRequest(format!(
            "Request does not match the command schema: {error}"
        ))
    })
}

#[cfg(test)]
mod tests;
