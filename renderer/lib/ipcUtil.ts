// Thin typed wrappers around the preload bridge. Every call degrades cleanly
// when the page runs in a plain browser (dev/testing without Electron).

interface IpcBridge {
  invoke<T>(channel: string, ...args: unknown[]): Promise<T>
  on<T>(channel: string, callback: (...args: T[]) => void): () => void
  send<T>(channel: string, value?: T): void
}

export function hasIpc(): boolean {
  return typeof window !== 'undefined' && typeof (window as { ipc?: unknown }).ipc !== 'undefined'
}

function bridge(): IpcBridge | null {
  return hasIpc() ? ((window as unknown as { ipc: IpcBridge }).ipc) : null
}

export async function ipcInvoke<T>(channel: string, ...args: unknown[]): Promise<T | null> {
  const b = bridge()
  if (!b) return null
  return b.invoke<T>(channel, ...args)
}

/** Subscribe; returns an unsubscribe function (no-op outside Electron). */
export function ipcOn<T>(channel: string, callback: (...args: T[]) => void): () => void {
  const b = bridge()
  if (!b) return () => {}
  return b.on<T>(channel, callback)
}
