import { useEffect, useId, useMemo, useState, type ReactNode } from 'react'
import type { SettingsEntry, SettingValue } from '@rallypoint-cmd/shared'
import { api, ApiError } from '../lib/api.js'
import { Badge, Button, Card, inputClass } from '../ui/primitives.js'
import { Banner } from '../ui/Banner.js'
import { LogPane } from '../ui/LogPane.js'

export function SettingsPage() {
  const [mode, setMode] = useState<'form' | 'raw'>('form')
  return (
    <div className="cmd-wide space-y-4">
      <div className="pg-head">
        <h1>Settings</h1>
        {/* Ink's segmented control replaces the page-local TabBtn pair. */}
        <div className="seg">
          <button className={mode === 'form' ? 'on' : ''} onClick={() => setMode('form')}>
            Structured
          </button>
          <button className={mode === 'raw' ? 'on' : ''} onClick={() => setMode('raw')}>
            Raw
          </button>
        </div>
      </div>
      {mode === 'form' ? <StructuredEditor /> : <RawEditor />}
    </div>
  )
}

function StructuredEditor() {
  const [entries, setEntries] = useState<SettingsEntry[] | null>(null)
  const [categories, setCategories] = useState<string[]>([])
  const [pendingRestart, setPendingRestart] = useState(false)
  const [dirty, setDirty] = useState<Record<string, SettingValue>>({})
  const [msg, setMsg] = useState<{ tone: 'good' | 'bad'; text: string } | null>(null)
  const [saving, setSaving] = useState(false)

  async function load() {
    const res = await api.settings()
    setEntries(res.entries)
    setCategories(res.categories)
    setPendingRestart(res.pendingRestart)
    setDirty({})
  }
  useEffect(() => {
    void load()
  }, [])

  const known = useMemo(() => (entries ?? []).filter((e) => e.kind !== null), [entries])
  const unknown = useMemo(() => (entries ?? []).filter((e) => e.kind === null), [entries])

  // Bucket known entries into the server-sent categories (file order
  // preserved within each section); entries without a category land in a
  // trailing "Other" bucket.
  const sections = useMemo(() => {
    const buckets = new Map<string, SettingsEntry[]>([...categories, 'Other'].map((c) => [c, []]))
    for (const e of known) {
      const category = e.category && buckets.has(e.category) ? e.category : 'Other'
      buckets.get(category)!.push(e)
    }
    return [...buckets].filter(([, list]) => list.length > 0)
  }, [known, categories])

  function setVal(key: string, v: SettingValue) {
    setDirty((d) => ({ ...d, [key]: v }))
  }

  async function save() {
    if (Object.keys(dirty).length === 0) return
    // Numbers were edited as raw text; validate and coerce them here so a
    // typo never reaches the game's config as 0 or NaN.
    const patch: Record<string, SettingValue> = {}
    for (const [key, raw] of Object.entries(dirty)) {
      const kind = entries?.find((e) => e.key === key)?.kind ?? null
      const coerced = coerceForKind(kind, raw)
      if (!coerced.ok) {
        setMsg({ tone: 'bad', text: `${key} ${coerced.reason}.` })
        return
      }
      patch[key] = coerced.value
    }
    setSaving(true)
    setMsg(null)
    try {
      await api.updateSettings(patch)
      await load()
      setMsg({ tone: 'good', text: 'Saved. Restart the server to apply.' })
    } catch (e) {
      setMsg({ tone: 'bad', text: e instanceof ApiError ? e.message : 'Save failed' })
    } finally {
      setSaving(false)
    }
  }

  if (!entries) return <p className="cmd-empty">Loading settings…</p>

  return (
    <div className="space-y-4">
      {pendingRestart && (
        <Banner tone="warn">
          Unapplied changes — restart the server for them to take effect.
        </Banner>
      )}
      <Card
        title="Server settings"
        actions={
          <Button variant="primary" onClick={save} disabled={saving || Object.keys(dirty).length === 0}>
            Save {Object.keys(dirty).length > 0 ? `(${Object.keys(dirty).length})` : ''}
          </Button>
        }
      >
        {msg && (
          <div className="mb-3">
            <Banner tone={msg.tone === 'good' ? 'ok' : 'bad'}>{msg.text}</Banner>
          </div>
        )}
        <div className="space-y-6">
          {sections.map(([category, list]) => (
            <section key={category}>
              <div className="pl-eyerow">
                <span className="eyebrow">{category}</span>
                <span className="ln" />
              </div>
              <div className="grid gap-x-6 gap-y-3 md:grid-cols-2">
                {list.map((e) => (
                  <EntryField
                    key={e.key}
                    entry={e}
                    value={e.key in dirty ? dirty[e.key]! : (e.value ?? '')}
                    onChange={(v) => setVal(e.key, v)}
                  />
                ))}
              </div>
            </section>
          ))}
        </div>
      </Card>

      {unknown.length > 0 && (
        <Card title={`Other keys (${unknown.length}) — preserved verbatim`}>
          <LogPane lines={unknown.map((e) => `${e.key}=${e.raw}`)} maxHeight={192} />
        </Card>
      )}
    </div>
  )
}

