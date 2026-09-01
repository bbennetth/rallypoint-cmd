import { describe, expect, it } from 'vitest'
import {
  SOURCE_CFG_DIALECT,
  SettingsFormatError,
  UNTURNED_DIALECT,
  ZOMBOID_DIALECT,
  assertLaunchConfSafe,
  keyValueFormat,
  launchConfFormat,
  sectionedIniFormat,
  xmlPropertiesFormat,
} from './settings-formats.js'

// The contract every format owes the engine: read a key, write a key,
// and leave every line it does not own exactly as it found it. An
// operator's comments and hand-tuned unknown keys are the thing most
// easily destroyed by a naive rewrite, so each format is tested for it.

describe('sectionedIniFormat (ARK)', () => {
  const FILE = [
    '[ServerSettings]',
    '; hand-written note',
    'ServerAdminPassword=hunter2',
    'DifficultyOffset=0.200000',
    'HandsomeUnknownKey=42',
    '',
    '[SessionSettings]',
    'SessionName=Rallypoint',
  ].join('\n')

  it('addresses keys by section so names can repeat', () => {
    const doc = sectionedIniFormat.parse(FILE)
    expect(doc.entries.get('ServerSettings/ServerAdminPassword')).toBe('hunter2')
    expect(doc.entries.get('SessionSettings/SessionName')).toBe('Rallypoint')
  })

  it('round-trips an untouched file byte for byte', () => {
    expect(sectionedIniFormat.serialize(sectionedIniFormat.parse(FILE))).toBe(FILE)
  })

  it('rewrites one key in place and preserves everything else', () => {
    const doc = sectionedIniFormat.parse(FILE)
    sectionedIniFormat.set(doc, 'ServerSettings/DifficultyOffset', '0.5')
    const out = sectionedIniFormat.serialize(doc)
    expect(out).toContain('DifficultyOffset=0.5')
    expect(out).toContain('; hand-written note')
    expect(out).toContain('HandsomeUnknownKey=42')
    expect(out).toContain('SessionName=Rallypoint')
  })

  it('appends a new key under its own section', () => {
    const doc = sectionedIniFormat.parse(FILE)
    sectionedIniFormat.set(doc, 'ServerSettings/RCONPort', '27020')
    const out = sectionedIniFormat.serialize(doc)
    const lines = out.split('\n')
    expect(lines.indexOf('RCONPort=27020')).toBeGreaterThan(lines.indexOf('[ServerSettings]'))
    expect(lines.indexOf('RCONPort=27020')).toBeLessThan(lines.indexOf('[SessionSettings]'))
  })

  it('does not quote ARK string values', () => {
    const doc = sectionedIniFormat.parse(FILE)
    sectionedIniFormat.set(doc, 'SessionSettings/SessionName', 'My Server')
    expect(sectionedIniFormat.serialize(doc)).toContain('SessionName=My Server')
  })
})

describe('xmlPropertiesFormat (7 Days to Die)', () => {
  const FILE = [
    '<?xml version="1.0"?>',
    '<ServerSettings>',
    '  <!-- General -->',
    '  <property name="ServerName" value="Rallypoint"/>',
    '  <property name="TelnetEnabled" value="false"/>',
    '  <property name="GameDifficulty" value="2"/>',
    '</ServerSettings>',
  ].join('\n')

  it('reads properties without an XML parser', () => {
    const doc = xmlPropertiesFormat.parse(FILE)
    expect(doc.entries.get('ServerName')).toBe('Rallypoint')
    expect(doc.entries.get('TelnetEnabled')).toBe('false')
  })

  it('round-trips an untouched file byte for byte', () => {
    expect(xmlPropertiesFormat.serialize(xmlPropertiesFormat.parse(FILE))).toBe(FILE)
  })

  it('preserves the declaration, comments and wrapper on a write', () => {
    const doc = xmlPropertiesFormat.parse(FILE)
    xmlPropertiesFormat.set(doc, 'TelnetEnabled', 'true')
    const out = xmlPropertiesFormat.serialize(doc)
    expect(out).toContain('<property name="TelnetEnabled" value="true"/>')
    expect(out).toContain('<?xml version="1.0"?>')
    expect(out).toContain('<!-- General -->')
    expect(out).toContain('</ServerSettings>')
  })

  it('inserts a new property among the others, not after the closing tag', () => {
    const doc = xmlPropertiesFormat.parse(FILE)
    xmlPropertiesFormat.set(doc, 'TelnetPassword', 'secret')
    const lines = xmlPropertiesFormat.serialize(doc).split('\n')
    expect(lines.findIndex((l) => l.includes('TelnetPassword'))).toBeLessThan(
      lines.findIndex((l) => l.includes('</ServerSettings>')),
    )
  })

  it('escapes markup characters written into a value', () => {
    const doc = xmlPropertiesFormat.parse(FILE)
    xmlPropertiesFormat.set(doc, 'ServerName', 'Bob & "Friends" <hi>')
    const out = xmlPropertiesFormat.serialize(doc)
    expect(out).toContain('value="Bob &amp; &quot;Friends&quot; &lt;hi&gt;"')
    // And reads back as the original text.
    expect(xmlPropertiesFormat.parse(out).entries.get('ServerName')).toBe('Bob & "Friends" <hi>')
  })

  it('refuses a file whose property spans lines rather than mangling it', () => {
    expect(() => xmlPropertiesFormat.parse('<property name="A"\n  value="B"/>')).toThrow(SettingsFormatError)
  })
})

