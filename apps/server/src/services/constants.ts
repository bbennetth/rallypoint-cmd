import { GAMES, templateUnitFor } from '@rallypoint-cmd/shared'

// Frozen argv constants for the commands the panel shells out to.
//
// The panel runs as root inside an unprivileged LXC, so these are direct
// calls — but unit and slug names still come from HTTP input, so both are
// validated against the closed set the game registry defines before they
// ever reach an argv. Never interpolate a caller-supplied string into a
// unit name without going through the asserts below.

export const SYSTEMCTL_BIN = '/usr/bin/systemctl'
export const JOURNALCTL_BIN = '/usr/bin/journalctl'

// The lifecycle verbs the panel drives on a game unit.
export const SYSTEMCTL_VERBS = ['start', 'stop', 'restart'] as const
export type SystemctlVerb = (typeof SYSTEMCTL_VERBS)[number]

// The closed set of units the panel may ever act on: one template
// instance per registry slug.
export const ALLOWED_UNITS: readonly string[] = Object.keys(GAMES).map((slug) =>
  templateUnitFor(slug),
)

export function assertAllowedUnit(unit: string): void {
  if (!ALLOWED_UNITS.includes(unit)) {
    throw new Error(`unit ${unit} is not a known game unit`)
  }
}

export const ALLOWED_SLUGS: readonly string[] = Object.keys(GAMES)

export function assertAllowedSlug(slug: string): void {
  if (!ALLOWED_SLUGS.includes(slug)) {
    throw new Error(`slug ${slug} is not a known game slug`)
  }
}

// `journalctl -u <unit> -n 500 -o cat -f`
export function journalctlTailArgs(unit: string): readonly string[] {
  return ['-u', unit, '-n', '500', '-o', 'cat', '-f']
}

// Paths inside a Palworld install dir.
export const PAL_SERVER_SH = 'PalServer.sh'
export const PAL_CONFIG_DIR = 'Pal/Saved/Config/LinuxServer'
export const PAL_SETTINGS_INI = `${PAL_CONFIG_DIR}/PalWorldSettings.ini`
export const PAL_GAME_USER_SETTINGS_INI = `${PAL_CONFIG_DIR}/GameUserSettings.ini`
export const PAL_SAVE_ROOT = 'Pal/Saved/SaveGames/0'
export const PAL_APP_MANIFEST = 'steamapps/appmanifest_2394010.acf'
// UE mounts every *.pak under ~mods; disabled mods are parked in the
// sibling dir so the active dir holds exactly the active mods.
export const PAL_MODS_DIR = 'Pal/Content/Paks/~mods'
export const PAL_MODS_DISABLED_DIR = 'Pal/Content/Paks/~mods-disabled'

// Paths inside an Enshrouded install dir. The server generates
// enshrouded_server.json on first boot; saveDirectory/logDirectory are
// panel-managed to these values so backups and the registry stay truthful.
export const ENSHROUDED_SERVER_JSON = 'enshrouded_server.json'
export const ENSHROUDED_SAVE_DIR = 'savegame'
export const ENSHROUDED_LOG_DIR = 'logs'
