#!/usr/bin/env bash
# Load / isolation test for the Onlyboxes sandbox (docker-compose/deploy/ONLYBOXES-SANDBOX.md).
# Runs ON the server, against the console on loopback, before the app is switched over.
#
#   onlyboxes-loadtest.sh <scenario> [out-dir]
#   scenarios: cpu oom work cap fork parallel outbomb disk net all
#
# Auth: mints obx_jit_v1 tokens exactly like the app (apps/server/src/services/sandbox/
# providers/onlyboxes.ts createJITToken) for synthetic subjects loadtest-1..6 under a
# dedicated issuer, so no real user account is touched. Sessions use a 300 s lease and
# expire on their own (lease expiry is a hard stop, so it must outlast every command).
set -euo pipefail

SCENARIO="${1:-}"
OUT="${2:-/var/tmp/onlyboxes-loadtest-$(date +%Y%m%d-%H%M%S)}"
CONSOLE="${ONLYBOXES_CONSOLE_URL:-http://127.0.0.1:8089}"
ENV_FILE="${ONLYBOXES_ENV_FILE:-/opt/onlyboxes/.env}"
ISSUER="${ONLYBOXES_LOADTEST_ISSUER:-aico-loadtest}"
APP_URL="${ONLYBOXES_LOADTEST_APP_URL:-https://chat.panafor.com/}"
SESSIONS="${ONLYBOXES_LOADTEST_SESSIONS:-5}"
# Public IPv4 of this host, for the host-port probes in `net`.
HOST_IP="${ONLYBOXES_LOADTEST_HOST_IP:-$(ip -4 route get 1.1.1.1 | awk '{for (i = 1; i < NF; i++) if ($i == "src") print $(i + 1)}')}"
LEASE=300

KEY="$(sed -n 's/^CONSOLE_JIT_SIGNING_KEY=//p' "$ENV_FILE")"
[[ -n "$KEY" ]] || { echo "CONSOLE_JIT_SIGNING_KEY not found in $ENV_FILE" >&2; exit 1; }
mkdir -p "$OUT"

b64url() { openssl base64 -A | tr '+/' '-_' | tr -d '='; }

mint() {
  local sub="$1" exp payload signed sig
  exp=$(($(date +%s%3N) + 1800000))
  payload="$(printf '{"exp":%s,"iss":"%s","sub":"%s"}' "$exp" "$ISSUER" "$sub" | b64url)"
  signed="obx_jit_v1.$payload"
  sig="$(printf '%s' "$signed" | openssl dgst -sha256 -hmac "$KEY" -binary | b64url)"
  printf '%s.%s' "$signed" "$sig"
}

# term <n> <command> [timeout_ms] -> prints "<http> <exit_code> <seconds>"; body in $OUT/last-<n>.json
term() {
  local n="$1" cmd="$2" timeout="${3:-120000}" body code t0 t1
  body="$(jq -nc --arg c "$cmd" --arg s "loadtest-session-$n" --argjson t "$timeout" --argjson l "$LEASE" \
    '{command:$c, session_id:$s, create_if_missing:true, lease_ttl_sec:$l, timeout_ms:$t}')"
  t0=$(date +%s.%N)
  code="$(curl -s -o "$OUT/last-$n.json" -w '%{http_code}' -m $((timeout / 1000 + 30)) \
    -H "Authorization: Bearer $(mint "loadtest-$n")" -H 'Content-Type: application/json' \
    -d "$body" "$CONSOLE/api/v1/commands/terminal" || echo 000)"
  t1=$(date +%s.%N)
  printf '%s %s %s\n' "$code" \
    "$(jq -r 'if has("exit_code") then .exit_code else ((.error|objects|.code) // (.error|strings) // .code // "-") end' \
      "$OUT/last-$n.json" 2>/dev/null || echo -)" \
    "$(awk -v a="$t0" -v b="$t1" 'BEGIN{printf "%.1fs", b-a}')"
}

