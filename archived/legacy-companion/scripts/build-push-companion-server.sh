#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PLATFORM_ENV="$ROOT_DIR/platform/.env"
DOCKERFILE="$ROOT_DIR/platform/docker/Dockerfile.fly-managed"

TAG="${1:-latest}"
IMAGE_REPO="${IMAGE_REPO:-docker.io/stangirard/the-companion-server}"
BASE_IMAGE="${BASE_IMAGE:-docker.io/stangirard/the-companion:latest}"
PLATFORMS="${PLATFORMS:-linux/amd64,linux/arm64}"
COMPANION_SOURCE="${COMPANION_SOURCE:-local}"
COMPANION_NPM_VERSION="${COMPANION_NPM_VERSION:-latest}"
FULL_IMAGE="${IMAGE_REPO}:${TAG}"

if ! command -v docker >/dev/null 2>&1; then
  echo "[build-push] docker command not found" >&2
  exit 1
fi

# Load platform env if present so DOCKERHUB_TOKEN/DOCKERHUB_USERNAME can be reused.
if [ -f "$PLATFORM_ENV" ]; then
  # shellcheck disable=SC1090
  set -a; source "$PLATFORM_ENV"; set +a
fi

DOCKERHUB_USERNAME="${DOCKERHUB_USERNAME:-stangirard}"
DOCKERHUB_TOKEN="${DOCKERHUB_TOKEN:-}"

if [ -n "$DOCKERHUB_TOKEN" ]; then
  echo "$DOCKERHUB_TOKEN" | docker login -u "$DOCKERHUB_USERNAME" --password-stdin >/dev/null
  echo "[build-push] docker login ok for $DOCKERHUB_USERNAME"
else
  echo "[build-push] DOCKERHUB_TOKEN not set; using existing docker auth session"
fi

echo "[build-push] Building+Pushing $FULL_IMAGE for platforms: $PLATFORMS"
echo "[build-push] Source mode: $COMPANION_SOURCE (npm version: $COMPANION_NPM_VERSION)"
docker buildx build \
  --platform "$PLATFORMS" \
  -f "$DOCKERFILE" \
  --build-arg "BASE_IMAGE=$BASE_IMAGE" \
  --build-arg "COMPANION_SOURCE=$COMPANION_SOURCE" \
  --build-arg "COMPANION_NPM_VERSION=$COMPANION_NPM_VERSION" \
  -t "$FULL_IMAGE" \
  --push \
  "$ROOT_DIR"

echo "[build-push] Done: $FULL_IMAGE"
