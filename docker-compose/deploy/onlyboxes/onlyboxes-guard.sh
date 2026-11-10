#!/usr/bin/env bash
# Enforces the limits worker-docker cannot set itself on Onlyboxes containers.
#
#   onlyboxes-guard.sh run     docker-events hardening + periodic sweep (systemd entrypoint)
#   onlyboxes-guard.sh sweep   one sweep, then exit
#
# Per container (on every start, and re-checked each sweep):
#   - swap 0:   docker update --memory-swap = --memory   (worker only passes --memory)
#   - disk I/O: cgroup v2 io.max on the root disk         (scheduler is `none`, so no weights)
# Each sweep:
#   - removes a container whose writable layer exceeds ONLYBOXES_GUARD_MAX_LAYER_BYTES
#   - removes all sandbox containers if / free space drops below ONLYBOXES_GUARD_MIN_FREE_BYTES
#   - re-applies sandbox-firewall.sh if its check fails
#
# Only containers with label onlyboxes.managed=true AND an onlyboxes- name prefix are
# touched. Removal is `docker rm -f` without -v; nothing here prunes anything.
set -uo pipefail

SWEEP_SEC="${ONLYBOXES_GUARD_SWEEP_SEC:-30}"
MAX_LAYER_BYTES="${ONLYBOXES_GUARD_MAX_LAYER_BYTES:-5000000000}"
MIN_FREE_BYTES="${ONLYBOXES_GUARD_MIN_FREE_BYTES:-40000000000}"
IO_LIMITS="${ONLYBOXES_GUARD_IO_LIMITS:-rbps=52428800 wbps=52428800 riops=300 wiops=300}"
FIREWALL="${ONLYBOXES_GUARD_FIREWALL:-/opt/onlyboxes/sandbox-firewall.sh}"
CGROUP_ROOT=/sys/fs/cgroup/system.slice

log() { printf 'onlyboxes-guard: %s\n' "$*" >&2; }

root_disk_dev() {
  if [[ -n "${ONLYBOXES_GUARD_IO_DEVICE:-}" ]]; then
    echo "$ONLYBOXES_GUARD_IO_DEVICE"
    return
  fi
  local source parent
  source="$(findmnt -no SOURCE /)"
  parent="$(lsblk -no PKNAME "$source" | head -1)"
  [[ -n "$parent" ]] || parent="$(basename "$source")"
  cat "/sys/block/$parent/dev"
}
IO_DEV="$(root_disk_dev)"

is_guarded_name() {
  case "$1" in
    onlyboxes-terminal-v1-* | onlyboxes-pythonexec-*) return 0 ;;
    *) return 1 ;;
  esac
}

managed_ids() {
  docker ps -q --no-trunc --filter label=onlyboxes.managed=true
}

remove_container() {
  local id="$1" name="$2" reason="$3"
  is_guarded_name "$name" || return 0
  log "removing $name: $reason"
  docker rm -f "$id" >/dev/null 2>&1 || log "docker rm -f $name failed"
}

harden() {
  local id="$1" info name managed mem swap cg
  info="$(docker inspect -f '{{.Name}}|{{index .Config.Labels "onlyboxes.managed"}}|{{.HostConfig.Memory}}|{{.HostConfig.MemorySwap}}' "$id" 2>/dev/null)" || return 0
  IFS='|' read -r name managed mem swap <<<"$info"
  name="${name#/}"
  [[ "$managed" == "true" ]] && is_guarded_name "$name" || return 0

  if [[ "$mem" -le 0 ]]; then
    remove_container "$id" "$name" "no memory limit set"
    return 0
  fi
  if [[ "$swap" != "$mem" ]]; then
    docker update --memory "$mem" --memory-swap "$mem" "$id" >/dev/null 2>&1 \
      || log "docker update swap failed for $name"
  fi

  cg="$CGROUP_ROOT/docker-$id.scope"
  [[ -d "$cg" ]] || return 0
  if [[ "$(cat "$cg/memory.swap.max" 2>/dev/null)" != "0" ]]; then
    echo 0 >"$cg/memory.swap.max" 2>/dev/null || log "cannot zero memory.swap.max for $name"
  fi
  if ! grep -q "^$IO_DEV " "$cg/io.max" 2>/dev/null; then
    echo "$IO_DEV $IO_LIMITS" >"$cg/io.max" 2>/dev/null || log "cannot set io.max for $name"
  fi
}

# "12.3MB (virtual 3.9GB)" -> bytes of the writable layer (Docker prints SI units).
layer_bytes() {
  awk '{
    s = $1; n = s + 0; u = s; sub(/^[0-9.]+/, "", u)
    m = (u == "kB") ? 1e3 : (u == "MB") ? 1e6 : (u == "GB") ? 1e9 : (u == "TB") ? 1e12 : 1
    printf "%.0f\n", n * m
  }' <<<"$1"
}

sweep() {
  local id name size bytes free

  if [[ -x "$FIREWALL" ]] && ! "$FIREWALL" check >/dev/null 2>&1; then
    log "firewall check failed; re-applying"
    "$FIREWALL" apply || log "firewall re-apply FAILED"
  fi

  for id in $(managed_ids); do
    harden "$id"
  done

  free="$(df --output=avail -B1 / | tail -1 | tr -d ' ')"
  if [[ "$free" -lt "$MIN_FREE_BYTES" ]]; then
    log "free space on / is $free bytes (< $MIN_FREE_BYTES): removing all sandbox containers"
    docker ps --no-trunc --filter label=onlyboxes.managed=true --format '{{.ID}}|{{.Names}}' |
      while IFS='|' read -r id name; do
        remove_container "$id" "$name" "host low on disk"
      done
    return 0
  fi

  docker ps --size --no-trunc --filter label=onlyboxes.managed=true --format '{{.ID}}|{{.Names}}|{{.Size}}' |
    while IFS='|' read -r id name size; do
      bytes="$(layer_bytes "$size")"
      if [[ "$bytes" -gt "$MAX_LAYER_BYTES" ]]; then
        remove_container "$id" "$name" "writable layer $bytes bytes > $MAX_LAYER_BYTES"
      fi
    done
}

run() {
  trap 'kill 0' EXIT
  log "started (io device $IO_DEV, sweep ${SWEEP_SEC}s)"
  (
    while true; do
      sweep
      sleep "$SWEEP_SEC"
    done
  ) &
  docker events \
    --filter type=container \
    --filter event=start \
    --filter label=onlyboxes.managed=true \
    --format '{{.Actor.ID}}' |
    while read -r id; do
      harden "$id"
    done
  log "docker events stream ended"
  exit 1
}

case "${1:-}" in
  run) run ;;
  sweep) sweep ;;
  *)
    echo "usage: $0 run|sweep" >&2
    exit 2
    ;;
esac
