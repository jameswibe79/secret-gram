import { useState } from 'react'

import './App.css'
import { AccessScreen } from './components/AccessScreen'
import { RoomWorkspace } from './components/RoomWorkspace'
import type { ActiveRoomSession } from './lib/session'

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

  if (session === null) {
    return <AccessScreen initialRoomCode={invitedCode} onSession={enterRoom} />
  }

  return <RoomWorkspace session={session} onLeave={leaveRoom} />
}

export default App