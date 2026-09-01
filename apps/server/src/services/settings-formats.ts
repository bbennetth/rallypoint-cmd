import { SettingsParseError } from './settings-ini.js'

// Config-file dialects for the games past Palworld and Enshrouded. Each
// format parses a file into an ordered line model plus a key→value view,
// and serializes it back preserving every line it does not own —
// comments, blank lines, unknown keys and their original order. That
// preservation is the whole point: an operator's hand-tuned config must
// survive a panel write untouched apart from the keys actually edited.
//
// Formats are pure text in, text out; the file I/O, history and
// pending-restart flag live in the generic engine (settings-file.ts).

export class SettingsFormatError extends SettingsParseError {
  constructor(message: string) {
    super(message)
    this.name = 'SettingsFormatError'
  }
}

// A parsed document: `lines` is the file as-is, with the entries that
// carry a setting tagged by key so serialize() can rewrite them in place.
export interface DocLine {
  text: string
  // Set when this line holds a setting; the key it defines.
  key?: string
  // The value as parsed from this line. A line whose entry still holds
  // this value is emitted verbatim rather than re-rendered — otherwise
  // serializing would restyle untouched lines (requoting `sv_pure 1` as
  // `sv_pure "1"`, say), which is exactly the churn callers were
  // promised would not happen.
  raw?: string
}

export interface SettingsDoc {
  lines: DocLine[]
  // Insertion-ordered key → raw value (the value as it appears, with any
  // surrounding quotes stripped).
  entries: Map<string, string>
}

export interface SettingsFormat {
  parse(content: string): SettingsDoc
  serialize(doc: SettingsDoc): string
  // Set a key, rewriting its line in place or appending a new one.
  set(doc: SettingsDoc, key: string, raw: string): void
}

function docFrom(lines: DocLine[]): SettingsDoc {
  const entries = new Map<string, string>()
  return { lines, entries }
}

// True when the line still carries the value it was parsed with, i.e.
// nothing edited this key and the original text should be kept as-is.
function unchanged(doc: SettingsDoc, line: DocLine): boolean {
  return line.key !== undefined && doc.entries.get(line.key) === line.raw
}

// --- [Section] Key=Value (ARK GameUserSettings.ini) -------------------
// Keys are addressed `Section/Key`, so two sections may carry the same
// key name without colliding. ARK does not quote its string values.

function renderSectionedLine(key: string, raw: string): string {
  const bare = key.slice(key.indexOf('/') + 1)
  return `${bare}=${raw}`
}

export const sectionedIniFormat: SettingsFormat = {
  parse(content) {
    const doc = docFrom([])
    let section = ''
    for (const text of content.split('\n')) {
      const trimmed = text.trim()
      const sectionMatch = /^\[(.+)\]$/.exec(trimmed)
      if (sectionMatch) {
        section = sectionMatch[1]!.trim()
        doc.lines.push({ text })
        continue
      }
      // `;` and `#` both start comments in the UE ini dialect.
      if (!trimmed || trimmed.startsWith(';') || trimmed.startsWith('#')) {
        doc.lines.push({ text })
        continue
      }
      const eq = text.indexOf('=')
      if (eq < 0) {
        doc.lines.push({ text })
        continue
      }
      const name = text.slice(0, eq).trim()
      const key = section ? `${section}/${name}` : name
      // A repeated key (ARK allows some) keeps the first; later ones stay
      // as unowned text so they round-trip untouched.
      if (doc.entries.has(key)) {
        doc.lines.push({ text })
        continue
      }
      const raw = text.slice(eq + 1).trim()
      doc.entries.set(key, raw)
      doc.lines.push({ text, key, raw })
    }
    return doc
  },

  serialize(doc) {
    return doc.lines
      .map((l) => (l.key && !unchanged(doc, l) ? renderSectionedLine(l.key, doc.entries.get(l.key)!) : l.text))
      .join('\n')
  },

  set(doc, key, raw) {
    if (doc.entries.has(key)) {
      doc.entries.set(key, raw)
      return
    }
    doc.entries.set(key, raw)
    const section = key.includes('/') ? key.slice(0, key.indexOf('/')) : ''
    // Append under the key's own section, after that section's last line.
    let insertAt = -1
    let current = ''
    doc.lines.forEach((line, i) => {
      const m = /^\[(.+)\]$/.exec(line.text.trim())
      if (m) current = m[1]!.trim()
      if (current === section) insertAt = i
    })
    const newLine: DocLine = { text: renderSectionedLine(key, raw), key }
    if (insertAt >= 0) doc.lines.splice(insertAt + 1, 0, newLine)
    else {
      if (section) doc.lines.push({ text: `[${section}]` })
      doc.lines.push(newLine)
    }
  },
}

