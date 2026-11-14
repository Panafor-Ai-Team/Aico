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
# Bug (prod, 2026-11-08): the control-plane image was pulled only after the
# nginx flip. ghcr timed out, so chat ran the new commit, the admin panel the
# old one, and the infra .env already named the control-plane image that never
# arrived.

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
# the refs listed in $tmp/in-use; `image inspect` succeeds for the refs listed
# in $tmp/present; other `image` calls log their arguments to $tmp/prune and
# fail with FAKE_PRUNE_FAIL=1.
mkdir -p "$tmp/bin"
cat >"$tmp/bin/docker" <<'EOF'
#!/usr/bin/env bash
case "$1" in
  pull)
    n=$(($(cat "$FAKE_DIR/pulls" 2>/dev/null || echo 0) + 1))
    echo "$n" >"$FAKE_DIR/pulls"
    [[ "${FAKE_PULL_HANG:-0}" == 1 ]] && exec sleep 30
    [[ -n "${FAKE_PULL_FAIL_REF:-}" && "$2" == "$FAKE_PULL_FAIL_REF" ]] &&
      { echo "Error response from daemon: dial tcp 192.0.2.1:443: i/o timeout" >&2; exit 1; }
    ((n > ${FAKE_PULL_FAILS:-0})) || { echo "Error response from daemon: net/http: TLS handshake timeout" >&2; exit 1; }
    echo "Status: Downloaded newer image for $2"
    ;;
  cp)
    # `docker cp <svc>:/app/public/<dir>/assets/. <dest>/` — log the source and
    # drop one chunk into <dest>, or fail with FAKE_CP_FAIL=1.
    echo "cp $2" >>"$FAKE_DIR/compose"
    [[ "${FAKE_CP_FAIL:-0}" == 1 ]] && { echo "Error response from daemon: No such container" >&2; exit 1; }
    touch "${3%/}/chunk-from-${2%%:*}.js"
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
    # `image inspect <ref>` succeeds for the refs listed in $tmp/present.
    if [[ "$1" == inspect ]]; then
      grep -qxF "$2" "$FAKE_DIR/present" 2>/dev/null
      exit
    fi
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
  rm -f "$tmp/pulls" "$tmp/rmi" "$tmp/in-use" "$tmp/prune" "$tmp/present"
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

# 3b. A commit-tagged image already on the host (CI shipped it over SSH, or a
#     re-run) is not pulled again: the host may have no route to the registry.
reset_fake
echo "$CP:abc1234" >"$tmp/present"
export FAKE_PULL_FAILS=99
pull_with_retry "$CP:abc1234" >"$tmp/out.log" 2>&1 || fail "a present image must not need the registry: $(cat "$tmp/out.log")"
[[ ! -e "$tmp/pulls" ]] || fail "a present commit-tagged image must not be pulled"
grep -q 'already on this host' "$tmp/out.log" || fail "skipped pull must say so: $(cat "$tmp/out.log")"

# 3c. A moving tag (:canary) is pulled even when present.
reset_fake
echo "$CP:canary" >"$tmp/present"
pull_with_retry "$CP:canary" >"$tmp/out.log" 2>&1 || fail "moving-tag pull should succeed: $(cat "$tmp/out.log")"
[[ "$(cat "$tmp/pulls")" == 1 ]] || fail "a moving tag must be pulled even when present"

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

# 9–11 drive cmd_deploy with the host side effects stubbed out. compose and the
# nginx flip are logged to $tmp/compose with the control-plane ref compose sees.
APP=ghcr.io/panafor-ai-team/panachat
require_env_files() { :; }
assert_db_fingerprint_matches() { :; }
run_backup() { :; }
sync_app_url_to_slot() { :; }
wait_healthy() { :; }
verify_slot_spa() { :; }
set_network_alias() { :; }
clear_network_alias() { :; }
save_db_fingerprint() { :; }
prune_repo_images() { :; }
prune_dangling_images() { :; }
compose_with_profile() { echo "compose $1 ${*: -1} cp=${PANACHAT_CONTROL_PLANE_IMAGE:-}" >>"$tmp/compose"; }
flip_nginx() { echo "flip $1" >>"$tmp/compose"; }
wait_control_plane() { [[ "${FAKE_CP_UNHEALTHY:-0}" != 1 ]]; }

reset_deploy() {
  reset_fake
  unset FAKE_PULL_FAIL_REF FAKE_CP_UNHEALTHY
  rm -rf "$tmp/compose" "$tmp/state"
  printf 'PANACHAT_IMAGE=%s:old\nPANACHAT_CONTROL_PLANE_IMAGE=%s:old\n' "$APP" "$CP" >"$tmp/infra.env"
  cp "$tmp/infra.env" "$tmp/infra.env.before"
  export PANACHAT_CONTROL_PLANE_IMAGE="$CP:new"
}

