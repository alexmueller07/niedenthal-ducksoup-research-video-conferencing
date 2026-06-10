# DuckSoup Experimenter Platform (v2)

A capture station for DuckSoup-style emotion-modification sessions in the
Niedenthal Emotions Lab. One screen for the experimenter: set up the session,
pick a modification condition, watch the clean and altered video side by side,
record both, and save a structured session folder that feeds the PPS
questionnaire app.

It rebuilds Suhaas's `ducksoup-research` prototype into a working instrument with
two real-time effects that run on a normal Windows laptop (no server required):

- **Facial smile morph** — in-browser face-landmark detection (MediaPipe) warps
  the mouth so the smile lifts (`α > 1`) or drops (`α < 1`). It tracks the actual
  mouth, so it reads as an expression change, not a video glitch, and does
  nothing when no face is visible.
- **Voice pitch/formant shift** — a real Web Audio pitch shifter on the live mic,
  recorded into the altered track.

---

## Quick start

```powershell
cd ducksoup-platform
npm install
npm run dev
```

Then, in the window that opens:

1. Fill **Session** (Study / Dyad / Participant IDs, RA). In the desktop app, also
   pick an **output folder**.
2. Pick a **Modification condition** (e.g. *Smile + (subtle)* or *Warmer voice*).
3. Click **Start capture** — grant camera + mic. The right ("Altered") panel shows
   the participant-facing view. Drag **Smile** and **Voice pitch** and watch/hear
   them change live. **Fullscreen** the altered panel for the participant.
4. **Start recording** → **Stop**. The app saves the session (or downloads the two
   videos in browser mode) and lists the files.

First run downloads the MediaPipe face model from a CDN, so it needs internet
once. For an offline lab build, vendor the two asset URLs in
`renderer/lib/faceMorph.ts` locally.

---

## Build the Windows installer (.exe)

To produce a double-click installer for lab machines (no Node/dev tools needed on
the target computer):

```powershell
cd ducksoup-platform
npm install
npm run build:win
```

The signed-free NSIS installer lands in `dist/`:

```
dist/DuckSoup-Capture-Station-Setup-2.0.0.exe
```

Copy that one file to a lab computer and run it. It installs **DuckSoup Capture
Station** with Start-menu and desktop shortcuts and lets the user pick the install
directory. Camera, mic, effects, recording, and structured session output all work
from the installed app exactly as in `npm run dev`.

---

## Two ways to run

| | Browser (`localhost:8888`) | Desktop app (Electron) |
|---|---|---|
| Camera / effects / recording | ✅ | ✅ |
| Saving | Downloads the two `.webm` files | Structured session folder + `session.json` |
| Use for | Quick testing | Real data collection |

The same page runs both ways; it detects Electron and switches the save path.

---

## Output (the questionnaire bridge)

In the desktop app, each session creates:

```
<output root>/
└── study_<studyId>/
    └── dyad_<dyadId>/
        └── p_<participantId>_<timestamp>/
            ├── <dyad>_<participant>_clean.webm      ← unaltered
            ├── <dyad>_<participant>_altered.webm     ← morphed face + shifted voice
            └── session.json                          ← manifest
```

`session.json` records the IDs, the modification condition + applied params
(alpha, voice semitones), start/stop times, duration, and the file list. This is
the contract the PPS questionnaire app reads to load the right video per
participant — no manual file matching.

---

## Where this sits relative to the real Mozza backend

The genuine DuckSoup/Mozza facial transformation runs in a GStreamer server on
Linux/ARM-Mac. This app's **in-browser morph is the no-backend path** so the
instrument runs and demos anywhere; the **voice shifter is a real effect** either
way. The clean separation (named conditions, structured output, dual recording)
is identical to what a Mozza-backed version needs, so swapping the face engine for
Mozza on lab hardware is a contained change, not a rewrite.

---

## Architecture

Single self-contained page (no cross-window IPC — that was the earlier design and
the source of a crash outside Electron):

| File | Role |
|------|------|
| `renderer/pages/dashboard.tsx` | The experimenter UI (setup, conditions, previews, recording, output, log) |
| `renderer/lib/capture.ts` | `CaptureStation`: camera, wires face + voice, dual recording, save/download |
| `renderer/lib/faceMorph.ts` | `FaceMorphProcessor`: MediaPipe landmarks + mouth mesh warp |
| `renderer/lib/voice.ts` | `VoiceProcessor`: Web Audio pitch/formant shifter |
| `renderer/lib/presets.ts` | Named modification conditions + counterbalancing |
| `renderer/lib/types.ts` | Shared types incl. the `session.json` manifest contract |
| `main/main.ts` | Electron window + folder dialog + structured session output |

Verified: renderer + main typecheck clean; production renderer build passes
(MediaPipe bundles, pages prerender).

## Status & next steps

- ✅ Working facial morph + voice shift, dual recording, structured output.
- ✅ Runs in browser and Electron.
- ⬜ Calibrate condition values (alpha, semitones) on real faces with Randy.
- ⬜ Vendor the MediaPipe model locally for offline lab use.
- ⬜ Second-monitor participant window (currently the Fullscreen button on the
  altered panel); true dual-window needs shared-stream plumbing.
- ⬜ Two-participant dyad networking; optional Mozza live-mode face engine.
- ⬜ PPS app: add a loader that ingests `session.json`.

*Built for the Niedenthal Emotions Lab, UW–Madison.*
