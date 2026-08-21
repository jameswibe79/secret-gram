import { useLayoutEffect, useState } from 'react'

import './App.css'
import { AccessScreen } from './components/AccessScreen'
import { RoomWorkspace } from './components/RoomWorkspace'
import type { ActiveRoomSession } from './lib/session'
import {
  parseRoomInvitation,
  roomPath,
  type RoomInvitation,
} from './lib/room-crypto'

type AppTheme = 'day' | 'night'

const THEME_STORAGE_KEY = 'secretgram-theme'

function initialTheme(): AppTheme {
  try {
    const stored = window.localStorage.getItem(THEME_STORAGE_KEY)
    if (stored === 'day' || stored === 'night') return stored
  } catch {
    // Storage can be unavailable in privacy-restricted browser contexts.
  }
  return window.matchMedia?.('(prefers-color-scheme: light)').matches ? 'day' : 'night'
}

function initialRoomInvitation(): RoomInvitation | null {
  if (!/^\/r\//iu.test(window.location.pathname)) return null
  try {
    const invitation = parseRoomInvitation(`${window.location.pathname}${window.location.hash}`)
    window.history.replaceState(
      window.history.state,
      '',
      `${roomPath(invitation.roomId)}${window.location.search}`,
    )
    return invitation
  } catch {
    window.history.replaceState(window.history.state, '', `/${window.location.search}`)
    return null
  }
}

function App() {
  const [session, setSession] = useState<ActiveRoomSession | null>(null)
  const [invitation, setInvitation] = useState<RoomInvitation | null>(initialRoomInvitation)
  const [theme, setTheme] = useState<AppTheme>(initialTheme)

  useLayoutEffect(() => {
    document.documentElement.dataset.theme = theme
    document.querySelector<HTMLMetaElement>('meta[name="theme-color"]')?.setAttribute(
      'content',
      theme === 'day' ? '#fafafa' : '#17191e',
    )
    try {
      window.localStorage.setItem(THEME_STORAGE_KEY, theme)
    } catch {
      // Applying the theme does not depend on persistence.
    }
  }, [theme])

  function enterRoom(nextSession: ActiveRoomSession) {
    setSession(nextSession)
    setInvitation(null)
    window.history.replaceState(
      null,
      '',
      `${roomPath(nextSession.roomId)}${window.location.search}`,
    )
  }

  function leaveRoom() {
    setSession(null)
    setInvitation(null)
    window.history.replaceState(null, '', `/${window.location.search}`)
  }

  const toggleTheme = () => setTheme((current) => current === 'night' ? 'day' : 'night')

  if (session === null) {
    return (
      <AccessScreen
        initialInvitation={invitation}
        onSession={enterRoom}
        theme={theme}
        onToggleTheme={toggleTheme}
      />
    )
  }

  return (
    <RoomWorkspace
      session={session}
      onLeave={leaveRoom}
      theme={theme}
      onToggleTheme={toggleTheme}
    />
  )
}

export default App