# Host metrics every 2 s while a scenario runs.
sample_start() {
  (
    echo "ts psi_mem_some10 psi_cpu_some10 psi_io_some10 mem_avail_kb swap_free_kb app_latency_s"
    while true; do
      printf '%s %s %s %s %s %s %s\n' "$(date +%T)" \
        "$(awk -F'avg10=' '/^some/{split($2,a," ");print a[1]}' /proc/pressure/memory)" \
        "$(awk -F'avg10=' '/^some/{split($2,a," ");print a[1]}' /proc/pressure/cpu)" \
        "$(awk -F'avg10=' '/^some/{split($2,a," ");print a[1]}' /proc/pressure/io)" \
        "$(awk '/^MemAvailable/{print $2}' /proc/meminfo)" \
        "$(awk '/^SwapFree/{print $2}' /proc/meminfo)" \
        "$(curl -s -o /dev/null -w '%{time_total}' -m 10 "$APP_URL" || echo timeout)"
      sleep 2
    done
  ) >"$OUT/host-$SCENARIO_NAME.tsv" &
  SAMPLER=$!
}
sample_stop() {
  kill "$SAMPLER" 2>/dev/null || true
  docker stats --no-stream --format '{{.Name}} {{.CPUPerc}} {{.MemUsage}}' |
    grep onlyboxes >"$OUT/stats-$SCENARIO_NAME.txt" || true
  awk 'NR>1{if($2>m)m=$2; if($7!="timeout"&&$7>l)l=$7; if(s==""||$6<s)s=$6} END{printf "  peak psi_mem=%s  min swap_free_kb=%s  max app_latency=%ss\n",m,s,l}' \
    "$OUT/host-$SCENARIO_NAME.tsv"
}

# Peak memory and swap limit of every managed container (cgroup v2).
cgroup_report() {
  local id name
  for id in $(docker ps -q --no-trunc --filter label=onlyboxes.managed=true); do
    name="$(docker inspect -f '{{.Name}}' "$id")"
    printf '  %s peak=%s swap.max=%s io.max=%s\n' "${name:1:34}" \
      "$(cat /sys/fs/cgroup/system.slice/docker-$id.scope/memory.peak 2>/dev/null)" \
      "$(cat /sys/fs/cgroup/system.slice/docker-$id.scope/memory.swap.max 2>/dev/null)" \
      "$(cat /sys/fs/cgroup/system.slice/docker-$id.scope/io.max 2>/dev/null)"
  done
}

# Waits only for its own jobs: a bare `wait` would also wait for the sampler.
parallel() {
  local cmd="$1" timeout="${2:-120000}" i
  local -a pids=()
  for i in $(seq 1 "$SESSIONS"); do
    term "$i" "$cmd" "$timeout" | sed "s/^/  session $i: /" &
    pids+=($!)
  done
  wait "${pids[@]}"
}

run_scenario() {
  SCENARIO_NAME="$1"
  echo "== $SCENARIO_NAME"
  case "$SCENARIO_NAME" in
    cpu)
      sample_start
      parallel "timeout 60 sh -c 'while :; do :; done'; echo done" 120000
      sample_stop
      echo "  expect: each onlyboxes-terminal container <= ~50% CPU in stats-cpu.txt" ;;
    oom)
      sample_start
      parallel "python3 -c 'b=bytearray(1536*1024*1024); print(len(b))'"
      sample_stop
      cgroup_report
      echo "  expect: exit 137 in every session, swap.max=0, no OOM outside sandboxes:"
      dmesg -T | grep -i 'killed process' | tail -10 | sed 's/^/    /' ;;
    work)
      sample_start
      parallel "cd /tmp && python3 - <<'PY'
import time, pandas as pd, numpy as np, docx, subprocess
t=time.time()
df=pd.DataFrame(np.random.rand(2_000_000,5),columns=list('abcde')); df.describe(); df.to_csv('d.csv')
d=docx.Document()
[d.add_paragraph('Load test paragraph %d '%i*20) for i in range(800)]
d.save('t.docx')
subprocess.run(['soffice','--headless','--convert-to','pdf','t.docx'],check=True,capture_output=True)
print('ok %.1fs'%(time.time()-t))
PY" 120000
      sample_stop
      cgroup_report
      echo "  expect: http 200 / exit 0 and < 120 s in every session; peak <= 536870912" ;;
    cap)
      for i in $(seq 1 "$SESSIONS"); do term "$i" "true" | sed "s/^/  session $i: /"; done
      term $((SESSIONS + 1)) "true" | sed "s/^/  session $((SESSIONS + 1)): /"
      echo "  expect: sessions 1..$SESSIONS -> 200, session $((SESSIONS + 1)) -> 429 session_capacity_exceeded" ;;
    fork)
      term 1 "timeout 20 python3 -c 'import os
