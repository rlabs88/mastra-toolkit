#!/usr/bin/env bash
set -euo pipefail

profile="${1:-}"
expected_image="${2:-}"
probe_root="${3:-}"
[[ $# -ge 1 && $# -le 3 ]] || {
  echo "usage: mastra-toolkit-runtime-probe <profile> [immutable-image] [probe-root]" >&2
  exit 64
}

manifest="$probe_root/etc/mastra-toolkit/runtime-profiles.json"
profile_json="$(node --input-type=module - "$manifest" "$profile" <<'JS'
import { readFileSync } from "node:fs";
const profiles = JSON.parse(readFileSync(process.argv[2], "utf8"));
const profile = profiles[process.argv[3]];
if (!profile) {
  console.error(`unsupported Mastra Toolkit runtime profile: ${process.argv[3]}`);
  process.exit(65);
}
console.log(JSON.stringify({ profile: profile.profile, layers: profile.packageLayers }));
JS
)"

installed_profile="$(cat "$probe_root/etc/mastra-toolkit/runtime-profile")"
[[ "$installed_profile" == "$profile" ]] || {
  echo "runtime image profile mismatch: installed=$installed_profile requested=$profile" >&2
  exit 66
}
if [[ -n "$expected_image" && "${MASTRA_TOOLKIT_RUNTIME_IMAGE:-}" != "$expected_image" ]]; then
  echo "runtime image identity mismatch: installed=${MASTRA_TOOLKIT_RUNTIME_IMAGE:-unset} requested=$expected_image" >&2
  exit 67
fi

source "$probe_root/usr/local/lib/mastra-toolkit/credential-guard.sh"

command -v git >/dev/null
command -v node >/dev/null
command -v tsx >/dev/null
(
  cd /opt/mastra-toolkit/mcode-runtime
  node --input-type=module -e 'await import("@mastra/core/workflows"); await import("esbuild")'
)

if [[ "$profile_json" == *'"operations"'* ]]; then
  docker --version >/dev/null
  docker buildx version >/dev/null
  docker compose version >/dev/null
  infisical --version >/dev/null
  python3 --version >/dev/null
fi

printf '%s\n' "$profile_json"
