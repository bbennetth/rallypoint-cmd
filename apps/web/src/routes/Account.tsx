import { useState } from 'react'
import { api, ApiError } from '../lib/api.js'
import { Button, Card, Field, inputClass } from '../ui/primitives.js'
import { Banner } from '../ui/Banner.js'

export function AccountPage() {
  const [current, setCurrent] = useState('')
  const [next, setNext] = useState('')
  const [confirm, setConfirm] = useState('')
  const [msg, setMsg] = useState<{ tone: 'good' | 'bad'; text: string } | null>(null)
  const [busy, setBusy] = useState(false)

  async function submit(e: React.FormEvent) {
    e.preventDefault()
    setMsg(null)
    if (next !== confirm) {
      setMsg({ tone: 'bad', text: 'New passwords do not match.' })
      return
    }
    setBusy(true)
    try {
      await api.changePassword(current, next)
      setMsg({ tone: 'good', text: 'Password changed. Other sessions were signed out.' })
      setCurrent('')
      setNext('')
      setConfirm('')
    } catch (err) {
      setMsg({ tone: 'bad', text: err instanceof ApiError ? err.message : 'Failed' })
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="max-w-md">
      <div className="pg-head">
        <h1>Account</h1>
      </div>

      <Card title="Change password">
        <form onSubmit={submit} className="space-y-4">
          <Field label="Current password">
            <input
              className={inputClass}
              type="password"
              value={current}
              onChange={(e) => setCurrent(e.target.value)}
              autoComplete="current-password"
            />
          </Field>
          <Field label="New password (min 12 chars)">
            <input
              className={inputClass}
              type="password"
              value={next}
              onChange={(e) => setNext(e.target.value)}
              autoComplete="new-password"
            />
          </Field>
          <Field label="Confirm new password">
            <input
              className={inputClass}
              type="password"
              value={confirm}
              onChange={(e) => setConfirm(e.target.value)}
              autoComplete="new-password"
            />
          </Field>
          {msg && <Banner tone={msg.tone === 'good' ? 'ok' : 'bad'}>{msg.text}</Banner>}
          <Button variant="primary" disabled={busy}>
            Update password
          </Button>
        </form>
      </Card>
    </div>
  )
}
