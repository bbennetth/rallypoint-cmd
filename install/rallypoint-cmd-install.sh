#!/usr/bin/env bash
# Copyright (c) 2021-2026 community-scripts ORG
# Author: bbennetth
# License: MIT | https://github.com/bbennetth/rallypoint-cmd/raw/main/LICENSE
# Source: https://github.com/bbennetth/rallypoint-cmd

# shellcheck disable=SC1091 # functions are piped in by the ct script
source /dev/stdin <<<"$FUNCTIONS_FILE_PATH"
color
verb_ip6
catch_errors
setting_up_container
network_check
update_os

# SteamCMD ships 32-bit binaries only, so i386 multiarch is a hard
# requirement before any of the lib32 packages below will resolve.
msg_info "Enabling i386 multiarch"
dpkg --add-architecture i386
$STD apt update
msg_ok "Enabled i386 multiarch"

msg_info "Installing Dependencies"
# python3/make/g++ are here because better-sqlite3 falls back to a
# node-gyp build when no prebuilt binary matches the running Node.
$STD apt install -y \
  lib32gcc-s1 lib32stdc++6 \
  xz-utils rsync procps \
  python3 make g++
msg_ok "Installed Dependencies"

# Enshrouded's dedicated server is a Windows-only binary run under Wine.
# Package names differ across Debian releases (bookworm splits wine64 and
# wine32; later releases ship a single multi-arch wine), so try the split
# set first and fall back. Fail loudly: a silent miss only surfaces later
# as "exec: wine: not found" when a Windows-only server starts.
msg_info "Installing Wine"
$STD apt install -y wine wine64 wine32:i386 ||
  $STD apt install -y wine wine32:i386 ||
  $STD apt install -y wine
if ! command -v wine64 >/dev/null 2>&1 && ! command -v wine >/dev/null 2>&1; then
  msg_error "Wine did not install — Windows-only servers (Enshrouded) will not start."
  exit 1
fi
msg_ok "Installed Wine"

NODE_VERSION="22" setup_nodejs

fetch_and_deploy_gh_release "rallypoint-cmd" "bbennetth/rallypoint-cmd" "prebuild" "latest" "/opt/rallypoint-cmd" "rallypoint-cmd-*.tar.gz"

msg_info "Installing Panel Dependencies"
cd /opt/rallypoint-cmd || exit
$STD npm ci --omit=dev --no-audit --no-fund
msg_ok "Installed Panel Dependencies"

msg_info "Installing SteamCMD"
# Shared by every game and game-neutral, so it lives at /opt/steamcmd
# rather than under any one game's install dir. No game is installed
# here — the panel installs games on demand into /opt/games/<slug>.
mkdir -p /opt/steamcmd /opt/games /var/lib/rallypoint-cmd /var/backups/rallypoint-cmd /etc/rallypoint-cmd
curl -fsSL https://steamcdn-a.akamaihd.net/client/installer/steamcmd_linux.tar.gz | tar zxf - -C /opt/steamcmd
msg_ok "Installed SteamCMD"

# Read what the caller passed before prompting, so an unattended install
# never stops at a question nobody is there to answer.
if [[ -z "${var_admin_user:-}" ]]; then
  read -r -p "${TAB3}Panel admin username: " var_admin_user
fi
var_admin_user="${var_admin_user:-admin}"

msg_info "Configuring Rallypoint cmd"
# Alphanumeric only: these land in an env file that is sourced, so any
# shell metacharacter would have to be escaped.
[[ -n "${var_admin_password:-}" ]] || var_admin_password="$(openssl rand -base64 24 | tr -dc 'a-zA-Z0-9' | head -c 16)"
PANEL_PEPPER="$(openssl rand -base64 48 | tr -dc 'a-zA-Z0-9' | head -c 32)"

cat <<EOF >/etc/rallypoint-cmd/panel.env
NODE_ENV=production
PANEL_MODE=live
# 0.0.0.0 = reachable on the LAN (default). 127.0.0.1 binds loopback only,
# e.g. when a reverse proxy on the host fronts the panel.
PANEL_HOST=${var_panel_bind:-0.0.0.0}
PANEL_PORT=${var_panel_port:-8080}
GAMES_ROOT=/opt/games
DATA_DIR=/var/lib/rallypoint-cmd
PANEL_BACKUP_DIR=/var/backups/rallypoint-cmd
STEAMCMD_BIN=/opt/steamcmd/steamcmd.sh
WEB_DIST_DIR=/opt/rallypoint-cmd/apps/web/dist
PANEL_PASSWORD_PEPPER=${PANEL_PEPPER}
PANEL_ADMIN_USERNAME=${var_admin_user}
PANEL_ADMIN_PASSWORD=${var_admin_password}
# LAN is plain http, so secure cookies stay off and no proxy is trusted.
# Behind an HTTPS reverse proxy set both to true.
COOKIE_SECURE=false
TRUSTED_PROXY=false
EOF
chmod 0640 /etc/rallypoint-cmd/panel.env
msg_ok "Configured Rallypoint cmd"

msg_info "Creating Service"
install -m 0644 /opt/rallypoint-cmd/deploy/systemd/rallypoint-cmd.service /etc/systemd/system/rallypoint-cmd.service
# Template unit for game servers. The panel writes each instance's
# start script and drop-in when a server is added.
install -m 0644 /opt/rallypoint-cmd/deploy/systemd/rallypoint-game@.service /etc/systemd/system/rallypoint-game@.service
systemctl enable -q --now rallypoint-cmd
msg_ok "Created Service"

motd_ssh
customize
cleanup_lxc
