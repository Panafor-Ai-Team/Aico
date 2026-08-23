#!/usr/bin/env bash
#
# OpenRouter model catalog sync — cron caller.
#
# Calls the existing sync endpoint; the server does the actual work
# (fetch live OpenRouter catalog -> replace the DB catalog). This script is
# only a thin, reliable curl wrapper intended for the host system crontab.
#
# Crontab (run every day at 03:00 UTC):
#
#   CRON_TZ=UTC
#   0 3 * * * /path/to/scripts/openrouter-sync-cron.sh >> /path/to/logs/openrouter-sync.log 2>&1
#
#   - CRON_TZ=UTC pins the schedule to 03:00 UTC regardless of the server's
#     local timezone (DST-safe). If your cron implementation lacks CRON_TZ,
#     make sure the server itself runs in UTC, or translate the schedule into
#     local time manually — otherwise the run will drift.
#   - CRON_SECRET must be set for the job. Preferred: define it once in
#     /etc/environment so the secret never appears in the crontab file or in
#     shell history:
#
#       CRON_SECRET=xxx /path/to/scripts/openrouter-sync-cron.sh >> ... 2>&1
#
#     becomes simply:
#
#       0 3 * * * /path/to/scripts/openrouter-sync-cron.sh >> ... 2>&1
#
#     The inline-prefix form (`0 3 * * * CRON_SECRET=xxx ...`) also works and
#     does NOT leak the value into `ps aux` (env assignment, not an argument),
#     but keep the crontab permission-restricted if you choose it.
#   - Log rotation: the `>>` redirect grows indefinitely. Drop this into
#     /etc/logrotate.d/openrouter-sync to rotate weekly:
#
#       /path/to/logs/openrouter-sync.log {
#         weekly
#         rotate 8
#         compress
#         missingok
#         notifempty
#       }

set -euo pipefail

readonly TIMEOUT_SECS=30
readonly ENDPOINT_PATH="/api/aico/cron/sync-openrouter-models"

SYNC_DOMAIN="${SYNC_DOMAIN:-chat.panafor.com}"

if [[ -z "${CRON_SECRET:-}" ]]; then
  echo "[$(date -u '+%Y-%m-%dT%H:%M:%SZ')] ERROR: CRON_SECRET is required but not set." >&2
  exit 1
fi

URL="https://${SYNC_DOMAIN}${ENDPOINT_PATH}"

body_file="$(mktemp)"
trap 'rm -f "$body_file"' EXIT

# -sS: silent but show errors on stderr; body goes to a temp file so a useful
# error response (the route returns JSON details on 4xx/5xx) is never lost,
# which is exactly why plain `-f` is not used here.
set +e
http_code="$(curl -sS --max-time "$TIMEOUT_SECS" \
  -o "$body_file" \
  -w '%{http_code}' \
  -H "Authorization: Bearer ${CRON_SECRET}" \
  "${URL}")"
curl_rc=$?
set -e

timestamp="$(date -u '+%Y-%m-%dT%H:%M:%SZ')"

if (( curl_rc != 0 )); then
  case "${curl_rc}" in
    28) reason="request timed out after ${TIMEOUT_SECS}s" ;;
    6) reason="could not resolve host ${SYNC_DOMAIN}" ;;
    7) reason="could not connect to ${SYNC_DOMAIN}" ;;
    *) reason="curl failed with exit code ${curl_rc}" ;;
  esac
  echo "[${timestamp}] ERROR: GET ${URL} failed: ${reason}." >&2
  cat "${body_file}" >&2 || true
  echo >&2
  exit 1
fi

# Success requires a present AND 2xx status; empty or "000" (interrupted
# transfer) must land in the failure branch, never be treated as success.
case "${http_code}" in
  2??)
    echo "[${timestamp}] OK (HTTP ${http_code}) from ${URL}"
    cat "${body_file}"
    exit 0
    ;;
  *)
    echo "[${timestamp}] ERROR: GET ${URL} returned HTTP status '${http_code:-<none>}'." >&2
    cat "${body_file}" >&2 || true
    echo >&2
    exit 1
    ;;
esac
