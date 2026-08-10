use std::fs;
use std::io::{self, IsTerminal, Read};
use std::path::PathBuf;

use clap::{Parser, Subcommand};
use one_status_device_sidecar::{execute, CommandName};

#[derive(Debug, Parser)]
#[command(name = "one-status-device-sidecar", version, about)]
struct Cli {
    #[command(subcommand)]
    command: Command,

    /// Read a JSON request from this file instead of stdin.
    #[arg(long, global = true, value_name = "PATH")]
    input: Option<PathBuf>,

    /// Pretty-print the JSON response.
    #[arg(long, global = true)]
    pretty: bool,
}

#[derive(Clone, Copy, Debug, Subcommand)]
enum Command {
    Scan,
    Usage,
    Preview,
    Apply,
    Rollback,
}

impl From<Command> for CommandName {
    fn from(value: Command) -> Self {
        match value {
            Command::Scan => Self::Scan,
            Command::Usage => Self::Usage,
            Command::Preview => Self::Preview,
            Command::Apply => Self::Apply,
            Command::Rollback => Self::Rollback,
        }
    }
}

fn main() {
    let cli = Cli::parse();
    let raw_input = match read_input(cli.input.as_ref()) {
        Ok(input) => input,
        Err(message) => {
            let response = serde_json::json!({
                "schemaVersion": 1,
                "ok": false,
                "command": CommandName::from(cli.command),
                "error": { "code": "input_read_failed", "message": message },
            });
            print_response(&response, cli.pretty);
            std::process::exit(1);
        }
    };

    let (exit_code, response) = execute(cli.command.into(), &raw_input);
    print_response(&response, cli.pretty);
    if exit_code != 0 {
        std::process::exit(exit_code);
    }
}

fn read_input(path: Option<&PathBuf>) -> Result<Vec<u8>, String> {
    if let Some(path) = path {
        return fs::read(path).map_err(|_| "Could not read the JSON input file.".to_string());
    }
    if io::stdin().is_terminal() {
        return Ok(b"{}".to_vec());
    }
    let mut input = Vec::new();
    io::stdin()
        .take(1_048_577)
        .read_to_end(&mut input)
        .map_err(|_| "Could not read JSON from stdin.".to_string())?;
    Ok(input)
}

fn print_response(response: &serde_json::Value, pretty: bool) {
    let serialized = if pretty {
        serde_json::to_string_pretty(response)
    } else {
        serde_json::to_string(response)
    }
    .expect("response serialization uses JSON-compatible values");
    println!("{serialized}");
}
