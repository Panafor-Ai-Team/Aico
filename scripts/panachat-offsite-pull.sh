#!/usr/bin/env bash
# Pull Panachat backups from production (kamyar) to this host.
# The key is restricted on prod to `rrsync -ro /var/lib/panachat/backups/`.
# No --delete: a wipe on prod must never propagate here. Local retention below.
set -euo pipefail
SRC_HOST="${PANACHAT_OFFSITE_SRC:-panachat@5.135.244.12}"
DEST="${PANACHAT_OFFSITE_DEST:-/var/lib/panachat-offsite/kamyar}"
KEEP_DAYS="${PANACHAT_OFFSITE_KEEP_DAYS:-90}"
echo "==> $(date -Iseconds) pull $SRC_HOST -> $DEST"
rsync -a --partial --timeout=300 --include="panachat-*" --include="backup.log" --exclude="*" \
  -e "ssh -i $HOME/.ssh/offsite_pull -o BatchMode=yes -o IdentitiesOnly=yes" \
  "$SRC_HOST:" "$DEST/"
find "$DEST" -maxdepth 1 -name "panachat-*" -type f -mtime "+$KEEP_DAYS" -print -delete
latest="$(ls -t "$DEST"/panachat-*.sql.gz 2>/dev/null | head -1 || true)"
[[ -n "$latest" ]] || { echo "Error: no SQL dump present" >&2; exit 1; }
age_h=$(( ( $(date +%s) - $(stat -c %Y "$latest") ) / 3600 ))
echo "    latest: $(basename "$latest") (${age_h}h old), total $(du -sh "$DEST" | cut -f1)"
(( age_h <= 30 )) || { echo "Error: newest dump is ${age_h}h old — prod backups may be failing" >&2; exit 1; }
