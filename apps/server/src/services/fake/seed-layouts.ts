// What the fake SteamCMD lays down per game, standing in for a real
// install. Two things have to be true afterwards or mock mode diverges
// from production: the files the game itself ships must exist (7 Days to
// Die's serverconfig.xml is the one the panel corrects rather than
// seeds), and each world-capable game must have a save tree its backup
// contract recognizes — otherwise Backups reports "no world" on a server
// that looks installed.
//
// Palworld and Enshrouded keep their hand-written layouts in index.ts;
// this table covers the games the generic engine owns.

export interface SeedFile {
  // Path relative to the install dir.
  path: string
  content: string
}

const SDTD_SERVERCONFIG = [
  '<?xml version="1.0"?>',
  '<ServerSettings>',
  '  <property name="ServerName" value="Rallypoint 7DTD"/>',
  '  <property name="ServerDescription" value="Mock-mode sandbox"/>',
  '  <property name="ServerPort" value="26900"/>',
  '  <property name="ServerMaxPlayerCount" value="8"/>',
  '  <property name="GameWorld" value="Navezgane"/>',
  '  <property name="GameName" value="Rallypoint"/>',
  '  <property name="GameDifficulty" value="2"/>',
  '  <property name="TelnetEnabled" value="false"/>',
  '  <property name="TelnetPort" value="8081"/>',
  '  <property name="TelnetPassword" value=""/>',
  '</ServerSettings>',
  '',
].join('\n')

// Save trees are shaped to satisfy each contract's looksLikeSave probe —
// the extensions matter (`.db`/`.fwl` for Valheim, `.ark` for ARK, …).
export const SEED_LAYOUTS: Record<string, SeedFile[]> = {
  valheim: [
    { path: '.config/unity3d/IronGate/Valheim/worlds_local/Dedicated.db', content: 'fake-valheim-world' },
    { path: '.config/unity3d/IronGate/Valheim/worlds_local/Dedicated.fwl', content: 'fake-valheim-meta' },
  ],
  rust: [
    { path: 'server/rallypoint/proceduralmap.4250.5000.221.sav', content: 'fake-rust-map' },
    { path: 'server/rallypoint/cfg/users.cfg', content: '' },
  ],
  'ark-survival-evolved': [
    { path: 'ShooterGame/Saved/SavedArks/TheIsland.ark', content: 'fake-ark-world' },
    { path: 'ShooterGame/Saved/SavedArks/TheIsland_AntiCorruptionBackup.ark', content: 'fake-ark-backup' },
  ],
  '7-days-to-die': [
    // Shipped by the game; the panel corrects it in place to open telnet.
    { path: 'serverconfig.xml', content: SDTD_SERVERCONFIG },
    { path: '.local/share/7DaysToDie/Saves/Navezgane/Rallypoint/main.ttp', content: 'fake-7dtd-save' },
    { path: '.local/share/7DaysToDie/Saves/Navezgane/Rallypoint/Region/r.0.0.7rg', content: 'fake-7dtd-region' },
  ],
  'project-zomboid': [
    { path: 'Zomboid/Saves/Multiplayer/rallypoint/map_p.bin', content: 'fake-pz-map' },
    { path: 'Zomboid/db/rallypoint.db', content: 'fake-pz-players' },
    { path: 'Zomboid/Logs/server.txt', content: 'fake log line' },
  ],
  satisfactory: [
    { path: '.config/Epic/FactoryGame/Saved/SaveGames/server/rallypoint.sav', content: 'fake-satisfactory-save' },
  ],
  unturned: [
    { path: 'Servers/rallypoint/Level/Rallypoint/Level.dat', content: 'fake-unturned-level' },
    { path: 'Servers/rallypoint/Players/.keep', content: '' },
  ],
  // Source servers have no world; their cfg dir is created so the
  // settings adapter has somewhere to seed server.cfg.
  'team-fortress-2': [{ path: 'tf/cfg/.keep', content: '' }],
  'counter-strike-2': [{ path: 'game/csgo/cfg/.keep', content: '' }],
}
