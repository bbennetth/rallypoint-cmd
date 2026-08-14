# Deploying & updating the Rallypoint on Proxmox

**One command, run on the Proxmox VE host as root:**

```bash
bash -c "$(curl -fsSL https://raw.githubusercontent.com/bbennetth/rallypoint-cmd/main/ct/rallypoint-cmd.sh)"
```

That single self-contained script (`ct/rallypoint-cmd.sh`) does everything: creates an
unprivileged Debian 12 LXC (nesting + i386 multiarch), installs Node 22 + SteamCMD, creates
the `rallypoint` service user, clones + builds this panel, installs the systemd units + a
least-privilege sudoers rule, and starts it. **No game is installed** — the panel comes up with
an empty server list; you add a game (Palworld, Valheim, …) from the panel, which installs it
into `/opt/games/<slug>`. It prints the panel URL + login at the end.

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
deploy/systemd/rallypoint-cmd.service      # the panel service
deploy/systemd/rallypoint-game@.service    # template unit for game servers (rallypoint-game@<slug>)
deploy/bin/rallypoint-cmd-game             # root helper: provision a game unit (add|remove <slug>)
deploy/sudoers/rallypoint-cmd     # only systemctl {start,stop,restart} + journal tail (wildcard-free)
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
`npm run build`, refresh helper+sudoers, restart the panel. **The game servers keep
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

**Updating a game itself** is separate — do it from that server's panel page (Updates tab), which
stops the server, runs the appropriate SteamCMD `app_update … validate`, and restarts it.

## Access

The panel binds `0.0.0.0:8080` by default so `http://<ct-ip>:8080` works on the LAN
(override at install time with `PANEL_BIND=127.0.0.1` to bind loopback only). If you put it behind
an HTTPS reverse proxy, set `COOKIE_SECURE=true` (and `TRUSTED_PROXY=true` for correct rate-limit
keying) — and, if you no longer need LAN access, `PANEL_HOST=127.0.0.1` — in
`/etc/rallypoint-cmd/panel.env`, then restart `rallypoint-cmd`. A game's own admin API (e.g.
Palworld's REST on `127.0.0.1:8212`) stays on loopback and is never exposed.
