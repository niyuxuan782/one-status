use serde_json::Value;

use crate::error::{SidecarError, SidecarResult};

pub fn reject_plaintext_credentials(value: &Value) -> SidecarResult<()> {
    match value {
        Value::Object(object) => {
            for (key, child) in object {
                if is_plaintext_credential_key(key) {
                    return Err(SidecarError::PlaintextCredential);
                }
                reject_plaintext_credentials(child)?;
            }
        }
        Value::Array(array) => {
            for child in array {
                reject_plaintext_credentials(child)?;
            }
        }
        _ => {}
    }
    Ok(())
}

fn is_plaintext_credential_key(key: &str) -> bool {
    let normalized = key
        .chars()
        .filter(|character| character.is_ascii_alphanumeric())
        .flat_map(char::to_lowercase)
        .collect::<String>();

    if normalized == "credentialenvvar" || normalized == "credentialavailable" {
        return false;
    }

    [
        "apikey",
        "accesstoken",
        "refreshtoken",
        "authtoken",
        "bearertoken",
        "credentialvalue",
        "clientsecret",
        "password",
        "secret",
    ]
    .iter()
    .any(|sensitive| normalized == *sensitive || normalized.ends_with(sensitive))
}

pub fn redacted_presence(value: Option<&Value>) -> Option<Value> {
    value.map(|_| Value::String("<redacted>".to_string()))
}
