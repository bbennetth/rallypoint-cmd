import { GAMES, LEGACY_PALWORLD_UNIT, templateUnitFor } from '@rallypoint-cmd/shared'

// Frozen argv constants. The sudoers file (deploy/sudoers/rallypoint-cmd)
// pins these EXACT command lines — code and sudoers must never drift, so
// both are generated from/checked against this file + the game registry.

export const PAL_SERVICE = LEGACY_PALWORLD_UNIT

export const SYSTEMCTL_BIN = '/usr/bin/systemctl'
export const JOURNALCTL_BIN = '/usr/bin/journalctl'

// `sudo -n systemctl <verb> <unit>` — the only privileged verbs.
export const SYSTEMCTL_VERBS = ['start', 'stop', 'restart'] as const
export type SystemctlVerb = (typeof SYSTEMCTL_VERBS)[number]

// The closed set of units the panel may ever pass to sudo systemctl /
// journalctl: the legacy Palworld unit plus one template instance per
// registry slug. The sudoers file enumerates exactly these (wildcard-free).
export const ALLOWED_UNITS: readonly string[] = [
  PAL_SERVICE,
  ...Object.keys(GAMES).map((slug) => templateUnitFor(slug)),
]

export function assertAllowedUnit(unit: string): void {
  if (!ALLOWED_UNITS.includes(unit)) {
    throw new Error(`unit ${unit} is not in the sudoers-pinned allow list`)
  }
}

// `sudo -n journalctl -u <unit> -n 500 -o cat -f`
export function journalctlTailArgs(unit: string): readonly string[] {
  return ['-u', unit, '-n', '500', '-o', 'cat', '-f']
}
export const JOURNALCTL_TAIL_ARGS = journalctlTailArgs(PAL_SERVICE)

// Paths inside PAL_DIR.
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
