#!/usr/bin/env bash
# Prove the newest Panachat backup restores: load the SQL dump into a throwaway
# ParadeDB container (no network, removed afterwards) and check the RustFS archive.
#
# Usage: panachat-restore-drill.sh [dir-or-file.sql.gz]
#   default: newest dump in $PANACHAT_OFFSITE_DEST (/var/lib/panachat-offsite/kamyar)
#
# The target DB is created from template0: the paradedb image pre-installs its
# extensions (and the `paradedb` schema) into POSTGRES_DB and template1, so a
# restore into those fails with `schema "paradedb" already exists`.

set -euo pipefail

SRC="${1:-${PANACHAT_OFFSITE_DEST:-/var/lib/panachat-offsite/kamyar}}"
IMAGE="${PANACHAT_DRILL_IMAGE:-paradedb/paradedb:latest-pg17}"
NAME="panachat-restore-drill"
MIN_USERS="${PANACHAT_DRILL_MIN_USERS:-1}"

if [[ -d "$SRC" ]]; then
  SQL="$(ls -t "$SRC"/panachat-*.sql.gz 2>/dev/null | head -1 || true)"
else
  SQL="$SRC"
fi
[[ -f "$SQL" ]] || { echo "Error: no SQL dump found in $SRC" >&2; exit 1; }
RUSTFS="${SQL%.sql.gz}.rustfs.tar.gz"

cleanup() { docker rm -f "$NAME" >/dev/null 2>&1 || true; }
trap cleanup EXIT
cleanup

echo "==> $(date -Iseconds) restore drill: $(basename "$SQL")"
docker run -d --name "$NAME" --network none -e POSTGRES_PASSWORD=drill "$IMAGE" >/dev/null
for _ in $(seq 90); do
  docker exec "$NAME" pg_isready -U postgres -q 2>/dev/null && break
  sleep 2
done
sleep 3
docker exec "$NAME" createdb -U postgres -T template0 drill

gunzip -c "$SQL" | docker exec -i "$NAME" psql -q -U postgres -d drill -v ON_ERROR_STOP=1 >/dev/null

read -r users messages topics files < <(docker exec "$NAME" psql -U postgres -d drill -At -F ' ' -c \
  "SELECT (SELECT count(*) FROM users), (SELECT count(*) FROM messages), (SELECT count(*) FROM topics), (SELECT count(*) FROM files)")
echo "    SQL restore OK: users=$users messages=$messages topics=$topics files=$files"
(( users >= MIN_USERS )) || { echo "Error: restored DB has $users users (< $MIN_USERS)" >&2; exit 1; }

if [[ -f "$RUSTFS" ]]; then
  gzip -t "$RUSTFS"
  echo "    RustFS archive OK: $(tar -tzf "$RUSTFS" | grep -vc '/$') entries ($(du -h "$RUSTFS" | cut -f1))"
else
  latest_rustfs="$(ls -t "$(dirname "$SQL")"/panachat-*.rustfs.tar.gz 2>/dev/null | head -1 || true)"
  echo "    Warning: no RustFS archive for this dump; newest is ${latest_rustfs:+$(basename "$latest_rustfs")}${latest_rustfs:-none}"
fi
echo "==> Drill passed"
