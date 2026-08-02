import { useEffect, useMemo, useState } from 'react'
import { PAL_KEY_SPECS, SETTINGS_CATEGORIES } from '@rallypoint-cmd/shared'
import type { SettingsEntry, SettingValue } from '@rallypoint-cmd/shared'
import { api, ApiError } from '../lib/api.js'
import { Badge, Button, Card, inputClass } from '../ui/primitives.js'

export function SettingsPage() {
  const [mode, setMode] = useState<'form' | 'raw'>('form')
  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h1 className="text-sm font-semibold">PalWorldSettings.ini</h1>
        <div className="flex gap-1 rounded-lg border border-panel-border p-0.5">
          <TabBtn active={mode === 'form'} onClick={() => setMode('form')}>
            Structured
          </TabBtn>
          <TabBtn active={mode === 'raw'} onClick={() => setMode('raw')}>
            Raw
          </TabBtn>
        </div>
      </div>
      {mode === 'form' ? <StructuredEditor /> : <RawEditor />}
    </div>
  )
}

function TabBtn({ active, onClick, children }: { active: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      onClick={onClick}
      className={`rounded-md px-3 py-1 text-xs ${active ? 'bg-panel-surface-2 text-panel-text' : 'text-panel-muted'}`}
    >
      {children}
    </button>
  )
}

function StructuredEditor() {
  const [entries, setEntries] = useState<SettingsEntry[] | null>(null)
  const [pendingRestart, setPendingRestart] = useState(false)
  const [dirty, setDirty] = useState<Record<string, SettingValue>>({})
  const [msg, setMsg] = useState<{ tone: 'good' | 'bad'; text: string } | null>(null)
  const [saving, setSaving] = useState(false)

  async function load() {
    const res = await api.settings()
    setEntries(res.entries)
    setPendingRestart(res.pendingRestart)
    setDirty({})
  }
  useEffect(() => {
    void load()
  }, [])

  const known = useMemo(() => (entries ?? []).filter((e) => e.kind !== null), [entries])
  const unknown = useMemo(() => (entries ?? []).filter((e) => e.kind === null), [entries])

  // Bucket known entries into spec categories (file order preserved within
  // each section). A known entry always has a spec; the last category is a
  // safety net in case one ever lacks it.
  const sections = useMemo(() => {
    const buckets = new Map<string, SettingsEntry[]>(SETTINGS_CATEGORIES.map((c) => [c, []]))
    for (const e of known) {
      const category = PAL_KEY_SPECS[e.key]?.category ?? SETTINGS_CATEGORIES[SETTINGS_CATEGORIES.length - 1]!
      buckets.get(category)!.push(e)
    }
    return [...buckets].filter(([, list]) => list.length > 0)
  }, [known])

  function setVal(key: string, v: SettingValue) {
    setDirty((d) => ({ ...d, [key]: v }))
  }

  async function save() {
    if (Object.keys(dirty).length === 0) return
    setSaving(true)
    setMsg(null)
    try {
      await api.updateSettings(dirty)
      await load()
      setMsg({ tone: 'good', text: 'Saved. Restart the server to apply.' })
    } catch (e) {
      setMsg({ tone: 'bad', text: e instanceof ApiError ? e.message : 'Save failed' })
    } finally {
      setSaving(false)
    }
  }

  if (!entries) return <p className="text-panel-muted">Loading settings…</p>

  return (
    <div className="space-y-4">
      {pendingRestart && (
        <div className="rounded-lg border border-panel-warn/40 bg-panel-warn/10 px-4 py-2 text-sm text-panel-warn">
          Unapplied changes — restart the server for them to take effect.
        </div>
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
          <p className={`mb-3 text-sm ${msg.tone === 'good' ? 'text-panel-good' : 'text-panel-bad'}`}>
            {msg.text}
          </p>
        )}
        <div className="space-y-6">
          {sections.map(([category, list]) => (
            <section key={category}>
              <h3 className="mb-3 border-b border-panel-border pb-1.5 text-xs font-semibold uppercase tracking-wider text-panel-muted">
                {category}
              </h3>
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
          <div className="mono max-h-48 space-y-1 overflow-auto text-xs text-panel-muted thin-scroll">
            {unknown.map((e) => (
              <div key={e.key}>
                {e.key}={e.raw}
              </div>
            ))}
          </div>
        </Card>
      )}
    </div>
  )
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
  const label = entry.label ?? entry.key
  return (
    <label className="block">
      <span className="mb-1 flex items-center gap-2 text-xs font-medium text-panel-muted">
        {label}
        {entry.managed && <Badge tone="warn">managed</Badge>}
      </span>
      {entry.kind === 'bool' ? (
        <select
          className={inputClass}
          disabled={entry.managed}
          value={String(value)}
          onChange={(e) => onChange(e.target.value === 'true')}
        >
          <option value="true">True</option>
          <option value="false">False</option>
        </select>
      ) : entry.kind === 'enum' ? (
        <select
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
      ) : (
        <input
          className={inputClass}
          disabled={entry.managed}
          type={entry.kind === 'int' || entry.kind === 'float' ? 'number' : 'text'}
          step={entry.kind === 'float' ? '0.01' : undefined}
          value={String(value)}
          onChange={(e) =>
            onChange(
              entry.kind === 'int'
                ? parseInt(e.target.value || '0', 10)
                : entry.kind === 'float'
                  ? parseFloat(e.target.value || '0')
                  : e.target.value,
            )
          }
        />
      )}
    </label>
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

  if (content == null) return <p className="text-panel-muted">Loading…</p>
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
        <p className={`mb-3 text-sm ${msg.tone === 'good' ? 'text-panel-good' : 'text-panel-bad'}`}>
          {msg.text}
        </p>
      )}
      <textarea
        className={`${inputClass} mono h-[28rem] resize-none text-xs`}
        value={content}
        onChange={(e) => setContent(e.target.value)}
        spellCheck={false}
      />
      <p className="mt-2 text-xs text-panel-muted">
        Panel-managed keys (REST API, RCON, admin password) are re-asserted on save.
      </p>
    </Card>
  )
}