describe('keyValueFormat', () => {
  it('reads and rewrites Zomboid’s ini dialect, keeping comments', () => {
    const format = keyValueFormat(ZOMBOID_DIALECT)
    const file = ['# server ini', 'PublicName=Rallypoint', 'MaxPlayers=32', 'Open=true'].join('\n')
    const doc = format.parse(file)
    expect(doc.entries.get('MaxPlayers')).toBe('32')
    format.set(doc, 'MaxPlayers', '48')
    const out = format.serialize(doc)
    expect(out).toContain('MaxPlayers=48')
    expect(out).toContain('# server ini')
    expect(out).toContain('PublicName=Rallypoint')
  })

  it('reads Source cfg commands and quotes values on write', () => {
    const format = keyValueFormat(SOURCE_CFG_DIALECT)
    const file = ['// notes', 'hostname "Old Name"', 'sv_pure 1'].join('\n')
    const doc = format.parse(file)
    expect(doc.entries.get('hostname')).toBe('Old Name')
    format.set(doc, 'hostname', 'Rallypoint TF2')
    const out = format.serialize(doc)
    expect(out).toContain('hostname "Rallypoint TF2"')
    expect(out).toContain('// notes')
    expect(out).toContain('sv_pure 1')
  })

  it('appends an unknown-to-the-file key at the end', () => {
    const format = keyValueFormat(SOURCE_CFG_DIALECT)
    const doc = format.parse('hostname "x"')
    format.set(doc, 'rcon_password', 'secret')
    expect(format.serialize(doc).split('\n').at(-1)).toBe('rcon_password "secret"')
  })

  it('matches Unturned command names case-insensitively', () => {
    const format = keyValueFormat(UNTURNED_DIALECT)
    const doc = format.parse('Name Rallypoint\nMaxPlayers 24')
    expect(doc.entries.get('name')).toBe('Rallypoint')
    format.set(doc, 'Name', 'Renamed')
    // Rewritten in place under the file's original spelling.
    expect(format.serialize(doc)).toBe('Name Renamed\nMaxPlayers 24')
  })

  it('round-trips untouched files byte for byte', () => {
    for (const [dialect, file] of [
      [ZOMBOID_DIALECT, '# c\nA=1\n\nB=two words'],
      [SOURCE_CFG_DIALECT, '// c\nmp_timelimit 30\nhostname "A B"'],
      [UNTURNED_DIALECT, 'Name Rallypoint\nPort 27015'],
    ] as const) {
      const format = keyValueFormat(dialect)
      expect(format.serialize(format.parse(file))).toBe(file)
    }
  })
})

// Every one of these was a live defect found in review; they are the
// cases that only show up against a real game's config file.
describe('regressions', () => {
  it('splits an ARK key at the LAST slash, not the first', () => {
    // The section name has slashes of its own. Splitting at the first one
    // wrote `Script/Engine.GameSession/MaxPlayers=100` — a junk key ARK
    // ignores, silently capping the server at its built-in default.
    const file = '[/Script/Engine.GameSession]\nMaxPlayers=70'
    const doc = sectionedIniFormat.parse(file)
    expect(doc.entries.get('/Script/Engine.GameSession/MaxPlayers')).toBe('70')
    sectionedIniFormat.set(doc, '/Script/Engine.GameSession/MaxPlayers', '100')
    expect(sectionedIniFormat.serialize(doc)).toBe('[/Script/Engine.GameSession]\nMaxPlayers=100')
  })

  it('parses CRLF files, which every line-oriented dialect used to miss', () => {
    // A CRLF file parsed as zero settings, so the panel appended fresh
    // keys at EOF — for 7DTD that meant properties after </ServerSettings>.
    const xml = '<?xml version="1.0"?>\r\n<ServerSettings>\r\n  <property name="TelnetPort" value="8081"/>\r\n</ServerSettings>\r\n'
    expect(xmlPropertiesFormat.parse(xml).entries.get('TelnetPort')).toBe('8081')
    const cfg = keyValueFormat(SOURCE_CFG_DIALECT)
    expect(cfg.parse('hostname "A"\r\nsv_pure 1\r\n').entries.get('sv_pure')).toBe('1')
    const ini = keyValueFormat(ZOMBOID_DIALECT)
    expect(ini.parse('RCONPort=27025\r\n').entries.get('RCONPort')).toBe('27025')
  })

  it('round-trips a CRLF file byte for byte, including a rewritten line', () => {
    const cfg = keyValueFormat(SOURCE_CFG_DIALECT)
    const file = '// note\r\nhostname "Old"\r\nsv_pure 1\r\n'
    expect(cfg.serialize(cfg.parse(file))).toBe(file)
    const doc = cfg.parse(file)
    cfg.set(doc, 'hostname', 'New')
    // The rewritten line keeps CRLF; the rest is untouched.
    expect(cfg.serialize(doc)).toBe('// note\r\nhostname "New"\r\nsv_pure 1\r\n')
  })

  it('refuses a value carrying a line break, in every dialect', () => {
    // This was a complete bypass of "managed keys cannot be edited":
    // `x"\nrcon_password ATTACKER` opened a second line that defined the
    // panel's own key, and the game reads the injected one.
    const injection = 'x"\nrcon_password ATTACKER'
    const cfg = keyValueFormat(SOURCE_CFG_DIALECT)
    expect(() => cfg.set(cfg.parse('hostname "A"'), 'hostname', injection)).toThrow(SettingsFormatError)
    expect(() =>
      sectionedIniFormat.set(sectionedIniFormat.parse('[ServerSettings]'), 'ServerSettings/SessionName', injection),
    ).toThrow(SettingsFormatError)
    expect(() =>
      xmlPropertiesFormat.set(xmlPropertiesFormat.parse('<ServerSettings>'), 'ServerName', injection),
    ).toThrow(SettingsFormatError)
  })

  it('refuses a quote in a dialect that delimits with quotes', () => {
    // Previously stripped silently, which quietly renamed the server.
    const cfg = keyValueFormat(SOURCE_CFG_DIALECT)
    expect(() => cfg.set(cfg.parse('hostname "A"'), 'hostname', 'The "Best" Server')).toThrow(SettingsFormatError)
  })
})

