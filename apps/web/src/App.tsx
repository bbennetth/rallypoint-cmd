import { Navigate, Route, Routes } from 'react-router-dom'
import { useAuth } from './lib/auth.js'
import { AppChrome } from './ui/AppChrome.js'
import { Spinner } from './ui/primitives.js'
import { LoginPage } from './routes/Login.js'
import { DashboardPage } from './routes/Dashboard.js'
import { ConsolePage } from './routes/Console.js'
import { PlayersPage } from './routes/Players.js'
import { SettingsPage } from './routes/Settings.js'
import { BackupsPage } from './routes/Backups.js'
import { ModsPage } from './routes/Mods.js'
import { SchedulesPage } from './routes/Schedules.js'
import { UpdatesPage } from './routes/Updates.js'
import { AccountPage } from './routes/Account.js'

function RequireAuth({ children }: { children: React.ReactNode }) {
  const { session, loading } = useAuth()
  if (loading)
    return (
      <div className="flex h-full items-center justify-center text-panel-muted">
        <Spinner />
      </div>
    )
  if (!session) return <Navigate to="/login" replace />
  return <AppChrome>{children}</AppChrome>
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
      <Route path="/mods" element={<RequireAuth><ModsPage /></RequireAuth>} />
      <Route path="/backups" element={<RequireAuth><BackupsPage /></RequireAuth>} />
      <Route path="/schedules" element={<RequireAuth><SchedulesPage /></RequireAuth>} />
      <Route path="/account" element={<RequireAuth><AccountPage /></RequireAuth>} />
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  )
}
