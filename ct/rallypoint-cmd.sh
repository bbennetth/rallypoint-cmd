#!/usr/bin/env bash
# Copyright (c) 2026 Byron Howell — MIT
# Rallypoint — a web manager for self-hosted Steam game servers, in one Debian 12 Proxmox LXC.
#
# One-line install, run ON the Proxmox VE host as root:
#   bash -c "$(curl -fsSL https://raw.githubusercontent.com/bbennetth/rallypoint-cmd/main/ct/rallypoint-cmd.sh)"
#
# Re-run the same line INSIDE the container (pct enter <id>) to update in place.
# Override any default with an env var, e.g. CTID=210 RAM=24576 DISK=80 bash -c "$(...)".
# Preview only (creates nothing): DRYRUN=1 bash -c "$(curl -fsSL .../ct/rallypoint-cmd.sh)".
# See raw command output while it runs: VERBOSE=1 bash -c "$(...)".
# Tunnel-only (no LAN exposure): PANEL_BIND=127.0.0.1 bash -c "$(...)".

set -euo pipefail

# --- config (env-overridable) ----------------------------------------------
CTID="${CTID:-}"                         # empty = next free id
HN="${HN:-rallypoint-cmd}"
CORES="${CORES:-6}"
RAM="${RAM:-16384}"                      # MiB (headroom for a memory-hungry game)
SWAP="${SWAP:-4096}"
DISK="${DISK:-64}"                       # GiB (SteamCMD + games + backups)
STORAGE="${STORAGE:-local-lvm}"
TEMPLATE_STORAGE="${TEMPLATE_STORAGE:-local}"
BRIDGE="${BRIDGE:-vmbr0}"
NET_IP="${NET_IP:-dhcp}"                 # "dhcp" or CIDR e.g. 192.168.1.60/24
NET_GW="${NET_GW:-}"                     # required if NET_IP is static
CT_PASSWORD="${CT_PASSWORD:-}"           # CT root pw; empty = random
TZ_REGION="${TZ_REGION:-Etc/UTC}"
PANEL_PORT="${PANEL_PORT:-8080}"
PANEL_BIND="${PANEL_BIND:-0.0.0.0}"      # LAN by default; 127.0.0.1 = tunnel-only
PANEL_ADMIN_USER="${PANEL_ADMIN_USER:-admin}"
PANEL_ADMIN_PASSWORD="${PANEL_ADMIN_PASSWORD:-}"  # empty = random (printed once)
PANEL_REPO_URL="${PANEL_REPO_URL:-https://github.com/bbennetth/rallypoint-cmd.git}"
PANEL_REPO_REF="${PANEL_REPO_REF:-main}"
DRYRUN="${DRYRUN:-}"                      # set to 1 to print the plan and exit (no changes)
VERBOSE="${VERBOSE:-}"                    # set to 1 to show raw pveam/pct/apt/node output

# --- output helpers (Proxmox-helper style) ---------------------------------
if [[ -t 1 ]]; then YW=$'\e[33m'; GN=$'\e[1;92m'; RD=$'\e[31m'; BL=$'\e[36m'; CL=$'\e[0m'; else YW=; GN=; RD=; BL=; CL=; fi
msg_info() { echo -e " ${BL}➜${CL} ${YW}$*${CL}"; }
msg_ok()   { echo -e " ${GN}✓${CL} $*"; }
die()      { echo -e " ${RD}✗ $*${CL}" >&2; exit 1; }
# `head -c` closes the pipe early → `tr` takes SIGPIPE (141); under
# `set -o pipefail` + `set -e` that would abort the script. `|| true`
# contains it so randpw always succeeds with its 24 captured chars.
randpw()   { tr -dc 'A-Za-z0-9' </dev/urandom 2>/dev/null | head -c 24 || true; }
# $STD prefixes noisy commands: quiet by default, raw output when VERBOSE=1.
if [[ -n "$VERBOSE" ]]; then STD=""; else STD="qt"; fi
qt() { "$@" >/dev/null 2>&1; }

# --- update mode: same command re-run INSIDE the container ------------------
if [[ -f /etc/rallypoint-cmd/panel.env ]]; then
  if [[ -n "$DRYRUN" ]]; then
    echo -e " ${YW}[dry-run]${CL} update mode: would git fetch+reset to '${PANEL_REPO_REF}', npm ci && build, then restart rallypoint-cmd.service. No changes made."
    exit 0
  fi
  msg_info "Updating the panel in place (the game keeps running)"
  cd /opt/rallypoint-cmd
  git config --global --add safe.directory /opt/rallypoint-cmd 2>/dev/null || true
  git fetch --depth 1 origin "$PANEL_REPO_REF"
  git reset --hard "origin/$PANEL_REPO_REF"
  npm ci && npm run build
  # Refresh the self-update helper + sudoers (new installs of both may
  # arrive via git updates; existing CTs pick them up here).
  command -v rsync >/dev/null || apt-get -qq -y install rsync >/dev/null 2>&1 || true
  install -m 0755 -o root -g root deploy/bin/rallypoint-cmd-apply-update /usr/local/bin/rallypoint-cmd-apply-update