# Run cmd_deploy as the workflow does: under set -e, in its own process. Never
# call it inside `if`/`&&`/`||`: bash ignores set -e there, also in subshells.
run_deploy() {
  (
    set -e
    cmd_deploy "$APP:new"
  ) >"$tmp/out.log" 2>&1
  rc=$?
}

# 9. A control-plane pull that fails aborts before any slot, nginx or .env change.
reset_deploy
export FAKE_PULL_FAIL_REF="$CP:new"
run_deploy
((rc != 0)) || fail "deploy must fail when the control-plane image cannot be pulled"
[[ ! -e "$tmp/compose" ]] || fail "no slot may start before both images are pulled: $(cat "$tmp/compose")"
cmp -s "$tmp/infra.env" "$tmp/infra.env.before" || fail "infra .env changed by a failed pull: $(cat "$tmp/infra.env")"
[[ ! -e "$tmp/state/deploy.env" ]] || fail "deploy state written by a failed pull"

# 10. The happy path pulls each image once, flips, then runs the new control
#     plane and only then records it in the infra .env.
reset_deploy
run_deploy
((rc == 0)) || fail "deploy should succeed: $(cat "$tmp/out.log")"
[[ "$(cat "$tmp/pulls")" == 2 ]] || fail "expected one pull per image, got $(cat "$tmp/pulls")"
expected="$(printf '%s\n' \
  "compose slot-green panachat-green cp=$CP:new" \
  'cp panachat-blue:/app/public/_spa/assets/.' \
  'cp panachat-blue:/app/public/_spa-auth/assets/.' \
  'cp panachat-blue:/app/public/_spa-workbench/assets/.' \
  'flip green' \
  "compose slot-blue panachat-blue cp=$CP:new" \
  "compose control-plane panachat-control-plane cp=$CP:new")"
[[ "$(cat "$tmp/compose")" == "$expected" ]] || fail "unexpected deploy steps: $(cat "$tmp/compose")"
grep -qxF "PANACHAT_CONTROL_PLANE_IMAGE=$CP:new" "$tmp/infra.env" || fail "healthy control plane not persisted: $(cat "$tmp/infra.env")"
grep -qxF "PANACHAT_IMAGE=$APP:new" "$tmp/infra.env" || fail "app image not persisted: $(cat "$tmp/infra.env")"

# 11. An unhealthy new control plane fails the deploy and is not persisted.
reset_deploy
export FAKE_CP_UNHEALTHY=1
run_deploy
((rc != 0)) || fail "deploy must fail when the new control plane is unhealthy"
grep -qxF "PANACHAT_CONTROL_PLANE_IMAGE=$CP:old" "$tmp/infra.env" ||
  fail "an unhealthy control-plane image must not be persisted: $(cat "$tmp/infra.env")"

# 12. Images CI already shipped to the host deploy with no registry at all.
reset_deploy
printf '%s\n' "$APP:new" "$CP:new" >"$tmp/present"
export FAKE_PULL_FAILS=99
run_deploy
((rc == 0)) || fail "deploy with shipped images must not need the registry: $(cat "$tmp/out.log")"
[[ ! -e "$tmp/pulls" ]] || fail "shipped images must not be pulled: $(cat "$tmp/pulls") pulls"
grep -qxF "PANACHAT_CONTROL_PLANE_IMAGE=$CP:new" "$tmp/infra.env" || fail "shipped control plane not persisted: $(cat "$tmp/infra.env")"

# 13. Bug (prod, 2026-11-10, T-031): every deploy deleted the outgoing build's
#     hashed chunks. A tab opened before the deploy then got 404s on its first
#     lazy import and the chunk-error handler reloaded the page, killing a
#     message the user had just sent. The outgoing slot's chunks are archived
#     before the flip (asserted in 10) and old archive files are pruned.
reset_deploy
archive="$ASSET_ARCHIVE_DIR"
mkdir -p "$archive/_spa/assets"
touch -d '40 days ago' "$archive/_spa/assets/expired-old.js"
touch -d '5 days ago' "$archive/_spa/assets/recent-old.js"
run_deploy
((rc == 0)) || fail "deploy should succeed with the archive step: $(cat "$tmp/out.log")"
for dir in _spa _spa-auth _spa-workbench; do
  [[ -f "$archive/$dir/assets/chunk-from-panachat-blue.js" ]] || fail "outgoing $dir chunks not archived"
done
[[ ! -e "$archive/_spa/assets/expired-old.js" ]] || fail "chunks older than the retention window must be pruned"
[[ -f "$archive/_spa/assets/recent-old.js" ]] || fail "chunks inside the retention window must be kept"

# 14. A failed archive copy is logged and never fails the deploy.
reset_deploy
export FAKE_CP_FAIL=1
run_deploy
unset FAKE_CP_FAIL
((rc == 0)) || fail "an archive failure must not fail the deploy: $(cat "$tmp/out.log")"
grep -q 'flip green' "$tmp/compose" || fail "deploy must still flip when the archive copy fails"

echo "OK: panachat-deploy-remote"
