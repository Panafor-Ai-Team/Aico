#!/usr/bin/env bash
# Runs on the CI runner before the SSH deploy. Brings the deploy host up to the
# commit being deployed without the host contacting GitHub:
#
#   1. Deploy scripts: the host's checkout is fast-forwarded from a git bundle
#      sent over SSH (the host used to `git fetch` from github.com).
#   2. Images: when the host cannot reach ghcr.io, the runner pulls the images
#      and streams them over SSH (`docker save | docker load`). When it can, the
#      host pulls them itself, which only transfers the layers that changed.
#
# Why (prod, 2026-11-08/09): the host could not reach ghcr.io (connect timeout),
# then could not resolve github.com at all, so two deploys failed at
# `git fetch` before touching anything.
#
# Usage: scripts/panachat-ship-release.sh
#
# Env:
#   DEPLOY_SSH_TARGET   user@host (required)
#   DEPLOY_SSH_KEY_FILE private key for the host (optional; ssh defaults otherwise)
#   DEPLOY_PATH         repo root on the host (default: ~/panachat on the host)
#   IMAGE               chat image ref (required)
#   CONTROL_PLANE_IMAGE control-plane image ref (optional)
#   IMAGE_TRANSFER      auto (default) | ssh | registry
#   SHIP_TIMEOUT_SEC    limit for streaming one image (default 2700)

set -euo pipefail

: "${DEPLOY_SSH_TARGET:?DEPLOY_SSH_TARGET is required}"
: "${IMAGE:?IMAGE is required}"
IMAGE_TRANSFER="${IMAGE_TRANSFER:-auto}"
SHIP_TIMEOUT="${SHIP_TIMEOUT_SEC:-2700}"

log() { printf '==> [ship] %s\n' "$*"; }
warn() { printf 'WARN: [ship] %s\n' "$*" >&2; }
err() { printf 'Error: [ship] %s\n' "$*" >&2; }

case "$IMAGE_TRANSFER" in
  auto | ssh | registry) ;;
  *)
    err "IMAGE_TRANSFER must be auto, ssh or registry (got: $IMAGE_TRANSFER)"
    exit 1
    ;;
esac

SSH_OPTS=(-o BatchMode=yes -o ServerAliveInterval=30 -o ServerAliveCountMax=6)
if [[ -n "${DEPLOY_SSH_KEY_FILE:-}" ]]; then
  SSH_OPTS+=(-i "$DEPLOY_SSH_KEY_FILE" -o IdentitiesOnly=yes)
fi

# Every remote command starts in the deploy checkout. The path travels quoted;
# an empty DEPLOY_PATH resolves to ~/panachat on the host, as the deploy step does.
REMOTE_CD="DEPLOY_PATH=$(printf '%q' "${DEPLOY_PATH:-}"); cd \"\${DEPLOY_PATH:-\$HOME/panachat}\""

remote() {
  ssh "${SSH_OPTS[@]}" "$DEPLOY_SSH_TARGET" "$REMOTE_CD && $1"
}

# --- 1. Deploy scripts -----------------------------------------------------

ship_checkout() {
  local head base
  head="$(git rev-parse HEAD)"
  base="$(remote 'git rev-parse HEAD')" || {
    err "cannot read the host checkout's HEAD"
    return 1
  }

  if [[ "$base" == "$head" ]]; then
    log "Host checkout already at ${head:0:10}"
    return 0
  fi
  if ! git cat-file -e "${base}^{commit}" 2>/dev/null; then
    # Same outcome the old `git merge --ff-only` failure had: deploy with the
    # scripts already on the host.
    warn "host checkout ${base:0:10} is not in this repository's history (local commits?); deploying with the scripts already on the host"
    return 0
  fi
  if git merge-base --is-ancestor "$head" "$base"; then
    log "Host checkout ${base:0:10} already contains ${head:0:10}"
    return 0
  fi

  log "Sending commits ${base:0:10}..${head:0:10} to the host checkout"
  # The bundle needs only $base on the host, which it has (it is its HEAD).
  git bundle create - "${base}..HEAD" |
    remote 'bundle=.git/panachat-deploy.bundle
      cat >"$bundle"
      git fetch --quiet "$bundle" HEAD; rc=$?
      if [ "$rc" -eq 0 ]; then
        git merge --ff-only FETCH_HEAD ||
          echo "WARN: could not fast-forward (local changes?); deploying with existing scripts" >&2
      fi
      rm -f "$bundle"
      exit "$rc"'
  log "Host checkout now at $(remote 'git rev-parse --short HEAD')"
}

# --- 2. Images ---------------------------------------------------------------

host_has_image() {
  remote "docker image inspect $(printf '%q' "$1") >/dev/null 2>&1"
}

# HTTP 401 from /v2/ means the registry answered (it wants a token). A DNS
# failure or connect timeout gives curl's 000.
host_reaches_registry() {
  local code
  code="$(remote "curl -sS -o /dev/null -w '%{http_code}' --max-time 15 https://ghcr.io/v2/ 2>/dev/null || true")" || code=000
  log "Registry probe from the host: HTTP ${code:-000}"
  [[ "$code" == 401 || "$code" == 200 ]]
}

ship_image() {
  local ref="$1"
  if host_has_image "$ref"; then
    log "$ref already on the host"
    return 0
  fi
  log "Pulling $ref on the runner"
  docker pull --quiet "$ref" >/dev/null
  log "Streaming $ref to the host (limit ${SHIP_TIMEOUT}s)"
  local start=$SECONDS
  timeout -k 30 "$SHIP_TIMEOUT" bash -c '
    set -euo pipefail
    docker save "$1" | gzip -1 | ssh "${@:3}" "$2" "gunzip | docker load"
  ' _ "$ref" "$DEPLOY_SSH_TARGET" "${SSH_OPTS[@]}" || {
    err "streaming $ref to the host failed after $((SECONDS - start))s"
    return 1
  }
  host_has_image "$ref" || {
    err "$ref is still missing on the host after docker load"
    return 1
  }
  log "$ref loaded on the host in $((SECONDS - start))s"
}

ship_images() {
  local mode="$IMAGE_TRANSFER"
  if [[ "$mode" == auto ]]; then
    if host_reaches_registry; then
      mode=registry
    else
      mode=ssh
    fi
  fi
  if [[ "$mode" == registry ]]; then
    log "Host pulls the images from the registry"
    return 0
  fi
  ship_image "$IMAGE"
  if [[ -n "${CONTROL_PLANE_IMAGE:-}" ]]; then
    ship_image "$CONTROL_PLANE_IMAGE"
  fi
}

main() {
  ship_checkout
  ship_images
}

# Sourced by scripts/panachat-ship-release.test.sh for its functions.
if [[ "${BASH_SOURCE[0]}" == "$0" ]]; then
  main "$@"
fi
