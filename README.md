# Lab Video Call — DuckSoup Research Video Conferencing (v3)

A three-seat desktop video call for the Niedenthal Emotions Lab's emotion-modification
paradigm: **two participants** have what looks like a normal video conversation, while an
**invisible researcher** watches both, manipulates each participant's facial expression
and voice in real time, and gets every action and every applied state written to CSV.

The key deception mechanic, enforced by the architecture itself: each participant's
modification runs **on their own machine, on the outgoing stream**. The partner sees the
altered face/voice; the participant's self-view PiP is wired to the raw camera and can
never show the modification.

```
Participant A ── altered A/V ──────────────► Participant B   (and vice versa)
     │  └ altered + clean A/V ──► Researcher ◄── altered + clean A/V ┘
     │                              │   ▲
     └◄── mic audio (muted until    │   └ WebSocket session server (roster,
          deliberately unmuted) ────┘     signaling, effect commands, CSV log)
```

Media is peer-to-peer WebRTC over the lab LAN. Only control, signaling, and telemetry
pass through the session server, which runs inside the researcher's app — there is no
separate server to install or start.

---

## Running a session in the lab

One installer on all three machines (they must all be the same OS):

- **Windows:** `dist/Lab-Video-Call-Setup-3.0.0.exe` (build it with `npm run build:win`)
- **macOS:** `Lab-Video-Call-3.0.0-universal.dmg` — built automatically in the cloud on
  every push to `main`. To download and install it, see [**Testing on macOS**](#testing-on-macos) below.

1. **Researcher machine** — open the app, type the RA's name, enter `Admin` in the
   Access code field, click *Open researcher dashboard*. The session server starts
   automatically and the header shows the address participants connect to
   (e.g. `10.140.2.15:8771`).
2. **Each participant laptop** — open the app, the RA enters the participant's name and
   IDs (or leaves them blank and fills them in later from the dashboard), sets the
   session address under *Setup options* (remembered after the first time), and clicks
   *Join the call*. The machine goes into a locked fullscreen kiosk showing
   **"Please wait for the researcher to start."** The camera, the face-morph model, and
   the voice pipeline all warm up during this screen, so the first modification later is
   instant.
3. **Dashboard** — both seats fill in, live previews appear, and the readiness dots turn
   green. Click **▶ Start conversation**. Participants see each other; the timer starts;
   all recordings start.
4. During the conversation the researcher can, per participant: drag the **Smile** and
   **Voice pitch** sliders, apply named presets (*Smile + (subtle)*, *Warmer voice*, …),
   toggle the monitor between **Altered (what the partner sees)** and **Clean**, and
   watch live telemetry (face tracked, fps, applied ✓). Global tools: timed **banners**
   on both participant screens, **mic unmute / hold-to-talk** (participants hear a voice
   but never see a third caller), and the live **event log**.
5. **■ End session** — participants see a calm "conversation has ended" screen,
   recordings finalize, `session.json` is written. *📂 Data folder* opens the output.

### What participants can and cannot do

Nothing is clickable. No mute, no camera toggle, no chat, no window controls; reload,
devtools, zoom, and close keys are swallowed; the display is kept awake. The single
escape hatch — for the RA, on any machine — is **Ctrl+Shift+Q**, which opens a dialog
that only closes the station after typing `Confirm`. Escape attempts, confirmations,
and even window focus/blur on participant machines are all logged.

---

## Testing on macOS

The lab's Mac machines need their own build (a Windows `.exe` cannot run on a Mac). That
build is produced **automatically by GitHub Actions** — there is no Mac required to make
it and nothing to compile by hand. This section is the full walkthrough for whoever is
installing and testing it on a lab Mac.

> **Why the extra steps below?** The app is not yet code-signed with a paid Apple
> Developer certificate, so macOS treats it as "from an unidentified developer" and blocks
> the first launch. The right-click / "Open Anyway" steps are the standard way to approve
> an internal app. It is safe — it is our own build.

### Step 1 — Get the installer (`.dmg`)

**If someone already sent you `Lab-Video-Call-3.0.0-universal.dmg`** (Slack, email, or the
Research Drive), save it to the Mac and skip to Step 2.

**Otherwise, download it from GitHub** (you need access to this repository):

1. Open the repo's **Actions** tab:
   https://github.com/alexmueller07/niedenthal-ducksoup-research-video-conferencing/actions
2. In the left sidebar click the **"Build macOS app"** workflow.
3. Click the most recent run that has a **green ✓** (a yellow ● dot means it is still
   building — wait for it to finish, ~5–10 minutes).
4. Scroll to the bottom of that run's page to the **Artifacts** box and click
   **`lab-video-call-macos`**. It downloads as a `.zip`.
5. Double-click the downloaded `.zip` to unzip it. Inside is
   **`Lab-Video-Call-3.0.0-universal.dmg`** — that is the installer. (The `.zip` also
   contains a `.zip` copy of the app; you only need the `.dmg`.)

The build is **universal**, so the same file runs on both Intel and Apple Silicon Macs —
you do not need to know which chip the lab Macs have.

### Step 2 — Install it

1. Double-click `Lab-Video-Call-3.0.0-universal.dmg`. A window opens showing the **Lab
   Video Call** icon next to an **Applications** folder shortcut.
2. Drag the **Lab Video Call** icon onto the **Applications** folder.
3. Close the window, then eject the installer (in Finder's sidebar, click the ⏏ next to
   "Lab Video Call", or drag its desktop icon to the Trash).

### Step 3 — Open it the first time (get past Gatekeeper)

Do **not** just double-click it the first time — macOS will refuse. Instead:

1. Open **Finder → Applications**.
2. **Right-click** (or hold **Control** and click) **Lab Video Call**, then choose
   **Open** from the menu.
3. A dialog warns it is from an unidentified developer — click **Open** again.
4. The app launches and macOS remembers the choice; from now on a normal double-click works.

**If there is no "Open" option, or you get blocked anyway** (newer macOS versions):

- Try to open the app once (it gets blocked), then go to  **System Settings → Privacy &
  Security**, scroll down to the message *"Lab Video Call was blocked…"*, and click
  **Open Anyway**. Confirm with the Mac's password/Touch ID, then open the app again.

**If you instead see "Lab Video Call is damaged and can't be opened":** that is the
quarantine flag, not real damage. Open **Terminal** (press ⌘+Space, type `Terminal`,
Enter) and paste this, then press Enter:

```bash
xattr -dr com.apple.quarantine "/Applications/Lab Video Call.app"
```

Then open the app normally.

### Step 4 — Allow the camera and microphone

This is a video-call app, so the first time it uses them macOS will pop up
**"Lab Video Call would like to access the Camera"** and the same for the Microphone —
click **Allow / OK** on both. If you clicked *Don't Allow* by accident, fix it in **System
Settings → Privacy & Security → Camera** (and **Microphone**): turn the **Lab Video Call**
switch **on**, then quit and reopen the app.

### Step 5 — Quick check that it works

You need three machines for a real session (see *Running a session in the lab* above — it
behaves identically on macOS), but you can confirm the Mac build itself is healthy on one
machine:

1. The app opens to the **sign-in** screen.
2. Type a name, enter **`Admin`** as the access code, click *Open researcher dashboard* —
   the dashboard appears and the header shows a session address. ✅ server works.
3. (Optional) On another machine/window, sign in with any **non-Admin** code → the
   participant kiosk shows *"Please wait for the researcher to start"* and the Mac's
   green camera light turns on as the model warms up. ✅ camera works.
4. The RA exit hatch is **Control + Shift + Q** (the **Control** key, *not* ⌘ Command) →
   type `Confirm` to quit the kiosk.

Session data is written to **`~/Documents/NiedenthalLab/video-call-sessions/`** on a Mac
(the equivalent of the Windows `Documents\NiedenthalLab` folder). For real sessions, point
the data root at the Research Drive from the dashboard, exactly as on Windows.

> **If the build fails or the app misbehaves on the Mac**, send the failing Actions run
> link (or a screenshot of the error) to Alex — the most likely fixes (separate Intel/Apple
> Silicon builds instead of universal, or signing) are a small config change.

---

## Data output ("get all the data")

Each researcher-app run creates one session folder (default
`Documents\NiedenthalLab\video-call-sessions\session_<timestamp>`, root configurable and
remembered — point it at the Research Drive for real sessions):

| File | Contents |
|------|----------|
| `events.csv` | Every discrete event with ISO + relative-ms timestamps and sequence numbers: sign-ins, identity edits, every effect command (param, value, target), preset applications, banners (text + duration), researcher mic on/off (toggle vs hold), session phase changes, connection/disconnection/timeouts, WebRTC state changes, participant window blur/focus, escape-dialog opened/cancelled/confirmed, recording start/stop, unauthorized-command attempts. |
| `effect_state.csv` | 1 Hz ground truth from each participant machine: applied alpha, applied semitones, face-tracking status, render fps, camera state, session phase. This is what was *actually* shown, not just what was commanded. |
| `recordings/` | `P1_<id>_clean.webm`, `P1_<id>_altered.webm`, same for P2, plus `researcher_mic.webm`. Written to disk in 1-second chunks (a crash loses at most the last second). A mid-session reconnect starts `_part2` files rather than corrupting the originals. |
| `session.json` | Manifest: IDs, RA name, app version, session start, recording list, event count. |

CSVs and session folders are gitignored — **participant data never goes in the repo**
(IRB 2020-1657).

---

## Development

```powershell
npm install
npm run dev        # Electron app (sign in as Admin or participant)
```

Browser harness (no Electron — used by the automated test, handy for UI work):

```powershell
npm run server:dev      # standalone session server on :8771 (one session per run)
npm run renderer:dev    # next dev on :8888
# then open http://localhost:8888 in three tabs (Admin + two participants)
```

Checks:

```powershell
npm run typecheck       # renderer + main
python tests/e2e_test.py   # full 3-client flow: sign-in → waiting → previews →
                           # start → live video both ways → preset → telemetry
                           # round-trip → banner → mic → log → end screens
# (requires `pip install playwright`, `python -m playwright install chromium`,
#  and both dev servers above running)
npm run build:win       # production installer in dist/
```

### Code map

| File | Role |
|------|------|
| `main/protocol.ts` | Shared wire protocol (single source; `renderer/lib/protocol.ts` re-exports it) |
| `main/server.ts` | Session server: seats, signaling relay, effect routing, phase, logging |
| `main/logger.ts` | Session folder + `events.csv` / `effect_state.csv` / `session.json` |
| `main/main.ts` | Electron main: kiosk lockdown, Ctrl+Shift+Q, server lifecycle, streamed recording writes |
| `renderer/lib/effects.ts` | Outgoing-media pipeline: camera → face morph + voice shift → clean/altered streams |
| `renderer/lib/faceMorph.ts` | MediaPipe face-landmark smile morph (from v2) |
| `renderer/lib/voice.ts` | Web Audio pitch shifter (from v2) |
| `renderer/lib/presets.ts` | Named modification conditions (from v2) |
| `renderer/lib/signaling.ts` | Reconnecting WebSocket client |
| `renderer/lib/rtc.ts` | PeerLink — perfect-negotiation WebRTC wrapper |
| `renderer/pages/index.tsx` | Sign-in (access code `Admin` → dashboard, anything else → participant) |
| `renderer/pages/session.tsx` | Participant kiosk: waiting / live / ended, PiP, banners, escape hatch |
| `renderer/pages/admin.tsx` | Researcher dashboard |
| `renderer/pages/dashboard.tsx` | v2 single-machine capture station (kept; linked from sign-in footer) |
| `tests/e2e_test.py` | Playwright 3-client end-to-end test (19 checks) |

### Notes & known limits

- **Face morph engine**: the in-browser MediaPipe morph (smile lift/dampen) is the
  no-backend stand-in for DuckSoup/Mozza's GStreamer transformation. The researcher
  control surface (alpha, semitones, presets) matches, so swapping the engine on lab
  hardware is contained to `renderer/lib/effects.ts`.
- The face model loads from a CDN on first run (needs internet once per machine).
- Effects survive a participant reconnect (the server re-pushes the commanded state);
  a transient ICE blip does not interrupt the call, and a failed link rebuilds itself.
- One researcher-app run = one session = one data folder. Restart the app between dyads.
- Verified: typecheck clean, production build + installer clean, packaged exe launches,
  and the 19-check end-to-end suite passes (sign-in routing, readiness gating, live
  video all directions, effect→telemetry round-trip, banners, mic, logging, end flow).

*Built for the Niedenthal Emotions Lab, UW–Madison. Coordinate with Randy and Ismam
before deploying changes that touch the study protocol.*
