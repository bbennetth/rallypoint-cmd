# Deploying & updating Rallypoint cmd on Proxmox

**One command, run on the Proxmox VE host as root:**

```bash
bash -c "$(curl -fsSL https://raw.githubusercontent.com/bbennetth/rallypoint-cmd/main/ct/rallypoint-cmd.sh)"
```

This follows the [Proxmox VE Helper-Scripts](https://community-scripts.org/docs/contribution)
conventions: `ct/rallypoint-cmd.sh` runs on the host and sources the community-scripts engine
(`community-scripts/core`), which creates the container and then runs
`install/rallypoint-cmd-install.sh` inside it.

Between them they create an unprivileged Debian 13 LXC, enable i386 multiarch, install Node 22,
SteamCMD and Wine, unpack a prebuilt release of the panel into `/opt/rallypoint-cmd`, write
`/etc/rallypoint-cmd/panel.env` and the systemd units, and start the panel. **No game is
installed** — the panel comes up with an empty server list; you add a game (Palworld, Valheim, …)
from the panel, which installs it into `/opt/games/<slug>` and writes that game's systemd unit.
The panel URL and login are printed at the end.

Defaults: 6 cores / 16 GiB / 64 GiB. Pick **Advanced** at the first prompt for the full wizard, or
set `var_*` variables inline for an unattended run:

```bash
var_cpu=8 var_ram=24576 var_disk=80 var_admin_user=admin var_admin_password=hunter2 \
  bash -c "$(curl -fsSL .../ct/rallypoint-cmd.sh)"
```

Panel-specific variables: `var_panel_port`, `var_panel_bind`, `var_admin_user`,
`var_admin_password` (empty generates one). Everything else — CT id, hostname, storage, bridge,
static IP, VLAN, MTU, DNS, timezone, SSH keys — comes from the engine; see the
[contribution docs](https://community-scripts.org/docs/contribution/templates_ct/appname).

To debug an install, prefix `dev_mode=trace,keep,logs` (see the
[dev mode guide](https://community-scripts.org/docs/dev_mode)).

## Files

```
ct/rallypoint-cmd.sh                     # host-side: container creation + update_script()
install/rallypoint-cmd-install.sh        # in-container install (run by ct/ via the engine)
json/rallypoint-cmd.json                 # catalog metadata for the community-scripts website
deploy/systemd/rallypoint-cmd.service    # the panel service
deploy/systemd/rallypoint-game@.service  # sandboxed template unit for game servers
deploy/update-panel.sh                   # optional: workstation -> CT push for local dev
```

Per-game units are not checked in: the panel renders each game's start script
(`/etc/rallypoint-cmd/games/<slug>/start.sh`) and drop-in
(`/etc/systemd/system/rallypoint-game@<slug>.service.d/instance.conf`) from the game registry in
`packages/shared/src/games.ts` when you add a server.

## Updating

Releases are cut by tagging (`git tag v0.3.0 && git push --tags` →
`.github/workflows/release.yml` builds and attaches `rallypoint-cmd-<tag>.tar.gz`, which carries
the prebuilt server and web dists). Both update paths consume that artifact and record the
installed version in `/root/.rallypoint-cmd`, so they never disagree about what is deployed.

**From the panel:** Updates → the **Rallypoint** card. The panel checks GitHub Releases daily
(badge on the Updates tab when one is available); clicking Update downloads the artifact, verifies
it (size and entry caps, path traversal guards, `release.json` matches the tag, the dists are
present), swaps it over `/opt/rallypoint-cmd`, installs prod dependencies, refreshes the systemd
units and restarts. The panel restarts itself; game servers keep running.

**From the installer:** re-run the same one-liner _inside_ the CT. The engine sees an existing
install and calls `update_script()`, which checks GitHub Releases and only acts if there is a
newer one.

```bash
pct enter <ctid>
bash -c "$(curl -fsSL https://raw.githubusercontent.com/bbennetth/rallypoint-cmd/main/ct/rallypoint-cmd.sh)"
```

**No release cut / local dev?** From the repo root on your workstation:

```bash
PVE_HOST=root@192.168.1.10 CTID=<ctid> bash deploy/update-panel.sh
```

Tars the working tree, ships it through the Proxmox host into the CT, builds, restarts.

**Updating a game itself** is separate — do it from that server's panel page (Updates tab), which
stops the server, runs the appropriate SteamCMD `app_update … validate`, and restarts it.

## Access

The panel binds `0.0.0.0:8080` by default so `http://<ct-ip>:8080` works on the LAN (override at
install time with `var_panel_bind=127.0.0.1` to bind loopback only). If you put it behind an HTTPS
reverse proxy, set `COOKIE_SECURE=true` (and `TRUSTED_PROXY=true` for correct rate-limit keying) —
and, if you no longer need LAN access, `PANEL_HOST=127.0.0.1` — in
`/etc/rallypoint-cmd/panel.env`, then restart `rallypoint-cmd`. A game's own admin API (e.g.
Palworld's REST on `127.0.0.1:8212`) stays on loopback and is never exposed.

## Upgrading from 0.2.x

0.3.0 changed the deployment model: the panel and game servers now run as root inside the
unprivileged container, and the `rallypoint` service user, its sudoers file and the
`/usr/local/bin/rallypoint-cmd-*` root helpers are gone. There is no in-place migration — back up
your worlds from the panel, create a fresh container with the one-liner, and restore.
