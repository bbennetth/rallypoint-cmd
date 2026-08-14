# Rallypoint `cmd`

A self-hosted web panel for Steam dedicated game servers — an AMP-style console that installs,
starts/stops, monitors, configures, backs up, and updates game servers via SteamCMD + systemd.
Single binary of responsibility: one small Node service (Hono + SQLite) serving a React SPA, one
unprivileged `rallypoint` OS user, and a wildcard-free sudoers file.

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
| Unturned | 1110390 | Basic | 8 GB |

**Basic** = install/update via SteamCMD, start/stop/restart, live console, restart schedules.
**Full** adds the game's admin API (players, announcements), a structured settings editor,
world-aware backup/restore, and mod management. The registry lives in
[`packages/shared/src/games.ts`](packages/shared/src/games.ts) — every game is a data entry, so
deepening support for a game is adapter work, not a rewrite.

## Deployment

### Proxmox VE (recommended, one line)

Run on the Proxmox host as root — creates an unprivileged Debian 12 LXC and provisions
everything (Node 22, SteamCMD, the panel):

```bash
bash -c "$(curl -fsSL https://raw.githubusercontent.com/bbennetth/rallypoint-cmd/main/ct/rallypoint-cmd.sh)"
```

- **Preview first** (no changes): prefix with `DRYRUN=1`.
- **Override defaults** with env vars: `CTID HN CORES RAM SWAP DISK STORAGE BRIDGE NET_IP NET_GW
  PANEL_PORT PANEL_BIND PANEL_ADMIN_USER PANEL_ADMIN_PASSWORD PANEL_REPO_URL PANEL_REPO_REF`, e.g.
  `CTID=210 RAM=24576 DISK=80 NET_IP=192.168.1.60/24 NET_GW=192.168.1.1 bash -c "$(...)"`.
- **Verbose output**: `VERBOSE=1`.
- **Update in place**: re-run the exact same line *inside* the CT (`pct enter <ctid>`). It detects
  the existing install and does git pull + rebuild + restart; game servers keep running.

It prints the panel URL and admin login at the end. Log in, **Add server**, pick a game — the
panel runs the SteamCMD install with live progress. On a live host, also provision the game's
systemd unit once (as root, inside the CT):

```bash
rallypoint-cmd-game add <slug>
```

Defaults: 6 cores / 16 GiB RAM / 64 GiB disk. Size the disk for the games you plan to run (see
the table above — ARK alone wants ~100 GB).

### Any Debian/Ubuntu host (manual)

The provisioner's in-container steps translate directly to any systemd distro:

1. **Prereqs**: Node ≥ 22, `dpkg --add-architecture i386` + `lib32gcc-s1 lib32stdc++6`
   (SteamCMD is 32-bit), `git sudo curl tar`.
2. **User + dirs**: create the unprivileged `rallypoint` user (home `/var/lib/rallypoint-cmd`);
   make `/opt/games`, `/var/backups/rallypoint-cmd`, `/etc/rallypoint-cmd` (root:rallypoint 0750).
3. **SteamCMD** (shared, game-neutral): untar to `/opt/steamcmd`, owned by `rallypoint`.
4. **Panel**: clone to `/opt/rallypoint-cmd`, `npm ci && npm run build`, then lock down
   `chown -R root:rallypoint /opt/rallypoint-cmd && chmod -R g-w` (the panel can't modify its own code).
5. **systemd + sudoers**: install `deploy/systemd/rallypoint-cmd.service` and
   `deploy/systemd/rallypoint-game@.service`; install `deploy/bin/rallypoint-cmd-game`,
   `rallypoint-cmd-apply-update`, `rallypoint-cmd-playit` to `/usr/local/bin`; install
   `deploy/sudoers/rallypoint-cmd` to `/etc/sudoers.d/` (verify with `visudo -cf`).
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

- **From the panel UI** (preferred): Updates → the Rallypoint card checks GitHub Releases and
  applies via the pinned `rallypoint-cmd-apply-update` root helper.
- **Git-based**: re-run the installer one-liner inside the CT/host.
- **Workstation push** (local dev, no git remote): `PVE_HOST=root@<pve> CTID=<id> bash deploy/update-panel.sh`.

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

1. **Enable public access** → the panel installs the playit agent (via the pinned
   `rallypoint-cmd-playit` root helper) and generates a claim code.
2. Approve the shown `playit.gg/claim/…` URL in your playit account.
3. The panel starts the agent and displays the public `host:port` players connect to.

Details worth knowing:

- The tunneled port is the game port of your first server that has one (for Palworld, the live
  `PublicPort` from its ini). If no UDP tunnel matches, create one at
  *playit.gg → account → tunnels* (UDP → `127.0.0.1:<game port>`); the panel picks up the
  address automatically.
- The agent secret is written by the root helper to `/etc/playit/playit.toml` and never enters
  the panel's logs (the diagnostics trace redacts it).
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
| `BACKUP_DIR` | `/var/backups/rallypoint-cmd` | per-server subdirs |
| `WEB_DIST_DIR` | — | serve the built SPA from here (production) |
| `PANEL_PASSWORD_PEPPER` | — | **required in production** (random ≥16 chars) |
| `PANEL_ADMIN_USERNAME` / `PANEL_ADMIN_PASSWORD` | `admin` / generated | first-boot seed only; generated password printed once to the journal |
| `COOKIE_SECURE` | `false` | `true` behind HTTPS (see Remote access) |
| `TRUSTED_PROXY` | `false` | `true` only behind a proxy you control |
| `DISK_FLOOR_BYTES` | 5 GiB | free-space floor for installs/backups/uploads |

## Security model

- The panel runs as the unprivileged `rallypoint` user; `/opt/rallypoint-cmd` is root-owned and
  read-only to it.
- Privilege is confined to a **wildcard-free sudoers file**: `systemctl start/stop/restart` and a
  `journalctl` tail for each registry game unit (exact argv pinned, drift-tested in CI), plus two
  fixed-verb root helpers (panel self-update, playit). No `systemctl *` anywhere.
- Game units are systemd template instances (`rallypoint-game@<slug>`) whose start scripts and
  resource drop-ins are root-written by `rallypoint-cmd-game` — never by the panel.
- Session cookies + double-submit CSRF on every state-changing request; SQLite-backed login rate
  limiting; backups/mod uploads are streamed with byte caps and validated (zip-slip/bomb checks)
  before anything touches game dirs.

## Repository layout

```
apps/server/      Hono API + SSE + services (real & mock impls per integration)
apps/web/         React SPA (Vite), served by the server in production
packages/shared/  Zod contract + the game registry (games.ts)
ct/               Proxmox one-line installer / in-place updater
deploy/           systemd units, sudoers, root helpers, deploy README
e2e/              Playwright suite (runs against a mock-mode build)
```

More deployment detail: [`deploy/README.md`](deploy/README.md).
