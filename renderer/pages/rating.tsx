import { useEffect, useRef, useState } from 'react'
import { ArrowRight, Check, Circle, FolderOpen, Loader2, RefreshCw, Search, Video } from 'lucide-react'
import { PageHeading } from '../components/SuiteShell'
import { hasIpc, ipcInvoke } from '../lib/ipcUtil'
import { browserRatingLookup, completeRecording, inspectRatingVideo, normalizeDyad } from '../lib/ratingStation'
import type { BrowserRatingCandidate } from '../lib/ratingStation'
import { RatingStationTask } from '../components/review/RatingStationTask'
import type { RatingStationRun } from '../components/review/RatingStationTask'
import type { RatingCandidate, RatingRecording } from '../../main/ratingStation'

const colors: Record<string, string> = { Red: '#e45558', Blue: '#4c8ced', Purple: '#9e6cce', Black: '#4a5059', Orange: '#e49037', Green: '#46b66b' }
const validId = (id: string) => /^[A-Za-z0-9_-]{1,60}$/.test(id)
const message = (error: unknown) => error instanceof Error ? error.message : String(error)
const localDate = () => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}` }

export default function RatingStationPage() {
  const [native, setNative] = useState(false)
  const [root, setRoot] = useState('')
  const [files, setFiles] = useState<File[]>([])
  const picker = useRef<HTMLInputElement>(null)
  const [dyad, setDyad] = useState('')
  const [round, setRound] = useState(1)
  const [seat, setSeat] = useState<'P1' | 'P2'>('P1')
  const [manualParticipant, setManualParticipant] = useState('')
  const [manualPartner, setManualPartner] = useState('')
  const [selfColor, setSelfColor] = useState('')
  const [partnerColor, setPartnerColor] = useState('')
  const [group, setGroup] = useState<'A' | 'B' | 'C'>('A')
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
  const check = useRef<AbortController | null>(null)
  const normalizedDyad = normalizeDyad(dyad)
  const selected = candidates.find(c => c.id === selectedId)
  const otherSeat = seat === 'P1' ? 'P2' : 'P1'
  const participant = selected?.participantIds[seat] || manualParticipant.trim()
  const partner = selected?.participantIds[otherSeat] || manualPartner.trim()
  const idsValid = validId(participant) && validId(partner) && participant !== partner
  const detailsValid = Boolean(ra.trim() && initials.trim() && date && time)
  const canStart = completeRecording(selected) && idsValid && detailsValid && !searching
  const nextStep = !root ? 'Choose a recordings folder.' : !normalizedDyad ? 'Enter the dyad ID.' : searching ? 'Searching for this dyad...' : !selected ? 'Select a conversation recording.' : !completeRecording(selected) ? 'This recording is incomplete.' : !idsValid ? 'Check both participant IDs.' : !detailsValid ? 'Complete the session details.' : 'Ready to check video files and begin.'

  useEffect(() => {
    setNative(hasIpc())
    if (hasIpc()) void ipcInvoke<string>('rating:root').then(value => setRoot(value || '')).catch(e => setError(message(e)))
    return () => check.current?.abort()
  }, [])

  useEffect(() => {
    const ticket = ++request.current
    setCandidates([]); setSelectedId(''); setSearchError(''); setError(''); setSearched(false)
    const canSearch = Boolean(normalizedDyad && root && (native || files.length))
    setSearching(canSearch)
    if (!canSearch) return
    const timer = setTimeout(async () => {
      try {
        const results = native ? await ipcInvoke<RatingCandidate[]>('rating:lookup', normalizedDyad) : await browserRatingLookup(files, normalizedDyad)
        if (ticket !== request.current) return
        setCandidates(results || [])
        if (results?.length === 1) setSelectedId(results[0].id)
      } catch (e) { if (ticket === request.current) setSearchError(message(e)) }
      finally { if (ticket === request.current) { setSearching(false); setSearched(true) } }
    }, 350)
    return () => { clearTimeout(timer); ++request.current }
  }, [normalizedDyad, root, native, files, refresh])

  useEffect(() => {
    setManualParticipant(''); setManualPartner(''); setInitials(''); setSelfColor(''); setPartnerColor('')
  }, [normalizedDyad, root])

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
        const prepared = await ipcInvoke<{ recordings: Pick<RatingRecording, 'seat' | 'kind'>[]; urls: string[] }>('rating:prepare', normalizedDyad, selected.id, runId, seat)
        if (!prepared) throw new Error('Could not prepare the selected recording.')
        urls = prepared.urls; recordings = prepared.recordings
      } else {
        recordings = selected.recordings.filter(r => r.kind === (r.seat === seat ? 'clean' : 'altered'))
        for (const recording of recordings) {
          const file = selected.files?.[`${recording.seat}:${recording.kind}`]
          if (!file) throw new Error('A selected recording is missing. Choose the folder again.')
          urls.push(URL.createObjectURL(file))
        }
      }
      if (urls.length !== 2) throw new Error('Both participant videos are required.')
      await Promise.all(urls.map((url, i) => inspectRatingVideo(url, controller.signal).catch(e => { throw new Error(`${recordings[i].seat}: ${message(e)}`) })))
      if (controller.signal.aborted) throw new Error('Recording check cancelled.')
      setRun({ runId, dyad: normalizedDyad, candidateId: selected.id, participantId: participant, partnerId: partner, seat, round, group, selfColor, partnerColor, initials: initials.trim(), researcher: ra.trim(), date, time, native, recordings: recordings.map((r, i) => ({ ...r, url: urls[i] })) })
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

  return <main className="suite-content rating-setup">
    <PageHeading title="Set up this station" eyebrow="Rating Station" action={<span className="rating-mode-tag">Researcher setup</span>}>
      <p>Select the conversation and participant before handing over this computer.</p>
    </PageHeading>
    <input ref={picker} type="file" hidden multiple {...{ webkitdirectory: '' }} onChange={e => {
      const next = Array.from(e.target.files || [])
      if (next.length) { setFiles(next); setRoot(next[0].webkitRelativePath.split('/')[0]) }
      e.target.value = ''
    }} />
    <fieldset className="rating-setup-fields" disabled={preparing}>
      <section className="rating-drive" aria-label="Research Drive">
        <div className="rating-drive-label"><FolderOpen size={21} /><div><h2>Research Drive</h2><p>{root ? native ? 'Saved on this computer' : 'Folder selected for this visit' : 'Choose the folder containing recorded sessions'}</p></div></div>
        <div className="rating-folder-row"><span className="rating-folder-path" title={root}>{root || 'No folder selected'}</span><button type="button" className="suite-btn" onClick={() => void chooseRoot()}>{root ? 'Change folder' : 'Browse'}</button></div>
      </section>
      <div className="rating-workspace">
        <div className="rating-setup-main">
          <SetupSection number="01" title="Participant" detail="Enter a dyad ID, then choose the seat for this station.">
            <div className="rating-setup-grid">
              <Field label="Dyad ID" value={dyad} onChange={setDyad} placeholder="e.g. 014" />
              <div className="suite-field"><span>Seat in recording</span><Segment choices={['P1', 'P2'] as const} value={seat} label={v => v} onChange={setSeat} ariaLabel="Seat in recording" /></div>
              <Field label="Participant ID" value={participant} onChange={setManualParticipant} readOnly={Boolean(selected?.participantIds[seat])} />
              <Field label="Partner ID" value={partner} onChange={setManualPartner} readOnly={Boolean(selected?.participantIds[otherSeat])} />
            </div>
            {participant && partner && !idsValid && <p className="rating-warning">Use two different IDs containing letters, numbers, dashes, or underscores.</p>}
            <details className="rating-optional"><summary>Nametag colors <span>Optional</span></summary><div className="rating-setup-grid"><ColorField label="Participant" value={selfColor} onChange={setSelfColor} /><ColorField label="Partner" value={partnerColor} onChange={setPartnerColor} /></div></details>
          </SetupSection>
          <SetupSection number="02" title="Session details" detail="Saved with the participant's responses.">
            <div className="rating-setup-grid">
              <div className="suite-field"><span>Round</span><Segment choices={[1, 2, 3, 4, 5]} value={round} label={n => `R${n}`} onChange={setRound} ariaLabel="Round" /></div>
              <div className="suite-field"><span>Group</span><Segment choices={['A', 'B', 'C'] as const} value={group} label={v => v} onChange={setGroup} ariaLabel="Group" /></div>
              <Field label="Subject initials" value={initials} onChange={setInitials} placeholder="AB" />
              <Field label="RA name" value={ra} onChange={setRa} placeholder="Researcher name" />
              <label className="suite-field"><span>Session date</span><input className="suite-input" type="date" value={date} onChange={e => setDate(e.target.value)} /></label>
              <label className="suite-field"><span>Session time</span><input className="suite-input" type="time" value={time} onChange={e => setTime(e.target.value)} /></label>
            </div>
          </SetupSection>
        </div>
        <aside className="rating-recording-panel" aria-label="Conversation recording">
          <div className="rating-recording-heading"><h2>Conversation video</h2><button type="button" className="rating-icon-button" title="Search again" aria-label="Search again" disabled={!root || !normalizedDyad || searching} onClick={() => setRefresh(value => value + 1)}><RefreshCw size={16} /></button></div>
          <div aria-live="polite" aria-busy={searching}>
            {searchError ? <p className="rating-warning" role="alert">{searchError}</p> : searching ? <div className="rating-empty"><Loader2 className="rating-spin" size={23} /><strong>Searching dyad {normalizedDyad}</strong><p>Checking the selected folder.</p></div> : !candidates.length ? <div className="rating-empty"><Search size={23} /><strong>{!root ? 'Choose your Research Drive' : !normalizedDyad ? 'Find a conversation' : 'No recording found'}</strong><p>{!root ? 'Recordings will appear here.' : !normalizedDyad ? 'Enter the dyad ID to search.' : searched ? 'Check the dyad ID and folder, then search again after the recording finishes copying.' : 'Waiting for the selected folder.'}</p></div> : <div className="rating-candidates">{candidates.map(candidate => <button type="button" key={candidate.id} className={selectedId === candidate.id ? 'selected' : ''} aria-pressed={selectedId === candidate.id} onClick={() => { setSelectedId(candidate.id); setError('') }}><Video size={18} /><span><strong>{candidate.label}</strong><small>{new Date(candidate.modifiedAt).toLocaleString()}</small><small className={completeRecording(candidate) ? 'rating-ready-text' : ''}>{completeRecording(candidate) ? 'All 4 tracks found' : candidate.source === 'suite' ? 'Single-video recording' : 'Missing or duplicate tracks'}</small></span>{selectedId === candidate.id && <Check size={17} />}</button>)}</div>}
          </div>
          {selected && !completeRecording(selected) && <p className="rating-warning">This task needs one clean and one altered video per participant. Select a complete Session View recording.</p>}
          <div className="rating-handoff-summary">
            <h3>Before handoff</h3>
            <Checklist done={completeRecording(selected)} label="Conversation selected" />
            <Checklist done={idsValid && Boolean(selected)} label={idsValid && selected ? `${participant} reviewing ${partner}` : 'Participant and partner confirmed'} />
            <Checklist done={detailsValid} label="Session details complete" />
            <div className="rating-session-facts"><span>Round {round}</span><span>Group {group}</span><span>4 parts · 2:30 each</span></div>
            {!native && <p className="rating-hint">Browser session: download responses when the task is finished.</p>}
            {error && <p className="rating-warning" role="alert">{error}</p>}
            <p className="rating-next-step" role="status">{preparing ? 'Checking that both videos can play...' : nextStep}</p>
            <button type="button" className="suite-btn primary rating-start" disabled={!canStart || preparing} onClick={() => void start()}>{preparing ? <><Loader2 size={17} className="rating-spin" /> Checking recordings...</> : <>Start participant task <ArrowRight size={17} /></>}</button>
          </div>
        </aside>
      </div>
    </fieldset>
    {preparing && <button className="suite-btn rating-cancel-check" onClick={() => check.current?.abort()}>Cancel video check</button>}
  </main>
}

function SetupSection({ number, title, detail, children }: { number: string; title: string; detail: string; children: React.ReactNode }) {
  return <section className="rating-setup-section"><div className="rating-section-heading"><span className="rating-step">{number}</span><div><h2>{title}</h2><p>{detail}</p></div></div>{children}</section>
}
function Field({ label, value, onChange, placeholder, readOnly }: { label: string; value: string; onChange: (value: string) => void; placeholder?: string; readOnly?: boolean }) {
  return <label className="suite-field"><span>{label}{readOnly && <small>From recording</small>}</span><input className="suite-input" aria-label={label} value={value} readOnly={readOnly} placeholder={placeholder} onChange={e => onChange(e.target.value)} autoComplete="off" /></label>
}
function Segment<T extends string | number>({ choices, value, label, onChange, ariaLabel }: { choices: readonly T[]; value: T; label: (v: T) => string; onChange: (v: T) => void; ariaLabel: string }) {
  return <div className="rating-setup-segments" role="group" aria-label={ariaLabel}>{choices.map(choice => <button type="button" key={choice} className={value === choice ? 'selected' : ''} aria-pressed={value === choice} onClick={() => onChange(choice)}>{label(choice)}</button>)}</div>
}
function ColorField({ label, value, onChange }: { label: string; value: string; onChange: (v: string) => void }) {
  return <div className="suite-field"><span>{label}</span><div className="rating-color-options" role="group" aria-label={`${label} nametag`}>{Object.entries(colors).map(([name, hex]) => <button type="button" key={name} title={name} aria-label={name} className={value === name ? 'selected' : ''} aria-pressed={value === name} onClick={() => onChange(value === name ? '' : name)}><i style={{ background: hex }}>{value === name && <Check size={13} />}</i></button>)}</div></div>
}
function Checklist({ done, label }: { done: boolean; label: string }) {
  return <div className={`rating-checklist-item ${done ? 'complete' : ''}`}>{done ? <Check size={16} /> : <Circle size={15} />}<span>{label}</span></div>
}
