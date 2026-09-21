# Panachat server bootstrap (ParsPack Tehran)

Runbook for the Iran-hosted Panachat server. Base host prep (sections 1–6) is **done** as of 2026-09-21; the app is **not** deployed yet. After host prep, continue with [SERVER-BOOTSTRAP.md](./SERVER-BOOTSTRAP.md) §2–§6 (repo, env, DNS, nginx). This file only covers what is different for this host.

| Setting   | Value                                                         |
| --------- | ------------------------------------------------------------- |
| Provider  | ParsPack cloud, Tehran DC (KVM, NVMe, live resize, snapshots) |
| Host      | `94.184.43.17` (`srv7465321388`)                              |
| OS        | Ubuntu 24.04.5 LTS                                            |
| Size      | 4 vCPU / 7.8 GB RAM / 290 GB disk + 4 GB swap                 |
| SSH user  | `panachat` (key only, passwordless sudo, `docker` group)      |
| Repo path | `/home/panachat/panachat` (canary)                            |
| Image     | `ghcr.io/panafor-ai-team/panachat` (private)                  |

**Hard bans:** these are the same as in SERVER-BOOTSTRAP.md. Never run `docker compose down -v`, and never `docker volume rm panachat_*`.

---

## What we need before the app can go live

- [x] Operator SSH key (`~/.ssh/id_ed25519` from Ali's workstation) on `root` and `panachat`
- [ ] **Rotate the root password** in the ParsPack panel. The original one was pasted in chat. Password login is disabled now, but the panel console still accepts it.
- [ ] GitHub Actions deploy key: add a `github-actions-panachat` public key to `/home/panachat/.ssh/authorized_keys`, then update the repo secrets `DEPLOY_HOST` / `DEPLOY_USER` / `DEPLOY_SSH_KEY` / `DEPLOY_PATH`
- [ ] `GHCR_READ_TOKEN` (PAT with `read:packages`). The image is private, and an anonymous manifest request returns `401`.
- [ ] Domain + DNS A records → `94.184.43.17`. They must be DNS-only (ArvanCloud "cloud" OFF) so certbot HTTP-01 reaches nginx.
- [ ] Production secrets for `.env` and `docker-compose/deploy/.env`. See SERVER-BOOTSTRAP.md §3.
- [ ] Answers to the ParsPack ticket:
  1. Does international traffic have a volume cap or separate pricing? (This decides the real monthly cost, because all LLM traffic leaves Iran.)
  2. Is there a private route between the Iran server and ParsPack's foreign (Germany/Hetzner) server, or does traffic go over the public internet?
  3. Does the foreign server allow outbound port 25 and rDNS? (Needed for Stalwart mail.)
- [ ] Decision on a **foreign relay** (ParsPack Germany/Hetzner) for LLM egress. See §8.
- [ ] `OPENROUTER_MANAGEMENT_BASE_URL` change so OpenRouter key allocation works from this host (open code item).
- [ ] Off-site backup target (ParsPack snapshots live on the same platform, so they are not an independent backup).

---

## 1. Swap

```bash
sudo fallocate -l 4G /swapfile && sudo chmod 600 /swapfile
sudo mkswap /swapfile && sudo swapon /swapfile
echo '/swapfile none swap sw 0 0' | sudo tee -a /etc/fstab
echo 'vm.swappiness=10' | sudo tee /etc/sysctl.d/99-swap.conf && sudo sysctl --system
swapon --show && free -h
```

---

## 2. Deploy user + SSH key

Run these as root. Replace `<pubkey>` with the operator's public key.

```bash
echo '<pubkey>' >> /root/.ssh/authorized_keys
adduser --disabled-password --gecos '' panachat
usermod -aG sudo panachat
echo 'panachat ALL=(ALL) NOPASSWD:ALL' > /etc/sudoers.d/90-panachat && chmod 440 /etc/sudoers.d/90-panachat
install -d -m 700 -o panachat -g panachat /home/panachat/.ssh
install -m 600 -o panachat -g panachat /root/.ssh/authorized_keys /home/panachat/.ssh/authorized_keys
```

Passwordless sudo is intentional: the deploy script runs non-interactively from Actions.

Check `ssh panachat@94.184.43.17` from a **second terminal** before continuing.

---

## 3. SSH hardening

The file name must sort **before** `50-cloud-init.conf`. ParsPack's cloud-init sets `PasswordAuthentication yes` there, and sshd keeps the first value it reads.

```bash
sudo tee /etc/ssh/sshd_config.d/00-hardening.conf << 'EOF'
PasswordAuthentication no
KbdInteractiveAuthentication no
PermitRootLogin prohibit-password
PubkeyAuthentication yes
MaxAuthTries 3
EOF
sudo sshd -t && sudo systemctl reload ssh
sudo sshd -T | grep -Ei '^(passwordauthentication|permitrootlogin) ' # expect: no / without-password
```

Check that password login is refused. The expected response is `Permission denied (publickey).`:

```bash
ssh -o PreferredAuthentications=password -o PubkeyAuthentication=no root@94.184.43.17 true
```

---

## 4. Packages, firewall, fail2ban

```bash
sudo apt-get update
sudo apt-get install -y ufw fail2ban unattended-upgrades ca-certificates curl gnupg \
  nginx certbot python3-certbot-nginx git jq

sudo ufw allow OpenSSH && sudo ufw allow 80/tcp && sudo ufw allow 443/tcp
sudo ufw --force enable

printf '[sshd]\nenabled = true\nmaxretry = 5\nbantime = 1h\n' | sudo tee /etc/fail2ban/jail.d/sshd.local
sudo systemctl enable --now fail2ban && sudo fail2ban-client status sshd
```

Do **not** open 3210/9000/5432 in ufw. Nginx proxies to `127.0.0.1` only.

> Docker-published ports bypass ufw. That is why the compose file binds app ports to `127.0.0.1`. Keep it that way.

---

## 5. Docker (official repo, reachable from this DC)

```bash
sudo install -m 0755 -d /etc/apt/keyrings
sudo curl -fsSL https://download.docker.com/linux/ubuntu/gpg -o /etc/apt/keyrings/docker.asc
sudo chmod a+r /etc/apt/keyrings/docker.asc
echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/ubuntu $(. /etc/os-release && echo $VERSION_CODENAME) stable" \
  | sudo tee /etc/apt/sources.list.d/docker.list
sudo apt-get update
sudo apt-get install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin

sudo tee /etc/docker/daemon.json << 'EOF'
{
  "log-driver": "json-file",
  "log-opts": { "max-size": "10m", "max-file": "3" },
  "live-restore": true
}
EOF
sudo systemctl restart docker
sudo usermod -aG docker panachat # re-login to apply
```

Installed: Docker Engine 29.8.1, Compose v5.5.1.

GHCR login is needed for the private app image:

```bash
echo "$GHCR_READ_TOKEN" | docker login ghcr.io -u "$GITHUB_USER" --password-stdin
```

If Docker Hub starts throttling or gets blocked, add `"registry-mirrors": ["https://docker.iranserver.com"]` (or `https://focker.ir`) to `daemon.json` and restart Docker. GHCR has no Iranian mirror. If ghcr.io becomes blocked, pull through the foreign relay, or `docker save | ssh … docker load`.

---

## 6. Repo

```bash
git clone -b canary https://github.com/Panafor-Ai-Team/Aico.git /home/panachat/panachat
```

Then follow SERVER-BOOTSTRAP.md §3 (env), §5 (DNS, replacing the IP with `94.184.43.17`) and §6 (nginx + certbot).

---

## 7. Reachability from this DC (tested 2026-09-21)

`401` means the host answered with a login challenge, so it is **reachable**.

| Endpoint                                           | Result     | Notes                                  |
| -------------------------------------------------- | ---------- | -------------------------------------- |
| `download.docker.com`                              | 200, 0.37s | official apt repo works                |
| `registry-1.docker.io`                             | 401, 0.60s | pulls work (paradedb 15s, rustfs 7s)   |
| `ghcr.io` / `pkg-containers.githubusercontent.com` | 401 / 400  | reachable; app image needs login       |
| `github.com` / `codeload.github.com`               | 200 / 301  | clone works                            |
| `openrouter.ai/api/v1/models`                      | 200, 0.53s | listing only, inference not tested yet |
| `api.openai.com`                                   | 401, 0.38s | reachable                              |
| `registry.npmjs.org`, `archive.ubuntu.com`         | 200        |                                        |
| `docker.iranserver.com`, `focker.ir`               | 401        | usable fallback Docker Hub mirrors     |
| `docker.arvancloud.ir`                             | 502        | down at test time                      |
| `mirror.arvancloud.ir/docker-ce`                   | 503        | down at test time                      |

**Decision:** use the official Docker repo and pull directly from Docker Hub and GHCR. No mirror is configured. Re-run the probe below if pulls start failing, because Iranian filtering changes without notice:

```bash
for u in https://download.docker.com/linux/ubuntu/gpg https://registry-1.docker.io/v2/ https://ghcr.io/v2/ \
  https://openrouter.ai/api/v1/models https://docker.iranserver.com/v2/ https://focker.ir/v2/; do
  printf '%-50s ' "$u"
  curl -s -o /dev/null -m 12 -w '%{http_code} %{time_total}s\n' "$u" || echo FAIL
done
```

---

## 8. Open items (not done)

- **LLM egress:** `openrouter.ai` answers from this DC, but providers can geo-block **inference** from Iranian IPs. Before go-live, run one real completion with a test key. If it is refused, route LLM traffic through the foreign relay: a ParsPack Germany/Hetzner server with a WireGuard tunnel, or an HTTP proxy via `HTTPS_PROXY` on the app container.
- **`OPENROUTER_MANAGEMENT_BASE_URL`:** code change needed so key allocation goes through the relay.
- **Backups:** after the stack is up, run `./scripts/panachat-backup.sh --install-cron`, then sync `~/.local/share/panachat-backups` off-site (for example to the foreign server with `rsync`).
- **Mail (Stalwart):** belongs on the foreign server if it provides outbound port 25 and rDNS (ticket question 3).