while True: os.fork()' ; echo exit=\$?" 60000 | sed 's/^/  session 1 (fork bomb): /' &
      local bomb=$!
      sleep 5
      term 2 "echo alive" | sed 's/^/  session 2 during bomb: /'
      wait "$bomb"
      echo "  expect: session 2 -> 200 alive; session 1 capped at 256 pids" ;;
    parallel)
      local -a pp=()
      for i in 1 2 3 4; do term 1 "sleep 3; echo $i" | sed "s/^/  same-session cmd $i: /" & pp+=($!); done
      wait "${pp[@]}"
      echo "  expect: four 200s, no 409 session_busy" ;;
    outbomb)
      term 2 "echo before" | sed 's/^/  session 2 before: /'
      term 1 "yes | head -c 2000000000" 120000 | sed 's/^/  session 1 (2 GB stdout): /'
      sleep 20
      term 2 "echo after" | sed 's/^/  session 2 after: /'
      systemctl status onlyboxes-worker-docker --no-pager | sed -n '1,5p' | sed 's/^/    /'
      echo "  expect: host unaffected; worker may have restarted; session 2 'after' -> 200 (retry once if 503 while reconciling)" ;;
    disk)
      sample_start
      term 1 "dd if=/dev/zero of=/tmp/fill bs=1M count=6000 status=none; echo wrote" 300000 | sed 's/^/  session 1 (6 GB): /'
      sample_stop
      journalctl -u onlyboxes-guard --since '-6 min' --no-pager | grep -i removing | sed 's/^/    /'
      echo "  expect: guard log 'removing ... writable layer' and the command fails" ;;
    net)
      local redis pg mail console_ip probes
      redis="$(docker inspect -f '{{(index .NetworkSettings.Networks "panachat-network").IPAddress}}' panachat-redis)"
      pg="$(docker inspect -f '{{(index .NetworkSettings.Networks "panachat-network").IPAddress}}' panachat-postgres)"
      mail="$(docker inspect -f '{{(index .NetworkSettings.Networks "panachat-network").IPAddress}}' stalwart)"
      console_ip="$(sed -n 's/^ONLYBOXES_APP_BIND_IP=//p' "$ENV_FILE")"
      probes="for t in $redis:6379 $pg:5432 $mail:143 $console_ip:8089 $HOST_IP:22 $HOST_IP:143 $HOST_IP:993 $HOST_IP:8089 169.254.169.254:80 1.1.1.1:25; do
        h=\${t%:*}; p=\${t#*:}; if timeout 4 bash -c \"</dev/tcp/\$h/\$p\" 2>/dev/null; then echo \"OPEN    \$t\"; else echo \"blocked \$t\"; fi; done
        for u in https://s3.panafor.com/ https://pypi.org/simple/ https://registry.npmjs.org/; do
        echo \"https \$(curl -s -o /dev/null -m 10 -w '%{http_code}' \$u) \$u\"; done"
      term 1 "$probes" 120000 >/dev/null
      jq -r '.stdout' "$OUT/last-1.json" | sed 's/^/  /'
      echo "  expect: every tcp target 'blocked'; every https line a real HTTP code (not 000)" ;;
    *)
      echo "unknown scenario $SCENARIO_NAME" >&2
      exit 2 ;;
  esac
}

case "$SCENARIO" in
  all)
    for s in net cap parallel cpu oom work fork disk outbomb; do
      run_scenario "$s" 2>&1 | tee -a "$OUT/report.txt"
      sleep 20
    done ;;
  cpu | oom | work | cap | fork | parallel | outbomb | disk | net)
    run_scenario "$SCENARIO" 2>&1 | tee -a "$OUT/report.txt" ;;
  *)
    sed -n '2,12p' "$0" >&2
    exit 2 ;;
esac
echo "results: $OUT"