describe('launchConfFormat', () => {
  it('renders the argument list start.sh forwards as "$@"', () => {
    const doc = launchConfFormat.parse('')
    launchConfFormat.set(doc, '-name', 'Rallypoint')
    launchConfFormat.set(doc, '-world', 'Dedicated')
    launchConfFormat.set(doc, '-crossplay', '')
    const out = launchConfFormat.serialize(doc)
    expect(out).toContain("set -- '-name' 'Rallypoint' '-world' 'Dedicated' '-crossplay'")
    // And reads its own output back.
    expect(launchConfFormat.parse(out).entries.get('-name')).toBe('Rallypoint')
  })

  it('keeps a value containing spaces as one argument', () => {
    // Server names have spaces. An unquoted variable would split this
    // into three arguments and the game would see the name "Byrons".
    const doc = launchConfFormat.parse('')
    launchConfFormat.set(doc, '-name', 'Byrons Valheim EU-West')
    expect(launchConfFormat.serialize(doc)).toContain("set -- '-name' 'Byrons Valheim EU-West'")
    expect(launchConfFormat.parse(launchConfFormat.serialize(doc)).entries.get('-name')).toBe(
      'Byrons Valheim EU-West',
    )
  })

  it('has exactly one executable line — the rest are comments', () => {
    // start.sh dot-sources this file, so any line that is not a comment
    // runs as a command. Writing the pairs as bare `-name Rallypoint`
    // lines would spray "command not found" on every server start.
    const doc = launchConfFormat.parse('')
    launchConfFormat.set(doc, '-name', 'Rallypoint')
    launchConfFormat.set(doc, 'port', '27015')
    const executable = launchConfFormat
      .serialize(doc)
      .split('\n')
      .filter((l) => l.trim() !== '' && !l.trimStart().startsWith('#'))
    expect(executable).toHaveLength(1)
    expect(executable[0]).toMatch(/^set -- '/)
  })

  it('rejects every shell metacharacter a value could carry', () => {
    for (const bad of [
      "x'; rm -rf /",
      'x`whoami`',
      'x$(id)',
      'x$HOME',
      'a\nEXTRA_ARGS=pwned',
      'x"y',
      'x\\y',
      'x&y',
      'x|y',
      'x;y',
      'x>y',
    ]) {
      expect(() => assertLaunchConfSafe('-name', bad), bad).toThrow(SettingsFormatError)
    }
  })

  it('rejects an injected argument name', () => {
    expect(() => assertLaunchConfSafe('-name; rm -rf /', 'x')).toThrow(SettingsFormatError)
  })

  it('allows the punctuation a real server name needs', () => {
    for (const ok of ['Rallypoint', "Byron's".replace("'", ''), 'EU-West 1', 'a.b_c,d:e@f', '']) {
      expect(() => assertLaunchConfSafe('-name', ok), ok).not.toThrow()
    }
  })

  it('refuses to serialize a document holding an unsafe value', () => {
    const doc = launchConfFormat.parse('')
    // Bypass set()'s check the way a corrupted file on disk would.
    doc.entries.set('-name', 'evil`id`')
    expect(() => launchConfFormat.serialize(doc)).toThrow(SettingsFormatError)
  })
})
