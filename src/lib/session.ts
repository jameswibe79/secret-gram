import type { MessageSenderContext } from './message-crypto'

export interface ActiveRoomSession {
  roomCode: string
  locator: string
  authToken: string
  messageRoot: CryptoKey
  deviceId: string
  sender: MessageSenderContext
  expiresAt: number
}
