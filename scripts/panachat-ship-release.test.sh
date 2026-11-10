#!/usr/bin/env bash
# Tests for panachat-ship-release.sh.
# Bug (prod, 2026-11-09): the deploy host could not resolve github.com, so the
# deploy failed at `git fetch origin canary` before it pulled anything; the day
# before, the host could not reach ghcr.io. The ship script sends the commits
# and, when the registry is unreachable, the images over SSH.
#
# Fakes: `ssh` runs the remote command locally with HOME=$tmp/host; `docker`
# keeps host images in $tmp/host-images and logs runner pulls; `curl` answers
# the registry probe with $FAKE_REGISTRY_CODE. git, gzip and timeout are real.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SHIP="$SCRIPT_DIR/panachat-ship-release.sh"

fail() {
  echo "FAIL: $*" >&2
  exit 1
}

tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT
mkdir -p "$tmp/bin" "$tmp/host"

cat >"$tmp/bin/ssh" <<'EOF'
#!/usr/bin/env bash
while (($#)); do
  case "$1" in
    -o | -i) shift 2 ;;
    -*) shift ;;
    *) break ;;
  esac
done
echo "$1" >>"$FAKE_DIR/ssh-targets"
shift
HOME="$FAKE_DIR/host" FAKE_SIDE=host exec bash -c "$*"
EOF

cat >"$tmp/bin/docker" <<'EOF'
#!/usr/bin/env bash
if [[ "${FAKE_SIDE:-runner}" == host ]]; then
  case "$1 ${2:-}" in
    "image inspect") grep -qxF "$3" "$FAKE_DIR/host-images" 2>/dev/null ;;
    "load "*)
      ref="$(sed -n 's/^IMAGE://p')"
      [[ -n "$ref" ]] || exit 1
      echo "$ref" >>"$FAKE_DIR/host-images"
      echo "Loaded image: $ref"
      ;;
    *) echo "unexpected host docker $*" >&2; exit 1 ;;
  esac
  exit
fi
case "$1" in
  pull) echo "$3" >>"$FAKE_DIR/runner-pulls" ;; # docker pull --quiet <ref>
  save) echo "IMAGE:$2" ;;
  *) echo "unexpected runner docker $*" >&2; exit 1 ;;
esac
EOF

cat >"$tmp/bin/curl" <<'EOF'
#!/usr/bin/env bash
printf '%s' "${FAKE_REGISTRY_CODE:-000}"
EOF
chmod +x "$tmp/bin/"*
export PATH="$tmp/bin:$PATH" FAKE_DIR="$tmp"
export GIT_AUTHOR_NAME=test GIT_AUTHOR_EMAIL=test@example.com
export GIT_COMMITTER_NAME=test GIT_COMMITTER_EMAIL=test@example.com

APP=ghcr.io/example-org/panachat:c0ffee12
CP=ghcr.io/example-org/panachat-control-plane:c0ffee12
export DEPLOY_SSH_TARGET=deploy@deploy-host.test IMAGE="$APP" CONTROL_PLANE_IMAGE="$CP"

# Runner repo with three commits; the host checkout is a clone at the first.
git init -q -b canary "$tmp/runner"
for n in 1 2 3; do
  echo "$n" >"$tmp/runner/file"
  git -C "$tmp/runner" add file
  git -C "$tmp/runner" commit -qm "commit $n"
done
first="$(git -C "$tmp/runner" rev-list --max-parents=0 HEAD)"
head="$(git -C "$tmp/runner" rev-parse HEAD)"

reset_host() {
  local dir="$1"
  rm -rf "$tmp/host/"* "$tmp/host-images" "$tmp/runner-pulls" "$tmp/ssh-targets" "$dir"
  git clone -q "$tmp/runner" "$dir"
  git -C "$dir" reset -q --hard "$first"
  unset FAKE_REGISTRY_CODE IMAGE_TRANSFER
}

run_ship() {
  (cd "$tmp/runner" && "$SHIP") >"$tmp/out.log" 2>&1
}

# 1. Default path (~/panachat), registry unreachable: the checkout is
#    fast-forwarded from a bundle and both images are streamed and loaded.
reset_host "$tmp/host/panachat"
unset DEPLOY_PATH
run_ship || fail "ship should succeed: $(cat "$tmp/out.log")"
[[ "$(git -C "$tmp/host/panachat" rev-parse HEAD)" == "$head" ]] ||
  fail "host checkout not fast-forwarded: $(cat "$tmp/out.log")"
[[ ! -e "$tmp/host/panachat/.git/panachat-deploy.bundle" ]] || fail "bundle left on the host"
[[ "$(cat "$tmp/host-images")" == "$(printf '%s\n' "$APP" "$CP")" ]] ||
  fail "images not loaded on the host: $(cat "$tmp/host-images" 2>/dev/null)"
[[ "$(cat "$tmp/runner-pulls")" == "$(printf '%s\n' "$APP" "$CP")" ]] ||
  fail "runner must pull each image once: $(cat "$tmp/runner-pulls")"