// --- <property name="X" value="Y"/> (7 Days to Die serverconfig.xml) ---
// Deliberately line-oriented rather than a real XML parse: the file is a
// flat property list, and a tolerant regex keeps the rest of the
// document (declaration, comments, wrapper element) byte-identical.

const XML_PROPERTY = /^(\s*<property\s+name\s*=\s*")([^"]+)("\s+value\s*=\s*")([^"]*)("\s*\/?>.*)$/

function xmlEscape(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}

function xmlUnescape(value: string): string {
  return value
    .replace(/&quot;/g, '"')
    .replace(/&gt;/g, '>')
    .replace(/&lt;/g, '<')
    .replace(/&amp;/g, '&')
}

export const xmlPropertiesFormat: SettingsFormat = {
  parse(content) {
    const doc = docFrom([])
    for (const text of content.split('\n')) {
      const m = XML_PROPERTY.exec(text)
      if (!m) {
        // A property opened but not closed on this line would be silently
        // dropped by the regex, so refuse the file rather than mangle it.
        if (/<property\b/.test(text) && !/\/?>/.test(text)) {
          throw new SettingsFormatError('serverconfig.xml has a property spanning multiple lines — edit it by hand')
        }
        doc.lines.push({ text })
        continue
      }
      const key = m[2]!
      if (doc.entries.has(key)) {
        doc.lines.push({ text })
        continue
      }
      const raw = xmlUnescape(m[4]!)
      doc.entries.set(key, raw)
      doc.lines.push({ text, key, raw })
    }
    return doc
  },

  serialize(doc) {
    return doc.lines
      .map((line) => {
        if (!line.key || unchanged(doc, line)) return line.text
        const m = XML_PROPERTY.exec(line.text)
        if (!m) return line.text
        return `${m[1]}${m[2]}${m[3]}${xmlEscape(doc.entries.get(line.key)!)}${m[5]}`
      })
      .join('\n')
  },

  set(doc, key, raw) {
    const existed = doc.entries.has(key)
    doc.entries.set(key, raw)
    if (existed) return
    const line: DocLine = { text: `  <property name="${key}" value="${xmlEscape(raw)}"/>`, key }
    // Land it beside the other properties, before the closing element.
    const lastProperty = doc.lines.reduce((acc, l, i) => (l.key ? i : acc), -1)
    if (lastProperty >= 0) doc.lines.splice(lastProperty + 1, 0, line)
    else doc.lines.push(line)
  },
}

// --- flat Key=Value and `key value` files ------------------------------
// One engine, two dialects: Project Zomboid's ini (`=` separated, `#`
// comments) and the Source/Rust/Unturned console-command style (space
// separated, `//` comments, optionally quoted values).

export interface KeyValueDialect {
  separator: '=' | ' '
  commentPrefixes: readonly string[]
  // Quote string values on write (Source cfg does; Zomboid and Unturned
  // do not).
  quoteValues: boolean
  // Match keys case-insensitively (Unturned's Commands.dat).
  caseInsensitive: boolean
}

export const ZOMBOID_DIALECT: KeyValueDialect = {
  separator: '=',
  commentPrefixes: ['#'],
  quoteValues: false,
  caseInsensitive: false,
}

export const SOURCE_CFG_DIALECT: KeyValueDialect = {
  separator: ' ',
  commentPrefixes: ['//'],
  quoteValues: true,
  caseInsensitive: false,
}

export const UNTURNED_DIALECT: KeyValueDialect = {
  separator: ' ',
  commentPrefixes: ['//'],
  quoteValues: false,
  caseInsensitive: true,
}

function stripQuotes(value: string): string {
  const trimmed = value.trim()
  if (trimmed.length >= 2 && trimmed.startsWith('"') && trimmed.endsWith('"')) return trimmed.slice(1, -1)
  return trimmed
}

export function keyValueFormat(dialect: KeyValueDialect): SettingsFormat {
  const normalize = (key: string): string => (dialect.caseInsensitive ? key.toLowerCase() : key)

  const renderLine = (key: string, raw: string): string => {
    if (dialect.separator === '=') return `${key}=${raw}`
    // A quoted value keeps spaces intact; an empty one still needs the
    // quotes so the command parses.
    const value = dialect.quoteValues || raw.includes(' ') || raw === '' ? `"${raw.replace(/"/g, '')}"` : raw
    return `${key} ${value}`
  }

  return {
    parse(content) {
      const doc = docFrom([])
      for (const text of content.split('\n')) {
        const trimmed = text.trim()
        if (!trimmed || dialect.commentPrefixes.some((p) => trimmed.startsWith(p))) {
          doc.lines.push({ text })
          continue
        }
        let name: string
        let value: string
        if (dialect.separator === '=') {
          const eq = text.indexOf('=')
          if (eq < 0) {
            doc.lines.push({ text })
            continue
          }
          name = text.slice(0, eq).trim()
          value = text.slice(eq + 1).trim()
        } else {
          const m = /^\s*(\S+)\s*(.*)$/.exec(text)
          if (!m || !m[1]) {
            doc.lines.push({ text })
            continue
          }
          name = m[1]
          value = stripQuotes(m[2] ?? '')
        }
        const key = normalize(name)
        if (doc.entries.has(key)) {
          doc.lines.push({ text })
          continue
        }
        doc.entries.set(key, value)
        doc.lines.push({ text, key, raw: value })
      }
      return doc
    },

    serialize(doc) {
      return doc.lines
        .map((line) => {
          if (!line.key || unchanged(doc, line)) return line.text
          // Keep the key's original spelling from the source line.
          const original =
            dialect.separator === '='
              ? line.text.slice(0, line.text.indexOf('=')).trim()
              : (/^\s*(\S+)/.exec(line.text)?.[1] ?? line.key)
          return renderLine(original, doc.entries.get(line.key)!)
        })
        .join('\n')
    },

    set(doc, key, raw) {
      const normalized = normalize(key)
      const existed = doc.entries.has(normalized)
      doc.entries.set(normalized, raw)
      if (!existed) doc.lines.push({ text: renderLine(key, raw), key: normalized })
    },
  }
}

// --- panel-owned launch conf (Valheim, Rust, CS2) ----------------------
// Not a game file at all: the panel writes it and the generated start.sh
// dot-sources it, so there is nothing to preserve and everything to
// distrust. Values are restricted to a conservative charset and
// single-quoted; anything else is refused rather than escaped, because
// the consumer is a root-launched shell.

export const LAUNCH_CONF_VALUE = /^[A-Za-z0-9 _.,:@-]*$/

export function assertLaunchConfSafe(key: string, value: string): void {
  if (!/^[+-]?[A-Za-z0-9_.]+$/.test(key)) {
    throw new SettingsFormatError(`${key} is not a valid launch argument name`)
  }
  if (!LAUNCH_CONF_VALUE.test(value)) {
    throw new SettingsFormatError(
      `${key} may only contain letters, numbers, spaces and _ . , : @ - (it is passed to a shell)`,
    )
  }
}

const LAUNCH_CONF_HEADER = [
  '# Generated by rallypoint-cmd — do not edit (the panel rewrites this file).',
  '# Sourced by start.sh, which then execs the game with "$@".',
  '# Values are single-quoted and charset-restricted.',
]

// The file holds exactly one executable line — the EXTRA_ARGS
// assignment start.sh consumes. The panel's own record of each key and
// value rides along as `#:`-prefixed comments, which is what parse()
// reads back. They must be comments: the file is dot-sourced, so a bare
// `-name Rallypoint` line would be run as a command on every start.
const LAUNCH_CONF_PAIR = '#: '

// Build launch-conf content from plain pairs. Seeds go through this
// rather than hand-writing lines, so nothing has to remember that the
// pairs are comment-prefixed.
export function renderLaunchConfSeed(pairs: Record<string, string>): string {
  return `${Object.entries(pairs)
    .map(([key, value]) => `${LAUNCH_CONF_PAIR}${key} ${value}`)
    .join('\n')}\n`
}

export const launchConfFormat: SettingsFormat = {
  parse(content) {
    const doc = docFrom([])
    for (const text of content.split('\n')) {
      if (!text.startsWith(LAUNCH_CONF_PAIR)) continue
      const m = /^(\S+)\s*(.*)$/.exec(text.slice(LAUNCH_CONF_PAIR.length).trim())
      if (!m || !m[1]) continue
      doc.entries.set(m[1], stripQuotes(m[2] ?? ''))
    }
    return doc
  },

  // The whole file is regenerated: it has no user content to preserve.
  serialize(doc) {
    const args: string[] = []
    const lines = [...LAUNCH_CONF_HEADER]
    for (const [key, raw] of doc.entries) {
      assertLaunchConfSafe(key, raw)
      lines.push(`${LAUNCH_CONF_PAIR}${key} ${raw}`)
      args.push(key)
      if (raw !== '') args.push(raw)
    }
    // `set --` rather than a variable: a server name legitimately
    // contains spaces, and an unquoted variable would word-split it into
    // several arguments. Positional parameters keep each value one
    // argument, and start.sh passes them on as "$@". Single quotes stop
    // expansion, and the charset check already ruled out the quote
    // character that could close the string early.
    lines.push(`set -- ${args.map((a) => `'${a}'`).join(' ')}`)
    return `${lines.join('\n')}\n`
  },

  set(doc, key, raw) {
    assertLaunchConfSafe(key, raw)
    doc.entries.set(key, raw)
  },
}
