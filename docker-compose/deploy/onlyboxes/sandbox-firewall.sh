#!/usr/bin/env bash
# Network isolation for Onlyboxes sandbox containers.
#
#   sandbox-firewall.sh apply    create/verify the sandbox network, (re)build rules and shaping
#   sandbox-firewall.sh check    exit 0 only if network, rules and jumps are all in place
#   sandbox-firewall.sh remove   drop rules (refused while sandbox containers exist)
#   sandbox-firewall.sh status   print the current rules
#
# Model:
#   FORWARD (DOCKER-USER -> ONLYBOXES-FWD): sandbox -> any private/link-local range
#     is dropped. Docker-published ports are DNATed to 172.x before FORWARD, so this
#     also covers Postgres/Redis/Stalwart/rustfs and the console. Outbound SMTP dropped.
#   INPUT (-i br-onlyboxes -> ONLYBOXES-IN): sandbox -> host itself only on 80/443
#     (host nginx: s3 skill zips, the app). SSH and everything else dropped.
#   tc on br-onlyboxes: download to sandboxes and upload from sandboxes are rate-capped.
set -euo pipefail

NETWORK="${ONLYBOXES_SANDBOX_NETWORK:-onlyboxes-sandbox}"
BRIDGE="${ONLYBOXES_SANDBOX_BRIDGE:-br-onlyboxes}"
SUBNET="${ONLYBOXES_SANDBOX_SUBNET:-172.20.0.0/16}"
DOWNLOAD_RATE="${ONLYBOXES_SANDBOX_DOWNLOAD_RATE:-40mbit}"
UPLOAD_RATE="${ONLYBOXES_SANDBOX_UPLOAD_RATE:-20mbit}"
FWD_CHAIN=ONLYBOXES-FWD
IN_CHAIN=ONLYBOXES-IN
BLOCKED_NETS=(172.16.0.0/12 10.0.0.0/8 192.168.0.0/16 100.64.0.0/10 169.254.0.0/16 127.0.0.0/8)

log() { printf 'sandbox-firewall: %s\n' "$*" >&2; }

ensure_network() {
  if ! docker network inspect "$NETWORK" >/dev/null 2>&1; then
    log "creating docker network $NETWORK ($SUBNET, bridge $BRIDGE, ICC off)"
    docker network create \
      --driver bridge \
      --subnet "$SUBNET" \
      --opt "com.docker.network.bridge.name=$BRIDGE" \
      --opt com.docker.network.bridge.enable_icc=false \
      --label aico.role=onlyboxes-sandbox \
      "$NETWORK" >/dev/null
  fi

  local actual
  actual="$(docker network inspect "$NETWORK" -f '{{.Driver}}|{{(index .IPAM.Config 0).Subnet}}|{{index .Options "com.docker.network.bridge.name"}}|{{index .Options "com.docker.network.bridge.enable_icc"}}')"
  if [[ "$actual" != "bridge|$SUBNET|$BRIDGE|false" ]]; then
    log "network $NETWORK has unexpected settings: $actual"
    return 1
  fi
}

ensure_jump() {
  local chain="$1"
  shift
  iptables -C "$chain" "$@" 2>/dev/null || iptables -I "$chain" 1 "$@"
}

build_chains() {
  iptables -N "$FWD_CHAIN" 2>/dev/null || true
  iptables -F "$FWD_CHAIN"
  iptables -A "$FWD_CHAIN" -m conntrack --ctstate RELATED,ESTABLISHED -j RETURN
  local net
  for net in "${BLOCKED_NETS[@]}"; do
    iptables -A "$FWD_CHAIN" -d "$net" -j DROP
  done
  iptables -A "$FWD_CHAIN" -p tcp -m multiport --dports 25,465,587 -j DROP
  iptables -A "$FWD_CHAIN" -j RETURN

  iptables -N "$IN_CHAIN" 2>/dev/null || true
  iptables -F "$IN_CHAIN"
  iptables -A "$IN_CHAIN" -m conntrack --ctstate RELATED,ESTABLISHED -j ACCEPT
  iptables -A "$IN_CHAIN" -p tcp -m multiport --dports 80,443 -j ACCEPT
  iptables -A "$IN_CHAIN" -j DROP

  # DOCKER-USER is created by dockerd and kept across its restarts.
  ensure_jump DOCKER-USER -s "$SUBNET" -j "$FWD_CHAIN"
  # Position 1, ahead of ufw's chains, which would otherwise allow SSH.
  ensure_jump INPUT -i "$BRIDGE" -j "$IN_CHAIN"
}

