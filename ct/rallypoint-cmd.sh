#!/usr/bin/env bash
# Scripts live in this repository; the engine comes from
# community-scripts/core. A local checkout of either wins over the network,
# so a fork or branch of core can be tested without editing this file.
COMMUNITY_SCRIPTS_URL="${COMMUNITY_SCRIPTS_URL:-https://raw.githubusercontent.com/bbennetth/rallypoint-cmd/main}"
_cs_boot="${COMMUNITY_SCRIPTS_CORE_DIR:-$(dirname "${BASH_SOURCE[0]}")/../../core}/core/build.func"
# shellcheck disable=SC1090 # engine path is resolved at run time, by design
source "$_cs_boot" 2>/dev/null || source <(curl -fsSL "${COMMUNITY_SCRIPTS_CORE_URL:-https://raw.githubusercontent.com/community-scripts/core/main}/core/build.func")
# Copyright (c) 2021-2026 community-scripts ORG
# Author: bbennetth
# License: MIT | https://github.com/bbennetth/rallypoint-cmd/raw/main/LICENSE
# Source: https://github.com/bbennetth/rallypoint-cmd

APP="Rallypoint-cmd"
var_tags="${var_tags:-gaming;steamcmd}"
var_cpu="${var_cpu:-6}"
var_ram="${var_ram:-16384}"
var_disk="${var_disk:-64}"
var_os="${var_os:-debian}"
var_version="${var_version:-13}"
# SteamCMD ships 32-bit x86 binaries only, so no game can be installed on
# arm64 regardless of what the panel itself would run on.
var_arm64="${var_arm64:-no}"
var_unprivileged="${var_unprivileged:-1}"

# Values the install script accepts up front. Without the export they stay
# on the host: lxc-attach carries the caller's environment, but only what
# was exported. Declared as app_vars in json/rallypoint-cmd.json.
export var_panel_port="${var_panel_port:-8080}"
export var_panel_bind="${var_panel_bind:-0.0.0.0}"
export var_admin_user="${var_admin_user:-admin}"
export var_admin_password="${var_admin_password:-}"

header_info "$APP"
variables
color
catch_errors

function update_script() {
  header_info
  check_container_storage
  check_container_resources

  if [[ ! -d /opt/rallypoint-cmd ]]; then
    msg_error "No ${APP} Installation Found!"
    exit
  fi

  if check_for_gh_release "rallypoint-cmd" "bbennetth/rallypoint-cmd"; then
    # Only the panel stops. Game servers run under their own units and
    # keep serving players across a panel update.
    msg_info "Stopping Panel"
    systemctl stop rallypoint-cmd
    msg_ok "Stopped Panel"

    # No create_backup here: everything the user owns lives outside the
    # app dir (/etc/rallypoint-cmd, /var/lib/rallypoint-cmd,
    # /var/backups/rallypoint-cmd, /opt/games), and CLEAN_INSTALL only
    # wipes /opt/rallypoint-cmd.
    CLEAN_INSTALL=1 fetch_and_deploy_gh_release "rallypoint-cmd" "bbennetth/rallypoint-cmd" "prebuild" "latest" "/opt/rallypoint-cmd" "rallypoint-cmd-*.tar.gz"

    msg_info "Installing Dependencies"
    cd /opt/rallypoint-cmd || exit
    $STD npm ci --omit=dev --no-audit --no-fund
    msg_ok "Installed Dependencies"

    msg_info "Updating Services"
    install -m 0644 /opt/rallypoint-cmd/deploy/systemd/rallypoint-cmd.service /etc/systemd/system/rallypoint-cmd.service
    install -m 0644 /opt/rallypoint-cmd/deploy/systemd/rallypoint-game@.service /etc/systemd/system/rallypoint-game@.service
    systemctl daemon-reload
    msg_ok "Updated Services"

    # Wine upgrades are NOT done here: the panel's Management page has a
    # Wine card that upgrades to WineHQ staging on demand (esync/fsync for
    # Windows-only servers). Fresh installs get staging from
    # install/rallypoint-cmd-install.sh.

    msg_info "Starting Panel"
    systemctl start rallypoint-cmd
    msg_ok "Started Panel"
    msg_ok "Updated successfully!"
  fi
  exit
}

start
build_container
description

msg_ok "Completed Successfully!\n"
echo -e "${CREATING}${GN}${APP} setup has been successfully initialized!${CL}"
echo -e "${INFO}${YW}Access it using the following URL:${CL}"
echo -e "${GATEWAY}${BGN}http://${IP}:${var_panel_port}${CL}"
