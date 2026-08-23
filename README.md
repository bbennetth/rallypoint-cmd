# Rallypoint `cmd`

A self-hosted web panel for Steam dedicated game servers — an AMP-style console that installs,
starts/stops, monitors, configures, backs up, and updates game servers via SteamCMD + systemd.
Single binary of responsibility: one small Node service (Hono + SQLite) serving a React SPA in a
disposable, unprivileged Proxmox LXC, with each game server confined to its own sandboxed systemd
unit.

A fresh install starts with an **empty server list** — you add games from the panel and each one
installs into `/opt/games/<slug>` under its own `rallypoint-game@<slug>.service` unit.

## Supported games

| Game | Steam app | Support | ~Disk |
|---|---|---|---|
| Palworld | 2394010 | **Full** — settings editor, players (kick/ban/announce), world backups + restore, `.pak` mods | 12 GB |
| Valheim | 896660 | Basic | 2 GB |
| Rust | 258550 | Basic | 35 GB |
| ARK: Survival Evolved | 376030 | Basic | 100 GB |
| 7 Days to Die | 294420 | Basic | 15 GB |
| Project Zomboid | 380870 | Basic | 5 GB |
| Satisfactory | 1690800 | Basic | 15 GB |
| Team Fortress 2 | 232250 | Basic | 25 GB |
| Counter-Strike 2 | 730 | Basic | 35 GB |
| Enshrouded | 2278520 | **Full** — settings editor, world backups + restore (Windows build run under Wine) | 8 GB |
| Unturned | 1110390 | Basic | 8 GB |

**Basic** = install/update via SteamCMD, start/stop/restart, live console, restart schedules.
**Full** adds the game's admin API (players, announcements), a structured settings editor,
world-aware backup/restore, and mod management. The registry lives in
[`packages/shared/src/games.ts`](packages/shared/src/games.ts) — every game is a data entry, so
deepening support for a game is adapter work, not a rewrite.

## Deployment

### Proxmox VE (recommended, one line)

Run on the Proxmox host as root — creates an unprivileged Debian 13 LXC and provisions
everything (Node 22, SteamCMD, Wine, the panel):

```bash
bash -c "$(curl -fsSL https://raw.githubusercontent.com/bbennetth/rallypoint-cmd/main/ct/rallypoint-cmd.sh)"
```

