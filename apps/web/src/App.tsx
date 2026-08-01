import { useEffect, useState } from 'react'
import { NavLink, Navigate, Route, Routes, useNavigate } from 'react-router-dom'
import { api } from './lib/api.js'
import { useAuth } from './lib/auth.js'
import { Spinner } from './ui/primitives.js'
import { LoginPage } from './routes/Login.js'
import { DashboardPage } from './routes/Dashboard.js'
import { ConsolePage } from './routes/Console.js'
import { PlayersPage } from './routes/Players.js'
import { SettingsPage } from './routes/Settings.js'
import { BackupsPage } from './routes/Backups.js'
import { SchedulesPage } from './routes/Schedules.js'
import { UpdatesPage } from './routes/Updates.js'
import { AccountPage } from './routes/Account.js'

const NAV = [
  { to: '/', label: 'Dashboard', end: true },
  { to: '/console', label: 'Console' },
  { to: '/players', label: 'Players' },
  { to: '/settings', label: 'Settings' },
  { to: '/updates', label: 'Updates' },
  { to: '/backups', label: 'Backups' },
  { to: '/schedules', label: 'Schedules' },
]

function Shell({ children }: { children: React.ReactNode }) {
  const { session, logout } = useAuth()
  const navigate = useNavigate()
  // Daily update check (server-side cached): show a subtle badge on the
  // Updates nav item when a newer release exists. Best-effort only.
  const [updateAvailable, setUpdateAvailable] = useState(false)
  useEffect(() => {
    api
      .panelUpdate(false)
      .then((info) => setUpdateAvailable(info.updateAvailable))
      .catch(() => {})
  }, [])
  return (
    <div className="min-h-full">
      <header className="border-b border-panel-border bg-panel-surface/60 backdrop-blur">
        <div className="mx-auto flex max-w-6xl items-center gap-6 px-4 py-3">
          <div className="flex items-center gap-2 font-semibold">
            <span className="text-panel-accent">◆</span> Rallypoint
          </div>
          <nav className="flex flex-1 flex-wrap gap-1">
            {NAV.map((n) => (
              <NavLink
                key={n.to}
                to={n.to}
                end={n.end ?? false}
                className={({ isActive }) =>
                  `rounded-lg px-3 py-1.5 text-sm transition-colors ${
                    isActive
                      ? 'bg-panel-surface-2 text-panel-text'
                      : 'text-panel-muted hover:text-panel-text'
                  }`
                }
              >
                {n.label}
                {n.to === '/updates' && updateAvailable && (
                  <span
                    className="ml-1.5 inline-block h-1.5 w-1.5 rounded-full bg-panel-warn align-middle"
                    title="Panel update available"
                  />
                )}
              </NavLink>
            ))}
          </nav>
          <div className="flex items-center gap-3 text-sm text-panel-muted">
            <NavLink to="/account" className="hover:text-panel-text">
              {session?.username}
            </NavLink>
            <button
              className="rounded-lg border border-panel-border px-2.5 py-1 text-xs hover:bg-panel-surface-2"
              onClick={async () => {
                await logout()
                navigate('/login')
              }}
            >
              Sign out
            </button>
          </div>
        </div>
      </header>
      <main className="mx-auto max-w-6xl px-4 py-6">{children}</main>
    </div>
  )
}

function RequireAuth({ children }: { children: React.ReactNode }) {
  const { session, loading } = useAuth()
  if (loading)
    return (
      <div className="flex h-screen items-center justify-center text-panel-muted">
        <Spinner />
      </div>
    )
  if (!session) return <Navigate to="/login" replace />
  return <Shell>{children}</Shell>
}

export function App() {
  return (
    <Routes>
      <Route path="/login" element={<LoginPage />} />
      <Route path="/" element={<RequireAuth><DashboardPage /></RequireAuth>} />
      <Route path="/console" element={<RequireAuth><ConsolePage /></RequireAuth>} />
      <Route path="/players" element={<RequireAuth><PlayersPage /></RequireAuth>} />
      <Route path="/settings" element={<RequireAuth><SettingsPage /></RequireAuth>} />
      <Route path="/updates" element={<RequireAuth><UpdatesPage /></RequireAuth>} />
      <Route path="/backups" element={<RequireAuth><BackupsPage /></RequireAuth>} />
      <Route path="/schedules" element={<RequireAuth><SchedulesPage /></RequireAuth>} />
      <Route path="/account" element={<RequireAuth><AccountPage /></RequireAuth>} />
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  )
}
