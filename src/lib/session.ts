import type { MessageSenderContext } from './message-crypto'

export interface ActiveRoomSession {
  roomId: string
  invitationKey?: string
  locator: string
  authToken: string
  messageRoot: CryptoKey
  deviceId: string
  sender: MessageSenderContext
  expiresAt: number
}
