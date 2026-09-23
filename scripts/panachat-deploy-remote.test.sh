#!/usr/bin/env bash
# Regression tests for panachat-deploy-remote.sh image handling.
# Bugs (prod, 2026-09-23):
#   - A stalled `docker pull` from ghcr had no limit, so the SSH step's 10-minute
#     timeout killed the deploy mid-script (#413, #415).
#   - Sourcing the infra .env replaced the control-plane ref the workflow
#     exported with the moving :canary tag, so the admin panel never ran the
#     image built from the deployed commit.
#   - Control-plane images (~9.5 GB each) were never pruned.
#   - Untagged images (left when a tag moved) are invisible to
#     `docker images <repo>` on the containerd store, so 11 of them piled up.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DEPLOY="$SCRIPT_DIR/panachat-deploy-remote.sh"

fail() {
  echo "FAIL: $*" >&2
  exit 1
}

tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT

# Fake docker. `pull` fails FAKE_PULL_FAILS times (or hangs with
# FAKE_PULL_HANG=1), then succeeds; attempts are counted in $tmp/pulls.
# `images` prints $tmp/images; `rmi` logs its argument to $tmp/rmi and refuses
# the refs listed in $tmp/in-use; `image` logs its arguments to $tmp/prune and
# fails with FAKE_PRUNE_FAIL=1.
mkdir -p "$tmp/bin"
cat >"$tmp/bin/docker" <<'EOF'
#!/usr/bin/env bash
case "$1" in
  pull)
    n=$(($(cat "$FAKE_DIR/pulls" 2>/dev/null || echo 0) + 1))
    echo "$n" >"$FAKE_DIR/pulls"
    [[ "${FAKE_PULL_HANG:-0}" == 1 ]] && exec sleep 30
    ((n > ${FAKE_PULL_FAILS:-0})) || { echo "Error response from daemon: net/http: TLS handshake timeout" >&2; exit 1; }
    echo "Status: Downloaded newer image for $2"
    ;;
  images) cat "$FAKE_DIR/images" ;;
  rmi)
    if grep -qxF "$2" "$FAKE_DIR/in-use" 2>/dev/null; then
      echo "Error response from daemon: conflict: unable to remove repository reference \"$2\"" >&2
      exit 1
    fi
    echo "$2" >>"$FAKE_DIR/rmi"
    ;;
  image)
    shift
    echo "$*" >>"$FAKE_DIR/prune"
    [[ "${FAKE_PRUNE_FAIL:-0}" == 1 ]] && { echo "Error response from daemon: a prune operation is already running" >&2; exit 1; }
    printf 'Deleted Images:\ndeleted: sha256:5949dcdc4726\n\nTotal reclaimed space: 9.57GB\n'
    ;;
esac
EOF
chmod +x "$tmp/bin/docker"
export PATH="$tmp/bin:$PATH" FAKE_DIR="$tmp"

# `main` must still run when the script is executed rather than sourced.
"$DEPLOY" help | grep -q 'Panachat blue-green remote deploy' || fail "executing the script must run main"

CP=ghcr.io/panafor-ai-team/panachat-control-plane
export PANACHAT_INFRA_ENV_FILE="$tmp/infra.env" PANACHAT_STATE_DIR="$tmp/state"
export PANACHAT_PULL_BACKOFF_SEC=0 PANACHAT_PULL_TIMEOUT_SEC=2
# shellcheck source-path=SCRIPTDIR source=panachat-deploy-remote.sh
source "$DEPLOY"
set +e

reset_fake() {
  rm -f "$tmp/pulls" "$tmp/rmi" "$tmp/in-use" "$tmp/prune"
  unset FAKE_PULL_FAILS FAKE_PULL_HANG FAKE_PRUNE_FAIL
}

# 1. Transient pull failures are retried.
reset_fake
export FAKE_PULL_FAILS=2
pull_with_retry "$CP:abc1234" >"$tmp/out.log" 2>&1 || fail "pull should succeed on the 3rd attempt: $(cat "$tmp/out.log")"
[[ "$(cat "$tmp/pulls")" == 3 ]] || fail "expected 3 pull attempts, got $(cat "$tmp/pulls")"

# 2. A registry that keeps failing fails the deploy after PULL_ATTEMPTS.
reset_fake
export FAKE_PULL_FAILS=99
if pull_with_retry "$CP:abc1234" >"$tmp/out.log" 2>&1; then
  fail "pull must fail after exhausting attempts"
