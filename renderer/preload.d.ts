import type { IpcHandler } from '../main/preload'

declare global {
  interface Window {
    ipc: IpcHandler
    DuckSoup: {
      render: (
        embedOptions: {
          callback?: (event: { kind: string; payload?: unknown }) => void
          mountEl?: HTMLElement
          stats?: boolean
        },
        peerOptions: {
          signalingUrl: string
          interactionName: string
          userId: string
          duration?: number
          size?: number
          width?: number
          height?: number
          framerate?: number
          videoFx?: string
          audioFx?: string
          videoFormat?: string
          recordingMode?: string
          namespace?: string
          gpu?: boolean
          overlay?: boolean
        }
      ) => Promise<{
        controlFx: (
          name: string,
          property: string,
          value: number,
          duration?: number,
          userId?: string
        ) => void
        polyControlFx: (...args: unknown[]) => void
        start: () => void
        stop: () => void
        serverLog: (kind: string, payload?: string) => void
      }>
    }
  }
}