install -m 0755 -o root -g root deploy/bin/rallypoint-cmd-playit /usr/local/bin/rallypoint-cmd-playit
  install -m 0755 -o root -g root deploy/bin/rallypoint-cmd-game /usr/local/bin/rallypoint-cmd-game
  install -m 0644 deploy/systemd/rallypoint-game@.service /etc/systemd/system/rallypoint-game@.service
  install -m 0440 -o root -g root deploy/sudoers/rallypoint-cmd /etc/sudoers.d/rallypoint-cmd
  visudo -cf /etc/sudoers.d/rallypoint-cmd >/dev/null
  systemctl daemon-reload
  chown -R root:rallypoint /opt/rallypoint-cmd && chmod -R g-w /opt/rallypoint-cmd
  # Migrate SteamCMD to its game-neutral home (idempotent): the multi-game
  # panel shares one SteamCMD across games, so it no longer lives under
  # /opt/palworld. Ownership travels with the move.
  if [[ -d /opt/palworld/steamcmd && ! -e /opt/steamcmd ]]; then
    mv /opt/palworld/steamcmd /opt/steamcmd
  fi
  if [[ -d /opt/steamcmd ]]; then
    sed -i 's|^STEAMCMD_BIN=/opt/palworld/steamcmd/steamcmd.sh$|STEAMCMD_BIN=/opt/steamcmd/steamcmd.sh|' /etc/rallypoint-cmd/panel.env
  fi
  systemctl restart rallypoint-cmd.service
  msg_ok "Panel updated"
  exit 0
fi

# --- host preflight ---------------------------------------------------------
[[ "$NET_IP" == "dhcp" || -n "$NET_GW" ]] || die "Static NET_IP set but NET_GW is empty."
[[ -n "$CT_PASSWORD" ]] || CT_PASSWORD="$(randpw)"
if [[ -n "$PANEL_ADMIN_PASSWORD" ]]; then AP_PROVIDED=1; else PANEL_ADMIN_PASSWORD="$(randpw)"; AP_PROVIDED=0; fi
PANEL_PEPPER="$(randpw)$(randpw)"

HAVE_PCT=0; command -v pct >/dev/null && HAVE_PCT=1
if [[ -z "$DRYRUN" ]]; then
  [[ $EUID -eq 0 ]] || die "Run as root on the Proxmox VE host."
  [[ $HAVE_PCT -eq 1 ]] || die "'pct' not found — run this on a Proxmox VE host."
fi

echo -e "\n ${GN}Rallypoint${CL} — Proxmox VE one-line installer\n"

# --- resolve id / network / template (read-only) ---------------------------
if [[ -z "$CTID" ]]; then
  CTID="$([[ $HAVE_PCT -eq 1 ]] && pvesh get /cluster/nextid 2>/dev/null || echo '<next-free>')"
fi
[[ $HAVE_PCT -eq 1 ]] && pct status "$CTID" &>/dev/null && die "CT $CTID already exists."
NETCONF="name=eth0,bridge=$BRIDGE"
[[ "$NET_IP" == "dhcp" ]] && NETCONF+=",ip=dhcp" || NETCONF+=",ip=$NET_IP,gw=$NET_GW"

msg_info "Locating Debian 12 template"
TEMPLATE=""
[[ $HAVE_PCT -eq 1 ]] && TEMPLATE="$(pveam list "$TEMPLATE_STORAGE" 2>/dev/null | awk '/debian-12-standard/{print $1}' | sort | tail -n1)"
if [[ -z "$TEMPLATE" ]]; then
  if [[ -n "$DRYRUN" ]]; then
    TEMPLATE="$TEMPLATE_STORAGE:vztmpl/debian-12-standard-* (would download if missing)"
  else
    $STD pveam update
    NAME="$(pveam available --section system | awk '/debian-12-standard/{print $2}' | sort | tail -n1)"
    [[ -n "$NAME" ]] || die "No debian-12-standard template available."
    msg_info "Downloading template $NAME"
    $STD pveam download "$TEMPLATE_STORAGE" "$NAME"
    TEMPLATE="$TEMPLATE_STORAGE:vztmpl/$NAME"
  fi
fi
msg_ok "Template: $TEMPLATE"

