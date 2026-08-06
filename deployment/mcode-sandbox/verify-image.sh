#!/usr/bin/env bash
set -Eeuo pipefail

image="${1:?usage: verify-image.sh <local-image> <profile> <source-revision>}"
profile="${2:?usage: verify-image.sh <local-image> <profile> <source-revision>}"
source_revision="${3:?usage: verify-image.sh <local-image> <profile> <source-revision>}"
[[ "$source_revision" =~ ^[a-f0-9]{40}$ ]] || {
  echo "source revision must be a full Git commit" >&2
  exit 64
}

deployment_root="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
suffix="$(date +%s)-$$"
abi_probe_container="mcode-abi-probe-$suffix"
runtime_container="mcode-runtime-$suffix"
probe_container="mcode-profile-probe-$suffix"
workflow_container="mcode-workflow-probe-$suffix"

cleanup() {
  docker rm -f "$abi_probe_container" "$runtime_container" "$probe_container" "$workflow_container" >/dev/null 2>&1 || true
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

run_bounded() {
  local seconds="$1"
  shift
  python3 - "$seconds" "$@" <<'PY'
import subprocess
import sys

try:
    completed = subprocess.run(sys.argv[2:], timeout=int(sys.argv[1]), check=False)
except subprocess.TimeoutExpired:
    print(f"timed out after {sys.argv[1]}s: {sys.argv[2]}", file=sys.stderr)
    raise SystemExit(124)
raise SystemExit(completed.returncode)
PY
}

architecture="$(run_bounded 20 docker image inspect "$image" --format '{{.Architecture}}')"
[[ "$architecture" == arm64 ]] || { echo "MCode sandbox must be linux/arm64" >&2; exit 1; }

labels="$(run_bounded 20 docker image inspect "$image" --format '{{json .Config.Labels}}')"
jq -e --arg profile "$profile" --arg revision "$source_revision" '
  ."io.rlabs.mastra-toolkit.runtime-profile" == $profile and
  ."org.opencontainers.image.source" == "https://github.com/rlabs88/mastra-toolkit" and
  ."org.opencontainers.image.revision" == $revision
' <<< "$labels" >/dev/null

run_bounded 60 docker run --rm --name "$abi_probe_container" "$image" probe >/dev/null
run_bounded 60 docker run --detach --name "$runtime_container" "$image" serve >/dev/null
run_bounded 30 docker exec "$runtime_container" \
  /usr/local/bin/mastra-toolkit-runtime-probe "$profile" >/dev/null
run_bounded 180 docker run --rm --name "$probe_container" \
  --entrypoint /usr/local/bin/mastra-toolkit-runtime-probe \
  "$image" "$profile" >/dev/null

workflow_smoke='import { createStep, createWorkflow } from "@mastra/core/workflows";
import { z } from "zod";
const step = createStep({
  id: "runtime-smoke-step",
  inputSchema: z.object({ value: z.string() }),
  outputSchema: z.object({ value: z.string() }),
  execute: async ({ inputData }) => ({ value: inputData.value + "-verified" }),
});
const workflow = createWorkflow({
  id: "runtime-smoke",
  inputSchema: z.object({ value: z.string() }),
  outputSchema: z.object({ value: z.string() }),
}).then(step).commit();
const run = await workflow.createRun();
const result = await run.start({ inputData: { value: "mcode" } });
if (result.status !== "success" || result.result.value !== "mcode-verified") process.exit(1);'
run_bounded 180 docker run --rm --name "$workflow_container" \
  --workdir /opt/mastra-toolkit/mcode-runtime --entrypoint tsx \
  "$image" --eval "$workflow_smoke" >/dev/null

credential_pattern="$("$deployment_root/credential-guard.sh" --pattern)="
history="$(run_bounded 30 docker history --no-trunc "$image")"
if rg -i "$credential_pattern" <<< "$history" >/dev/null; then
  echo "credential-shaped material found in image history" >&2
  exit 1
fi
config="$(run_bounded 20 docker image inspect "$image" --format '{{json .Config}}')"
if rg -i "$credential_pattern" <<< "$config" >/dev/null; then
  echo "credential-shaped material found in image config" >&2
  exit 1
fi

echo "MCode sandbox image validation passed for $profile at $source_revision"
