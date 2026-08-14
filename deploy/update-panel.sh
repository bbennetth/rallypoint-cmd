#!/usr/bin/env bash
#
# update-panel.sh — push a panel update from your workstation into the
# Proxmox LXC, WITHOUT needing a git remote. Use this for local dev
# iteration; for a normal git-based update just re-run
# `ct/rallypoint-cmd.sh` inside the CT (see deploy/README.md).
#
# It tars the working tree (excluding node_modules/dist/data/.git), ships
# it to the CT via the Proxmox host, then rebuilds + restarts the panel.
# The game servers are left running throughout.
#
# Usage (from the repo root, on your workstation):
#   PVE_HOST=root@192.168.1.10 CTID=210 bash deploy/update-panel.sh
#
# Env:
#   PVE_HOST  ssh target for the Proxmox VE host (required)
#   CTID      container id of the panel LXC (required)

set -euo pipefail

PVE_HOST="${PVE_HOST:?set PVE_HOST=root@your-proxmox-host}"
CTID="${CTID:?set CTID=<container id>}"
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

msg() { echo -e "\e[1;34m[*]\e[0m $*"; }
ok()  { echo -e "\e[1;32m[+]\e[0m $*"; }

TARBALL="$(mktemp -t panel-src-XXXXXX.tar.gz)"
trap 'rm -f "$TARBALL"' EXIT

msg "Packing working tree..."
tar czf "$TARBALL" -C "$REPO_ROOT" \
  --exclude='./node_modules' --exclude='*/node_modules' \
  --exclude='./**/dist' --exclude='dist' \
  --exclude='./apps/server/data' --exclude='data' \
  --exclude='.git' --exclude='playwright-report' --exclude='test-results' \
  .
ok "Packed $(du -h "$TARBALL" | awk '{print $1}')"

msg "Shipping to $PVE_HOST -> CT $CTID..."
scp -q "$TARBALL" "$PVE_HOST:/tmp/panel-src.tar.gz"
ssh "$PVE_HOST" "pct push $CTID /tmp/panel-src.tar.gz /tmp/panel-src.tar.gz && rm -f /tmp/panel-src.tar.gz"

msg "Rebuilding + restarting the panel in CT $CTID (game stays up)..."
ssh "$PVE_HOST" "pct exec $CTID -- bash -euo pipefail -c '
  rm -rf /opt/rallypoint-cmd-new && mkdir -p /opt/rallypoint-cmd-new
  tar xzf /tmp/panel-src.tar.gz -C /opt/rallypoint-cmd-new
  # Preserve the existing .git (if any) so git-based updates keep working.
  [ -d /opt/rallypoint-cmd/.git ] && cp -a /opt/rallypoint-cmd/.git /opt/rallypoint-cmd-new/.git || true
  rm -rf /opt/rallypoint-cmd && mv /opt/rallypoint-cmd-new /opt/rallypoint-cmd
  cd /opt/rallypoint-cmd
  npm ci
  npm run build
  chown -R root:rallypoint /opt/rallypoint-cmd
  chmod -R g-w /opt/rallypoint-cmd
  systemctl restart rallypoint-cmd.service
  rm -f /tmp/panel-src.tar.gz
'"
ok "Panel updated. (migrations run automatically on panel startup.)"
