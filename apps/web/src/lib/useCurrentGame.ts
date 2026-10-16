import { useLocation } from 'react-router-dom'
import { GAMES, type GameDef } from '@rallypoint-cmd/shared'
import { useServers } from './servers.js'

// The registry entry for the server in the current /servers/:serverId/*
// URL (undefined while loading or outside a server route). Pages use it
// to hide capability-gated controls the API would 404.
export function useCurrentGame(): GameDef | undefined {
  const location = useLocation()
  const { servers } = useServers()
  const serverId = location.pathname.match(/^\/servers\/([a-z0-9-]+)/)?.[1] ?? null
  if (!serverId) return undefined
  const slug = servers?.find((s) => s.id === serverId)?.gameSlug
  return slug ? GAMES[slug] : undefined
}
