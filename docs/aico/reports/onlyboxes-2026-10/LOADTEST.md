# Onlyboxes sandbox load test, 2026-10-27

Production host (4 vCPU / 7.75 GiB), Onlyboxes 0.14.1, runtime `0.14.1-lobehub`. The test ran **before** any app traffic was pointed at the sandbox. It used `scripts/aico/onlyboxes-loadtest.sh` against the console on loopback, with synthetic JIT subjects `loadtest-1..9` under issuer `aico-loadtest`.

Limits under test: 5 sessions × (512 MiB, swap 0, 0.5 CPU, 256 pids, io.max 50 MB/s + 300 IOPS); worker 512 MiB / 25 % CPU. The 2 GiB total for all of Onlyboxes was added and tested afterwards (section below).

## Results

| Scenario                                        | Result                   | Evidence                                                                                                                                                                                                                                                                                   |
| ----------------------------------------------- | ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| net: isolation                                  | **Pass**                 | Blocked: Redis 6379, Postgres 5432, Stalwart 143, console 172.18.0.1:8089, host 22/143/993/8089, 169.254.169.254, outbound 25. Reachable: pypi, npm, s3.panafor.com (403 = anonymous bucket root, path works). Positive control with the same `/dev/tcp` probe: pypi:443 and host:443 OPEN |
| limits applied                                  | **Pass**                 | `docker inspect`: Memory=MemorySwap=536870912, NanoCpus=5e8, PidsLimit=256, network onlyboxes-sandbox. cgroup: `memory.swap.max=0`, `io.max=253:0 rbps=52428800 wbps=52428800 riops=300 wiops=300` (set by guard)                                                                          |
| cap: 6th session                                | **Pass**                 | sessions 1–5 → 200; 6th → 429 `terminal session capacity exceeded`                                                                                                                                                                                                                         |
| parallel: 4 cmds / session                      | **Pass**                 | 4 × 200, no 409                                                                                                                                                                                                                                                                            |
| cpu: 5 × busy loop 60 s                         | **Pass**                 | each sandbox 48–52 % CPU. App and Postgres cgroup `cpu.pressure some avg10=0.00`. Host PSI cpu 33–61 % comes only from throttled sandboxes. App latency 0.09–0.22 s                                                                                                                        |
| oom: 5 × 1.5 GB alloc                           | **Pass**                 | exit 137 in all 5; every `dmesg` kill is a sandbox `python3` at anon-rss ≈ 512 MiB; host swap unchanged                                                                                                                                                                                    |
| work: pandas 2M rows + LibreOffice docx→pdf × 5 | **Pass, at the ceiling** | all 200 / exit 0 in 50–56 s (< 120 s app timeout). A fresh sandbox reached memory.peak = 512 MiB with **0 oom\_kill** (page cache reclaimed). Bigger jobs will OOM. Runtime is set by the 0.5 CPU cap (49 s alone ≈ 50 s × 5)                                                              |
| fork: fork bomb                                 | **Pass**                 | bystander session answered in 0.6 s during the bomb                                                                                                                                                                                                                                        |
| disk: 6 GB write                                | **Pass**                 | guard removed the container at 6.06 GB (one 30 s sweep past 5 GB); free space restored                                                                                                                                                                                                     |
| disk I/O isolation                              | **Pass (light DB load)** | during a 2 GB direct write: host PSI io up to 74 %, **Postgres and app cgroup io.pressure 0.00**, app latency 0.10–0.19 s. Not tested: a heavy concurrent Postgres write load                                                                                                              |
| outbomb: 2 GB stdout                            | **Pass (as designed)**   | worker OOM-killed inside its 512 MiB unit, systemd restarted it, it reconnected in seconds; bystander session kept working; host memory unchanged. The bombing command got 502                                                                                                             |

## 2 GiB total (`onlyboxes.slice`), same day

After the worker, guard, console and every sandbox were moved into `onlyboxes.slice` (`MemoryMax=2G`, swap 0), the `slice` scenario had 5 sandboxes each hold 450 MB at once, about 2.25 GB in total:

- `onlyboxes.slice` memory.peak = **2147483648 (exactly 2 GiB)**, never above it. memory.events: `max 370`, `oom_kill 1`, `low 14406` (the worker, guard and console `MemoryLow` floors were honoured).
- Exactly one process was killed: `python3` in one sandbox, with `oom_memcg=/onlyboxes.slice`. The other 4 sessions finished with exit 0.
- Worker, guard and console: no restart and not OOM-killed (`oom_score_adj -900`). App latency ≤ 0.20 s, host swap untouched.

Host during the whole run: PSI memory ≤ 0.44, swap free constant at 3.38 GiB, app latency never above 0.22 s.

## Behaviour notes (for operating with LobeHub)

- **The lease is a hard stop.** A command that runs longer than its lease is killed (`404 session not found`). LobeHub renews the lease to 900 s on each command and caps commands at 600 s, so this does not affect it. Load tests must use a lease longer than any command.
- **Session reuse after expiry works.** `create_if_missing` recreates the sandbox (`created:true`). This matches how LobeHub reuses `lobe-<user>-<topic>`.
- **After the guard removes a sandbox**, the next call can return one `404 session not found` until the console prunes the route (it prunes every few minutes). The call after that recreates the sandbox.
- **One unexplained 502:** `persist terminal session route: terminal session route changed before persistence` appeared on 5 sessions during a CPU run that started right after an interrupted test run. It did not reproduce from a clean state (3 tries).

## Not covered

- A real LobeHub chat end to end (step 5 of the runbook).
- A heavy Postgres write load concurrent with sandbox I/O.
- Provider egress quota.
