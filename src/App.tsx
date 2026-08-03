import { useLayoutEffect, useState } from 'react'

import './App.css'
import { AccessScreen } from './components/AccessScreen'
import { RoomWorkspace } from './components/RoomWorkspace'
import type { ActiveRoomSession } from './lib/session'

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

function initialRoomCode(): string {
  const fragment = window.location.hash.slice(1)
  if (!fragment) return ''
  const params = new URLSearchParams(fragment)
  const code = params.get('room') ?? fragment
  window.history.replaceState(
    window.history.state,
    '',
    `${window.location.pathname}${window.location.search}`,
  )
  return code
}

function App() {
  const [session, setSession] = useState<ActiveRoomSession | null>(null)
  const [invitedCode, setInvitedCode] = useState(initialRoomCode)
  const [theme, setTheme] = useState<AppTheme>(initialTheme)

  useLayoutEffect(() => {
    document.documentElement.dataset.theme = theme
    document.querySelector<HTMLMetaElement>('meta[name="theme-color"]')?.setAttribute(
      'content',
      theme === 'day' ? '#f4f3ed' : '#090a0a',
    )
    try {
      window.localStorage.setItem(THEME_STORAGE_KEY, theme)
    } catch {
      // Applying the theme does not depend on persistence.
    }
  }, [theme])

  function enterRoom(nextSession: ActiveRoomSession) {
    setSession(nextSession)
    setInvitedCode('')
    if (window.location.hash) {
      window.history.replaceState(null, '', `${window.location.pathname}${window.location.search}`)
    }
  }

  function leaveRoom() {
    setSession(null)
    setInvitedCode('')
  }

  const toggleTheme = () => setTheme((current) => current === 'night' ? 'day' : 'night')

  if (session === null) {
    return (
      <AccessScreen
        initialRoomCode={invitedCode}
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