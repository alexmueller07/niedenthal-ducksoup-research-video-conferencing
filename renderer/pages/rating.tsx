import { useEffect, useRef, useState } from 'react'
import { hasIpc, ipcInvoke } from '../lib/ipcUtil'
import { browserRatingLookup, completeRecording, inspectRatingVideo, normalizeDyad } from '../lib/ratingStation'
import type { BrowserRatingCandidate } from '../lib/ratingStation'
import { RatingStationTask } from '../components/review/RatingStationTask'
import type { RatingStationRun } from '../components/review/RatingStationTask'
import type { RatingCandidate, RatingRecording } from '../../main/ratingStation'
import RetryCountdown, { retriesExhausted } from '../components/rating/RetryCountdown'
import type { RetryState } from '../components/rating/RetryCountdown'

const colors: Record<string, string> = { Red: '#d64545', Blue: '#3b76d6', Purple: '#8c56c4', Black: '#242424', Orange: '#e0812b', Green: '#3faa5a' }
const RETRY_MAX = 4
const RETRY_EVERY_MS = 10_000
const choice = (on: boolean) => `rs-choice ${on ? 'on' : ''}`
const validId = (id: string) => /^[A-Za-z0-9_-]{1,60}$/.test(id)
const message = (error: unknown) => error instanceof Error ? error.message : String(error)
const localDate = () => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}` }

export default function RatingStationPage() {
  const [native, setNative] = useState(false)
  const [root, setRoot] = useState('')
  const [driveChoices, setDriveChoices] = useState<string[]>([])
  const [files, setFiles] = useState<File[]>([])
  const picker = useRef<HTMLInputElement>(null)
  const [dyad, setDyad] = useState('')
  const [lookupParticipant, setLookupParticipant] = useState('')
  const [round, setRound] = useState(1)
  const [seat, setSeat] = useState<'P1' | 'P2'>('P1')
  const [manualParticipant, setManualParticipant] = useState('')
  const [manualPartner, setManualPartner] = useState('')
  const [selfColor, setSelfColor] = useState('')
  const [partnerColor, setPartnerColor] = useState('')
  const [group, setGroup] = useState<'A' | 'B' | 'C'>('A')
  // What to present: the RA's choice before handing the computer over.
  const [audioOnly, setAudioOnly] = useState(false)
  const [ownVersion, setOwnVersion] = useState<'clean' | 'altered'>('clean')
  const [partnerVersion, setPartnerVersion] = useState<'clean' | 'altered'>('altered')
  const [blocks, setBlocks] = useState<number[]>([0, 1, 2, 3])
  const [initials, setInitials] = useState('')
  const [ra, setRa] = useState('')
  const [date, setDate] = useState(localDate)
  const [time, setTime] = useState(() => new Date().toTimeString().slice(0, 5))
  const [candidates, setCandidates] = useState<BrowserRatingCandidate[]>([])
  const [selectedId, setSelectedId] = useState('')
  const [searching, setSearching] = useState(false)
  const [searched, setSearched] = useState(false)
  const [refresh, setRefresh] = useState(0)
  const [preparing, setPreparing] = useState(false)
  const [searchError, setSearchError] = useState('')
  const [error, setError] = useState('')
  const [run, setRun] = useState<RatingStationRun | null>(null)
  const request = useRef(0)
  const [retry, setRetry] = useState<RetryState>({ attempt: 0, nextAt: null, max: RETRY_MAX })
  const [previewUrl, setPreviewUrl] = useState('')
  const [attempted, setAttempted] = useState(false)
  const check = useRef<AbortController | null>(null)
  const normalizedDyad = normalizeDyad(dyad)
  const selected = candidates.find(c => c.id === selectedId)
  const effectiveDyad = lookupParticipant.trim() ? selected?.dyadId || '' : normalizedDyad
  const otherSeat = seat === 'P1' ? 'P2' : 'P1'
  const participant = selected?.participantIds[seat] || manualParticipant.trim()
  const partner = selected?.participantIds[otherSeat] || manualPartner.trim()
  const idsValid = validId(participant) && validId(partner) && participant !== partner
  const detailsValid = Boolean(ra.trim() && initials.trim() && date && time && blocks.length)
  const canStart = Boolean(effectiveDyad && completeRecording(selected) && idsValid && detailsValid && !searching)

  useEffect(() => {
    setNative(hasIpc())
    if (hasIpc()) {
      void ipcInvoke<string>('rating:root').then(value => setRoot(value || '')).catch(e => setError(message(e)))
      void ipcInvoke<string[]>('rating:detect-roots').then(found => setDriveChoices(found || [])).catch(() => {})
    }
    return () => check.current?.abort()
  }, [])

  useEffect(() => {
    const ticket = ++request.current
    setCandidates([]); setSelectedId(''); setSearchError(''); setError(''); setSearched(false)
    const canSearch = Boolean((lookupParticipant.trim() || normalizedDyad) && root && (native || files.length))
    setSearching(canSearch)
    if (!canSearch) return
    const timer = setTimeout(async () => {
      try {
        const results = lookupParticipant.trim()
          ? native ? await ipcInvoke<RatingCandidate[]>('rating:lookup-participant', lookupParticipant.trim()) : await browserRatingLookup(files, '', lookupParticipant.trim())
          : native ? await ipcInvoke<RatingCandidate[]>('rating:lookup', normalizedDyad) : await browserRatingLookup(files, normalizedDyad)
        if (ticket !== request.current) return
        setCandidates(results || [])
        if (results?.length === 1) {
          setSelectedId(results[0].id)
          if (lookupParticipant.trim()) {
            const matchedSeat = (['P1', 'P2'] as const).find(slot => results[0].participantIds[slot]?.toLowerCase() === lookupParticipant.trim().toLowerCase())
            if (matchedSeat) setSeat(matchedSeat)
          }
        }
      } catch (e) { if (ticket === request.current) setSearchError(message(e)) }
      finally { if (ticket === request.current) { setSearching(false); setSearched(true) } }
    }, 350)
    return () => { clearTimeout(timer); ++request.current }
  }, [normalizedDyad, lookupParticipant, root, native, files, refresh])

  useEffect(() => {
    setManualParticipant(''); setManualPartner(''); setInitials(''); setSelfColor(''); setPartnerColor('')
  }, [normalizedDyad, root])

  // The recording room may still be copying: look again by itself a few times, and say so.
  useEffect(() => { setRetry({ attempt: 0, nextAt: null, max: RETRY_MAX }) }, [normalizedDyad, lookupParticipant, root])
  useEffect(() => {
    const canSearch = Boolean((lookupParticipant.trim() || normalizedDyad) && root && (native || files.length))
    if (!canSearch || !searched || searching || candidates.length || searchError || retry.nextAt !== null || retry.attempt >= retry.max) return
    setRetry(r => ({ ...r, nextAt: Date.now() + RETRY_EVERY_MS }))
  }, [searched, searching, candidates.length, searchError, retry.attempt, retry.nextAt])
  useEffect(() => {
    if (retry.nextAt === null) return
    const timer = setTimeout(() => { setRetry(r => ({ ...r, attempt: r.attempt + 1, nextAt: null })); setRefresh(value => value + 1) }, Math.max(0, retry.nextAt - Date.now()))
    return () => clearTimeout(timer)
  }, [retry.nextAt])

  // A frame from the chosen recording, so a wrong one is caught before the participant sits down.
  useEffect(() => {
    setPreviewUrl('')
    if (!selected) return
    let live = true
    let blob = ''
    if (native) void ipcInvoke<string | null>('rating:preview', effectiveDyad || normalizedDyad, selected.id).then(url => { if (live && url) setPreviewUrl(url) }).catch(() => {})
    else {
      const file = selected.files?.['P1:clean'] || Object.values(selected.files || {})[0]
      if (file) { blob = URL.createObjectURL(file); setPreviewUrl(blob) }
    }
    return () => { live = false; if (blob) URL.revokeObjectURL(blob) }
  }, [selectedId, native])

  async function browseSession() {
    try {
      if (!native) { picker.current?.click(); return }
      const picked = await ipcInvoke<{ root: string; participantId: string } | null>('rating:browse-session')
      if (picked) { setRoot(picked.root); setDyad(''); setLookupParticipant(picked.participantId); setRefresh(value => value + 1) }
    } catch (e) { setError(message(e)) }
  }

  async function chooseRoot() {
    if (!native) { picker.current?.click(); return }
    try {
      const next = await ipcInvoke<string>('rating:choose-root')
      if (next) { setRoot(next); setRefresh(value => value + 1) }
    } catch (e) { setError(message(e)) }
  }

  async function release(runId: string, urls: string[]) {
    urls.filter(url => url.startsWith('blob:')).forEach(url => URL.revokeObjectURL(url))
    if (native) await ipcInvoke('rating:finish', runId)
  }

  async function start() {
    if (!selected || !canStart || check.current) return
    const controller = new AbortController()
    check.current = controller
    setPreparing(true); setError('')
    const runId = crypto.randomUUID()
    let urls: string[] = []
    try {
      let recordings: Pick<RatingRecording, 'seat' | 'kind'>[]
      if (native) {
        const prepared = await ipcInvoke<{ recordings: Pick<RatingRecording, 'seat' | 'kind'>[]; urls: string[] }>('rating:prepare', effectiveDyad, selected.id, runId, seat, { own: ownVersion, partner: partnerVersion })
        if (!prepared) throw new Error('Could not prepare the selected recording.')
        urls = prepared.urls; recordings = prepared.recordings
      } else {
        recordings = selected.recordings.filter(r => r.kind === (r.seat === seat ? ownVersion : partnerVersion))
        for (const recording of recordings) {
          const file = selected.files?.[`${recording.seat}:${recording.kind}`]
          if (!file) throw new Error('A selected recording is missing. Choose the folder again.')
          urls.push(URL.createObjectURL(file))
        }
      }
      if (urls.length !== 2) throw new Error('Both participant videos are required.')
      await Promise.all(urls.map((url, i) => inspectRatingVideo(url, controller.signal).catch(e => { throw new Error(`${recordings[i].seat}: ${message(e)}`) })))
      if (controller.signal.aborted) throw new Error('Recording check cancelled.')
      setRun({ audioOnly, ownVersion, partnerVersion, blocks: [...blocks].sort((a, b) => a - b), runId, dyad: effectiveDyad, candidateId: selected.id, participantId: participant, partnerId: partner, seat, round, group, selfColor, partnerColor, initials: initials.trim(), researcher: ra.trim(), date, time, native, recordings: recordings.map((r, i) => ({ ...r, url: urls[i] })) })
    } catch (e) {
      if (!controller.signal.aborted) setError(message(e))
      controller.abort()
      await release(runId, urls).catch(() => {})
    } finally {
      check.current = null
      setPreparing(false)
    }
  }

  if (run) return <RatingStationTask run={run} onExit={() => {
    void release(run.runId, run.recordings.map(r => r.url)).catch(e => setError(message(e)))
    setRun(null); setInitials(''); setTime(new Date().toTimeString().slice(0, 5))
  }} />

  const missing: string[] = []
  if (!root) missing.push('recordings folder')
  if (!selected || !completeRecording(selected)) missing.push('a complete conversation recording')
  if (!validId(participant)) missing.push('participant ID')
  if (!validId(partner) || partner === participant) missing.push('partner ID')
  if (!initials.trim()) missing.push('initials')
  if (!ra.trim()) missing.push('RA name')
  if (!blocks.length) missing.push('at least one part')
  const searchable = Boolean((lookupParticipant.trim() || normalizedDyad) && root)

  return <main className="suite-content rating-setup rs">
    <input ref={picker} type="file" hidden multiple {...{ webkitdirectory: '' }} onChange={e => {
      const next = Array.from(e.target.files || [])
      if (next.length) { setFiles(next); setRoot(next[0].webkitRelativePath.split('/')[0]) }
      e.target.value = ''
    }} />
    <fieldset style={{ border: 0, margin: 0, padding: 0, minWidth: 0, maxWidth: 820 }}>
      <div>
        <div className="mb-8">
          <h1 className="text-white text-4xl font-bold">Set up this station</h1>
          <p className="text-gray-400 text-base mt-2">Researcher only. Hand the computer over once this is done.</p>
        </div>

        <section className="rs-card">
          <h2 className="text-white text-xl font-bold mb-1">Research Drive</h2>
          <p className="text-gray-400 text-sm mb-4">Where the recording rooms file their conversations. This station finds the participant's recording here on its own, so nobody browses for a file mid-session. Set it once on this computer and it is remembered.</p>
          <div className="flex items-center gap-3 flex-wrap">
            {root ? <span className="text-green-400 text-sm font-mono break-all">{root}</span> : <span className="text-yellow-400 text-sm">Not set yet.</span>}
            <button type="button" onClick={() => void chooseRoot()} className="suite-btn">{root ? 'Change' : 'Browse'}</button>
          </div>
          {native && driveChoices.filter(c => c !== root).length > 0 && <div className="flex flex-wrap items-center gap-2 mt-3">
            <span className="text-gray-400 text-sm">Found on this computer:</span>
            {driveChoices.filter(c => c !== root).map(c => <button type="button" key={c} title={c} onClick={() => void ipcInvoke('rating:set-root', c).then(() => { setRoot(c); setRefresh(v => v + 1) }).catch(e => setError(message(e)))} className="suite-btn">{c}</button>)}
          </div>}
        </section>

        <section className="rs-card">
          <h2 className="text-white text-xl font-bold mb-1">Which round is this?</h2>
          <p className="text-gray-400 text-sm mb-4">Saved with the participant's responses, so the rounds can be told apart afterwards.</p>
          <div className="flex items-center gap-3">
            {[1, 2, 3, 4, 5].map(r => <button key={r} type="button" onClick={() => setRound(r)} className={choice(round === r)}>R{r}</button>)}
          </div>
        </section>

        <section className="rs-card">
          <h2 className="text-white text-xl font-bold mb-1">Who is sitting here</h2>
          <p className="text-gray-400 text-sm mb-4">Type the participant's ID and their conversation is found automatically, with both IDs filled in from it. Or search by dyad ID.</p>
          <div className="grid grid-cols-2 gap-4">
            <div><label className="block text-white text-lg mb-2">Find by participant ID</label><input aria-label="Find by participant ID" autoComplete="off" className="suite-input" value={lookupParticipant} onChange={e => setLookupParticipant(e.target.value)} placeholder="e.g. P101" /></div>
            <div><label className="block text-white text-lg mb-2">Dyad ID (optional)</label><input aria-label="Dyad ID" autoComplete="off" className="suite-input" value={dyad} onChange={e => setDyad(e.target.value)} placeholder="e.g. 014" /></div>
            <div><label className="block text-white text-lg mb-2">Participant ID{selected?.participantIds[seat] && <span className="text-gray-500 text-sm ml-2">from the recording</span>}</label><input aria-label="Participant ID" autoComplete="off" className="suite-input" value={participant} readOnly={Boolean(selected?.participantIds[seat])} onChange={e => setManualParticipant(e.target.value)} /></div>
            <div><label className="block text-white text-lg mb-2">Partner ID{selected?.participantIds[otherSeat] && <span className="text-gray-500 text-sm ml-2">from the recording</span>}</label><input aria-label="Partner ID" autoComplete="off" className="suite-input" value={partner} readOnly={Boolean(selected?.participantIds[otherSeat])} onChange={e => setManualPartner(e.target.value)} /></div>
            <div className="col-span-2"><label className="block text-white text-lg mb-2">Seat in the recording</label>
              <div className="flex space-x-3">{(['P1', 'P2'] as const).map(side => <button key={side} type="button" onClick={() => setSeat(side)} className={choice(seat === side)}>{side}</button>)}</div></div>
          </div>
          {participant && partner && !idsValid && attempted && <p className="text-red-400 text-xs mt-2">Use two different IDs containing letters, numbers, dashes, or underscores.</p>}
          <div className="grid grid-cols-2 gap-4 mt-4">
            {([['This participant\'s nametag', selfColor, setSelfColor], ['Partner\'s nametag', partnerColor, setPartnerColor]] as const).map(([label, value, setValue]) => <div key={label}>
              <label className="block text-white text-lg mb-2">{label}</label>
              <div className="flex flex-wrap gap-2">{Object.entries(colors).map(([name, hex]) => { const active = value === name; return <button key={name} type="button" title={name} aria-pressed={active} onClick={() => setValue(active ? '' : name)} className={`rs-pill ${active ? 'on' : ''}`}><span aria-hidden className="w-4 h-4 rounded-full border border-white/40 shrink-0" style={{ backgroundColor: hex }} /><span className="text-white text-sm">{name}</span></button> })}</div>
            </div>)}
          </div>
        </section>

        <section className="rs-card">
          <div className="flex items-start justify-between gap-4 mb-4">
            <div>
              <h2 className="text-white text-xl font-bold mb-1">Conversation video</h2>
              <p className="text-gray-400 text-sm">{selected ? `Found for ${lookupParticipant.trim() ? `participant ${lookupParticipant.trim()}` : `dyad ${normalizedDyad}`}. Nothing to enter.` : 'Enter a participant ID above and their recording is found automatically.'}</p>
            </div>
            {searchable && <button type="button" onClick={() => { setRetry({ attempt: 0, nextAt: null, max: RETRY_MAX }); setRefresh(v => v + 1) }} disabled={searching} className="suite-btn">{searching ? 'Looking…' : 'Look again'}</button>}
          </div>
          <div className="space-y-4" aria-live="polite">
            {searching && <p className="text-gray-400 text-sm">Looking on the Research Drive for {lookupParticipant.trim() ? `participant ${lookupParticipant.trim()}` : `dyad ${normalizedDyad}`}…</p>}
            {searchError && <p className="text-red-400 text-sm" role="alert">{searchError}</p>}
            {!searching && candidates.length > 0 && <>
              <p className="text-gray-400 text-sm">{candidates.length === 1 ? '1 recording found.' : `${candidates.length} recordings found. The newest is first.`}</p>
              <div className="flex flex-wrap gap-2">{candidates.map((c, i) => <button type="button" key={c.id} aria-pressed={selectedId === c.id} onClick={() => { setSelectedId(c.id); setError(''); if (lookupParticipant.trim()) { const m = (['P1', 'P2'] as const).find(slot => c.participantIds[slot]?.toLowerCase() === lookupParticipant.trim().toLowerCase()); if (m) setSeat(m) } }} className={`rs-pill ${selectedId === c.id ? 'on' : ''}`}>{c.label} · {new Date(c.modifiedAt).toLocaleString()}{i === 0 && <span className="ml-2 text-gray-500 text-xs">newest</span>}{!completeRecording(c) && <span className="ml-2 text-yellow-400 text-xs">incomplete</span>}</button>)}</div>
            </>}
            {selected && <div className="flex gap-4 items-start">
              <div className="w-60 shrink-0 aspect-video border border-gray-700 rounded bg-gray-900 flex items-center justify-center overflow-hidden">
                {previewUrl ? <video src={previewUrl} muted preload="metadata" onLoadedMetadata={e => { e.currentTarget.currentTime = 1 }} className="w-full h-full object-cover" /> : <span className="text-gray-500 text-xs">Reading a frame…</span>}
              </div>
              <div className="min-w-0"><p className="text-white text-base break-words">{selected.label}</p><p className={`text-sm mt-1 ${completeRecording(selected) ? 'text-green-400' : 'text-yellow-400'}`}>{completeRecording(selected) ? 'All 4 recordings found. The task will open them without asking.' : 'Missing or duplicate recordings. This task needs one original and one changed video from each person.'}</p></div>
            </div>}
            {!searching && !candidates.length && !searchError && searched && <div className="border border-yellow-600 rounded-lg p-4">
              <p className="text-yellow-400 text-sm font-semibold">No recording found for {lookupParticipant.trim() ? `participant ${lookupParticipant.trim()}` : `dyad ${normalizedDyad}`}.</p>
              <p className="text-gray-300 text-sm mt-1">The recording may still be copying, or filed in a different folder. Check the ID, then look again, or point at the folder yourself.</p>
              <div className="mt-3">{!retriesExhausted(retry) ? <RetryCountdown retry={retry} /> : <button type="button" onClick={() => { setRetry({ attempt: 0, nextAt: null, max: RETRY_MAX }); setRefresh(v => v + 1) }} className="suite-btn">Try again</button>}</div>
            </div>}
            {!root && <p className="text-gray-500 text-sm">Choose the Research Drive folder above first.</p>}
            <button type="button" onClick={() => void browseSession()} className="text-gray-400 text-sm underline hover:text-white">Browse for the folder instead</button>
          </div>
        </section>

        <section className="rs-card space-y-4">
          <h2 className="text-white text-xl font-bold">What to show</h2>
          <p className="text-gray-400 text-sm -mt-2">What the participant sees and hears. Saved with their responses.</p>
          <div><label className="block text-white text-lg mb-2">Presentation</label>
            <div className="flex space-x-3">{([['video', 'Video and audio'], ['audio', 'Audio only']] as const).map(([k, l]) => <button key={k} type="button" aria-pressed={(k === 'audio') === audioOnly} onClick={() => setAudioOnly(k === 'audio')} className={choice((k === 'audio') === audioOnly)}>{l}</button>)}</div></div>
          <div className="grid grid-cols-2 gap-4">
            <div><label className="block text-white text-lg mb-2">Participant's own recording</label>
              <div className="flex space-x-3">{(['clean', 'altered'] as const).map(v => <button key={v} type="button" aria-pressed={ownVersion === v} onClick={() => setOwnVersion(v)} className={choice(ownVersion === v)}>{v === 'clean' ? 'Original' : 'Changed'}</button>)}</div></div>
            <div><label className="block text-white text-lg mb-2">Partner's recording</label>
              <div className="flex space-x-3">{(['clean', 'altered'] as const).map(v => <button key={v} type="button" aria-pressed={partnerVersion === v} onClick={() => setPartnerVersion(v)} className={choice(partnerVersion === v)}>{v === 'clean' ? 'Original' : 'Changed'}</button>)}</div></div>
          </div>
          <div><label className="block text-white text-lg mb-2">Parts to run (2:30 each)</label>
            <div className="flex space-x-3">{[0, 1, 2, 3].map(b => <button key={b} type="button" aria-pressed={blocks.includes(b)} onClick={() => setBlocks(cur => cur.includes(b) ? cur.filter(x => x !== b) : [...cur, b])} className={choice(blocks.includes(b))}>Part {b + 1}</button>)}</div></div>
        </section>

        <section className="rs-card space-y-4">
          <h2 className="text-white text-xl font-bold">This session</h2>
          <div><label className="block text-white text-lg mb-2">Group</label>
            <div className="flex space-x-3">{(['A', 'B', 'C'] as const).map(g => <button key={g} type="button" aria-pressed={group === g} onClick={() => setGroup(g)} className={choice(group === g)}>{g}</button>)}</div>
            <p className="text-gray-500 text-xs mt-2">Recorded with the responses. It does not change what this participant sees.</p></div>
          <div className="grid grid-cols-2 gap-4">
            <div><label className="block text-white text-lg mb-2">Subject initials</label><input aria-label="Subject initials" autoComplete="off" className="suite-input" value={initials} onChange={e => setInitials(e.target.value)} placeholder="AB" /></div>
            <div><label className="block text-white text-lg mb-2">RA name</label><input aria-label="RA name" autoComplete="off" className="suite-input" value={ra} onChange={e => setRa(e.target.value)} placeholder="Your name" /></div>
            <div><label className="block text-white text-lg mb-2">Session date</label><input aria-label="Session date" type="date" className="suite-input" value={date} onChange={e => setDate(e.target.value)} /></div>
            <div><label className="block text-white text-lg mb-2">Session time</label><input aria-label="Session time" type="time" className="suite-input" value={time} onChange={e => setTime(e.target.value)} /></div>
          </div>
        </section>

        {attempted && missing.length > 0 && <p className="text-red-400 text-sm mb-4" role="alert">Still needed: {missing.join(', ')}.</p>}
        {error && <p className="text-red-400 text-sm mb-4" role="alert">{error}</p>}
        <button type="button" disabled={preparing} onClick={() => { setAttempted(true); if (missing.length === 0 && canStart) void start() }} className="suite-btn primary rs-start">{preparing ? 'Checking that both videos can play…' : 'Start — hand the computer to the participant'}</button>
        <p className="text-gray-500 text-xs text-center mt-3">The next screen is the participant's first set of questions. Nothing above is shown to them.</p>
        {preparing && <div className="text-center mt-3"><button type="button" className="text-gray-400 text-sm underline hover:text-white" onClick={() => check.current?.abort()}>Cancel video check</button></div>}
      </div>
    </fieldset>
  </main>
}