// Panel-generated admin secrets (REST/RCON/telnet passwords, Enshrouded
// role passwords). The admin never needs to read them, so they render
// masked with a per-field reveal.
const SECRET_KEY_RE = /password/i

export function coerceForKind(
  kind: SettingsEntry['kind'],
  raw: SettingValue,
): { ok: true; value: SettingValue } | { ok: false; reason: string } {
  if (kind !== 'int' && kind !== 'float') return { ok: true, value: raw }
  if (typeof raw === 'number') return { ok: true, value: raw }
  const text = String(raw).trim()
  const n = Number(text)
  if (text === '' || !Number.isFinite(n)) return { ok: false, reason: 'must be a number' }
  if (kind === 'int' && !Number.isInteger(n)) return { ok: false, reason: 'must be a whole number' }
  return { ok: true, value: n }
}

function EntryField({
  entry,
  value,
  onChange,
}: {
  entry: SettingsEntry
  value: SettingValue
  onChange: (v: SettingValue) => void
}) {
  const id = useId()
  const label = entry.label ?? entry.key
  const isNumber = entry.kind === 'int' || entry.kind === 'float'
  const secret = entry.kind === 'string' && SECRET_KEY_RE.test(entry.key)
  const [reveal, setReveal] = useState(false)

  let control: ReactNode
  if (entry.kind === 'bool') {
    control = (
      <select
        id={id}
        className={inputClass}
        disabled={entry.managed}
        value={String(value)}
        onChange={(e) => onChange(e.target.value === 'true')}
      >
        <option value="true">True</option>
        <option value="false">False</option>
      </select>
    )
  } else if (entry.kind === 'enum') {
    control = (
      <select
        id={id}
        className={inputClass}
        disabled={entry.managed}
        value={String(value)}
        onChange={(e) => onChange(e.target.value)}
      >
        {(entry.enumValues ?? []).map((v) => (
          <option key={v} value={v}>
            {v}
          </option>
        ))}
      </select>
    )
  } else {
    // Numbers are edited as text: a type="number" input reports '' while
    // the user is mid-way through "1." or has cleared it, which used to
    // snap the field back to 0. The raw string is kept until save, where
    // coerceForKind() validates it.
    control = (
      <input
        id={id}
        className={inputClass}
        disabled={entry.managed}
        type={secret && !reveal ? 'password' : 'text'}
        inputMode={isNumber ? 'decimal' : undefined}
        autoComplete={secret ? 'off' : undefined}
        value={String(value)}
        onChange={(e) => onChange(e.target.value)}
      />
    )
  }

  return (
    <div className="block">
      <div className="eyebrow mb-1.5 flex items-center gap-2">
        <label htmlFor={id}>{label}</label>
        {entry.managed && <Badge tone="warn">managed</Badge>}
        {secret && (
          <button
            type="button"
            className="cmd-reveal"
            aria-pressed={reveal}
            aria-controls={id}
            onClick={() => setReveal((r) => !r)}
          >
            {reveal ? 'hide' : 'show'}
          </button>
        )}
      </div>
      {control}
    </div>
  )
}

function RawEditor() {
  const [content, setContent] = useState<string | null>(null)
  const [msg, setMsg] = useState<{ tone: 'good' | 'bad'; text: string } | null>(null)
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    void api.rawSettings().then((r) => setContent(r.content))
  }, [])

  async function save() {
    if (content == null) return
    setSaving(true)
    setMsg(null)
    try {
      await api.updateRawSettings(content)
      setMsg({ tone: 'good', text: 'Saved. Restart the server to apply.' })
    } catch (e) {
      setMsg({ tone: 'bad', text: e instanceof ApiError ? e.message : 'Save failed' })
    } finally {
      setSaving(false)
    }
  }

  if (content == null) return <p className="cmd-empty">Loading…</p>
  return (
    <Card
      title="Raw editor"
      actions={
        <Button variant="primary" onClick={save} disabled={saving}>
          Save
        </Button>
      }
    >
      {msg && (
        <div className="mb-3">
          <Banner tone={msg.tone === 'good' ? 'ok' : 'bad'}>{msg.text}</Banner>
        </div>
      )}
      <textarea
        className={`${inputClass} mono h-[28rem] resize-none text-xs`}
        value={content}
        onChange={(e) => setContent(e.target.value)}
        spellCheck={false}
      />
      <p className="cmd-note mt-2">
        Panel-managed keys (REST API, RCON, admin password) are re-asserted on save.
      </p>
    </Card>
  )
}
