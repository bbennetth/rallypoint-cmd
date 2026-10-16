import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { BrowserRouter } from 'react-router-dom'
import { AuthProvider } from './lib/auth.js'
import { ServersProvider } from './lib/servers.js'
import { App } from './App.js'
import './index.css'

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <BrowserRouter>
      <AuthProvider>
        <ServersProvider>
          <App />
        </ServersProvider>
      </AuthProvider>
    </BrowserRouter>
  </StrictMode>,
)
