#!/usr/bin/env bash
set -euo pipefail

APP_ROOT="/srv/meinprojekt/21-Challenge/VAULTS"
BACKUP_ROOT="/srv/meinprojekt/21-Challenge/backups/vaults"
STAMP="$(date -u +%Y%m%d-%H%M%S)"
WORKDIR="$(mktemp -d)"
ARCHIVE="${BACKUP_ROOT}/vaults-${STAMP}.tar.gz"

cleanup() {
  chmod -R u+w "$WORKDIR" 2>/dev/null || true
  rm -rf "$WORKDIR"
}
trap cleanup EXIT

install -d "$BACKUP_ROOT"
install -d \
  "$WORKDIR/etc/nginx/sites-available" \
  "$WORKDIR/etc/systemd/system" \
  "$WORKDIR/var/lib/kascoven-vaults" \
  "$WORKDIR/srv/meinprojekt/21-Challenge"

rsync -a \
  --exclude node_modules \
  --exclude .next \
  --exclude .toccata-mini-test \
  --exclude .git \
  "$APP_ROOT" \
  "$WORKDIR/srv/meinprojekt/21-Challenge/"

cp /etc/nginx/sites-available/vaults.kaslab.space \
  "$WORKDIR/etc/nginx/sites-available/vaults.kaslab.space"
cp /etc/systemd/system/kaslab-vaults.service \
  "$WORKDIR/etc/systemd/system/kaslab-vaults.service"
if [[ -f /var/lib/kascoven-vaults/vault-index.json ]]; then
  cp /var/lib/kascoven-vaults/vault-index.json \
    "$WORKDIR/var/lib/kascoven-vaults/vault-index.json"
fi

tar -C "$WORKDIR" -czf "$ARCHIVE" .
find "$BACKUP_ROOT" -type f -name 'vaults-*.tar.gz' -mtime +14 -delete

printf 'Created %s\n' "$ARCHIVE"