# --- dry-run: print the plan and stop (no changes) --------------------------
if [[ -n "$DRYRUN" ]]; then
  ap_display="$([[ $AP_PROVIDED -eq 1 ]] && echo "$PANEL_ADMIN_PASSWORD" || echo '<auto-generated on install>')"
  cat <<PLAN
 ${YW}[dry-run]${CL} No changes made. Would create CT ${CTID}:
   hostname ...... $HN
   resources ..... $CORES cores / $RAM MiB RAM / $SWAP MiB swap / $DISK GiB on $STORAGE
   flags ......... unprivileged, nesting=1, onboot=1
   network ....... $NETCONF
   template ...... $TEMPLATE
   panel ......... http://<ct-ip>:$PANEL_PORT  bind=$PANEL_BIND  (login: $PANEL_ADMIN_USER / ${ap_display})
   source ........ $PANEL_REPO_URL @ $PANEL_REPO_REF

 Host command:
   pct create $CTID $TEMPLATE --hostname $HN --cores $CORES --memory $RAM \\
     --swap $SWAP --rootfs $STORAGE:$DISK --net0 $NETCONF \\
     --unprivileged 1 --features nesting=1 --onboot 1 --ostype debian --timezone host

 Then inside the CT: i386 multiarch + Node 22 + SteamCMD, create the rallypoint
 user, clone & build the panel, install systemd units / sudoers / panel.env,
 lock down code (root:rallypoint, group-ro), enable + start rallypoint-cmd.
 No game is installed — add one from the panel after it is up.
PLAN
  exit 0
fi

# --- create + start the LXC -------------------------------------------------
msg_info "Creating LXC $CTID ($HN): ${CORES} cores / ${RAM} MiB / ${DISK} GiB"
$STD pct create "$CTID" "$TEMPLATE" \
  --hostname "$HN" --cores "$CORES" --memory "$RAM" --swap "$SWAP" \
  --rootfs "$STORAGE:$DISK" --net0 "$NETCONF" \
  --unprivileged 1 --features nesting=1 --onboot 1 --ostype debian \
  --password "$CT_PASSWORD" --timezone host
pct start "$CTID"

# Readiness = the CT can resolve a hostname (what apt needs). This beats a
# `ping` probe: getent is always present (ping often isn't in the minimal
# template) and ICMP is frequently blocked, so ping fails even when the
# network is fine. On timeout, dump real diagnostics instead of a bare error.
msg_info "Waiting for the container network"
NET_OK=0
for i in $(seq 1 30); do
  if pct exec "$CTID" -- getent hosts deb.debian.org >/dev/null 2>&1; then NET_OK=1; break; fi
  [[ -n "$VERBOSE" ]] && echo "   probe $i/30: no DNS resolution yet"
  sleep 2
done
if [[ $NET_OK -eq 0 ]]; then
  echo -e " ${RD}✗ Container $CTID has no working network/DNS after 60s.${CL}" >&2
  echo "   --- diagnostics (CT $CTID) ---" >&2
  pct exec "$CTID" -- ip -4 addr show dev eth0 2>&1 | sed 's/^/   addr: /' >&2 || true
  pct exec "$CTID" -- ip -4 route show 2>&1     | sed 's/^/   route: /' >&2 || true
  pct exec "$CTID" -- cat /etc/resolv.conf 2>&1 | sed 's/^/   dns: /'   >&2 || true
  echo "   → Check bridge ($BRIDGE)/VLAN/DHCP, or pass a static NET_IP=<cidr> NET_GW=<gw>." >&2
  echo "   → The CT was created but not provisioned; remove it with:  pct destroy $CTID" >&2
  exit 1
fi
msg_ok "Container network is up"

# --- provision everything inside the CT (one inline pass) -------------------
msg_info "Installing Node, SteamCMD + the panel (several minutes)"
pct exec "$CTID" -- bash -s <<EOF
set -euo pipefail
export DEBIAN_FRONTEND=noninteractive
ln -sf "/usr/share/zoneinfo/$TZ_REGION" /etc/localtime
QT="$STD"; qt() { "\$@" >/dev/null 2>&1; }   # quiet unless VERBOSE (baked from host)

echo ">>> base packages + i386 multiarch (SteamCMD is 32-bit)"
dpkg --add-architecture i386
\$QT apt-get -qq update
\$QT apt-get -qq -y install curl ca-certificates tar xz-utils sudo git rsync \
  lib32gcc-s1 lib32stdc++6 python3 make g++ procps

echo ">>> Node.js 22"
if [[ -z "\$QT" ]]; then
  curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
else
  curl -fsSL https://deb.nodesource.com/setup_22.x | bash - >/dev/null 2>&1
fi
\$QT apt-get -qq -y install nodejs

