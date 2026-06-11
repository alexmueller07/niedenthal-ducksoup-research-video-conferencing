// PeerLink: one WebRTC connection to one other seat, with signaling relayed
// through the session server.
//
// Implements the "perfect negotiation" pattern (polite/impolite roles) so both
// sides can add tracks whenever they like — glare resolves itself. Media flows
// peer-to-peer over the lab LAN; the STUN entry only matters if machines sit on
// different subnets.

import type { SignalData } from './protocol'

export interface PeerLinkOptions {
  /** The polite side rolls back on glare. Exactly one side of each pair. */
  polite: boolean
  sendSignal: (data: SignalData) => void
  onTrack: (track: MediaStreamTrack, streams: readonly MediaStream[]) => void
  onConnectionState: (state: RTCPeerConnectionState) => void
}

export class PeerLink {
  readonly pc: RTCPeerConnection
  private opts: PeerLinkOptions
  private makingOffer = false
  private ignoreOffer = false
  private closed = false

  constructor(opts: PeerLinkOptions) {
    this.opts = opts
    this.pc = new RTCPeerConnection({
      iceServers: [{ urls: 'stun:stun.l.google.com:19302' }],
    })

    this.pc.onnegotiationneeded = async () => {
      try {
        this.makingOffer = true
        await this.pc.setLocalDescription()
        if (this.pc.localDescription) {
          opts.sendSignal({ description: this.pc.localDescription.toJSON() })
        }
      } catch (err) {
        console.error('negotiationneeded failed', err)
      } finally {
        this.makingOffer = false
      }
    }

    this.pc.onicecandidate = (e) => {
      opts.sendSignal({ candidate: e.candidate ? e.candidate.toJSON() : null })
    }

    this.pc.ontrack = (e) => {
      opts.onTrack(e.track, e.streams)
    }

    this.pc.onconnectionstatechange = () => {
      opts.onConnectionState(this.pc.connectionState)
    }
  }

  async handleSignal(data: SignalData): Promise<void> {
    if (this.closed) return
    try {
      if (data.description) {
        const description = data.description as RTCSessionDescriptionInit
        const offerCollision =
          description.type === 'offer' &&
          (this.makingOffer || this.pc.signalingState !== 'stable')
        this.ignoreOffer = !this.opts.polite && offerCollision
        if (this.ignoreOffer) return
        await this.pc.setRemoteDescription(description)
        if (description.type === 'offer') {
          await this.pc.setLocalDescription()
          if (this.pc.localDescription) {
            this.opts.sendSignal({ description: this.pc.localDescription.toJSON() })
          }
        }
      } else if (data.candidate !== undefined) {
        try {
          await this.pc.addIceCandidate(data.candidate ?? undefined)
        } catch (err) {
          if (!this.ignoreOffer) throw err
        }
      }
    } catch (err) {
      console.error('signal handling failed', err)
    }
  }

  addStreamTracks(stream: MediaStream) {
    for (const track of stream.getTracks()) {
      this.pc.addTrack(track, stream)
    }
  }

  addTrack(track: MediaStreamTrack, stream: MediaStream) {
    return this.pc.addTrack(track, stream)
  }

  close() {
    this.closed = true
    this.pc.close()
  }
}
