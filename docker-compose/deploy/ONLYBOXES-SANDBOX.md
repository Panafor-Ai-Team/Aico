# Onlyboxes Cloud Sandbox on the production host

Self-hosted sandbox for LobeHub's Cloud Sandbox tool (`SANDBOX_PROVIDER=onlyboxes`, provider code in `apps/server/src/services/sandbox/providers/onlyboxes.ts`). It is sized for **5 concurrent sandboxes** on the 4 vCPU / 7.75 GiB host and isolated so it cannot take the app or its data down.

Upstream: [coooolfan/onlyboxes](https://github.com/coooolfan/onlyboxes) 0.14.1 (console image `coolfan1024/onlyboxes`, runtime `coolfan1024/onlyboxes-runtime:0.14.1-lobehub`, `worker-docker` release binary).

## Shape

```text
panachat-green/blue ──REST──► 172.18.0.1:8089 ─► onlyboxes-console (own network, SQLite in ./db)
                                                      │ gRPC 127.0.0.1:50051
                                            onlyboxes-worker-docker (systemd, host)
                                                      │ docker create/exec
                                   onlyboxes-terminal-v1-* containers on onlyboxes-sandbox
                                   (172.20.0.0/16, br-onlyboxes, ICC off, one per user+topic)
```

| Limit                              | Value                                                                                                   | Enforced by                    |
| ---------------------------------- | ------------------------------------------------------------------------------------------------------- | ------------------------------ |
| Sandboxes                          | 5 active (a 6th new session gets HTTP 429 `session_capacity_exceeded`)                                  | worker                         |
| Per sandbox                        | 512 MiB RAM, **0 swap**, 0.5 CPU, 256 pids, 50 MB/s + 300 IOPS on the root disk                         | worker + `onlyboxes-guard`     |
| Writable layer                     | removed above 5 GB; all sandboxes removed if `/` free < 40 GB                                           | `onlyboxes-guard` (30 s sweep) |
| Console                            | 256 MiB, 0.25 CPU                                                                                       | compose                        |
| Worker + its `docker` CLI children | 512 MiB, 25 % CPU                                                                                       | systemd                        |
| Bandwidth                          | 40 Mbit down / 20 Mbit up shared by all sandboxes                                                       | tc on `br-onlyboxes`           |
| Network                            | no private/link-local ranges (Postgres, Redis, Stalwart, rustfs, console), no SMTP; host only on 80/443 | `sandbox-firewall.sh`          |

Total ceiling: about 3.5 GiB RAM and 3.25 vCPU. A LobeHub session (`lobe-<userId>-<topicId>`) holds its sandbox for 15 minutes after its last command.

## Files

| Repo                                                               | Server                                       |
| ------------------------------------------------------------------ | -------------------------------------------- |
| `onlyboxes/docker-compose.onlyboxes.yml`, `onlyboxes/.env.example` | `/opt/onlyboxes/` (+ `.env`, `db/`)          |
| `onlyboxes/sandbox-firewall.sh`, `onlyboxes/onlyboxes-guard.sh`    | `/opt/onlyboxes/`                            |
| `onlyboxes/*.service`                                              | `/etc/systemd/system/`                       |
| `onlyboxes/worker.env.example`                                     | `/etc/onlyboxes/worker.env` (600)            |
| release binary                                                     | `/opt/onlyboxes/bin/onlyboxes-worker-docker` |
| `scripts/aico/onlyboxes-loadtest.sh`                               | `/opt/onlyboxes/onlyboxes-loadtest.sh`       |

## Install (as root)

Data-safety rules for every step: run compose only with `-p onlyboxes` from `/opt/onlyboxes`. Never run `down`, `--remove-orphans`, `-v` or `prune` against the panachat project, and never restart `docker.service`.

```bash
# 0. Backup first (Postgres dump + rustfs), and keep a copy of the app env.
sudo -u panachat /home/panachat/panachat/scripts/panachat-backup.sh --reason pre-onlyboxes
cp -a /home/panachat/panachat/.env /root/panachat.env.pre-onlyboxes

# 1. Images and binary, pinned.
docker pull coolfan1024/onlyboxes:0.14.1
docker pull coolfan1024/onlyboxes-runtime:0.14.1-lobehub
docker inspect -f '{{index .RepoDigests 0}}' coolfan1024/onlyboxes:0.14.1 coolfan1024/onlyboxes-runtime:0.14.1-lobehub
mkdir -p /opt/onlyboxes/bin /etc/onlyboxes && cd /opt/onlyboxes
curl -fsSLO https://github.com/coooolfan/onlyboxes/releases/download/0.14.1/onlyboxes-worker-docker_0.14.1_linux_amd64.zip
echo '97f8fb27102b7e6784086e17074dec7412d51a7f1894e1e353605f2a180de756  onlyboxes-worker-docker_0.14.1_linux_amd64.zip' | sha256sum -c
python3 -m zipfile -e onlyboxes-worker-docker_0.14.1_linux_amd64.zip bin/
mv bin/onlyboxes-worker-docker_0.14.1_linux_amd64 bin/onlyboxes-worker-docker && chmod 755 bin/onlyboxes-worker-docker

# 2. Network isolation and guard (copy the repo files listed above first).
systemctl daemon-reload
systemctl enable --now onlyboxes-sandbox-firewall.service onlyboxes-guard.service
/opt/onlyboxes/sandbox-firewall.sh check && /opt/onlyboxes/sandbox-firewall.sh status

# 3. Console. Fill .env from .env.example: openssl rand -hex 32 per secret, digest from step 1.
install -m 600 .env.example .env && "${EDITOR:-vi}" .env
docker compose -p onlyboxes -f docker-compose.onlyboxes.yml up -d
curl -fsS -o /dev/null -w '%{http_code}\n' http://127.0.0.1:8089/
```

Warning: on first start the console writes the initial admin password and any `CONSOLE_INITIAL_ADMIN_API_KEY` to `docker logs` in plain text. Don't copy those logs anywhere. Rotate the password (`POST /api/v1/auth/password`) and delete the `initial-admin` API key (`DELETE /api/v1/api-keys/:id`, cookie session) right after setup.

`POST /api/v1/workers` with `{"type":"normal"}` returns `{node_id, type, worker_secret}` in 0.14.1, not the `command` string that `docs/API.md` describes. `node_id` is `WORKER_ID`. The secret is returned only once.

4. Open the dashboard through a tunnel (`ssh -L 8089:127.0.0.1:8089 root@<host>`), sign in, go to **Workers → Create worker**, and copy the id and secret into `/etc/onlyboxes/worker.env` (from `worker.env.example`, with the runtime image digest from step 1). Then:

```bash
chmod 600 /etc/onlyboxes/worker.env
systemctl enable --now onlyboxes-worker-docker.service
journalctl -u onlyboxes-worker-docker -n 20 --no-pager # "terminalExec configured: ... max_active_sessions=5"
```

The dashboard shows the worker as online.

## Gate: load test before any user traffic

```bash
/opt/onlyboxes/onlyboxes-loadtest.sh all /var/tmp/onlyboxes-loadtest
```

Each scenario prints what it expects. Pass criteria:

- **net:** every TCP target is blocked; pypi, npm and `s3.panafor.com` answer.
- **cap:** the 6th session gets 429.
- **parallel:** no 409.
- **oom:** exit 137 only inside sandboxes, and `swap.max=0`.
- **work:** finishes in < 120 s.
- **fork:** session 2 stays alive.
- **disk:** the guard removes the container.
- **outbomb:** the host is unaffected.
- **host:** app latency within +20 %, PSI memory `some avg10` < 10, no OOM outside `onlyboxes-*` in `dmesg`, swap growth < 256 MiB.

Save a summary to `docs/aico/reports/` with synthetic ids only.

Also check that the app can reach the console. App and console are on different bridges, so this depends on Docker forwarding the published port:

```bash
docker exec panachat-green node -e "fetch('http://172.18.0.1:8089/').then(r=>console.log('reachable',r.status))"
```

## Switch the app on

Add these lines to the repo-root `.env` on the server (`/home/panachat/panachat/.env`, read by blue, green and control-plane):

```bash
SANDBOX_PROVIDER=onlyboxes
ONLYBOXES_BASE_URL=http://172.18.0.1:8089
ONLYBOXES_JIT_SIGNING_KEY=<CONSOLE_JIT_SIGNING_KEY from /opt/onlyboxes/.env>
```

Then redeploy the **current** image through the blue-green script, which takes its own pre-deploy backup:

```bash
PANACHAT_ENV=canary ./scripts/panachat-deploy-remote.sh status   # note the current image
PANACHAT_ENV=canary ./scripts/panachat-deploy-remote.sh deploy <current image>
```

Then run one real chat with the Cloud Sandbox tool: run Python, write a file, and export it as a download.

## Operate

- Status: `systemctl status onlyboxes-worker-docker onlyboxes-guard onlyboxes-sandbox-firewall`, `docker ps --filter label=onlyboxes.managed=true --size`.
- Guard actions: `journalctl -u onlyboxes-guard | grep removing`.
- Raise or lower capacity by changing `WORKER_TERMINAL_MAX_ACTIVE_SESSIONS` and `WORKER_TERMINAL_EXEC_MEMORY_MIB` together, keeping their product ≤ 2.5 GiB. Then `systemctl restart onlyboxes-worker-docker`.

## Rollback

```bash
# App first: remove the three ONLYBOXES/SANDBOX lines from .env, then redeploy the current image as above.
systemctl disable --now onlyboxes-worker-docker
docker ps -aq --filter label=onlyboxes.managed=true | xargs -r docker rm -f
cd /opt/onlyboxes && docker compose -p onlyboxes -f docker-compose.onlyboxes.yml stop
systemctl disable --now onlyboxes-guard
/opt/onlyboxes/sandbox-firewall.sh remove && systemctl disable onlyboxes-sandbox-firewall
```

`/opt/onlyboxes/db` (console accounts and workers) is kept. Nothing in the panachat stack is touched.

## Known limits

- Disk is watched, not quota'd: overlayfs on ext4 has no per-container size limit. The 50 MB/s write cap and the 30 s sweep bound a fill to about 7.5 GB per sweep.
- Swap is zeroed within moments of container start, not at creation.
- Large stdout is buffered unbounded in the worker (upstream). The 512 MiB systemd cap turns this into a worker restart, not a host problem.
- The sandbox runs as root on the shared host kernel (runc, default seccomp/AppArmor, no userns-remap). Keep the kernel, containerd and Docker patched.
