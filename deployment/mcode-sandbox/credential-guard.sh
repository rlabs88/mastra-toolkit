#!/usr/bin/env bash
set -euo pipefail

forbidden_credentials=(
  IMAGE_PUBLISHING_TOKEN GHCR_PACKAGE_TOKEN MASTRA_PLATFORM_SECRET_KEY
  GITHUB_APP_PRIVATE_KEY GITHUB_APP_CLIENT_SECRET GITHUB_APP_WEBHOOK_SECRET
  WORKOS_API_KEY WORKOS_CLIENT_ID WORKOS_COOKIE_PASSWORD DATABASE_URL REDIS_URL
  INFISICAL_TOKEN INFISICAL_UNIVERSAL_AUTH_CLIENT_SECRET
)

if [[ "${1:-}" == --pattern ]]; then
  printf '(%s)' "$(IFS='|'; echo "${forbidden_credentials[*]}")"
  exit 0
fi

for forbidden in "${forbidden_credentials[@]}"; do
  [[ -z "${!forbidden:-}" ]] || {
    echo "privileged credential must not be ambient in the sandbox: $forbidden" >&2
    exit 77
  }
done
