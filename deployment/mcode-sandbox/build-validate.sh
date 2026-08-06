#!/usr/bin/env bash
set -Eeuo pipefail

deployment_root="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
repository_root="$(git -C "$deployment_root" rev-parse --show-toplevel)"
source_revision="$(git -C "$repository_root" rev-parse HEAD)"
profile_manifest="$repository_root/packages/sandbox/config/runtime-profiles.json"

[[ -z "$(git -C "$repository_root" status --porcelain --untracked-files=all)" ]] || {
  echo "MCode sandbox provenance requires a clean Git worktree" >&2
  exit 1
}
[[ "$(uname -m)" == arm64 ]] || {
  echo "MCode sandbox validation requires a native ARM64 host" >&2
  exit 1
}
for required in docker git jq python3 rg; do
  command -v "$required" >/dev/null || {
    echo "MCode sandbox validation requires $required" >&2
    exit 1
  }
done
case "$(docker info --format '{{.Architecture}}')" in
  aarch64|arm64) ;;
  *) echo "MCode sandbox validation requires a native ARM64 Docker daemon" >&2; exit 1 ;;
esac
docker buildx version >/dev/null

profiles=()
while IFS= read -r profile; do profiles+=("$profile"); done < <(jq -r 'keys[]' "$profile_manifest")

for profile in "${profiles[@]}"; do
  image="mastra-toolkit/mcode-sandbox:$profile-$source_revision"
  docker buildx build \
    --platform linux/arm64 \
    --file "$deployment_root/Dockerfile" \
    --target "$profile" \
    --build-arg "SOURCE_REVISION=$source_revision" \
    --tag "$image" \
    --load \
    "$repository_root"
  "$deployment_root/verify-image.sh" "$image" "$profile" "$source_revision"
done

printf 'Validated %s MCode sandbox profile images at revision %s\n' "${#profiles[@]}" "$source_revision"