apply_shaping() {
  tc qdisc replace dev "$BRIDGE" root tbf rate "$DOWNLOAD_RATE" burst 256kb latency 400ms
  tc qdisc replace dev "$BRIDGE" handle ffff: ingress
  tc filter replace dev "$BRIDGE" parent ffff: protocol all prio 1 u32 match u32 0 0 \
    police rate "$UPLOAD_RATE" burst 256k drop flowid :1
}

check() {
  ensure_network || return 1
  iptables -C DOCKER-USER -s "$SUBNET" -j "$FWD_CHAIN" 2>/dev/null || { log "missing DOCKER-USER jump"; return 1; }
  iptables -C INPUT -i "$BRIDGE" -j "$IN_CHAIN" 2>/dev/null || { log "missing INPUT jump"; return 1; }
  [[ "$(iptables -S INPUT 2>/dev/null | sed -n '2p')" == "-A INPUT -i $BRIDGE -j $IN_CHAIN" ]] \
    || { log "INPUT jump is not the first rule"; return 1; }
  [[ "$(iptables -S "$FWD_CHAIN" | grep -c -- '-j DROP')" -eq $((${#BLOCKED_NETS[@]} + 1)) ]] \
    || { log "$FWD_CHAIN rules incomplete"; return 1; }
  iptables -S "$IN_CHAIN" | grep -q -- '-A ONLYBOXES-IN -j DROP' || { log "$IN_CHAIN rules incomplete"; return 1; }
  tc qdisc show dev "$BRIDGE" | grep -q '^qdisc tbf' || { log "missing tc shaping"; return 1; }
}

apply() {
  ensure_network
  build_chains
  # A stale non-first INPUT jump (e.g. after `ufw reload` reordering) is moved to the top.
  if [[ "$(iptables -S INPUT | sed -n '2p')" != "-A INPUT -i $BRIDGE -j $IN_CHAIN" ]]; then
    while iptables -D INPUT -i "$BRIDGE" -j "$IN_CHAIN" 2>/dev/null; do :; done
    iptables -I INPUT 1 -i "$BRIDGE" -j "$IN_CHAIN"
  fi
  apply_shaping
  check
  log "applied"
}

remove() {
  if [[ -n "$(docker ps -aq --filter label=onlyboxes.managed=true)" ]]; then
    log "refusing: onlyboxes containers still exist; stop the worker and remove them first"
    return 1
  fi
  while iptables -D DOCKER-USER -s "$SUBNET" -j "$FWD_CHAIN" 2>/dev/null; do :; done
  while iptables -D INPUT -i "$BRIDGE" -j "$IN_CHAIN" 2>/dev/null; do :; done
  iptables -F "$FWD_CHAIN" 2>/dev/null && iptables -X "$FWD_CHAIN" || true
  iptables -F "$IN_CHAIN" 2>/dev/null && iptables -X "$IN_CHAIN" || true
  tc qdisc del dev "$BRIDGE" root 2>/dev/null || true
  tc qdisc del dev "$BRIDGE" ingress 2>/dev/null || true
  log "removed (the $NETWORK docker network is kept)"
}

status() {
  iptables -S DOCKER-USER
  iptables -S INPUT | head -5
  iptables -S "$FWD_CHAIN" 2>/dev/null || true
  iptables -S "$IN_CHAIN" 2>/dev/null || true
  tc qdisc show dev "$BRIDGE" 2>/dev/null || true
}

case "${1:-}" in
  apply) apply ;;
  check) check ;;
  remove) remove ;;
  status) status ;;
  *)
    echo "usage: $0 apply|check|remove|status" >&2
    exit 2
    ;;
esac