grep -q 'Registry probe from the host: HTTP 000' "$tmp/out.log" || fail "probe result must be logged: $(cat "$tmp/out.log")"
grep -qvxF deploy@deploy-host.test "$tmp/ssh-targets" && fail "unexpected ssh target: $(cat "$tmp/ssh-targets")"

# 2. A second run sends nothing: checkout current, images present.
rm -f "$tmp/runner-pulls"
run_ship || fail "re-run should succeed: $(cat "$tmp/out.log")"
grep -q 'Host checkout already at' "$tmp/out.log" || fail "re-run must skip the bundle: $(cat "$tmp/out.log")"
[[ ! -e "$tmp/runner-pulls" ]] || fail "present images must not be pulled again"
grep -q "$CP already on the host" "$tmp/out.log" || fail "present image must be reported: $(cat "$tmp/out.log")"

# 3. Registry reachable (401): the host pulls; nothing is streamed. A custom
#    DEPLOY_PATH with a space is quoted through to the host.
reset_host "$tmp/host/deploy dir"
export DEPLOY_PATH="$tmp/host/deploy dir" FAKE_REGISTRY_CODE=401
run_ship || fail "ship with reachable registry should succeed: $(cat "$tmp/out.log")"
[[ "$(git -C "$tmp/host/deploy dir" rev-parse HEAD)" == "$head" ]] || fail "custom DEPLOY_PATH checkout not updated"
[[ ! -e "$tmp/host-images" && ! -e "$tmp/runner-pulls" ]] || fail "reachable registry must not stream images"
grep -q 'Host pulls the images from the registry' "$tmp/out.log" || fail "registry mode must be logged"

# 4. IMAGE_TRANSFER=ssh forces streaming even with a reachable registry.
reset_host "$tmp/host/deploy dir"
export FAKE_REGISTRY_CODE=401 IMAGE_TRANSFER=ssh
run_ship || fail "forced ssh transfer should succeed: $(cat "$tmp/out.log")"
[[ "$(wc -l <"$tmp/host-images")" == 2 ]] || fail "forced ssh transfer must load both images"

# 5. Host checkout on a commit this repo lacks (local commit): warn, leave the
#    checkout alone, still ship the images.
reset_host "$tmp/host/deploy dir"
echo local >"$tmp/host/deploy dir/file"
git -C "$tmp/host/deploy dir" commit -qam "host-only commit"
host_head="$(git -C "$tmp/host/deploy dir" rev-parse HEAD)"
run_ship || fail "unknown host commit must not fail the ship: $(cat "$tmp/out.log")"
[[ "$(git -C "$tmp/host/deploy dir" rev-parse HEAD)" == "$host_head" ]] || fail "host-only commit must be left alone"
grep -q 'not in this repository' "$tmp/out.log" || fail "unknown host commit must warn: $(cat "$tmp/out.log")"
[[ "$(wc -l <"$tmp/host-images")" == 2 ]] || fail "images must still be shipped"

# 6. Host checkout ahead of the deployed commit (re-run of an older run): no
#    rewind.
reset_host "$tmp/host/deploy dir"
git -C "$tmp/host/deploy dir" reset -q --hard "$head"
(cd "$tmp/runner" && git checkout -q HEAD~1)
run_ship || fail "host ahead must not fail: $(cat "$tmp/out.log")"
(cd "$tmp/runner" && git checkout -q canary)
[[ "$(git -C "$tmp/host/deploy dir" rev-parse HEAD)" == "$head" ]] || fail "host checkout must not be rewound"
grep -q 'already contains' "$tmp/out.log" || fail "host ahead must be reported: $(cat "$tmp/out.log")"

# 7. Local changes on the host block the fast-forward: warn, keep going
#    (the old deploy step's behaviour).
reset_host "$tmp/host/deploy dir"
echo dirty >"$tmp/host/deploy dir/file"
run_ship || fail "dirty host checkout must not fail the ship: $(cat "$tmp/out.log")"
grep -q 'could not fast-forward' "$tmp/out.log" || fail "blocked fast-forward must warn: $(cat "$tmp/out.log")"

# 8. A load that does not produce the image fails the ship.
reset_host "$tmp/host/deploy dir"
cat >"$tmp/bin/gzip" <<'EOF'
#!/usr/bin/env bash
cat >/dev/null
printf 'garbage' | /usr/bin/env -i PATH=/usr/bin:/bin gzip
EOF
chmod +x "$tmp/bin/gzip"
if run_ship; then
  fail "a failed docker load must fail the ship"
fi
grep -q "streaming $APP to the host failed" "$tmp/out.log" || fail "failed stream must say so: $(cat "$tmp/out.log")"
rm -f "$tmp/bin/gzip"

# 9. An unknown IMAGE_TRANSFER is refused.
export IMAGE_TRANSFER=carrier-pigeon
if run_ship; then
  fail "unknown IMAGE_TRANSFER must be refused"
fi
grep -q 'IMAGE_TRANSFER must be auto, ssh or registry' "$tmp/out.log" || fail "refusal must say why"

echo "OK: panachat-ship-release"