echo ">>> rallypoint user + data dirs"
id rallypoint &>/dev/null || useradd -d /var/lib/rallypoint-cmd -m -s /bin/bash rallypoint
install -d -o rallypoint -g rallypoint -m 0755 /opt/games
install -d -o rallypoint -g rallypoint -m 0750 /var/lib/rallypoint-cmd /var/backups/rallypoint-cmd
install -d -o root -g rallypoint -m 0750 /etc/rallypoint-cmd

echo ">>> SteamCMD (panel-wide, game-neutral tool)"
# SteamCMD is shared by every game and lives at /opt/steamcmd (its Steam/
# state and logs land next to it). No game is installed here — the panel
# installs games on demand into /opt/games/<slug>.
install -d -o rallypoint -g rallypoint /opt/steamcmd
sudo -u rallypoint -H bash -c 'cd /opt/steamcmd && curl -sqL https://steamcdn-a.akamaihd.net/client/installer/steamcmd_linux.tar.gz | tar zxf -'

echo ">>> panel: clone + build"
git clone --depth 1 --branch "$PANEL_REPO_REF" "$PANEL_REPO_URL" /opt/rallypoint-cmd
cd /opt/rallypoint-cmd
npm ci
npm run build

echo ">>> systemd units + least-privilege sudoers"
install -m 0644 deploy/systemd/rallypoint-cmd.service /etc/systemd/system/rallypoint-cmd.service
# Template unit for game servers. The panel provisions instances
# automatically on server create (sudoers-pinned rallypoint-cmd-game).
install -m 0644 deploy/systemd/rallypoint-game@.service /etc/systemd/system/rallypoint-game@.service
install -m 0755 -o root -g root deploy/bin/rallypoint-cmd-apply-update /usr/local/bin/rallypoint-cmd-apply-update
install -m 0755 -o root -g root deploy/bin/rallypoint-cmd-playit /usr/local/bin/rallypoint-cmd-playit
install -m 0755 -o root -g root deploy/bin/rallypoint-cmd-game /usr/local/bin/rallypoint-cmd-game
mkdir -p /opt/games && chown rallypoint:rallypoint /opt/games
install -m 0440 -o root -g root deploy/sudoers/rallypoint-cmd /etc/sudoers.d/rallypoint-cmd
visudo -cf /etc/sudoers.d/rallypoint-cmd >/dev/null

echo ">>> panel environment"
cat > /etc/rallypoint-cmd/panel.env <<ENV
NODE_ENV=production
PANEL_MODE=live
# Bind address: 0.0.0.0 = reachable on the LAN (default). Set to 127.0.0.1
# for tunnel-only once cloudflared runs inside the CT.
PANEL_HOST=$PANEL_BIND
PANEL_PORT=$PANEL_PORT
GAMES_ROOT=/opt/games
DATA_DIR=/var/lib/rallypoint-cmd
BACKUP_DIR=/var/backups/rallypoint-cmd
STEAMCMD_BIN=/opt/steamcmd/steamcmd.sh
WEB_DIST_DIR=/opt/rallypoint-cmd/apps/web/dist
PANEL_PASSWORD_PEPPER=$PANEL_PEPPER
PANEL_ADMIN_USERNAME=$PANEL_ADMIN_USER
PANEL_ADMIN_PASSWORD=$PANEL_ADMIN_PASSWORD
PANEL_REPO_REF=$PANEL_REPO_REF
# LAN is plain http, so secure cookies stay OFF. After the Cloudflare Tunnel
# is up and you stop using http://<ct-ip>, set COOKIE_SECURE=true.
COOKIE_SECURE=false
TRUSTED_PROXY=true
ENV
chown root:rallypoint /etc/rallypoint-cmd/panel.env; chmod 0640 /etc/rallypoint-cmd/panel.env

echo ">>> lock down panel code (root:rallypoint, group-read-only) + start"
chown -R root:rallypoint /opt/rallypoint-cmd; chmod -R g-w /opt/rallypoint-cmd
systemctl daemon-reload
systemctl enable -q rallypoint-cmd.service
systemctl start rallypoint-cmd.service
EOF
msg_ok "Installed"

# --- summary ----------------------------------------------------------------
IP="$(pct exec "$CTID" -- hostname -I 2>/dev/null | awk '{print $1}')"
cat <<SUMMARY

 ${GN}Rallypoint is up.${CL}
   CT id / root pw : ${CTID}  /  ${CT_PASSWORD}
   Panel (LAN)     : http://${IP:-<container-ip>}:${PANEL_PORT}
   Login           : ${PANEL_ADMIN_USER} / ${PANEL_ADMIN_PASSWORD}

 Next: log in and add a game server from the panel. Then change the admin
 password, and add a Cloudflare Tunnel to
 http://127.0.0.1:${PANEL_PORT} and set COOKIE_SECURE=true.
 Update later: re-run this exact line inside the CT (pct enter ${CTID}).
SUMMARY