This is a [Proxmox VE Helper-Scripts](https://community-scripts.org/docs/contribution) style
installer: it runs on the community-scripts engine, so it behaves like every other script in that
ecosystem.

- **Defaults**: 6 cores / 16 GiB RAM / 64 GiB disk. Size the disk for the games you plan to run
  (see the table above — ARK alone wants ~100 GB).
- **Change anything**: pick **Advanced** at the first prompt for the full wizard (CT id, hostname,
  storage, bridge, static IP/VLAN/MTU, DNS, timezone, SSH keys). The wizard can save your answers
  as defaults for next time.
- **Unattended**: set `var_*` variables up front, e.g.
  `var_cpu=8 var_ram=24576 var_disk=80 var_admin_user=admin var_admin_password=hunter2 bash -c "$(...)"`.
  Panel-specific ones are `var_panel_port`, `var_panel_bind`, `var_admin_user`, `var_admin_password`
  (empty generates one).
- **Debugging**: `dev_mode=trace,keep,logs` (also `pause`, `net`, `timing`) — see the
  [dev mode guide](https://community-scripts.org/docs/dev_mode).
- **Update in place**: re-run the exact same line *inside* the CT (`pct enter <ctid>`). It checks
  GitHub Releases, and updates only if there's a newer one; game servers keep running.

It prints the panel URL and admin login at the end. Log in, **Add server**, pick a game — the panel
runs the SteamCMD install with live progress and writes that game's systemd unit itself. There is
no separate provisioning step.

### Any Debian/Ubuntu host (manual)

[`install/rallypoint-cmd-install.sh`](install/rallypoint-cmd-install.sh) is the source of truth —
it runs inside the container and its steps translate directly to any systemd distro:

1. **Prereqs**: Node ≥ 22, `dpkg --add-architecture i386` + `lib32gcc-s1 lib32stdc++6`
   (SteamCMD is 32-bit), `curl tar xz-utils rsync`, and `wine` for Windows-only servers.
2. **Dirs**: `/opt/games`, `/opt/steamcmd`, `/var/lib/rallypoint-cmd`,
   `/var/backups/rallypoint-cmd`, `/etc/rallypoint-cmd`.
3. **SteamCMD** (shared, game-neutral): untar to `/opt/steamcmd`.
4. **Panel**: unpack a release artifact to `/opt/rallypoint-cmd`, then `npm ci --omit=dev`.
   (Releases ship prebuilt server + web dists, so the host never runs a build.)
5. **systemd**: install `deploy/systemd/rallypoint-cmd.service` and
   `deploy/systemd/rallypoint-game@.service`.
6. **Config**: write `/etc/rallypoint-cmd/panel.env` (see [Configuration](#configuration)),
   `systemctl enable --now rallypoint-cmd`.

### Local dev / evaluation (no game server needed)

Mock mode fakes every game-facing integration (systemd, SteamCMD, the game's admin API) over a
sandbox in `./data`, so the whole panel runs on a laptop:

```bash
npm install
PANEL_MODE=mock npm run dev:server     # API on :8080 (admin password printed on first boot)
npm run dev:web                        # Vite SPA on :5173, proxies /api → :8080
```

`npm run check` runs lint + typecheck + unit tests; `npm run e2e` runs the Playwright suite
against a mock-mode build.

### Updating a deployed panel

- **From the panel UI**: Updates → the Rallypoint card checks GitHub Releases, verifies the
  artifact, swaps it in and restarts.
- **From the installer**: re-run the one-liner inside the CT (`pct enter <ctid>`).
- **Workstation push** (local dev, no release cut): `PVE_HOST=root@<pve> CTID=<id> bash deploy/update-panel.sh`.

Both of the first two consume the same GitHub Release and record the installed version in
`/root/.rallypoint-cmd`, so they never disagree about what is deployed.

> **Upgrading from 0.2.x:** 0.3.0 changed the deployment model (the panel and game servers now run
> as root inside the unprivileged container; the `rallypoint` user, its sudoers file and the
> `/usr/local/bin/rallypoint-cmd-*` helpers are gone). There is no in-place migration — back up your
> worlds from the panel, create a fresh container with the one-liner, and restore.

## Remote access

The panel binds `0.0.0.0:<PANEL_PORT>` (default 8080) — reachable on your LAN over plain HTTP out
of the box. It is a single-admin panel with peppered-scrypt auth, CSRF protection, and rate
limiting, but **don't port-forward it raw**; pick one of these for access from outside:

### Option A — VPN (simplest)

Tailscale, WireGuard, or any overlay network into the LAN. No panel config changes needed; keep
the defaults (`COOKIE_SECURE=false`, `TRUSTED_PROXY=false`).

### Option B — Cloudflare Tunnel

Runs `cloudflared` inside the CT/host; no inbound ports, TLS and (optionally) Cloudflare Access
in front.

```bash
# inside the CT/host
cloudflared tunnel create rallypoint
cloudflared tunnel route dns rallypoint panel.example.com
# config: ingress panel.example.com → http://127.0.0.1:8080
cloudflared service install
```

Then in `/etc/rallypoint-cmd/panel.env`:

```ini
COOKIE_SECURE=true      # session cookie gets __Host- + Secure (you're on HTTPS now)
TRUSTED_PROXY=true      # rate-limit by the forwarded client IP, not the tunnel's
PANEL_HOST=127.0.0.1    # optional: drop plain-HTTP LAN access entirely
```

…and `systemctl restart rallypoint-cmd`. Note: once `COOKIE_SECURE=true`, plain-HTTP logins
(e.g. `http://<lan-ip>:8080`) stop working — that's the point.

The SSE streams (console, install progress) send 15 s heartbeats, so they survive proxy idle
timeouts, including Cloudflare's ~100 s.

### Option C — Generic HTTPS reverse proxy

Caddy, nginx, Traefik on the same host or in front of it. Example (Caddy):

```
panel.example.com {
    reverse_proxy 127.0.0.1:8080
}
```

Same `panel.env` changes as Option B (`COOKIE_SECURE=true`, `TRUSTED_PROXY=true`). The panel
reads the client IP from `X-Forwarded-For` (or `CF-Connecting-IP`) only when
`TRUSTED_PROXY=true` — leave it `false` unless a proxy you control is actually in front,
otherwise the header is spoofable.

Whatever you pick: a game's own admin API (e.g. Palworld's REST on `127.0.0.1:8212`) always stays
on loopback — the browser only ever talks to the panel, which proxies it.

## Public access for players (playit.gg)

Exposing the *panel* is separate from exposing the *game*. If you can't (or don't want to)
port-forward the game's UDP port, the dashboard's **Public access** card sets up a free
[playit.gg](https://playit.gg) tunnel:

1. **Enable public access** → the panel installs the playit agent (from its apt repo) and
   generates a claim code.
2. Approve the shown `playit.gg/claim/…` URL in your playit account.
3. The panel starts the agent and displays the public `host:port` players connect to.

Details worth knowing:

- The tunneled port is the game port of your first server that has one (for Palworld, the live
  `PublicPort` from its ini). If no UDP tunnel matches, create one at
  *playit.gg → account → tunnels* (UDP → `127.0.0.1:<game port>`); the panel picks up the
  address automatically.
- The agent secret is written to `/etc/playit/playit.toml` (mode 0600) and never enters the
  panel's logs — the diagnostics trace redacts it.
- **Disable** stops the agent; the Console toggle on the card shows the panel↔playit exchange and
  the agent's journal for debugging.

If you'd rather port-forward: forward the game's UDP port(s) from the table in
`packages/shared/src/games.ts` straight to the CT — the panel plays no part in that path.

## Configuration

`/etc/rallypoint-cmd/panel.env` (all optional unless marked; live defaults shown):

| Key | Default | Notes |
|---|---|---|
| `PANEL_MODE` | `live` | `mock` = fake integrations over `./data` (dev/e2e) |
| `PANEL_HOST` / `PANEL_PORT` | `0.0.0.0` / `8080` | bind address / port |
| `GAMES_ROOT` | `/opt/games` | each server installs to `GAMES_ROOT/<slug>` |
| `STEAMCMD_BIN` | `/opt/steamcmd/steamcmd.sh` | shared SteamCMD |
| `DATA_DIR` | `/var/lib/rallypoint-cmd` | SQLite DB, staging, ini history |
| `PANEL_BACKUP_DIR` | `/var/backups/rallypoint-cmd` | per-server subdirs |
| `WEB_DIST_DIR` | — | serve the built SPA from here (production) |
| `PANEL_PASSWORD_PEPPER` | — | **required in production** (random ≥16 chars) |
| `PANEL_ADMIN_USERNAME` / `PANEL_ADMIN_PASSWORD` | `admin` / generated | first-boot seed only; generated password printed once to the journal |
| `COOKIE_SECURE` | `false` | `true` behind HTTPS (see Remote access) |
| `TRUSTED_PROXY` | `false` | `true` only behind a proxy you control |
| `DISK_FLOOR_BYTES` | 5 GiB | free-space floor for installs/backups/uploads |

## Security model

- **The container is the boundary.** The panel and the game servers run as root inside an
  *unprivileged* LXC, so container-root is not host-root — this is the model every Proxmox VE
  Helper-Script uses. Treat the container as disposable and keep backups off it.
- **Game servers are sandboxed by systemd.** They execute third-party binaries and load
  user-supplied mods, so `rallypoint-game@<slug>` runs with `NoNewPrivileges`, `ProtectSystem=strict`,
  `ProtectHome`, `PrivateTmp` and kernel/cgroup protections. The only writable path is that game's
  own install dir, granted per instance via `ReadWritePaths`.
- **Unit files are never assembled from request input.** Start scripts and per-instance drop-ins are
  rendered from the game registry (`packages/shared/src/games.ts`), and every slug and unit name is
  checked against that registry's closed set before it reaches an argv.
- Session cookies + double-submit CSRF on every state-changing request; SQLite-backed login rate
  limiting; backups/mod uploads are streamed with byte caps and validated (zip-slip/bomb checks)
  before anything touches game dirs.

## Repository layout

```
apps/server/      Hono API + SSE + services (real & mock impls per integration)
apps/web/         React SPA (Vite), served by the server in production
packages/shared/  Zod contract + the game registry (games.ts)
ct/               Proxmox host-side script: container creation + update_script()
install/          In-container install script (run by ct/ via the engine)
json/             Catalog metadata for the community-scripts website
deploy/           systemd units + deploy README
e2e/              Playwright suite (runs against a mock-mode build)
```

More deployment detail: [`deploy/README.md`](deploy/README.md).
