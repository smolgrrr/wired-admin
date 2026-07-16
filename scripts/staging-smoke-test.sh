#!/usr/bin/env bash
set -euo pipefail

base_url="${1:-https://staging.wiredsignal.online}"
admin_token="${STAGING_ADMIN_TOKEN:-}"

curl_args=(
  --fail
  --silent
  --show-error
  --max-time
  "20"
)

if [[ -n "${admin_token}" ]]; then
  curl_args+=(--header "X-Admin-Token: ${admin_token}")
fi

retry() {
  local url="$1"
  local attempt

  for attempt in {1..12}; do
    if curl "${curl_args[@]}" "${url}" >/dev/null; then
      return 0
    fi
    sleep 10
  done

  curl "${curl_args[@]}" "${url}" >/dev/null
}

retry "${base_url}/api/status"
retry "${base_url}/api/feed/bootstrap"
retry "${base_url}/api/media-moderation/status"
retry "${base_url}/healthz"
retry "${base_url}/api/moderation/manifest"
retry "${base_url}/api/wired-account/status"
retry "${base_url}/api/revenue/config"
retry "${base_url}/.well-known/lnurlp/wired"
retry "${base_url}/api/revenue/operator/status"

echo "staging smoke test passed: ${base_url}"