fi
[[ "$(cat "$tmp/pulls")" == 3 ]] || fail "expected 3 pull attempts before giving up, got $(cat "$tmp/pulls")"
grep -q 'failed after 3 attempts' "$tmp/out.log" || fail "exhausted pull must say so: $(cat "$tmp/out.log")"

# 3. A stalled pull is killed by the per-attempt limit instead of hanging.
reset_fake
export FAKE_PULL_HANG=1
start=$SECONDS
if pull_with_retry "$CP:abc1234" >"$tmp/out.log" 2>&1; then
  fail "a hung pull must fail"
fi
((SECONDS - start < 20)) || fail "hung pull was not bounded by PANACHAT_PULL_TIMEOUT_SEC"

# 4. The control-plane ref exported by the workflow wins over the infra .env…
printf 'PANACHAT_CONTROL_PLANE_IMAGE=%s:canary\nPANACHAT_PORT_BLUE=3210\n' "$CP" >"$tmp/infra.env"
export PANACHAT_CONTROL_PLANE_IMAGE="$CP:abc1234"
load_infra_defaults
[[ "$PANACHAT_CONTROL_PLANE_IMAGE" == "$CP:abc1234" ]] ||
  fail "infra .env overrode the exported control-plane image: $PANACHAT_CONTROL_PLANE_IMAGE"

# …and an empty export (control-plane build failed) keeps the persisted one.
export PANACHAT_CONTROL_PLANE_IMAGE=""
load_infra_defaults
[[ "$PANACHAT_CONTROL_PLANE_IMAGE" == "$CP:canary" ]] ||
  fail "empty export should fall back to the infra .env: $PANACHAT_CONTROL_PLANE_IMAGE"

# 5. Pruning keeps the newest N distinct images, removes older ones by tag (by
#    ID when untagged), and tolerates an image a container still uses.
reset_fake
cat >"$tmp/images" <<EOF
aaaaaaaaaaaa $CP:new1
bbbbbbbbbbbb $CP:canary
bbbbbbbbbbbb $CP:old2
cccccccccccc $CP:old3
dddddddddddd $CP:<none>
eeeeeeeeeeee $CP:old5
EOF
echo "$CP:old5" >"$tmp/in-use"
prune_repo_images "$CP:new1" 2 >"$tmp/out.log" 2>&1 || fail "prune must not fail: $(cat "$tmp/out.log")"
expected="$(printf '%s\n' "$CP:old3" dddddddddddd)"
[[ "$(cat "$tmp/rmi")" == "$expected" ]] || fail "unexpected removals: $(cat "$tmp/rmi")"

# 6. Nothing to prune is a no-op.
reset_fake
printf 'aaaaaaaaaaaa %s:new1\n' "$CP" >"$tmp/images"
prune_repo_images "$CP:new1" 2 >/dev/null 2>&1 || fail "prune with nothing stale must succeed"
[[ ! -e "$tmp/rmi" ]] || fail "nothing should be removed: $(cat "$tmp/rmi")"

# 7. Untagged images are pruned by our title label only: dangling-only prune
#    (no -a), one per image CI builds.
reset_fake
prune_dangling_images >"$tmp/out.log" 2>&1 || fail "dangling prune must not fail: $(cat "$tmp/out.log")"
expected="$(printf '%s\n' \
  'prune -f --filter label=org.opencontainers.image.title=panachat' \
  'prune -f --filter label=org.opencontainers.image.title=panachat-control-plane')"
[[ "$(cat "$tmp/prune")" == "$expected" ]] || fail "unexpected prune calls: $(cat "$tmp/prune")"
grep -q 'Untagged panachat-control-plane images: Total reclaimed space: 9.57GB' "$tmp/out.log" ||
  fail "prune must log the reclaimed space: $(cat "$tmp/out.log")"

# 8. A failed prune is reported but never fails the (already flipped) deploy.
reset_fake
export FAKE_PRUNE_FAIL=1
prune_dangling_images >"$tmp/out.log" 2>&1 || fail "a failed prune must not fail the deploy"
grep -q 'Pruning untagged panachat images failed (ignored): .*already running' "$tmp/out.log" ||
  fail "a failed prune must say so: $(cat "$tmp/out.log")"

echo "OK: panachat-deploy-remote"
