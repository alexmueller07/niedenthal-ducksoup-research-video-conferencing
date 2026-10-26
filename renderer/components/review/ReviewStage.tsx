// The video area of the review, in any of the three view modes.
//
// Every recording in play gets one <video> element that stays mounted for
// the whole review; the view mode and the altered/original toggle only change
// where each element sits and whether it is heard. Nothing reloads on a
// switch, so toggling is instant and stays in sync.
//
//   gallery — everything at once: each person's altered video (and original,
//             when shown), the person whose turn it is highlighted
//   single  — the partner's video (the person you watched during the call)
//   active  — only the person whose turn it is
//
// Sound: in gallery the altered recordings play; otherwise both voices come
// from whichever version is on screen, so it sounds like the conversation.

import { useEffect, useRef, useState } from 'react'
import { reviewPositionMs } from '../../../main/review'
import { ReviewTrack } from '../../lib/reviewSync'
import type {
  PSlot,
  ReviewMedia,
  ReviewState,
  ReviewViewMode,
  VideoVersion,
} from '../../lib/protocol'

const SEATS: PSlot[] = ['P1', 'P2']
const SYNC_INTERVAL_MS = 100

export const VERSION_LABEL: Record<VideoVersion, string> = {
  altered: 'Changed',
  clean: 'Original',
}

interface Tile {
  key: string
  person: PSlot
  version: VideoVersion
}

export interface ReviewStageProps {
  onPlaybackTime?: (ms: number) => void
  versionsBySeat?: Record<PSlot, VideoVersion>
  audioOnly?: boolean
  state: ReviewState
  media: ReviewMedia
  baseUrl: string
  serverNow: () => number
  mode: ReviewViewMode
  /** Which recordings to load. */
  versions: VideoVersion[]
  /** The version on screen in single/active mode. */
  version: VideoVersion
  /** The seat watching (decides whose video 'single' shows), or null for the researcher. */
  viewer: PSlot | null
  names: Record<PSlot, string>
  muted?: boolean
  onReady?: (loadSeq: number) => void
  onBuffering?: (loadSeq: number) => void
}

