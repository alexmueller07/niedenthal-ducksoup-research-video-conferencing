// Sign-in. One screen for everyone:
//   - RA types the participant's info on each participant laptop → Join →
//     locked participant view.
//   - RA types the access code "Admin" on the researcher machine → researcher
//     dashboard (their "name" becomes the RA name on the session log).
//
// The session address (the researcher machine) is remembered per machine, so
// after first setup the RA only fills names/IDs.

import { useEffect, useState } from 'react'
import { useRouter } from 'next/router'
import { DEFAULT_PORT } from '../lib/protocol'
import { hasIpc, ipcInvoke } from '../lib/ipcUtil'

export default function SignInPage() {
  const router = useRouter()
  const [name, setName] = useState('')
  const [participantId, setParticipantId] = useState('')
  const [dyadId, setDyadId] = useState('')
  const [studyId, setStudyId] = useState('')
  const [accessCode, setAccessCode] = useState('')
  const [serverAddr, setServerAddr] = useState('')
  const [showAdvanced, setShowAdvanced] = useState(false)
  const [initialized, setInitialized] = useState(false)
  const [joinError, setJoinError] = useState('')
  const [joinShake, setJoinShake] = useState(0)
  const [captureLoginOpen, setCaptureLoginOpen] = useState(false)
  const [captureUser, setCaptureUser] = useState('')
  const [capturePass, setCapturePass] = useState('')
  const [captureError, setCaptureError] = useState('')
  const [captureShake, setCaptureShake] = useState(0)
  const [joining, setJoining] = useState(false)

  useEffect(() => {
    void (async () => {
      if (!hasIpc()) return
      const saved = await ipcInvoke<string | null>('prefs:get', 'serverAddr')
      if (saved) setServerAddr(saved)
      const savedStudy = await ipcInvoke<string | null>('prefs:get', 'studyId')
      if (savedStudy) setStudyId(savedStudy)
    })()
  }, [])

  const isAdmin = accessCode.trim().toLowerCase() === 'admin'
  // Access code "test" joins as a participant running on bundled example
  // faces instead of the camera, with a switcher panel (single-laptop testing).
  const isTest = accessCode.trim().toLowerCase() === 'test'

  async function join() {
    if (joining) return
    const role = isAdmin ? 'admin' : 'participant'
    if (role === 'participant' && (!name.trim() || !participantId.trim() || !dyadId.trim())) {
      setJoinError('Enter full name, participant ID, and dyad ID before joining.')
      setJoinShake((shake) => shake + 1)
      return
    }
    setJoinError('')
    setJoining(true)
    // Admin hosts the server on its own machine; participants need the address.
    const addr = role === 'admin' ? 'localhost' : serverAddr.trim() || 'localhost'
    if (hasIpc()) {
      await ipcInvoke('prefs:set', 'serverAddr', serverAddr.trim())
      await ipcInvoke('prefs:set', 'studyId', studyId.trim())
    }
    sessionStorage.setItem(
      'labcall',
      JSON.stringify({
        role,
        testMode: isTest,
        serverAddr: addr,
        identity: {
          name: name.trim(),
          participantId: participantId.trim(),
          dyadId: dyadId.trim(),
          studyId: studyId.trim(),
        },
      }),
    )
    void router.push(role === 'admin' ? '/admin' : '/session')
  }

  function openCaptureLogin() {
    setCaptureUser('')
    setCapturePass('')
    setCaptureError('')
    setCaptureLoginOpen(true)
  }

  function closeCaptureLogin() {
    setCaptureLoginOpen(false)
    setCaptureUser('')
    setCapturePass('')
    setCaptureError('')
  }

  function confirmCaptureLogin() {
    if (captureUser !== 'admin' || capturePass !== 'admin') {
      setCaptureError('Invalid experimenter login.')
      setCaptureShake((shake) => shake + 1)
      return
    }
    void router.push('/dashboard')
  }

  const input =
    'w-full rounded-lg border border-slate-700/80 bg-slate-950/45 px-3 py-2.5 text-sm text-white ' +
    'placeholder-slate-500 outline-none transition focus:border-cyan-400 focus:ring-2 focus:ring-cyan-400/25'
  const inputClass = (missing: boolean) =>
    `${input} ${missing ? 'border-red-400/70 bg-red-950/20 focus:border-red-300 focus:ring-red-400/25' : ''}`
  const label = 'mb-1.5 block text-xs font-medium uppercase tracking-wider text-gray-400'
  const missingName = !!joinError && !name.trim()
  const missingParticipantId = !!joinError && !participantId.trim()
  const missingDyadId = !!joinError && !dyadId.trim()

  return (
    <div
      className="intersync-shell relative flex min-h-screen items-center justify-center overflow-hidden bg-[#05080d] p-6 text-white"
      onMouseMove={(e) => {
        const rect = e.currentTarget.getBoundingClientRect()
        e.currentTarget.style.setProperty('--mx', `${e.clientX - rect.left}px`)
        e.currentTarget.style.setProperty('--my', `${e.clientY - rect.top}px`)
      }}
    >
      <div className="pointer-events-none absolute inset-0 bg-[radial-gradient(circle_at_var(--mx,50%)_var(--my,50%),rgba(86,166,255,.18),transparent_260px)]" />
      <div className="pointer-events-none absolute inset-0 opacity-70 [background-image:radial-gradient(circle,rgba(87,166,255,.32)_1.25px,transparent_1.35px)] [background-size:32px_32px]" />
      <div className="pointer-events-none absolute inset-0 intersync-dots opacity-60" />
      <div className="pointer-events-none absolute left-[8%] top-[32%] h-[430px] w-[430px] rounded-full bg-cyan-500/10 blur-3xl" />
      <div className="pointer-events-none absolute right-[12%] top-[12%] h-[520px] w-[520px] rounded-full bg-indigo-500/10 blur-3xl" />

      <main className="relative z-10 w-full max-w-[860px]">
        <div className="relative min-h-[680px] overflow-hidden rounded-[28px] border border-slate-600/60 bg-[linear-gradient(135deg,rgba(20,32,49,.92),rgba(5,8,13,.96)_48%,rgba(9,10,14,.98))] shadow-[0_32px_120px_rgba(0,0,0,.65)] ring-1 ring-white/10">
          <div className="pointer-events-none absolute inset-0 bg-[radial-gradient(circle_at_44%_44%,rgba(96,165,250,.16),transparent_190px),radial-gradient(circle_at_18%_58%,rgba(34,211,238,.11),transparent_250px)]" />
          <div className="pointer-events-none absolute -left-24 top-36 h-[420px] w-[420px] rounded-full border border-cyan-300/10" />
          <div className="pointer-events-none absolute inset-y-0 left-0 w-1/3 bg-[radial-gradient(circle,rgba(96,165,250,.42)_2px,transparent_2.8px)] [background-size:20px_20px] opacity-35 [mask-image:radial-gradient(circle_at_22%_50%,black,transparent_62%)]" />

          <div className={`relative flex min-h-[680px] flex-col items-center justify-center px-6 py-12 transition-all duration-500 ${initialized ? 'pb-8 pt-10' : ''}`}>
            <div className={`text-center transition-all duration-500 ${initialized ? 'mb-7 scale-90' : ''}`}>
              <h1 className="select-none text-[76px] font-black leading-[0.88] tracking-normal text-white drop-shadow-[0_12px_34px_rgba(125,211,252,.28)] sm:text-[112px]">
                Inter
                <span className="block pr-2 text-[0.78em] font-black italic text-slate-100">
                  Sync
                </span>
              </h1>
            </div>

            {!initialized ? (
              <button
                type="button"
                onClick={() => setInitialized(true)}
                className="group mt-16 flex min-h-[64px] items-center gap-4 rounded-full bg-white px-9 text-sm font-black uppercase tracking-[0.18em] text-slate-950 shadow-[0_0_45px_rgba(96,165,250,.16)] transition hover:-translate-y-0.5 hover:bg-cyan-50 hover:shadow-[0_0_70px_rgba(96,165,250,.28)]"
              >
                Initialize session
                <span className="text-2xl leading-none transition group-hover:translate-x-1">›</span>
              </button>
            ) : (
              <div
                key={joinShake}
                className={`w-full max-w-md rounded-2xl border border-slate-700/80 bg-slate-950/55 p-6 shadow-2xl backdrop-blur-xl ${
                  joinError ? 'animate-[joinShake_.28s_ease-in-out]' : ''
                }`}
              >
                <div className="space-y-4">
                  <div>
                    <label className={label}>Full name</label>
                    <input
                      className={inputClass(missingName)}
                      value={name}
                      onChange={(e) => {
                        setName(e.target.value)
                        setJoinError('')
                      }}
                      placeholder="First and last name"
                      autoFocus
                      aria-invalid={missingName}
                    />
                  </div>
                  <div className="grid grid-cols-2 gap-3">
                    <div>
                      <label className={label}>Participant ID</label>
                      <input
                        className={inputClass(missingParticipantId)}
                        value={participantId}
                        onChange={(e) => {
                          setParticipantId(e.target.value)
                          setJoinError('')
                        }}
                        placeholder="e.g. 1043"
                        aria-invalid={missingParticipantId}
                      />
                    </div>
                    <div>
                      <label className={label}>Dyad ID</label>
                      <input
                        className={inputClass(missingDyadId)}
                        value={dyadId}
                        onChange={(e) => {
                          setDyadId(e.target.value)
                          setJoinError('')
                        }}
                        placeholder="e.g. D22"
                        aria-invalid={missingDyadId}
                      />
                    </div>
                  </div>
                  <div>
                    <label className={label}>
                      Access code <span className="normal-case text-gray-600">(optional)</span>
                    </label>
                    <input
                      className={input}
                      type="password"
                      value={accessCode}
                      onChange={(e) => {
                        setAccessCode(e.target.value)
                        setJoinError('')
                      }}
                      placeholder="Leave blank to join as participant"
                    />
                  </div>
                  {joinError && (
                    <p className="rounded-lg border border-red-500/30 bg-red-500/10 px-3 py-2 text-xs font-medium text-red-200">
                      {joinError}
                    </p>
                  )}

                  <button
                    type="button"
                    onClick={() => setShowAdvanced((s) => !s)}
                    className="text-xs text-slate-500 transition hover:text-slate-300"
                  >
                    {showAdvanced ? '▾' : '▸'} Setup options
                  </button>
                  {showAdvanced && (
                    <div className="space-y-4 rounded-xl border border-slate-800 bg-black/25 p-4">
                      <div>
                        <label className={label}>Study ID</label>
                        <input
                          className={input}
                          value={studyId}
                          onChange={(e) => setStudyId(e.target.value)}
                          placeholder="e.g. PPS-2"
                        />
                      </div>
                      <div>
                        <label className={label}>Session address</label>
                        <input
                          className={input}
                          value={serverAddr}
                          onChange={(e) => setServerAddr(e.target.value)}
                          placeholder={`researcher machine, e.g. 10.140.2.15:${DEFAULT_PORT}`}
                          disabled={isAdmin}
                        />
                        <p className="mt-1.5 text-[11px] leading-snug text-slate-500">
                          {isAdmin
                            ? 'The researcher machine hosts the session itself; no address needed.'
                            : 'Shown on the researcher dashboard. Remembered on this machine after the first session.'}
                        </p>
                      </div>
                    </div>
                  )}

                  <button
                    type="button"
                    onClick={() => void join()}
                    disabled={joining}
                    className={
                      'mt-2 w-full rounded-xl px-4 py-3 text-sm font-semibold transition ' +
                      (isAdmin
                        ? 'bg-violet-600 text-white hover:bg-violet-500'
                        : 'bg-cyan-500 text-slate-950 hover:bg-cyan-300') +
                      (joining ? ' cursor-wait opacity-60' : '')
                    }
                  >
                    {joining
                      ? 'Joining...'
                      : isAdmin
                        ? 'Open researcher dashboard'
                        : isTest
                          ? 'Join as test participant'
                          : 'Join session'}
                  </button>
                </div>
              </div>
            )}

            <p className="mt-7 text-center text-[11px] text-slate-600">
              IRB 2020-1657 · For lab use only
            </p>
            <button
              type="button"
              onClick={openCaptureLogin}
              className="mt-3 text-center text-xs font-bold uppercase tracking-[0.18em] text-slate-500 underline-offset-4 transition hover:text-cyan-200 hover:underline"
            >
              Capture station
            </button>
          </div>
        </div>
      </main>

      {captureLoginOpen && (
        <div className="absolute inset-0 z-50 flex items-center justify-center bg-black/70 p-6 backdrop-blur-sm">
          <div
            key={captureShake}
            className={`w-full max-w-[430px] rounded-2xl border border-slate-700 bg-slate-950 p-6 shadow-2xl ring-1 ring-white/5 ${
              captureError ? 'animate-[captureShake_.28s_ease-in-out]' : ''
            }`}
          >
            <div className="mb-4 flex h-11 w-11 items-center justify-center rounded-xl bg-cyan-500/15 ring-1 ring-cyan-400/30">
              <svg viewBox="0 0 24 24" className="h-5 w-5 text-cyan-200" fill="none" stroke="currentColor" strokeWidth="2">
                <path strokeLinecap="round" strokeLinejoin="round" d="M12 15v2m-6 4h12a2 2 0 0 0 2-2v-6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v6a2 2 0 0 0 2 2Zm10-10V7a4 4 0 0 0-8 0v4" />
              </svg>
            </div>
            <h2 className="text-base font-semibold text-white">Experimenter login required</h2>
            <p className="mt-2 text-sm leading-relaxed text-slate-400">
              Access to the capture station is restricted to authorized experimenters.
            </p>
            <div className="mt-5 space-y-3">
              <label className="block">
                <span className="mb-1.5 block text-[11px] font-semibold uppercase tracking-wider text-slate-500">
                  Username
                </span>
                <input
                  value={captureUser}
                  onChange={(e) => {
                    setCaptureUser(e.target.value)
                    setCaptureError('')
                  }}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') confirmCaptureLogin()
                    if (e.key === 'Escape') closeCaptureLogin()
                  }}
                  className={input}
                  autoCapitalize="none"
                  autoCorrect="off"
                  autoFocus
                  placeholder="Enter username"
                />
              </label>
              <label className="block">
                <span className="mb-1.5 block text-[11px] font-semibold uppercase tracking-wider text-slate-500">
                  Password
                </span>
                <input
                  value={capturePass}
                  onChange={(e) => {
                    setCapturePass(e.target.value)
                    setCaptureError('')
                  }}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') confirmCaptureLogin()
                    if (e.key === 'Escape') closeCaptureLogin()
                  }}
                  className={input}
                  type="password"
                  placeholder="Enter password"
                />
              </label>
              {captureError && (
                <p className="rounded-lg border border-red-500/30 bg-red-500/10 px-3 py-2 text-xs font-medium text-red-200">
                  {captureError}
                </p>
              )}
            </div>
            <div className="mt-4 flex justify-end gap-2">
              <button
                type="button"
                onClick={closeCaptureLogin}
                className="rounded-lg px-4 py-2 text-sm font-medium text-slate-300 transition hover:bg-slate-900"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={confirmCaptureLogin}
                disabled={!captureUser || !capturePass}
                className="rounded-lg bg-cyan-500 px-4 py-2 text-sm font-semibold text-slate-950 transition enabled:hover:bg-cyan-300 disabled:opacity-40"
              >
                Continue
              </button>
            </div>
          </div>
        </div>
      )}

      <style jsx global>{`
        .intersync-shell {
          --mx: 50%;
          --my: 50%;
        }
        .intersync-dots {
          background-image: radial-gradient(circle, rgba(125, 211, 252, 0.52) 2px, transparent 2.8px);
          background-size: 24px 24px;
          animation: intersyncDrift 9s ease-in-out infinite alternate;
          mask-image: radial-gradient(circle at var(--mx) var(--my), black 0, black 170px, transparent 330px);
        }
        @keyframes intersyncDrift {
          from {
            transform: translate3d(-10px, 8px, 0);
          }
          to {
            transform: translate3d(18px, -14px, 0);
          }
        }
        @keyframes joinShake {
          0%,
          100% {
            transform: translateX(0);
          }
          20%,
          60% {
            transform: translateX(-8px);
          }
          40%,
          80% {
            transform: translateX(8px);
          }
        }
        @keyframes captureShake {
          0%,
          100% {
            transform: translateX(0);
          }
          20%,
          60% {
            transform: translateX(-8px);
          }
          40%,
          80% {
            transform: translateX(8px);
          }
        }
      `}</style>
    </div>
  )
}
