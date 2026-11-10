#!/usr/bin/env bash
# Regression tests for the RustFS archive step of panachat-backup.sh.
# Bug (prod, 2026-09-20): docker0 was missing on a wedged dockerd, so the
# networked `docker run alpine tar …` failed and the script logged
# "RustFS empty/missing — skipped". Daily backups silently lost uploads.
# The archive container must not need a network, and a real failure must
# fail the run instead of being reported as an empty volume.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BACKUP="$SCRIPT_DIR/panachat-backup.sh"

fail() {
  echo "FAIL: $*" >&2
  exit 1
}

tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT

# Fake docker. FAKE_DOCKER_MODE:
#   exec        RustFS container is running; `docker exec` streams the archive
#   no-bridge   RustFS container is down; `docker run` without --network none
#               fails like a missing docker0
#   hang        RustFS container is down; `docker run` never returns (lost exit event)
#   empty       RustFS container is running but the volume has no files
#   broken      RustFS container is down; every `docker run` fails
mkdir -p "$tmp/bin"
cat >"$tmp/bin/docker" <<'EOF'
#!/usr/bin/env bash
archive() { printf 'fake-archive\n'; }
case "$1" in
  inspect)
    if [[ "${!#}" == *-rustfs && "$FAKE_DOCKER_MODE" =~ ^(exec|empty)$ ]]; then echo running; else echo exited; fi
    ;;
  volume) exit 0 ;;
  exec)
    [[ "$FAKE_DOCKER_MODE" == empty ]] && exit 2
    archive
    ;;
  run)
    case "$FAKE_DOCKER_MODE" in
      broken) echo "docker: Error response from daemon: boom" >&2; exit 125 ;;
      hang) sleep 30; exit 0 ;;
    esac
    if [[ " $* " != *" --network none "* ]]; then
      echo "docker: Error response from daemon: adding interface veth0 to bridge docker0 failed: Device does not exist" >&2
      exit 125
    fi
    archive
    ;;
esac
exit 0
EOF
chmod +x "$tmp/bin/docker"

run_backup() {
  local mode="$1" dir="$tmp/$1"
  mkdir -p "$dir/backups" "$dir/data"
  FAKE_DOCKER_MODE="$mode" PATH="$tmp/bin:$PATH" PANACHAT_BACKUP_DOCKER_TIMEOUT=2 \
    PANACHAT_INFRA_ENV_FILE="$dir/none.env" \
    PANACHAT_BACKUP_DIR="$dir/backups" PANACHAT_DATA_DIR="$dir/data" \
    "$BACKUP" --reason manual >"$dir/out.log" 2>&1
}

assert_archived() {
  local f
  f="$(compgen -G "$tmp/$1/backups/panachat-*-manual.rustfs.tar.gz" || true)"
  [[ -n "$f" ]] || fail "$1: RustFS archive missing: $(cat "$tmp/$1/out.log")"
  grep -q fake-archive "$f" || fail "$1: RustFS archive has wrong content"
}

assert_failed_loudly() {
  grep -q 'RustFS archive failed' "$tmp/$1/out.log" || fail "$1: failure must be logged: $(cat "$tmp/$1/out.log")"
  if grep -q 'RustFS empty/missing' "$tmp/$1/out.log"; then
    fail "$1: a docker failure must not be reported as an empty volume"
  fi
  if compgen -G "$tmp/$1/backups/*.rustfs.tar.gz" >/dev/null; then
    fail "$1: a failed archive must not be left behind"
  fi
}

# 1. Running RustFS container: archive via exec, no new container.
run_backup exec || fail "exec path failed: $(cat "$tmp/exec/out.log")"
assert_archived exec
grep -q 'via: docker exec lobe-rustfs' "$tmp/exec/out.log" || fail "exec path should use the RustFS container"

# 2. Missing docker0 must not stop the fallback archive.
run_backup no-bridge || fail "backup failed without docker0: $(cat "$tmp/no-bridge/out.log")"
assert_archived no-bridge

# 3. A genuinely empty volume is still a clean skip.
run_backup empty || fail "empty volume should not fail the backup"
grep -q 'RustFS empty/missing — skipped' "$tmp/empty/out.log" || fail "empty volume should log a skip"

# 4. A docker failure must fail the run, not pretend the volume is empty.
if run_backup broken; then
  fail "backup must exit non-zero when the RustFS archive fails"
fi
assert_failed_loudly broken

# 5. A hung docker run (lost exit event) is killed by the timeout instead of hanging cron.
start=$SECONDS
if run_backup hang; then
  fail "backup must exit non-zero when docker run hangs"
fi
(( SECONDS - start < 20 )) || fail "hung docker run was not bounded by the timeout"
assert_failed_loudly hang

# 6. Retention counts a pre-deploy run once, even with both .sql.gz and .rustfs.tar.gz.
ret="$tmp/retention"
mkdir -p "$ret"
for i in 1 2 3 4 5 6 7; do
  for ext in sql.gz rustfs.tar.gz meta.txt; do
    touch "$ret/panachat-2025010$i-120000-pre-deploy.$ext"
  done
done
PANACHAT_INFRA_ENV_FILE="$ret/none.env" PANACHAT_BACKUP_DIR="$ret" "$BACKUP" --prune-only >/dev/null
kept="$(find "$ret" -name '*.rustfs.tar.gz' | wc -l)"
[[ "$kept" -eq 5 ]] || fail "expected 5 pre-deploy RustFS archives kept, got $kept"
[[ ! -e "$ret/panachat-20250102-120000-pre-deploy.sql.gz" ]] || fail "6th-newest pre-deploy dump should be pruned"

echo "OK: panachat-backup"
