// Frozen argv constants. The sudoers file (deploy/sudoers/rallypoint-cmd)
// pins these EXACT command lines — code and sudoers must never drift, so
// both are generated from/checked against this file.

export const PAL_SERVICE = 'palworld.service'

export const SYSTEMCTL_BIN = '/usr/bin/systemctl'
export const JOURNALCTL_BIN = '/usr/bin/journalctl'

// `sudo -n systemctl <verb> palworld.service` — the only privileged verbs.
export const SYSTEMCTL_VERBS = ['start', 'stop', 'restart'] as const
export type SystemctlVerb = (typeof SYSTEMCTL_VERBS)[number]

// `sudo -n journalctl -u palworld.service -n 500 -o cat -f`
export const JOURNALCTL_TAIL_ARGS = ['-u', PAL_SERVICE, '-n', '500', '-o', 'cat', '-f'] as const

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
