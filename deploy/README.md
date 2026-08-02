# Deploying & updating the Rallypoint on Proxmox

**One command, run on the Proxmox VE host as root:**

```bash
bash -c "$(curl -fsSL https://raw.githubusercontent.com/bbennetth/rallypoint-cmd/main/ct/rallypoint-cmd.sh)"
```

That single self-contained script (`ct/rallypoint-cmd.sh`) does everything: creates an
unprivileged Debian 12 LXC (nesting + i386 multiarch), installs Node 22 + SteamCMD + the
Palworld dedicated server (app 2394010), clones + builds this panel, drops a REST-enabled
`PalWorldSettings.ini` with a generated admin password, installs the two systemd units + a
least-privilege sudoers rule, and starts it. It prints the panel URL + login at the end.

Defaults: 6 cores / 16 GiB / 64 GiB. Override with env vars inline, e.g.:

```bash
CTID=210 RAM=24576 DISK=80 NET_IP=192.168.1.60/24 NET_GW=192.168.1.1 \
  bash -c "$(curl -fsSL .../ct/rallypoint-cmd.sh)"
```

Common overrides: `CTID HN CORES RAM DISK STORAGE BRIDGE NET_IP NET_GW`
`PANEL_PORT PANEL_ADMIN_USER PANEL_ADMIN_PASSWORD PANEL_REPO_URL PANEL_REPO_REF`.

> Requires this repo to be reachable via git (default `github.com/bbennetth/rallypoint-cmd`). Before
> that first push exists, use the workstation pusher below.

## Files

```
ct/rallypoint-cmd.sh              # the single installer (host create + in-CT provision + update mode)
deploy/systemd/*.service          # palworld.service + rallypoint-cmd.service
deploy/sudoers/rallypoint-cmd     # only systemctl {start,stop,restart} + journal tail (wildcard-free)
deploy/config/PalWorldSettings.default.ini
deploy/update-panel.sh            # optional: workstation -> CT push for local dev (no git remote)
```

## Updating

**From the panel (preferred):** Updates → the **Rallypoint** card. The panel checks GitHub
Releases daily (badge on the Updates tab when one is available); clicking Update downloads the
prebuilt release artifact, verifies it, and applies it via the pinned root helper
(`/usr/local/bin/rallypoint-cmd-apply-update`, whitelisted in sudoers — the helper validates its
argument and `/opt/rallypoint-cmd` stays root-owned read-only). The panel restarts itself; the
game keeps running. Releases are cut by tagging (`git tag v0.2.0 && git push --tags` →
`.github/workflows/release.yml` builds + attaches the artifact).

> Self-update also installs system assets shipped in the release (pinned `rallypoint-cmd-*`
> helpers, the panel systemd unit, and sudoers — sudoers is visudo-validated before landing).
> Only CTs installed before v0.1.5 need ONE git-based update (below) to bootstrap; after that,
> everything arrives via the panel.

**Git-based:** re-run the same one-liner _inside_ the CT. It detects
`/etc/rallypoint-cmd/panel.env` and switches to update mode: `git reset --hard`, `npm ci`,
`npm run build`, refresh helper+sudoers, restart the panel. **The Palworld game process keeps
running.**

```bash
pct enter <ctid>
bash -c "$(curl -fsSL https://raw.githubusercontent.com/bbennetth/rallypoint-cmd/main/ct/rallypoint-cmd.sh)"
```

**No git remote / local dev?** From the repo root on your workstation:

```bash
PVE_HOST=root@192.168.1.10 CTID=<ctid> bash deploy/update-panel.sh
```

Tars the working tree, ships it through the Proxmox host into the CT, rebuilds, restarts.

**Updating the Palworld game itself** is separate — do it from the panel UI (Updates tab), which
stops the server, runs `app_update 2394010 validate`, and restarts it.

## Remote access

The panel binds `0.0.0.0:8080` by default so `http://<ct-ip>:8080` works on the LAN
(override at install time with `PANEL_BIND=127.0.0.1` for tunnel-only). For remote access add a
Cloudflare Tunnel ingress → `http://127.0.0.1:8080`, then set `COOKIE_SECURE=true` — and, if you
no longer need LAN access, `PANEL_HOST=127.0.0.1` — in `/etc/rallypoint-cmd/panel.env` and restart
`rallypoint-cmd`. Palworld's REST API stays on `127.0.0.1:8212` and is never exposed.
