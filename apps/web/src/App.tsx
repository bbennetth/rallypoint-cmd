import { Navigate, Route, Routes, useParams } from 'react-router-dom'
import { useAuth } from './lib/auth.js'
import { AppChrome } from './ui/AppChrome.js'
import { Spinner } from './ui/primitives.js'
import { LoginPage } from './routes/Login.js'
import { ServersPage } from './routes/Servers.js'
import { DashboardPage } from './routes/Dashboard.js'
import { ConsolePage } from './routes/Console.js'
import { MonitoringPage } from './routes/Monitoring.js'
import { PlayersPage } from './routes/Players.js'
import { SettingsPage } from './routes/Settings.js'
import { BackupsPage } from './routes/Backups.js'
import { ModsPage } from './routes/Mods.js'
import { SchedulesPage } from './routes/Schedules.js'
import { UpdatesPage } from './routes/Updates.js'
import { ManagementPage } from './routes/Management.js'
import { AccountPage } from './routes/Account.js'

function RequireAuth({ children }: { children: React.ReactNode }) {
  const { session, loading } = useAuth()
  if (loading)
    return (
      <div className="cmd-empty flex h-full items-center justify-center">
        <Spinner />
      </div>
    )
  if (!session) return <Navigate to="/login" replace />
  return <AppChrome>{children}</AppChrome>
}

function ServerPage({ page }: { page: React.ReactNode }) {
  // Key the subtree by server id so switching servers remounts pages
  // (polling hooks re-fetch under the new API scope).
  const { serverId } = useParams()
  return <div key={serverId ?? ''}>{page}</div>
}

export function App() {
  return (
    <Routes>
      <Route path="/login" element={<LoginPage />} />
      <Route path="/" element={<RequireAuth><ServersPage /></RequireAuth>} />
      <Route path="/servers/:serverId" element={<RequireAuth><ServerPage page={<DashboardPage />} /></RequireAuth>} />
      <Route path="/servers/:serverId/console" element={<RequireAuth><ServerPage page={<ConsolePage />} /></RequireAuth>} />
      <Route path="/servers/:serverId/monitoring" element={<RequireAuth><ServerPage page={<MonitoringPage />} /></RequireAuth>} />
      <Route path="/servers/:serverId/players" element={<RequireAuth><ServerPage page={<PlayersPage />} /></RequireAuth>} />
      <Route path="/servers/:serverId/settings" element={<RequireAuth><ServerPage page={<SettingsPage />} /></RequireAuth>} />
      <Route path="/servers/:serverId/updates" element={<RequireAuth><ServerPage page={<UpdatesPage />} /></RequireAuth>} />
      <Route path="/servers/:serverId/mods" element={<RequireAuth><ServerPage page={<ModsPage />} /></RequireAuth>} />
      <Route path="/servers/:serverId/backups" element={<RequireAuth><ServerPage page={<BackupsPage />} /></RequireAuth>} />
      <Route path="/servers/:serverId/schedules" element={<RequireAuth><ServerPage page={<SchedulesPage />} /></RequireAuth>} />
      <Route path="/management" element={<RequireAuth><ManagementPage /></RequireAuth>} />
      <Route path="/account" element={<RequireAuth><AccountPage /></RequireAuth>} />
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  )
}
