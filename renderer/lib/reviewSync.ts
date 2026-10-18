// Keeps one <video> element on the review's shared clock.
//
// The server says where playback should be (a position on the conversation
// timeline); this works out which recording file covers that moment, loads
// it from the session server, and holds the element there:
//   off by < 80 ms   → leave it
//   80–400 ms        → play 5% faster or slower until it catches up
//   > 400 ms         → jump straight to the right spot
// A participant's recording can have gaps (a reconnect restarts it as a
// _part2 file); during a gap the element pauses and reports `gap` so the tile
// can say so, while the clock — and the partner's screen — carries on.

import { resolveMediaAt } from '../../main/review'
import type { ReviewMediaPart } from './protocol'

const SMALL_DRIFT_S = 0.08
const BIG_DRIFT_S = 0.4
const PAUSED_DRIFT_S = 0.05
const LOAD_TIMEOUT_MS = 8000
const STALL_REPORT_MS = 1000

export interface ReviewTrackOptions {
  parts: ReviewMediaPart[]
  /** http://host:port of the session server; part URLs are paths on it. */
  baseUrl: string
  onGap?: (gap: boolean) => void
  /** Fired once the element has been stuck buffering for over a second while it should be playing. */
  onStall?: () => void
}

export class ReviewTrack {
  private url = ''
  private busy = false
  private wantPlaying = false
  private gap: boolean | null = null
  private stallTimer: ReturnType<typeof setTimeout> | null = null
  private readonly onWaiting = () => {
    if (!this.wantPlaying || this.stallTimer) return
    this.stallTimer = setTimeout(() => {
      this.stallTimer = null
      if (this.wantPlaying && this.video.readyState < 3) this.opts.onStall?.()
    }, STALL_REPORT_MS)
  }
  private readonly onPlaying = () => this.clearStall()

  constructor(
    readonly video: HTMLVideoElement,
    private readonly opts: ReviewTrackOptions,
  ) {
    video.preload = 'auto'
    video.playsInline = true
    video.addEventListener('waiting', this.onWaiting)
    video.addEventListener('playing', this.onPlaying)
    video.addEventListener('canplay', this.onPlaying)
  }

  destroy() {
    this.clearStall()
    this.video.removeEventListener('waiting', this.onWaiting)
    this.video.removeEventListener('playing', this.onPlaying)
    this.video.removeEventListener('canplay', this.onPlaying)
    this.video.pause()
    this.video.removeAttribute('src')
    this.video.load()
  }

  /** Get ready to play from this moment; resolves once it can (or straight away for a gap). */
  async prepare(timelineMs: number): Promise<void> {
    this.wantPlaying = false
    this.clearStall()
    const hit = resolveMediaAt(this.opts.parts, timelineMs)
    if (!hit) {
      this.video.pause()
      this.setGap(true)
      return
    }
    this.setGap(false)
    this.busy = true
    try {
      await this.load(hit.part)
      this.video.pause()
      this.video.playbackRate = 1
      await this.seek(hit.localMs / 1000)
      await this.canPlay()
    } finally {
      this.busy = false
    }
  }

  /** Called a few times a second with where the shared clock is. */
  sync(timelineMs: number, playing: boolean) {
    this.wantPlaying = playing
    if (!playing) this.clearStall()
    if (this.busy) return
    const hit = resolveMediaAt(this.opts.parts, timelineMs)
    if (!hit) {
      if (!this.video.paused) this.video.pause()
      this.setGap(true)
      return
    }
    this.setGap(false)
    const local = hit.localMs / 1000
    if (hit.part.url !== this.url) {
      // Crossed into the next file (after a reconnect gap).
      this.busy = true
      void this.load(hit.part)
        .then(() => {
          this.video.currentTime = local
        })
        .catch(() => {})
        .finally(() => {
          this.busy = false
        })
      return
    }
    if (this.video.seeking) return
    const drift = this.video.currentTime - local
    if (!playing) {
      if (!this.video.paused) this.video.pause()
      this.video.playbackRate = 1
      if (Math.abs(drift) > PAUSED_DRIFT_S) this.video.currentTime = local
      return
    }
    if (Math.abs(drift) > BIG_DRIFT_S) {
      this.video.currentTime = local
      this.video.playbackRate = 1
    } else if (Math.abs(drift) > SMALL_DRIFT_S) {
      this.video.playbackRate = drift < 0 ? 1.05 : 0.95
    } else {
      this.video.playbackRate = 1
    }
    if (this.video.paused) void this.video.play().catch(() => {})
  }

  private setGap(gap: boolean) {
    if (this.gap === gap) return
    this.gap = gap
    this.opts.onGap?.(gap)
  }

  private clearStall() {
    if (this.stallTimer) clearTimeout(this.stallTimer)
    this.stallTimer = null
  }

  private load(part: ReviewMediaPart): Promise<void> {
    if (part.url === this.url && this.video.readyState >= 1) return Promise.resolve()
    this.url = part.url
    this.video.src = this.opts.baseUrl + part.url
    return waitFor(this.video, 'loadedmetadata', () => this.video.readyState >= 1)
  }

  private seek(seconds: number): Promise<void> {
    if (Math.abs(this.video.currentTime - seconds) < 0.001 && !this.video.seeking) return Promise.resolve()
    const done = waitFor(this.video, 'seeked', () => false)
    this.video.currentTime = seconds
    return done
  }

  private canPlay(): Promise<void> {
    return waitFor(this.video, 'canplay', () => this.video.readyState >= 3)
  }
}

/** Resolve on the event (or if already true); give up quietly after a timeout or an error. */
function waitFor(el: HTMLMediaElement, event: string, already: () => boolean): Promise<void> {
  if (already()) return Promise.resolve()
  return new Promise((resolve) => {
    const finish = () => {
      clearTimeout(timer)
      el.removeEventListener(event, finish)
      el.removeEventListener('error', finish)
      resolve()
    }
    const timer = setTimeout(finish, LOAD_TIMEOUT_MS)
    el.addEventListener(event, finish)
    el.addEventListener('error', finish)
  })
}

/** http(s)://host:port for a ws(s):// session server URL. */
export function httpBaseFor(wsUrl: string): string {
  return wsUrl.replace(/^ws/, 'http').replace(/\/+$/, '')
}

/** m:ss for a timeline position. */
export function fmtTimeline(ms: number): string {
  const total = Math.max(0, Math.round(ms / 1000))
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`
}
