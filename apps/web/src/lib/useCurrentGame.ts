import { useEffect, useState } from 'react'
import { useLocation } from 'react-router-dom'
import { GAMES, type GameDef } from '@rallypoint-cmd/shared'
import { api } from './api.js'

// The registry entry for the server in the current /servers/:serverId/*
// URL (undefined while loading or outside a server route). Pages use it
// to hide capability-gated controls the API would 404.
export function useCurrentGame(): GameDef | undefined {
  const location = useLocation()
  const serverId = location.pathname.match(/^\/servers\/([a-z0-9-]+)/)?.[1] ?? null
  const [slug, setSlug] = useState<string | null>(null)
  useEffect(() => {
    if (!serverId) {
      setSlug(null)
      return
    }
    let alive = true
    api
      .servers()
      .then((r) => {
        if (alive) setSlug(r.servers.find((s) => s.id === serverId)?.gameSlug ?? null)
      })
      .catch(() => {})
    return () => {
      alive = false
    }
  }, [serverId])
  return slug ? GAMES[slug] : undefined
}
