// SignalClient: one resilient WebSocket to the session server.
//
// Reconnects automatically (the hello is replayed, and the server gives the
// same seat back), so a network blip on a lab machine degrades to a few
// seconds of "Reconnecting…" instead of a dead session.

import type { ClientMessage, ServerMessage } from './protocol'
import { parseServerMessage } from './protocol'

export type SignalStatus = 'connecting' | 'connected' | 'reconnecting' | 'rejected' | 'closed'

export interface SignalClientOptions {
  url: string
  hello: Extract<ClientMessage, { type: 'hello' }>
  onMessage: (msg: ServerMessage) => void
  onStatus: (status: SignalStatus) => void
}

const RETRY_MS = 2000

export class SignalClient {
  private ws: WebSocket | null = null
  private opts: SignalClientOptions
  private closed = false
  private everConnected = false
  private retryTimer: ReturnType<typeof setTimeout> | null = null

  constructor(opts: SignalClientOptions) {
    this.opts = opts
  }

  connect() {
    if (this.closed) return
    this.opts.onStatus(this.everConnected ? 'reconnecting' : 'connecting')
    let ws: WebSocket
    try {
      ws = new WebSocket(this.opts.url)
    } catch {
      this.scheduleRetry()
      return
    }
    this.ws = ws

    ws.onopen = () => {
      this.everConnected = true
      this.send(this.opts.hello)
      this.opts.onStatus('connected')
    }
    ws.onmessage = (e) => {
      const msg = parseServerMessage(String(e.data))
      if (!msg) return
      if (msg.type === 'rejected') {
        this.closed = true
        this.opts.onStatus('rejected')
      }
      this.opts.onMessage(msg)
    }
    ws.onclose = () => {
      this.ws = null
      if (!this.closed) this.scheduleRetry()
    }
    ws.onerror = () => {
      ws.close()
    }
  }

  private scheduleRetry() {
    if (this.retryTimer) return
    this.opts.onStatus(this.everConnected ? 'reconnecting' : 'connecting')
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null
      this.connect()
    }, RETRY_MS)
  }

  send(msg: ClientMessage) {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(msg))
    }
  }

  get isOpen(): boolean {
    return this.ws !== null && this.ws.readyState === WebSocket.OPEN
  }

  close() {
    this.closed = true
    if (this.retryTimer) clearTimeout(this.retryTimer)
    this.retryTimer = null
    this.ws?.close()
    this.ws = null
    this.opts.onStatus('closed')
  }
}

/** Normalize what the RA types ("localhost", "10.0.0.5:8771", "ws://…") into a ws URL. */
export function normalizeServerUrl(input: string, defaultPort: number): string {
  let s = input.trim()
  if (s === '') s = 'localhost'
  if (!/^wss?:\/\//.test(s)) s = `ws://${s}`
  const hasPort = /:\d+$/.test(s.replace(/^wss?:\/\//, ''))
  if (!hasPort) s = `${s}:${defaultPort}`
  return s
}
