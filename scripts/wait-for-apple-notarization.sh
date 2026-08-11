#!/usr/bin/env bash

set -euo pipefail

submission_id="${1:?Usage: wait-for-apple-notarization.sh <submission-id> [timeout-seconds]}"
timeout_seconds="${2:-18000}"
poll_interval="${NOTARY_POLL_INTERVAL_SECONDS:-30}"

for variable in APPLE_ID APPLE_TEAM_ID APPLE_APP_SPECIFIC_PASSWORD; do
  if [[ -z "${!variable:-}" ]]; then
    echo "$variable is required to query Apple notarization." >&2
    exit 1
  fi
done

if ! [[ "$timeout_seconds" =~ ^[0-9]+$ ]] || (( timeout_seconds < 1 )); then
  echo "timeout-seconds must be a positive integer." >&2
  exit 1
fi

if ! [[ "$poll_interval" =~ ^[0-9]+$ ]] || (( poll_interval < 1 )); then
  echo "NOTARY_POLL_INTERVAL_SECONDS must be a positive integer." >&2
  exit 1
fi

deadline=$(( $(date +%s) + timeout_seconds ))

while (( $(date +%s) < deadline )); do
  info_file="$(mktemp "${RUNNER_TEMP:-${TMPDIR:-/tmp}}/one-status-notary-info.XXXXXX")"
  error_file="$(mktemp "${RUNNER_TEMP:-${TMPDIR:-/tmp}}/one-status-notary-error.XXXXXX")"

  if xcrun notarytool info "$submission_id" \
    --apple-id "$APPLE_ID" \
    --team-id "$APPLE_TEAM_ID" \
    --password "$APPLE_APP_SPECIFIC_PASSWORD" \
    --output-format json >"$info_file" 2>"$error_file"; then
    status="$(jq -r '.status // empty' "$info_file")"
    rm -f "$error_file"
    case "$status" in
      Accepted)
        echo "Apple notarization accepted submission $submission_id."
        rm -f "$info_file"
        exit 0
        ;;
      Invalid|Rejected)
        echo "Apple notarization rejected submission $submission_id with status $status." >&2
        xcrun notarytool log "$submission_id" \
          --apple-id "$APPLE_ID" \
          --team-id "$APPLE_TEAM_ID" \
          --password "$APPLE_APP_SPECIFIC_PASSWORD" || true
        rm -f "$info_file"
        exit 1
        ;;
      "In Progress")
        echo "Apple notarization is still processing submission $submission_id."
        ;;
      *)
        echo "Apple returned an unexpected notarization status for $submission_id: ${status:-missing}." >&2
        cat "$info_file" >&2
        rm -f "$info_file"
        exit 1
        ;;
    esac
  else
    echo "Unable to query Apple notarization for $submission_id; retrying." >&2
    cat "$error_file" >&2
    rm -f "$error_file"
  fi

  rm -f "$info_file"
  sleep "$poll_interval"
done

echo "Apple notarization is still processing submission $submission_id after ${timeout_seconds}s." >&2
echo "Rerun the failed job to continue polling the same submission." >&2
exit 2
