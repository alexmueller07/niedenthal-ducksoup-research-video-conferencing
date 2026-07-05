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
    setJoining(true)
    const role = isAdmin ? 'admin' : 'participant'
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

  const input =
    'w-full rounded-lg border border-gray-700 bg-gray-800/80 px-3 py-2.5 text-sm text-white ' +
    'placeholder-gray-500 outline-none transition focus:border-sky-500 focus:ring-2 focus:ring-sky-500/30'
  const label = 'mb-1.5 block text-xs font-medium uppercase tracking-wider text-gray-400'

  return (
    <div className="flex min-h-screen items-center justify-center bg-gradient-to-b from-gray-950 via-gray-900 to-gray-950 p-6">
      <div className="w-full max-w-md">
        <div className="mb-8 text-center">
          <div className="mx-auto mb-4 flex h-14 w-14 items-center justify-center rounded-2xl bg-sky-600/20 ring-1 ring-sky-500/40">
            <svg viewBox="0 0 24 24" className="h-7 w-7 text-sky-400" fill="currentColor">
              <path d="M17 10.5V7a1 1 0 0 0-1-1H4a1 1 0 0 0-1 1v10a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1v-3.5l4 4v-11l-4 4z" />
            </svg>
          </div>
          <h1 className="text-2xl font-semibold tracking-tight text-white">Video Call</h1>
          <p className="mt-1 text-sm text-gray-400">Niedenthal Emotions Lab · UW–Madison</p>
        </div>

        <div className="rounded-2xl border border-gray-800 bg-gray-900/70 p-6 shadow-2xl backdrop-blur">
          <div className="space-y-4">
            <div>
              <label className={label}>Full name</label>
              <input
                className={input}
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="First and last name"
                autoFocus
              />
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className={label}>Participant ID</label>
                <input
                  className={input}
                  value={participantId}
                  onChange={(e) => setParticipantId(e.target.value)}
                  placeholder="e.g. 1043"
                />
              </div>
              <div>
                <label className={label}>Dyad ID</label>
                <input
                  className={input}
                  value={dyadId}
                  onChange={(e) => setDyadId(e.target.value)}
                  placeholder="e.g. D22"
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
                onChange={(e) => setAccessCode(e.target.value)}
                placeholder="Leave blank to join as participant"
              />
            </div>

            <button
              type="button"
              onClick={() => setShowAdvanced((s) => !s)}
              className="text-xs text-gray-500 transition hover:text-gray-300"
            >
              {showAdvanced ? '▾' : '▸'} Setup options
            </button>
            {showAdvanced && (
              <div className="space-y-4 rounded-xl border border-gray-800 bg-gray-950/50 p-4">
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
                  <p className="mt-1.5 text-[11px] leading-snug text-gray-500">
                    {isAdmin
                      ? 'The researcher machine hosts the session itself — no address needed.'
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
                  : 'bg-sky-600 text-white hover:bg-sky-500') +
                (joining ? ' cursor-wait opacity-60' : '')
              }
            >
              {joining
                ? 'Joining…'
                : isAdmin
                  ? 'Open researcher dashboard'
                  : isTest
                    ? 'Join as test participant (example faces)'
                    : 'Join the call'}
            </button>
          </div>
        </div>

        <p className="mt-6 text-center text-[11px] text-gray-600">
          IRB 2020-1657 · For lab use only ·{' '}
          <a href="/dashboard" className="underline-offset-2 hover:text-gray-400 hover:underline">
            capture station
          </a>
        </p>
      </div>
    </div>
  )
}
