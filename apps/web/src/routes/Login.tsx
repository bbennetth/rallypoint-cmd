import { useState } from 'react'
import { Navigate, useNavigate } from 'react-router-dom'
import { useAuth } from '../lib/auth.js'
import { ApiError } from '../lib/api.js'
import { Button, Field, inputClass, Spinner } from '../ui/primitives.js'
import { AppBrandLockup } from '../ui/ink/icons.js'
import { Banner } from '../ui/Banner.js'

export function LoginPage() {
  const { session, login } = useAuth()
  const navigate = useNavigate()
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  if (session) return <Navigate to="/" replace />

  async function submit(e: React.FormEvent) {
    e.preventDefault()
    setBusy(true)
    setError(null)
    try {
      await login(username, password)
      navigate('/')
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Login failed')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="cmd-auth">
      <form onSubmit={submit} className="pl-card w-full max-w-sm p-6">
        <div className="mb-6 flex items-center gap-2.5">
          <AppBrandLockup />
        </div>
        <div className="space-y-4">
          <Field label="Username">
            <input
              className={inputClass}
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              autoFocus
              autoComplete="username"
            />
          </Field>
          <Field label="Password">
            <input
              className={inputClass}
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              autoComplete="current-password"
            />
          </Field>
          {error && <Banner tone="bad">{error}</Banner>}
          <Button variant="primary" className="w-full" disabled={busy}>
            {busy ? <Spinner /> : 'Sign in'}
          </Button>
        </div>
      </form>
    </div>
  )
}
