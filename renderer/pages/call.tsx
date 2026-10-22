import { useEffect, useState } from 'react'
import { useRouter } from 'next/router'
import { ArrowRight, Video, ShieldCheck, CopyPlus } from 'lucide-react'
import { PageHeading } from '../components/SuiteShell'
import { DEFAULT_PORT } from '../lib/protocol'
import { hasIpc, ipcInvoke } from '../lib/ipcUtil'
import { readStudy } from '../lib/suitePreferences'

export default function CallSetupPage() {
  const router = useRouter()
  const [name, setName] = useState('')
  const [participantId, setParticipantId] = useState('')
  const [dyadId, setDyadId] = useState('')
  const [accessCode, setAccessCode] = useState('')
  const [serverAddr, setServerAddr] = useState('')
  const [joinError, setJoinError] = useState('')
  const [joining, setJoining] = useState(false)
  const [native, setNative] = useState(false)
  const [opening, setOpening] = useState(false)
  const isAdmin = accessCode.trim().toLowerCase() === 'admin'
  const isTest = accessCode.trim().toLowerCase() === 'test'

  useEffect(() => {
    setNative(hasIpc())
    if (hasIpc())
      void ipcInvoke<string>('prefs:get', 'serverAddr')
        .then((saved) => {
          if (saved) setServerAddr(saved)
        })
        .catch((e) => setJoinError(String(e)))
    else {
      try {
        setServerAddr(localStorage.getItem('session-view:serverAddr') || '')
      } catch {
        /* Optional remembered address. */
      }
    }
  }, [])

  async function join() {
    if (joining) return
    if (!name.trim() && isAdmin) {
      setJoinError('Enter the researcher name before opening the dashboard.')
      return
    }
    if (
      !name.trim() ||
      (!isAdmin && (!participantId.trim() || !dyadId.trim()))
    ) {
      setJoinError(
        'Enter full name, participant ID, and dyad ID before joining.',
      )
      return
    }
    setJoinError('')
    setJoining(true)
    try {
      if (hasIpc())
        await ipcInvoke('prefs:set', 'serverAddr', serverAddr.trim())
      else localStorage.setItem('session-view:serverAddr', serverAddr.trim())
      sessionStorage.setItem(
        'labcall',
        JSON.stringify({
          role: isAdmin ? 'admin' : 'participant',
          testMode: isTest,
          serverAddr: isAdmin ? 'localhost' : serverAddr.trim() || 'localhost',
          identity: {
            name: name.trim(),
            participantId: isAdmin ? '' : participantId.trim(),
            dyadId: isAdmin ? '' : dyadId.trim(),
            studyId: readStudy().studyId.trim(),
          },
        }),
      )
      await router.push(isAdmin ? '/admin' : '/session')
    } catch (e) {
      setJoinError(String(e))
      setJoining(false)
    }
  }

  return (
    <main className="suite-content">
      <PageHeading
        title="Video Calling"
        eyebrow="Session setup"
        action={
          native && (
            <button
              className="suite-btn"
              disabled={opening}
              onClick={() => {
                setOpening(true)
                void ipcInvoke('app:new-instance')
                  .catch((e) => setJoinError(String(e)))
                  .finally(() => setOpening(false))
              }}
            >
              <CopyPlus size={16} />
              {opening ? 'Opening...' : 'Open another instance'}
            </button>
          )
        }
      >
        <p>Join a participant station or open the researcher dashboard.</p>
      </PageHeading>
      <div className="suite-tabs" aria-label="Station role">
        <button
          aria-pressed={!isAdmin}
          onClick={() => {
            setAccessCode('')
            setJoinError('')
          }}
        >
          <Video size={15} className="inline mr-2" />
          Participant
        </button>
        <button
          aria-pressed={isAdmin}
          onClick={() => {
            setAccessCode('Admin')
            setJoinError('')
          }}
        >
          <ShieldCheck size={15} className="inline mr-2" />
          Researcher
        </button>
      </div>
      <form
        onSubmit={(e) => {
          e.preventDefault()
          void join()
        }}
        style={{ maxWidth: 700 }}
      >
        <section className="suite-section">
          <h2>{isAdmin ? 'Researcher details' : 'Participant details'}</h2>
          <div className="suite-form-grid">
            <label className="suite-field" style={{ gridColumn: '1 / -1' }}>
              <span>Full name</span>
              <input
                className="suite-input"
                autoComplete="name"
                value={name}
                onChange={(e) => setName(e.target.value)}
                aria-invalid={!!joinError && !name.trim()}
              />
            </label>
            {!isAdmin && (
              <>
                <label className="suite-field">
                  <span>Participant ID</span>
                  <input
                    className="suite-input"
                    value={participantId}
                    onChange={(e) => setParticipantId(e.target.value)}
                    aria-invalid={!!joinError && !participantId.trim()}
                  />
                </label>
                <label className="suite-field">
                  <span>Dyad ID</span>
                  <input
                    className="suite-input"
                    value={dyadId}
                    onChange={(e) => setDyadId(e.target.value)}
                    aria-invalid={!!joinError && !dyadId.trim()}
                  />
                </label>
                <label className="suite-field" style={{ gridColumn: '1 / -1' }}>
                  <span>Session address</span>
                  <input
                    className="suite-input"
                    value={serverAddr}
                    onChange={(e) => setServerAddr(e.target.value)}
                    placeholder={`localhost:${DEFAULT_PORT}`}
                    spellCheck={false}
                  />
                  <small className="suite-muted">
                    Use the session address shown on the researcher dashboard.
                  </small>
                </label>
              </>
            )}
          </div>
        </section>
        <section className="suite-section">
          <label className="suite-field" style={{ maxWidth: 340 }}>
            <span>Access code {isAdmin ? '' : '(optional)'}</span>
            <input
              className="suite-input"
              type="password"
              autoComplete="off"
              value={accessCode}
              onChange={(e) => setAccessCode(e.target.value)}
            />
          </label>
          {isTest && (
            <p className="suite-notice" style={{ marginTop: 15 }}>
              Sample-face participant mode selected.
            </p>
          )}
        </section>
        {joinError && (
          <p className="suite-notice suite-error" role="alert">
            {joinError}
          </p>
        )}
        <button type="submit" className="suite-btn primary" disabled={joining}>
          {joining
            ? 'Opening...'
            : isAdmin
              ? 'Open researcher dashboard'
              : 'Join the call'}
          <ArrowRight size={16} />
        </button>
      </form>
    </main>
  )
}