export function ReviewStage({
  state,
  media,
  baseUrl,
  serverNow,
  mode,
  versions,
  version,
  viewer,
  names,
  muted = false,
  onReady,
  onBuffering,
  onPlaybackTime,
  versionsBySeat,
  audioOnly,
}: ReviewStageProps) {
  const tiles: Tile[] = SEATS.flatMap((person) =>
    (versionsBySeat ? [versionsBySeat[person]] : versions).map((v) => ({ key: `${person}:${v}`, person, version: v })),
  )
  const tilesKey = tiles.map((t) => t.key).join('|')
  const target = state.segments[state.current]?.targetSeat ?? 'P1'
  const shownPerson: PSlot = mode === 'single' && viewer ? (viewer === 'P1' ? 'P2' : 'P1') : target

  const videoRefs = useRef(new Map<string, HTMLVideoElement>())
  const tracksRef = useRef(new Map<string, ReviewTrack>())
  const stateRef = useRef(state)
  stateRef.current = state
  const callbacksRef = useRef({ onReady, onBuffering, serverNow, onPlaybackTime })
  callbacksRef.current = { onReady, onBuffering, serverNow, onPlaybackTime }
  const [gaps, setGaps] = useState<Record<string, boolean>>({})
  const [broken, setBroken] = useState<Record<string, boolean>>({})

  const isVisible = (t: Tile) =>
    !audioOnly && (mode === 'gallery' || (t.person === shownPerson && (!!versionsBySeat || t.version === version)))
  const isAudible = (t: Tile) => !muted && (versionsBySeat ? true : mode === 'gallery' ? t.version === 'altered' : t.version === version)
  const watchedRef = useRef<(t: Tile) => boolean>(() => true)
  watchedRef.current = (t) => isVisible(t) || isAudible(t)

  // One track per recording, rebuilt only if the recordings themselves change.
  useEffect(() => {
    const tracks = new Map<string, ReviewTrack>()
    for (const tile of tiles) {
      const video = videoRefs.current.get(tile.key)
      if (!video) continue
      tracks.set(
        tile.key,
        new ReviewTrack(video, {
          parts: media[tile.person][tile.version],
          baseUrl,
          onGap: (gap) => setGaps((prev) => (prev[tile.key] === gap ? prev : { ...prev, [tile.key]: gap })),
          onBroken: (b) => setBroken((prev) => (prev[tile.key] === b ? prev : { ...prev, [tile.key]: b })),
          onStall: () => {
            // A hidden, silent element falling behind is no reason to stop everyone.
            if (!watchedRef.current(tile)) return
            callbacksRef.current.onBuffering?.(stateRef.current.loadSeq)
          },
        }),
      )
    }
    tracksRef.current = tracks
    return () => {
      for (const track of tracks.values()) track.destroy()
      tracksRef.current = new Map()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [media, baseUrl, tilesKey])

  // Each time the server asks for it, get every player to the same spot.
  useEffect(() => {
    if (state.status !== 'loading') return
    const seq = state.loadSeq
    const at = state.anchorPosMs
    let cancelled = false
    let retry: ReturnType<typeof setTimeout> | null = null
    const prepare = async () => {
      await Promise.all([...tracksRef.current.values()].map(t => t.prepare(at).catch(() => {})))
      if (cancelled || stateRef.current.status !== 'loading' || stateRef.current.loadSeq !== seq) return
      const ready = tracksRef.current.size === tiles.length && [...tracksRef.current.values()].every(t => t.readyAt(at))
      if (stateRef.current.config.task !== 'continuous' || ready) callbacksRef.current.onReady?.(seq)
      else retry = setTimeout(() => void prepare(), 2000)
    }
    void prepare()
    return () => { cancelled = true; if (retry) clearTimeout(retry) }
  }, [state.status, state.loadSeq, state.anchorPosMs, tilesKey])

  // Follow the shared clock.
  useEffect(() => {
    const id = setInterval(() => {
      const s = stateRef.current
      const now = callbacksRef.current.serverNow()
      const playing = s.status === 'playing' && now >= s.anchorServerMs
      const pos = reviewPositionMs(s, now)
      for (const track of tracksRef.current.values()) track.sync(pos, playing)
      if (playing) {
        const active = [...tracksRef.current.entries()].filter(([key]) => {
          const tile = tiles.find(t => t.key === key)
          return tile && watchedRef.current(tile)
        })
        const times = active.map(([, t]) => t.playbackTimeMs())
        if (times.length && times.every((t): t is number => t !== null)) callbacksRef.current.onPlaybackTime?.(Math.min(...times))
      }
    }, SYNC_INTERVAL_MS)
    return () => clearInterval(id)
  }, [tilesKey])

  // Mute everything that should not be heard.
  useEffect(() => {
    for (const tile of tiles) {
      const video = videoRefs.current.get(tile.key)
      if (video) video.muted = !isAudible(tile)
    }
  })

  const rows = versionsBySeat ? 1 : versions.length
  const containerClass =
    mode === 'gallery'
      ? `grid h-full w-full gap-3 ${rows === 2 ? 'grid-cols-2 grid-rows-2' : 'grid-cols-2 grid-rows-1'}`
      : 'relative h-full w-full'

  return (
    <div className={containerClass}>
      {audioOnly && <div className="absolute inset-0 flex items-center justify-center text-gray-300">Conversation audio</div>}
      {tiles.map((tile) => {
        const visible = isVisible(tile)
        const placement =
          mode === 'gallery'
            ? 'relative h-full w-full'
            : visible
              ? 'absolute inset-0'
              : 'pointer-events-none absolute left-0 top-0 h-px w-px opacity-0'
        const highlight = mode === 'gallery' && tile.person === target
        return (
          <div
            key={tile.key}
            className={`${placement} overflow-hidden rounded-xl bg-black ${
              highlight ? 'ring-2 ring-sky-400' : 'ring-1 ring-white/10'
            }`}
            aria-hidden={!visible}
          >
            <video
              ref={(el) => {
                if (el) videoRefs.current.set(tile.key, el)
                else videoRefs.current.delete(tile.key)
              }}
              playsInline
              className="h-full w-full object-contain"
            />
            {visible && !gaps[tile.key] && broken[tile.key] && (
              <div className="absolute inset-0 flex items-center justify-center bg-gray-950/85 px-6 text-center text-sm text-gray-400">
                This part of the recording cannot be played
              </div>
            )}
            {visible && gaps[tile.key] && (
              <div className="absolute inset-0 flex items-center justify-center bg-gray-950/85 px-6 text-center text-sm text-gray-400">
                No video for this moment (the connection dropped during the call)
              </div>
            )}
            {visible && (
              <div className="absolute bottom-3 left-3 flex items-center gap-2 rounded-lg bg-black/60 px-2.5 py-1 text-xs font-medium text-white backdrop-blur-sm">
                {names[tile.person]}
                {versions.length > 1 && (
                  <span
                    className={`rounded px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide ${
                      tile.version === 'altered' ? 'bg-violet-500/30 text-violet-200' : 'bg-gray-500/30 text-gray-200'
                    }`}
                  >
                    {VERSION_LABEL[tile.version]}
                  </span>
                )}
              </div>
            )}
          </div>
        )
      })}
    </div>
  )
}
