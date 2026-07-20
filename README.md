# Lab Video Call — Complete Software Documentation & Audit

**Application:** Lab Video Call (package name `niedenthal-lab-video-call`)
**Purpose:** Three-seat research video call (two participants + one invisible researcher) with real-time facial-expression and voice modification, full session logging, and dual-stream recording.
**Lab:** Niedenthal Emotions Lab, University of Wisconsin–Madison, Department of Psychology
**IRB:** Protocol 2020-1657
**App version documented:** `3.0.0` (`APP_VERSION` in `main/protocol.ts`)
**Repository:** `niedenthal-ducksoup-research-video-conferencing`
**Documented from commit:** `f246bc0` (branch `main`)
**Document purpose:** Reference for the *Application / Materials / Methods* section of the study paper. Every quantitative value below is taken directly from source; file and line references are given so any claim can be verified.

> **How to read this document.** Sections 1–5 describe what an operator sees and does. Section 6 is the core technical reference for the manipulation (the smile morph and voice shift, with all equations and constants). Sections 7–11 cover expression detection, automation, networking, and data outputs. Section 12 onward covers test mode, packaging, a master constant table, and a critical audit (limitations and research-validity caveats). Section 16 is a paper-ready draft paragraph. Section 17 is a file-by-file index.

---

## Table of contents

1. Executive summary
2. System architecture
3. Application entry & roles (sign-in)
4. Participant session view
5. Researcher dashboard
6. **The transformation pipeline (core manipulation)**
   - 6.1 Camera capture
   - 6.2 Face-landmark detection
   - 6.3 Smile / frown morph — geometry, equations, per-condition displacement, timing
   - 6.4 Voice pitch shift
   - 6.5 Modification presets (experimental conditions)
7. Real-expression detection & smile sub-type classifier
8. Automation rule engine (no-code triggers)
9. Networking (signaling, WebRTC, reconnection)
10. Session lifecycle & phases
11. Data outputs & logging
12. Test mode (single-laptop, example faces)
13. Desktop packaging, kiosk lockdown, permissions
14. Master constants reference
15. **Audit: limitations, validity caveats, known inconsistencies, security**
16. Paper-ready methods draft
17. File-by-file index

---

## 1. Executive summary

The application runs a recorded, lightly moderated video conversation between two study participants seated at separate computers, while a researcher observes invisibly from a third machine and can alter, in real time, how each participant's face and voice appear *to their partner*. Neither participant ever sees their own modification; each sees the partner's modified ("altered") stream, and a small self-view showing their own raw camera.

Each participant machine independently:
- captures its camera and microphone,
- detects the participant's real facial expression (smiling / frowning, and a heuristic smile sub-type) from the *raw* camera frame,
- warps the mouth region of the outgoing video to increase or decrease apparent smiling (parameter **alpha**), and pitch-shifts the outgoing audio (parameter **voiceSemitones**),
- sends the *altered* stream to the partner and *both* the altered and *clean* streams to the researcher.

The researcher machine hosts an embedded WebSocket coordination server that assigns seats, relays connection setup, routes modification commands, runs an automation rule engine, and writes a complete session log (two CSV files + a JSON manifest) plus recordings of every stream. Audio and video flow peer-to-peer over the lab LAN; only control messages and telemetry pass through the server.

The independent variable is delivered through **named presets** (e.g. "Smile + (subtle)", "Frown (strong)", "Neutral"), each of which is a fixed (alpha, voiceSemitones) pair. Modifications can be applied manually, via presets, or automatically via researcher-authored "if-this-then-that" rules (e.g. *when Participant 1 genuinely smiles for 1 s, subtly lift Participant 2's smile*).

---

## 2. System architecture

### 2.1 Technology stack

| Layer | Technology | Where |
|---|---|---|
| Desktop shell | Electron `^41.0.3` | `main/` |
| Scaffolding | Nextron `^10.0.0` (Next.js + Electron integration) | `nextron.config.ts` |
| UI framework | Next.js `^16.2.1`, React `^19.2.4`, TypeScript `^5.7.3` (strict) | `renderer/` |
| Styling | Tailwind CSS `^4.2.2` (+ inline `styled-jsx` on two pages) | `renderer/styles/globals.css` |
| Face detection | MediaPipe Tasks-Vision `^0.10.18` (FaceLandmarker, WASM/GPU) | `renderer/lib/faceMorph.ts` |
| Video morph | HTML Canvas 2D mesh warp (no external CV library) | `renderer/lib/faceMorph.ts` |
| Voice shift | Web Audio API (delay-line pitch shifter) | `renderer/lib/voice.ts` |
| Realtime media | WebRTC (peer-to-peer) | `renderer/lib/rtc.ts` |
| Signaling / coordination | `ws` `^8.18.0` WebSocket server | `main/server.ts` |
| Persistence | `electron-store` `^11.0.2` (preferences), Node `fs` write-streams (logs/recordings) | `main/main.ts`, `main/logger.ts` |
| Recording | Browser `MediaRecorder` → streamed to disk | `renderer/lib/recording.ts`, `main/main.ts` |

### 2.2 The three seats

Defined in `main/protocol.ts` as `SlotId = 'P1' | 'P2' | 'ADMIN'`.

- **P1, P2** — the two participants. Kiosk-locked full-screen participant view.
- **ADMIN** — the researcher. Invisible to participants (never appears as a video tile). Hosts the server, holds all controls.

Exactly one of each seat is allowed. A fourth connection is rejected ("The call is full.").

### 2.3 Processes and data flow

```
   Participant 1 machine            Researcher machine (ADMIN)             Participant 2 machine
 ┌───────────────────────┐   ┌────────────────────────────────────┐   ┌───────────────────────┐
 │ session.tsx (kiosk)   │   │ admin.tsx (dashboard)              │   │ session.tsx (kiosk)   │
 │  LiveEffects:         │   │  SessionServer (WebSocket :8771)   │   │  LiveEffects:         │
 │   camera+mic          │   │   - seat assignment                │   │   camera+mic          │
 │   FaceMorphProcessor  │   │   - signaling relay                │   │   FaceMorphProcessor  │
 │   VoiceProcessor      │   │   - effect command routing         │   │   VoiceProcessor      │
 │   clean + altered     │   │   - RuleEngine (4 Hz)              │   │   clean + altered     │
 └─────────┬─────────────┘   │   - SessionLogger (CSV + manifest) │   └─────────┬─────────────┘
           │                 │   - streamed recordings to disk    │             │
   control │ (WebSocket)      └───────────────┬────────────────────┘   control  │ (WebSocket)
           └──────────────────────────────────┼─────────────────────────────────┘
                                               │
        media (WebRTC, peer-to-peer over LAN):  altered stream → partner;  altered+clean → ADMIN
```

Key architectural facts:
- **Media never passes through the server.** WebRTC carries audio/video directly between machines; the server only sees JSON control messages (`main/server.ts` header comment).
- **The server lives inside the researcher's Electron main process** (`main/main.ts` `server:start` IPC handler), so rules keep firing and logging keeps happening even if the dashboard tab is busy.
- **The whole media pipeline pre-warms during the waiting room** (`renderer/lib/effects.ts` header; `session.tsx` boot). The model is loaded, the render loop runs, and the audio graph is live at neutral settings *before* the conversation starts, so the first modification command changes parameters on an already-hot path rather than cold-starting anything mid-conversation.

---

## 3. Application entry & roles (sign-in)

File: `renderer/pages/index.tsx`. One screen serves everyone. The role is decided by the **Access code** field.

### 3.1 Fields (in visual order)

| UI element | Type | Notes |
|---|---|---|
| **Full name** | text, autofocused | Participant's first+last name, or the RA's name for admin. Written to the session log as `actor_name`. Placeholder: "First and last name". |
| **Participant ID** | text | Placeholder "e.g. 1043". |
| **Dyad ID** | text | Placeholder "e.g. D22". |
| **Access code** *(optional)* | password | Determines role (see below). Placeholder "Leave blank to join as participant". |
| **▸ Setup options** | toggle | Expands the advanced panel (below). Chevron ▸/▾. |
| **Study ID** | text (advanced) | Placeholder "e.g. PPS-2". Remembered per machine. |
| **Session address** | text (advanced) | The researcher machine's address (e.g. `10.140.2.15:8771`). Disabled when access code = admin. Remembered per machine after first session. |
| **Join** button | button | Label changes with role (below). Disabled state "Joining…" while navigating. |
| **capture station** link | link | Bottom of card ("IRB 2020-1657 · For lab use only · capture station"). Opens the legacy single-machine capture page `/dashboard`. |

### 3.2 Access codes (role selection)

Evaluated case-insensitively on the trimmed access code (`index.tsx:36–39`):

| Access code | Role | Button label | Destination |
|---|---|---|---|
| `admin` | Researcher | "Open researcher dashboard" (violet button) | `/admin` |
| `test` | Test participant | "Join as test participant (example faces)" (sky button) | `/session` (test mode) |
| anything else / blank | Participant | "Join the call" (sky button) | `/session` |

### 3.3 What Join does

`index.tsx:41–66`. Persists `serverAddr` and `studyId` to `electron-store` (Electron only), then writes a `labcall` object to `sessionStorage` containing `{ role, testMode, serverAddr, identity{ name, participantId, dyadId, studyId } }`, and routes to `/admin` (admin) or `/session` (participant/test). The admin always hosts on `localhost`; participants use the entered session address (defaulting to `localhost`).

---

## 4. Participant session view

File: `renderer/pages/session.tsx`. Presents as a minimal, calm video call. The cursor is hidden (`cursor-none`), nothing is clickable, and the window is a kiosk (see §13).

### 4.1 Screen states (driven by session **phase**)

- **Waiting room** (`phase === 'waiting'`): full-screen gradient, a video-camera glyph, "Please wait for the researcher to start", sub-text "Your conversation will begin automatically — no action needed", and two live readiness dots — **Camera** and **Session** — plus an animated three-dot "waiting" indicator. During this state the media pipeline pre-warms (model load, render loop, audio graph).
- **Live** (`phase === 'live'`): the partner's **altered** stream fills the screen (`object-cover`). The partner's name shows in a lower-left pill once their video is live. If the partner's stream is not yet live, a spinner + "Connecting to your partner…" overlay appears.
- **Ended** (`phase === 'ended'`): green check glyph, "The conversation has ended", "Please remain seated — the researcher will be with you shortly."

### 4.2 Persistent overlays

- **Self-view PiP** (bottom-right, 220×124 px, shown in waiting and live states): the participant's **own raw camera**, horizontally mirrored (`-scale-x-100`), muted, labelled "You". **This is always the clean, unaltered camera** — a participant never sees their own modification (`session.tsx:509–521`, and the header comment).
- **Researcher banner** (top-center): slides in (`bannerIn` keyframe, 0.35 s ease-out) when the researcher sends a message; auto-dismisses after the specified duration (default 8 s). Logged as `banner_shown`.
- **Researcher audio**: an invisible `<audio autoPlay>` element. The researcher is otherwise invisible; their audio plays only when they unmute (`autoplay-policy=no-user-gesture-required` is set so audio can start without a click — `main/main.ts:36`).
- **Reconnecting pill** (top-center, amber): shows only while the signaling socket is reconnecting *and* the phase is not ended. A transient ICE "disconnected" blip does **not** raise this — media keeps flowing and the participant is not alarmed; only a failed/closed link (which drops the stream) shows the "Connecting to your partner…" overlay (`session.tsx:402–407`).
- **Escape hatch** (see §4.4).

### 4.3 Test-mode panel

Present only when signed in with access code `test` (§12). A right-side panel lists five example faces; a bottom-left amber pill reads "TEST MODE — example face, not a camera".

### 4.4 The escape hatch (only way out of a participant station)

`session.tsx:335–349, 388–400, 540–582`. Triggered by **Ctrl/Cmd + Shift + Q** (handled three ways for reliability — see §13.2). Opens a modal "Close this station?" requiring the operator to type the exact word **`Confirm`** (case-sensitive) and press "Close station" (or Enter). Enter confirms, Escape cancels. On confirm, after a 150 ms delay it calls the Electron `app:request-quit` IPC (or `window.close()` in a browser). Every step is logged: `escape_dialog_opened`, `escape_dialog_cancelled`, `escape_confirmed`.

### 4.5 What the participant machine sends continuously

- **Telemetry** every **1 s** (`session.tsx:303–308`): applied alpha, voiceSemitones, faceFound, render FPS, cameraOn, and the current detected expression. Ground-truth record of what was actually shown.
- **Expression updates** checked at **5 Hz** (200 ms) but transmitted **only when the state changes** (`session.tsx:313–324`), so a neutral face costs almost no traffic. Change key = `label | smileType | round(smile×20) | round(frown×20)` (≈0.05 quantization on smile/frown magnitude).
- **Client events**: `window_blur`, `window_focus`, `rtc_state`, escape-dialog events, `effect_applied`, `banner_shown`, `media_pipeline_error`, `test_face_mode_enabled`, `test_face_changed`.

---

## 5. Researcher dashboard

File: `renderer/pages/admin.tsx`. The invisible third seat. This machine hosts the server, starts recording, and drives the manipulation.

### 5.1 Header bar

- Lab glyph + "Researcher Dashboard" + RA name.
- **Phase badge**: "● Waiting room" (amber) / "● LIVE" (green) / "● Ended" (gray).
- **Live clock** (`mm:ss`, monospace) — counts from `sessionStartedAt`, shown only while live.
- **"Participants connect to"** chip — shows the researcher machine's first LAN IP + port (e.g. `10.140.2.15:8771`), with a `+N` hover for additional interfaces.
- **📂 Data folder** button — opens the current session output folder in the OS file browser.
- **Primary action button**, which changes by phase:
  - *Waiting:* **▶ Start conversation** — enabled once **both** participants are connected. If both are also *ready* (camera + voice reported), it starts immediately; if some readiness checks are still pending, it opens a "Start with pending checks?" confirmation.
  - *Live:* **■ End session** — opens an "End the session?" confirmation.
  - *Ended:* "Session complete — data saved", plus **↻ Restart conversation** (new clock, recordings continue as `_part2…` files) and **Waiting room** (send participants back).

### 5.2 Participant panels (one per P1/P2) — `ParticipantPanel`

Each panel contains:

- **Title row**: readiness dot (green ready / amber connected-not-ready / gray empty), `P1 · <name>`, `#<participantId>`, a **MODIFIED** badge (shown when `|alpha−1| ≥ 0.02` or `|voiceSemitones| ≥ 0.5`), and an **edit info** toggle.
- **Identity editor** (when open): four inputs — Full name, Participant ID, Dyad ID, Study ID — and an "Apply to P1/P2" button that pushes the identity to the participant (`set-identity`).
- **Video monitor** (16:9, `object-contain`):
  - **Altered ⇄ Clean toggle** (top-left). "Altered (partner sees)" is violet and is *exactly* what the partner sees; "Clean" is green (the raw camera). Default view is **altered**.
  - **Telemetry chips** (bottom-left): `face tracked`/`no face`; `<n> fps` (green if ≥20); `applied ✓`/`pending…` (green once the participant's reported telemetry matches the commanded effect within tolerance — `|Δalpha| < 0.011` and `|Δsemitones| < 0.51`); and an **expression chip** (😐 neutral / 🙂 smiling · `<subtype>` / 🙁 frowning), whose tooltip shows the raw smile/frown/asymmetry/eye-constriction scores.
  - **Monitor volume** (bottom-right, 🎧 slider, 0–1, step 0.05) — starts muted at 0; tooltip warns to use headphones so monitored audio doesn't leak into the room.
- **Effect controls**:
  - **Smile slider** — label "Smile", live hint "lifted"/"dampened"/"neutral", range **−1 … 3**, step **0.05**, neutral 1, readout `α <value>`. Emits during drag (throttled) and commits (unthrottled) on release. A "reset" chip returns to neutral.
  - **Voice pitch slider** — label "Voice pitch", hint "higher"/"lower"/"neutral", range **−12 … +12** semitones, step **1**, neutral 0, readout `±<n> st`.
  - **Preset chips** — one per preset (§6.5); the active preset is highlighted violet.

### 5.3 Right rail

- **Researcher voice** card:
  - **Unmute mic** button (toggles latching live/muted; shows "🔴 Mic LIVE — click to mute" when on).
  - **Hold to talk** button (push-to-talk via pointer down/up; also releases on pointer-leave).
  - A live **level meter** (fed by a local `AnalyserNode`, `fftSize 512`) so the RA can see the mic works even while muted, and a LIVE/muted label. The mic track is captured at join but `enabled = false` until the RA goes live; `admin_mic_live` / `admin_mic_muted` are logged.
- **Message banner** card:
  - Text input (+ Enter to send), a **duration** number input (seconds, 1–120, default 8), and a **Send** button.
  - Three one-click quick banners: "Five minutes remaining.", "Please begin wrapping up your conversation.", "One moment please — brief technical pause."
  - A short history list (last 20) with timestamps and durations.
- **Automation rules** card — the no-code rule builder (§8).
- **Recordings** card — one row per active recorder (P1/P2 × altered/clean + researcher mic), with a pulsing red dot while active and a live byte counter. "Armed — starts when you start the conversation." before live.
- **Event log** card — live stream of `events.csv` rows (newest first, capped at 800 in the UI), with a text filter and an event count. Rows are color-coded by category (effect=violet, session=green, disconnect/error=red, mic/banner=sky, escape/window=amber).

### 5.4 Modals

- **Start with pending checks?** — confirm starting before all readiness checks are green.
- **End the session?** — confirm ending (participants see the ended screen, recorders stop and finalize, the manifest is written 1.5 s later).

---

## 6. The transformation pipeline (core manipulation)

This is the technical heart of the manipulation and the part most directly quotable in the paper. All of it runs *on each participant's machine*, on that participant's outgoing stream. The class that owns it in the live call is `LiveEffects` (`renderer/lib/effects.ts`); it produces two streams:

- **cleanStream** — raw camera + raw mic. Shown in the participant's own self-view PiP and sent to the researcher for reference.
- **alteredStream** — face-morphed canvas video + pitch-shifted mic. This is what the **partner** sees and hears, and what the researcher monitors.

The pipeline is fault-tolerant: if the face model fails to load, video passes through unmorphed; if the audio graph fails, raw mic audio is used. Status reports what is actually running (`effects.ts:70–121`).

### 6.1 Camera capture

`renderer/lib/effects.ts:86–89`. `getUserMedia` is requested with:

```
video: { width: 1280, height: 720 }
audio: { echoCancellation: true, noiseSuppression: true }
```

The actual negotiated resolution is read back from the track settings and used for the canvas size (falls back to 1280×720). The morphed canvas is published as a video track at **30 fps** (`canvas.captureStream(30)`). (The legacy capture station requests `audio: true` without the audio constraints; the researcher mic is captured with `audio: true`.)

### 6.2 Face-landmark detection

`renderer/lib/faceMorph.ts`. MediaPipe **FaceLandmarker** (Tasks-Vision, WASM) runs once per rendered frame on the **raw** camera frame:

- **Model**: `face_landmarker.task` (float16), vendored locally at `renderer/public/mediapipe/` for fast, offline start; the jsDelivr/Google CDN is a fallback only if local assets are missing (`faceMorph.ts:36–41, 133–140`).
- **Options** (`faceMorph.ts:142–151`): `delegate: 'GPU'`, `runningMode: 'VIDEO'`, `numFaces: 1`, `outputFaceBlendshapes: true`.
- Produces a **468-point face mesh** plus **face blendshapes** (used for expression detection, §7).
- **Mouth landmarks** used to bound the region of interest (`LIP_INDICES`, 20 outer-lip points): `61, 146, 91, 181, 84, 17, 314, 405, 321, 375, 291, 409, 270, 269, 267, 0, 37, 39, 40, 185`. Left mouth corner = **61**, right corner = **291**.
- **Yaw (head turn) estimation**: nose tip = **1**, left face edge = **234**, right face edge = **454**.

If no face is found, nothing is warped and the last expression is held for 1 s, then decayed to neutral so rules don't hold forever (`faceMorph.ts:211–220`).

### 6.3 Smile / frown morph — geometry, equations, per-condition displacement, timing

The morph is a **triangular mesh warp** of the mouth region of the canvas. The control parameter is **alpha (α)**:

- **α = 1.0** → neutral (no change).
- **α > 1** → more smiling (mouth corners pulled outward and upward).
- **α < 1** → toward a frown (corners pulled down and slightly inward, with a lower-lip pout).

Everything scales with **mouth width W** (the Euclidean distance between landmarks 61 and 291), so the effect is invariant to how close the face is to the camera.

#### 6.3.1 Tuning constants (`faceMorph.ts:55–64`)

| Constant | Value | Meaning |
|---|---|---|
| `SMILE_ANGLE_RAD` | 25° = 0.4363 rad | Mouth corners travel outward+upward at 25° above horizontal (mostly outward). |
| `SMILE_GAIN` | **0.17** | Total corner travel per unit of `(α − 1)`, in mouth-widths. |
| `FROWN_GAIN` | **0.13** | Corner-down travel per unit of `(1 − α)`, in mouth-widths. |
| `FROWN_INWARD` | **0.25** | Fraction of the corner travel applied inward (horizontally) while frowning. |
| `FROWN_POUT` | **0.5** | Lower-lip-centre drop relative to the corner drop (protruding lower lip). |
| `ALPHA_TWEEN_TAU_MS` | **350 ms** | Time constant of the smoothing tween (how fast the smile develops). |
| `YAW_FADE_START` | 0.65 | Above this face-half symmetry the morph is at full strength. |
| `YAW_FADE_END` | 0.35 | Below this symmetry the morph is fully faded out (side profile). |
| mesh `cols × rows` | 12 × 8 | Warp mesh resolution → 13×9 = **117 nodes**, 12×8×2 = **192 triangles**. |

Additional geometric constants inside the warp (`faceMorph.ts:386–391, 263–264`):
`sigmaY = 0.6·W` (vertical Gaussian falloff around the mouth line); `poutY = centerY + 0.22·W`, `poutSigma = 0.35·W` (lower-lip pout centre); ROI padding `padX = 0.55·W`, `padY = 0.7·W`; triangles are grown 0.6 px to hide seams.

#### 6.3.2 The displacement field

Let **strength `s = (α_current − 1) · yawScale`** (yaw attenuation from §6.3.4). Define `mag = |s| · W`. For each mesh node at pixel `(sx, sy)` with normalized grid coordinates `(u, v)` in the ROI:

- Horizontal position relative to mouth centre, normalized so ±1 is a corner: `xn = (sx − centerX) / (W/2)`
- Vertical Gaussian falloff about the mouth line: `vy = exp( −(sy − centerY)² / (2·sigmaY²) )`, `sigmaY = 0.6·W`
- Edge window (0 at ROI border for a seamless blend): `win = sin(π·u) · sin(π·v)`
- **Corner weight** (strongest at corners, ~0 mid-mouth, capped): `cornerW = min(1.6, xn²) · vy · win`

**Smile (s > 0)** — `faceMorph.ts:412–417`:
```
d  = mag · SMILE_GAIN · cornerW            = 0.17 · |α−1| · W · cornerW · yawScale
dx = sign(xn) · cos(25°) · d               (outward)
dy = −sin(25°) · d                         (upward)
```

**Frown (s < 0)** — `faceMorph.ts:418–428`:
```
d       = mag · FROWN_GAIN · cornerW       = 0.13 · |α−1| · W · cornerW · yawScale
dx      = −sign(xn) · FROWN_INWARD · d     = −sign(xn) · 0.25 · d   (corners pull inward)
dy      = d                                (corners pull down)
# plus a lower-lip-centre pout:
centerW = max(0, 1 − xn²)
vb      = exp( −(sy − poutY)² / (2·poutSigma²) )     poutY = centerY + 0.22·W, poutSigma = 0.35·W
dy     += mag · FROWN_GAIN · FROWN_POUT · centerW · vb · win   = 0.065 · |α−1| · W · centerW · vb · win
```

Each of the 192 triangles is then affine-mapped from its source position to its displaced destination and drawn from the raw frame, clipped to the (0.6 px-grown) destination triangle (`drawTriangle`, `faceMorph.ts:447–505`). The result tracks the actual mouth, so it reads as an expression change rather than a video glitch, and does nothing when no face is present.

**Nominal corner travel** (ignoring the window/Gaussian attenuation, i.e. the coefficient at the mouth corner): the corner moves **`SMILE_GAIN · |α−1|` mouth-widths** for a smile, decomposed as horizontal `0.17·cos25° = 0.1541` and vertical (up) `0.17·sin25° = 0.0719` mouth-widths per unit `|α−1|`. For a frown the corner drops **`FROWN_GAIN · |α−1| = 0.13` mouth-widths** per unit `|α−1|`, with an inward component of `0.0325` and a lower-lip pout peaking at `0.065` mouth-widths per unit `|α−1|`.

#### 6.3.3 Per-condition displacement table

Corner travel expressed in **mouth-widths (W)**. "Neutral" produces no warp (the pipeline still runs but the warp is skipped when `|α_current − 1| < 0.02`, `faceMorph.ts:226`).

| Preset | α | `|α−1|` | Corner travel (total) | Horizontal (out) | Vertical (up=smile / down=frown) | Extra |
|---|---|---|---|---|---|---|
| Neutral / Sham | 1.00 | 0 | — | — | — | none |
| Smile + (subtle) | 1.35 | 0.35 | 0.0595 W | 0.0539 W | +0.0251 W (up) | — |
| Smile + (strong) | 1.90 | 0.90 | 0.1530 W | 0.1387 W | +0.0647 W (up) | — |
| Warmer voice | 1.25 | 0.25 | 0.0425 W | 0.0385 W | +0.0180 W (up) | voice −2 st |
| Brighter voice | 1.25 | 0.25 | 0.0425 W | 0.0385 W | +0.0180 W (up) | voice +2 st |
| Frown (subtle) | 0.60 | 0.40 | 0.0520 W (down) | 0.0130 W (in) | −0.0520 W (down) | pout 0.0260 W |
| Frown (strong) | 0.10 | 0.90 | 0.1170 W (down) | 0.0293 W (in) | −0.1170 W (down) | pout 0.0585 W |

The manual smile slider allows α ∈ [−1, 3] (step 0.05) on the dashboard, so an operator can push the corner travel up to `0.17 × 2 = 0.34 W` (smile) or `0.13 × 2 = 0.26 W` (frown) for calibration. The legacy capture station's slider is wider still (α ∈ [−2, 5], step 0.1). Presets are the intended experimental conditions; the free sliders exist for calibration.

> Absolute pixel displacement = coefficient × mouth-width in pixels. For example, at a face where the mouth spans ~150 px, "Smile + (strong)" moves each corner ≈ 0.153 × 150 ≈ **23 px** (≈21 px outward, ≈10 px up). The exact figure depends on the participant's face size in frame.

#### 6.3.4 Head-yaw attenuation

`faceMorph.ts:238–248`. To avoid smearing on side profiles, the morph strength is scaled by how symmetric the two face halves are:
```
dl = |nose.x − leftEdge.x| ;  dr = |rightEdge.x − nose.x|
symmetry = min(dl, dr) / max(dl, dr)             # ≈1 frontal, →0 in profile
yawScale = clamp01( (symmetry − 0.35) / (0.65 − 0.35) )
```
So the morph is at full strength when symmetry ≥ 0.65, ramps down linearly between 0.65 and 0.35, and is fully off at symmetry ≤ 0.35. If `yawScale ≤ 0.01` the warp is skipped entirely.

#### 6.3.5 Timing — how fast the smile develops

The applied alpha is not snapped to the target; it eases via a frame-rate-independent exponential tween with time constant **τ = 350 ms** (`faceMorph.ts:189–196`):
```
dt = min(100, now − lastFrame)         # ms, capped
k  = 1 − exp(−dt / 350)
α_current += (α_target − α_current) · k
# snaps exactly to target when |α_current − α_target| < 0.004
```

Fraction of the way from the old value to the new target versus elapsed time (independent of frame rate):

| Elapsed | Fraction reached |
|---|---|
| 100 ms | 25% |
| 200 ms | 44% |
| 350 ms (1τ) | 63% |
| 500 ms | 76% |
| 700 ms (2τ) | 86% |
| 1000 ms | 94% |
| 1050 ms (3τ) | 95% |
| 1400 ms (4τ) | 98% |

In practice the smile **visibly develops over roughly one second** (≈95% at ~1.05 s) and completes (snaps to target) at ~1.6 s for the subtle preset and ~1.9 s for the strong preset. The same tween governs relaxation back toward neutral. The render loop itself runs on `requestAnimationFrame` (~60 Hz on lab hardware); because the tween is `dt`-based, the timing above holds regardless of the actual frame rate.

### 6.4 Voice pitch shift

File: `renderer/lib/voice.ts`. A real-time pitch/formant shifter on the live microphone, implemented with the **delay-line modulation ("Jungle") technique**: two cross-faded delay lines whose delay times are swept linearly, shifting pitch without changing tempo. It is a genuine, audible effect and is recorded into the altered audio track. (A comment notes the same control can instead drive a DuckSoup audio FX on lab hardware; that path is not active in this build.)

Constants (`voice.ts:10–12`): `DELAY_TIME = 0.1 s`, `FADE_TIME = 0.05 s`, `BUFFER_TIME = 0.1 s`.

**Control** — `setSemitones(n)` (`voice.ts:157–172`):
```
mult = clamp(n / 12, −1, 1)            # octaves; ±12 semitones = ±1 octave = full range
if mult > 0:  route the "shift up" delay buffers   (mod3,mod4 gain = 1; mod1,mod2 = 0)
else:         route the "shift down" delay buffers  (mod1,mod2 gain = 1; mod3,mod4 = 0)
setDelay( DELAY_TIME · |mult| )        # modulation depth
# setDelay: modGain1 = modGain2 = 0.5 · delay, applied with setTargetAtTime τ = 0.01 s
```

- **n = 0** → neutral/bypass.
- Range: the admin dashboard slider allows **−12 … +12 semitones** (step 1); the legacy capture station allows −8 … +8. `setSemitones` clamps the internal octave factor to ±1, so |n| beyond 12 has no additional effect.
- Preset values: "Warmer voice" = **−2 st**, "Brighter voice" = **+2 st** (both paired with α = 1.25). All smile/frown/neutral presets use **0 st**.
- Musical reference (intended pitch ratio `2^(n/12)`): +2 st ≈ 1.122× (brighter), −2 st ≈ 0.891× (warmer/lower), ±12 st = 2×/0.5×. The Jungle algorithm approximates this ratio via the delay sweep; modulation depth for ±2 st is `0.1 × (2/12) = 0.0167 s`.

The audio graph is built once at construction (`voice.ts:68–149`): mic source → input gain → two delay lines whose `delayTime` is driven by looping buffer sources (shift-up / shift-down ramps), cross-faded by two fade buffers, summed to an output gain → `MediaStreamDestination` (the published `outputStream`). Sources are started at `currentTime + 0.05 s`, staggered by `BUFFER_TIME − FADE_TIME`.

### 6.5 Modification presets (experimental conditions)

File: `main/presets.ts`. Presets are the experiment's manipulation conditions — kept as named, documented bundles rather than raw numbers so the manipulation is reproducible and operator error is reduced. Each is a fixed `(alpha, voiceSemitones)` pair. Lives in `main/` so the server's rule engine can resolve a preset ID; re-exported to the renderer via `renderer/lib/presets.ts`.

| ID | Label | α | Voice (st) | Control? | Description (verbatim) |
|---|---|---|---|---|---|
| `neutral` | Neutral / Sham | 1.0 | 0 | **yes** | "Control condition. Pipeline runs identically but face and voice are unchanged." |
| `smile-subtle` | Smile + (subtle) | 1.35 | 0 | no | "Mildly increases smile intensity. Often below conscious detection." |
| `smile-strong` | Smile + (strong) | 1.9 | 0 | no | "Clearly increases smile intensity." |
| `frown-subtle` | Frown (subtle) | 0.6 | 0 | no | "Mildly dampens the smile toward neutral/negative." |
| `frown-strong` | Frown (strong) | 0.1 | 0 | no | "Clearly shifts the mouth toward a frown." |
| `warm-voice` | Warmer voice | 1.25 | −2 | no | "Subtle smile lift paired with a slightly lower, warmer voice." |
| `bright-voice` | Brighter voice | 1.25 | +2 | no | "Subtle smile lift paired with a slightly higher, brighter voice." |

`DEFAULT_PRESET_ID = 'neutral'`. The **sham/control** condition runs the full pipeline identically (detection, canvas, audio graph all live) but leaves face and voice unchanged — so the control differs from a real condition only in the parameter values, not in any processing artifact or latency.

#### 6.5.1 Counterbalancing helper

`main/presets.ts:92–99`, `counterbalanceConditions(presetIds, nDyads)`: returns a deterministic condition order across dyads (`order[k] = presetIds[k mod presetIds.length]`), so conditions are evenly distributed and not confounded with session order. Deterministic given the same inputs (a documented, reproducible assignment). **Note:** this helper is defined but is not currently invoked anywhere in the shipped UI — condition assignment in the current build is manual (the RA picks a preset / writes rules). See §15.

---

## 7. Real-expression detection & smile sub-type classifier

Files: `renderer/lib/faceMorph.ts:276–367` (computation), `main/protocol.ts:46–72` (types). Detection runs on the participant's **real** face — the raw camera frame — **never** the morphed output. So a rule like "when P1 smiles" reacts to what the participant actually did, not to what the app drew.

### 7.1 Inputs (MediaPipe blendshapes)

Detection consumes FaceLandmarker **blendshape** scores (0–1). The features used:

| Feature | Formula (from blendshapes) |
|---|---|
| `smile` | mean(`mouthSmileLeft`, `mouthSmileRight`) |
| `frown` | mean(`mouthFrownLeft`, `mouthFrownRight`) |
| `lipPress` | mean(`mouthPressLeft`, `mouthPressRight`) |
| `openness` | mean(`mouthUpperUpLeft`,`mouthUpperUpRight`) + 0.8·`jawOpen` + 0.8·mean(`mouthLowerDownLeft`,`mouthLowerDownRight`) |
| `asymmetry` | `|smileL − smileR| + |pressL − pressR|` |
| `relAsymmetry` | `asymmetry / max(0.3, max(smileL, smileR))` |
| `eyeConstriction` | mean(`eyeSquintL`,`eyeSquintR`,`cheekSquintL`,`cheekSquintR`) — **logged only, not used to classify** |

All features are **EMA-smoothed** with time constant **τ = 220 ms** (`emaTauMs`) before thresholding.

### 7.2 Thresholds (`DETECTION_TUNING`, `faceMorph.ts:83–98`)

| Parameter | Value | Role |
|---|---|---|
| `smileOn` | 0.60 | Enter "smiling" when smile ≥ this. |
| `smileOff` | 0.45 | Stay "smiling" until smile drops below this (hysteresis). |
| `frownOn` | 0.08 | Enter "frowning" when frown ≥ this. |
| `frownOff` | 0.04 | Stay "frowning" until frown drops below this. |
| `frownSmileGate` | 0.15 | A frown only counts while smile < this (a relaxed face can score smile ≈ 0.5). |
| `rewardOpenness` | 0.20 | Openness ≥ this → **reward** smile. |
| `dominanceRelAsymmetry` | 0.12 | Relative L/R asymmetry ≥ this → **dominance** smile. |
| `emaTauMs` | 220 ms | Blendshape smoothing time constant. |
| `debounceMs` | 350 ms | A new label / sub-type must persist this long before it is published. |

### 7.3 Classification logic

1. **Label** (with hysteresis, `faceMorph.ts:326–335`): once smiling, stays smiling while smile ≥ `smileOff`; a frown requires `frown ≥ frownOn` **and** `smile < frownSmileGate`. Harder to enter a state than to stay in it.
2. **Smile sub-type** (only while smiling, `faceMorph.ts:337–342`):
   - `openness ≥ 0.20` → **reward** (open/teeth-baring smile),
   - else `relAsymmetry ≥ 0.12` → **dominance** (asymmetric smile / lip-press),
   - else → **affiliative** (everything else).
3. **Debounce** (`faceMorph.ts:344–355`): a candidate label/sub-type must hold for ≥ 350 ms before it is published.

### 7.4 Theoretical framing and calibration

The reward / affiliative / dominance sub-types follow the lab's smile-typology framework, cited in-code as **Martin et al. 2021 (Affective Science)** and **Rychlowska et al. 2021 (Cognition & Emotion)** (`main/protocol.ts:51–55`, `faceMorph.ts:24–29`).

The thresholds were **calibrated against the lab's five example photos** in `smile_examples/` (`faceMorph.ts:66–82`). The recorded calibration findings:
- a relaxed "straight" face can score `mouthSmile ≈ 0.54`, so the smiling threshold sits well above that;
- `cheekSquint`/`noseSneer` are ~0 on every example (dead features with this model), and `eyeSquint` is contaminated by blinking/looking down — so **the classic Duchenne eye-constriction cue is NOT usable as the reward marker with this model** (this is why `eyeConstriction` is logged but not used);
- what separated the three types in the examples was: reward → mouth opens/teeth show (`mouthUpperUp ≈ 0.65` vs ≈ 0.005); dominance → L/R asymmetry + lip press (rel. ≈ 0.21); affiliative → strong smile with closed lips and none of the above;
- the frown example peaked at `mouthFrown ≈ 0.12` with smile ≈ 0.

### 7.5 `ExpressionState` (what is logged and streamed)

`main/protocol.ts:60–72`: `{ label: 'neutral'|'smiling'|'frowning', smileType: 'reward'|'affiliative'|'dominance'|null, smile, frown, asymmetry, eyeConstriction, lipPress, openness }` — all scores rounded to 2 decimals. Streamed to the dashboard and fed to the rule engine at up to 5 Hz (change-gated); label/sub-type changes are written to `events.csv` as `expression_changed`.

---

## 8. Automation rule engine (no-code triggers)

Files: `main/rules.ts` (engine, runs on the server), `renderer/pages/admin.tsx:1166–1477` (the builder UI), `main/protocol.ts:84–120` (types). Rules let the researcher pre-program modifications instead of driving every slider by hand. They are authored in the dashboard, **stored and executed on the session server**, and are **editable at any moment, including mid-call**. Every firing lands in `events.csv` like any manual command.

### 8.1 Rule structure (`AutomationRule`)

```
{ id, enabled,
  trigger: { kind:'expression', slot:'P1'|'P2', expression, holdSec }
         | { kind:'timer', atSec },
  action:  { slot:'P1'|'P2', presetId },
  release: 'previous' | 'neutral' | 'none',      # expression rules only
  revertAfterSec: number | null }                # timer rules only
```

**Trigger expressions** (`RuleExpression`): `smiling` (any type), `reward-smile`, `affiliative-smile`, `dominance-smile`, `frowning`.

### 8.2 Semantics (`main/rules.ts`)

- **Expression rule** — *while* the watched participant holds the expression for `holdSec` seconds, apply the preset to the target seat. When the expression stops:
  - `previous` → restore the target's pre-rule effects,
  - `neutral` → reset the target to neutral,
  - `none` → leave the change on.
- **Timer rule** — *at* `atSec` into the live conversation, apply the preset once. If `revertAfterSec` is set, restore the pre-rule effects after that many seconds; if null, it stays on.
- **When rules run** (`rules.ts:16–18, 113–116`): **expression rules run in the waiting room AND live** (so the setup can be tested before Start); **timer rules count only from the moment the conversation goes live**. Ending the session or returning to the waiting room releases anything a rule left applied.
- **Deleting/disabling a fired rule releases it first** (`rules.ts:89–98`), so a removed rule cannot leave a participant stuck in a morph.
- **Evaluation cadence:** the server ticks the engine every **250 ms (4 Hz)** (`main/server.ts:115`).

### 8.3 The builder UI

Plain-language rows a non-programmer reads left to right, e.g.:
`WHEN [P1] [is smiling] for [1] s   THEN [P2] gets [Smile + (subtle)] · when it stops: [back to how they were]`
`AT [5]:[00] into the conversation   THEN [P1] gets [Frown (subtle)] · revert after [30] s`

Controls: an enable checkbox per rule; slot/expression/preset dropdowns; `holdSec` number (0–30, step 0.5); timer minute/second inputs; release dropdown ("back to how they were" / "reset to neutral" / "leave the change on"); revert-after number. A firing rule is highlighted violet with a "● firing" badge. Buttons: **+ expression rule**, **+ timer rule**, and **+ template: mirror smiles** (adds two reciprocal rules so each participant's genuine smile subtly lifts the partner's). Edits are debounced 400 ms before being sent, and server echoes are ignored for 1.5 s while the RA is typing so a slow round-trip can't clobber an in-progress edit.

Default new expression rule: watch P1 → target P2, "smiling", holdSec 1, preset `smile-subtle`, release `previous`. Default new timer rule: `atSec 300` (5:00), target P1, `smile-subtle`.

---

## 9. Networking (signaling, WebRTC, reconnection)

### 9.1 Wire protocol

File: `main/protocol.ts`. JSON over one WebSocket per client. `PROTOCOL_VERSION = 1`, `DEFAULT_PORT = 8771`. The module is deliberately DOM-type-free so the Electron main process can import it. Messages are fully enumerated as discriminated unions:

- **Client → Server** (`ClientMessage`): `hello`, `signal`, `ready`, `telemetry`, `expression`, `stream-map`, `client-event`, and admin-only: `set-identity`, `set-effect`, `apply-preset`, `banner`, `set-phase`, `admin-mic`, `set-rules`.
- **Server → Client** (`ServerMessage`): `welcome`, `roster`, `signal`, `effect-command`, `identity-assigned`, `banner`, `phase`, `peer-left`, `telemetry`, `expression`, `stream-map`, `log-row`, `rules`, `rule-status`, `rejected`.

Admin-only commands are rejected from participants and logged as `unauthorized_command` (`main/server.ts:505–515`).

### 9.2 The coordination server (`main/server.ts`)

- Binds `0.0.0.0:8771`. Assigns seats: admin → `ADMIN`; participants → the seat their `participantId` last held (reconnect), else P1, else P2, else reject "The call is full."
- **Identities and effects survive a reconnect** — a participant that drops and rejoins keeps its seat, its researcher-set identity, and its current modification (so the manipulation is not silently reset).
- **Heartbeat:** pings every **5 s**; a client that misses a pong between pings is terminated and logged `client_timeout` (`server.ts:114, 261–271`).
- Relays `signal` between seats; routes effect commands to the targeted participant; owns the phase; logs every event through `SessionLogger` and streams each row to the dashboard.

### 9.3 WebRTC peer links (`renderer/lib/rtc.ts`)

- One `PeerLink` per pair of seats, using the **"perfect negotiation"** pattern (polite/impolite roles) so either side can add tracks at will and glare resolves itself.
- **Politeness:** among participants, **P2 yields to P1**; the **admin is always polite** (participants drive negotiation with the admin) (`session.tsx:152–156`, `admin.tsx:308–310`).
- ICE: a single STUN server `stun:stun.l.google.com:19302`. Media is expected to flow directly over the lab LAN; STUN only matters if machines sit on different subnets. **No TURN server** is configured (see §15).
- A failed connection drops the link and (on the admin) finalizes that seat's recorders so a reconnect starts fresh `_part` files rather than appending dead-stream silence.

### 9.4 Signaling client & reconnection (`renderer/lib/signaling.ts`)

Resilient WebSocket with automatic reconnect (retry every **2 s**), replaying the `hello` so the server returns the same seat. `normalizeServerUrl` turns whatever the RA types ("localhost", "10.0.0.5:8771", "ws://…") into a valid `ws://host:port` URL, defaulting the port to 8771.

### 9.5 Stream identification

Each participant sends a `stream-map` telling the admin which MediaStream id is the **altered** vs **clean** stream (`StreamMap`), so the dashboard can label the two monitors correctly. If no map arrives and exactly one stream is present, it is treated as the altered stream.

---

## 10. Session lifecycle & phases

`Phase = 'waiting' | 'live' | 'ended'` (`main/protocol.ts:19`). The admin drives transitions via `set-phase`; the server broadcasts `phase` to everyone (`main/server.ts:478–503`).

- **waiting → live**: if coming from `ended` (or first start), a fresh `sessionStartedAt` clock is stamped; timer rules re-arm.
- **live → ended**: participants see the ended screen; recorders stop and finalize; the manifest is written ~1.5 s later; rules release.
- **→ waiting**: clears the clock entirely; rules release; expression state resets.
- **Sessions are restartable** (an RA request): `ended → live` starts a fresh clock and continues recordings as `_partN` files (nothing is overwritten); `ended/live → waiting` returns participants to the waiting room.

**Start gating:** the dashboard's Start button is enabled once both participants are *connected*; if both are also *ready* (camera + voice), it starts immediately, otherwise it asks for confirmation. Readiness is defined server-side as `camera && voice` (`main/server.ts:285`); the face model is reported but does not block Start (video simply passes through unmorphed if the model failed).

---

## 11. Data outputs & logging

Files: `main/logger.ts` (CSV + manifest), `main/main.ts` (streamed recordings), `renderer/lib/recording.ts` (format selection).

### 11.1 Session folder layout

Created per server run under the output root (default `Documents/NiedenthalLab/video-call-sessions`, selectable via a folder picker — intended to point at the UW Research Drive study folder):

```
session_<YYYY-MM-DDTHH-MM-SS>/
├── events.csv          # every discrete event
├── effect_state.csv    # 1 Hz applied-state telemetry (ground truth)
├── session.json        # manifest (written on End)
└── recordings/
    ├── P1_<pid>_clean.mp4      P1_<pid>_altered.mp4
    ├── P2_<pid>_clean.mp4      P2_<pid>_altered.mp4
    └── researcher_mic.mp4      (…_part2, _part3 on restart / reconnect)
```

CSVs are opened with append write-streams (`flags:'a'`) so rows hit disk as they happen — a crash mid-session loses at most the OS buffer, never the whole log. Recording chunks are streamed to disk every 1 s for the same reason.

### 11.2 `events.csv` schema

Header: `ts_iso, t_rel_ms, seq, actor_role, actor_slot, actor_name, event, target, param, value, detail`.
`t_rel_ms` is milliseconds since the logger started; `seq` is a monotonic counter; `detail` is JSON (CSV-escaped). Full event catalogue:

| Category | Events |
|---|---|
| Server | `server_started`, `server_stopped` |
| Connection | `client_connected`, `client_rejected`, `client_disconnected`, `client_timeout`, `client_ready`, `unauthorized_command`, `stream_map` |
| Session phase | `session_waiting`, `session_live`, `session_ended` |
| Modification | `effect_command`, `preset_applied`, `identity_set_by_admin` |
| Automation | `rules_updated`, `rule_fired`, `rule_released`, `rule_reverted` |
| Expression | `expression_changed` (on label/sub-type change only — the 5 Hz stream is not logged row-by-row) |
| Researcher | `banner_sent`, `admin_mic_live`, `admin_mic_muted` |
| Recording | `recording_started`, `recording_stopped` |
| Participant client-events | `rtc_state`, `window_blur`, `window_focus`, `escape_dialog_opened`, `escape_dialog_cancelled`, `escape_confirmed`, `banner_shown`, `effect_applied`, `media_pipeline_error`, `test_face_mode_enabled`, `test_face_changed` |

### 11.3 `effect_state.csv` schema (ground-truth telemetry)

Header: `ts_iso, t_rel_ms, slot, participant_id, phase, alpha, voice_semitones, face_found, fps, camera_on, expression, smile_type`.
Written once per second from each participant's telemetry (`fps` rounded to 0.1). This is the authoritative record of **what was actually applied and shown**, independent of what was commanded — so any command-vs-applied discrepancy is auditable.

### 11.4 Manifests (two formats — mode-dependent)

- **Three-seat call** (`admin.tsx:509–525`, written via `server:write-manifest` on End): `{ schemaVersion:2, app:'Niedenthal Lab Video Call', appVersion:'3.0.0', writtenAt, sessionStartedAt, raName, participants:[{slot, identity}], recordings:[{label, bytes}], eventCount }` → `session.json`.
- **Legacy capture station** (`renderer/lib/capture.ts:310–330`): `{ schemaVersion:1, app:'DuckSoup Experimenter Platform', appVersion:'2.0.0', createdAt, config, preset, appliedParams:{alpha, voiceSemitones, overlay}, startedAt, stoppedAt, durationSec, files:[{kind, filename, path, bytes}] }`. This is the manifest the PPS questionnaire app was written to read (`renderer/lib/types.ts:44–60`). **The two formats differ** — see §15.

### 11.5 Recording format

`renderer/lib/recording.ts`. MP4 is preferred (RAs asked for `.mp4`; opens everywhere the lab works): candidates in order `video/mp4;codecs=avc1.640028,mp4a.40.2` → `avc1.42E01E,mp4a.40.2` → `video/mp4` → `video/webm;codecs=vp9,opus` → `video/webm`. The first the running Chromium supports wins; otherwise it falls back to WebM. Fragmented MP4 stays playable even if the app crashes mid-recording. Chunks are cut every 1 s (`MediaRecorder.start(1000)`).

---

## 12. Test mode (single-laptop, example faces)

Signed in with access code **`test`** (`index.tsx:39`, `session.tsx:42–49, 275–301`). Instead of the camera, the pipeline runs on a **bundled example face image** letterboxed onto a 720p canvas (redrawn every 66 ms → ~15 fps, `captureStream(15)`) plus a silent oscillator audio track, so the morph, detection, ready-gate, and full WebRTC call all behave exactly as with a real camera. A right-side panel switches the face live among five options — **Straight face, Reward smile, Affiliative smile, Dominance smile, Frown** (`renderer/public/images/test-faces/`). Every use is written to the log (`test_face_mode_enabled`, `test_face_changed`) and an amber "TEST MODE" pill is shown, because **a real session must never quietly run on an example face**. For single-laptop testing only.

---

## 13. Desktop packaging, kiosk lockdown, permissions

### 13.1 Build & distribution

- **Electron-builder** (`electron-builder.yml`): appId `edu.wisc.niedenthal.labvideocall`, product name "Lab Video Call". Windows target: NSIS installer (`Lab-Video-Call-Setup-<version>.exe`, desktop + start-menu shortcuts, user-selectable install dir). macOS target: universal (Intel + Apple Silicon) **DMG + ZIP** (`Lab-Video-Call-<version>-<arch>.dmg`).
- **macOS CI** (`.github/workflows/build-mac.yml`): builds the universal Mac app on a GitHub `macos-latest` runner (no Mac needed locally), uploads `lab-video-call-macos` artifacts, 30-day retention. Builds are **unsigned** (`CSC_IDENTITY_AUTO_DISCOVERY:false`; no Apple Developer cert) — testers must right-click → Open on first launch.
- Camera/mic **Info.plist usage strings** and **entitlements** (`resources/entitlements.mac.plist`) are set so a signed build works unchanged; `hardenedRuntime:false`, ad-hoc signature. **Consequence:** on unsigned macOS builds, the OS ties the camera/mic permission grant to the code signature, so a fresh install may re-prompt for permissions (documented as a code-signing limitation, not a bug).
- Windows/Mac icons in `resources/`.

### 13.2 Kiosk lockdown (participant machines)

`main/main.ts:149–216`. When a client signs in as a participant (`role:participant` IPC), the window becomes a locked kiosk:
- `setKiosk(true)`, `setAlwaysOnTop(true, 'screen-saver')`, `setClosable(false)`, minimum size 800×600.
- `powerSaveBlocker` prevents display sleep during a session.
- Blocked keys: `F5`, `F11`, `F12`; `Ctrl/Cmd`-combos for reload/close/new-window/zoom (`R/W/N/+/−/0`); devtools combos (`Ctrl+Shift+I/J/C`) in production.
- **The only exit is Ctrl/Cmd+Shift+Q → type "Confirm".** This is handled in **three** places for reliability: a global shortcut, a per-window `before-input-event` handler, and a renderer `keydown` listener — because an Electron global shortcut can only be claimed by one process per machine, which made the combo unreliable when several windows ran on one laptop for testing.
- The researcher window is a normal window; closing it mid-live prompts a confirmation (it shuts the server down for everyone).

### 13.3 Permissions & autoplay

`main/main.ts:36, 70–80`. `autoplay-policy=no-user-gesture-required` (so the researcher's audio can start without a participant click). On macOS the app proactively calls `askForMediaAccess('microphone'|'camera')` up front; Chromium's own permission handler grants `media`, `fullscreen`, and `display-capture` outright (this is a kiosk lab app; the OS-level permission is the real gate).

### 13.4 Dev vs. production

Dev: `npm run dev` (Nextron) runs Next.js on port 8888 + Electron; `nextron.config.ts` sets `startupDelay:30000` so the renderer has time to bind. Browser-only dev: `npm run server:dev` runs the standalone WebSocket server (`main/server-standalone.ts`) so the full three-client flow can be exercised in three browser tabs without Electron (CSVs land in `scratchpad/dev-sessions/`). Production serves the exported Next.js app from `app://` via `electron-serve`; the renderer is statically exported (`output:'export'`, `renderer/next.config.ts`).

---

## 14. Master constants reference

Every tunable in one place, for quoting exact figures.

### 14.1 Morph & timing

| Constant | Value | File |
|---|---|---|
| Smile corner angle | 25° above horizontal | faceMorph.ts |
| Smile gain (`SMILE_GAIN`) | 0.17 mouth-widths per unit `|α−1|` | faceMorph.ts |
| Frown gain (`FROWN_GAIN`) | 0.13 mouth-widths per unit `|α−1|` | faceMorph.ts |
| Frown inward fraction | 0.25 | faceMorph.ts |
| Frown pout fraction | 0.5 | faceMorph.ts |
| Alpha tween τ | 350 ms | faceMorph.ts |
| Warp skip threshold | `|α−1| < 0.02` | faceMorph.ts |
| Tween snap threshold | `|α−α_target| < 0.004` | faceMorph.ts |
| Yaw full/off symmetry | 0.65 / 0.35 | faceMorph.ts |
| Mesh resolution | 12 × 8 (117 nodes / 192 triangles) | faceMorph.ts |
| Vertical falloff σ | 0.6 × mouth width | faceMorph.ts |
| ROI padding | 0.55×W (x), 0.7×W (y) | faceMorph.ts |

### 14.2 Voice

| Constant | Value |
|---|---|
| DELAY_TIME | 0.1 s |
| FADE_TIME | 0.05 s |
| BUFFER_TIME | 0.1 s |
| Octave clamp | `n/12 ∈ [−1, 1]` (±12 st = ±1 octave) |
| Delay smoothing τ | 0.01 s |
| Admin slider range / step | −12 … +12 st / 1 |
| Legacy slider range / step | −8 … +8 st / 1 |

### 14.3 Detection

| Constant | Value |
|---|---|
| smileOn / smileOff | 0.60 / 0.45 |
| frownOn / frownOff | 0.08 / 0.04 |
| frownSmileGate | 0.15 |
| rewardOpenness | 0.20 |
| dominanceRelAsymmetry | 0.12 |
| EMA τ | 220 ms |
| debounce | 350 ms |

### 14.4 Cadences & networking

| Item | Value |
|---|---|
| Default port | 8771 |
| Render loop | requestAnimationFrame (~60 Hz), dt capped 100 ms |
| Telemetry send | 1 Hz |
| Expression check / send | 5 Hz (200 ms), change-gated |
| Rule engine tick | 4 Hz (250 ms) |
| Heartbeat ping | 5 s |
| Reconnect retry | 2 s |
| Recording chunk | 1 s |
| Effect slider throttle | 90 ms (forced commit on release) |
| Rule send debounce | 400 ms |
| Edit-echo ignore window | 1.5 s |
| Canvas captureStream | 30 fps (test mode 15 fps) |
| Camera request | 1280×720 |
| Banner default / range | 8 s / 1–120 s |
| STUN | stun.l.google.com:19302 (no TURN) |

### 14.5 Slider / control ranges (UI)

| Control | Range | Step | Neutral |
|---|---|---|---|
| Smile α (dashboard) | −1 … 3 | 0.05 | 1 |
| Voice pitch (dashboard) | −12 … +12 st | 1 | 0 |
| Smile α (legacy capture) | −2 … 5 | 0.1 | 1 |
| Voice pitch (legacy capture) | −8 … +8 st | 1 | 0 |
| Rule hold time | 0 … 30 s | 0.5 | — |
| Timer minute / second | 0–180 / 0–59 | 1 | — |
| Monitor volume | 0 … 1 | 0.05 | 0 (muted) |

---

## 15. Audit — limitations, validity caveats, known inconsistencies, security

This section flags things Randy should know before describing or citing the software, and things worth addressing before the next data collection. Severity in brackets uses the lab's convention (High = fix before relying on it in a study; Medium = should address; Low = note only).

### 15.1 Research-validity caveats (most important for the paper)

1. **The manipulation intensities are un-calibrated placeholders.** `main/presets.ts` states in-code that the current α values are "starting points to calibrate with Randy," reduced from earlier values after a demo. No psychophysical validation (detection threshold, perceived naturalness, believability) has been run. **The paper should not present the preset α values as validated intensities** without a calibration study; describe them as pilot settings.
2. **The smile sub-type classifier is a heuristic tuned to five still images.** Reward/affiliative/dominance are assigned by blendshape thresholds calibrated to `smile_examples/`, not validated against FACS-coded or human-rated video. The Duchenne eye-constriction cue is explicitly *not* used (unreliable on webcams with this model). If sub-type is an analysis variable, it needs independent validation; otherwise treat it as an exploratory signal.
3. **The morph is a 2-D planar mesh warp, not a 3-D face model.** It moves mouth-corner geometry only (plus a lower-lip pout); it does not add Duchenne eye/cheek changes, teeth, or lighting/shading consistent with a real smile. It attenuates on head turn (fades out by ~35% face-half symmetry) and does nothing when no face is detected — so during head turns or tracking dropouts the participant briefly sees the unmodified partner. Any frames where `face_found = false` in `effect_state.csv` are unmodified regardless of the commanded α.
4. **Detection runs on the raw face — good — but at ~5 Hz and EMA-smoothed (220 ms) with a 350 ms debounce.** Expression onset is therefore reported with up to ~0.5–0.7 s latency. Rule "hold" durations should be interpreted with that in mind.
5. **Effect timing has a ~1 s ease-in.** A commanded change reaches ~95% of target in ~1.05 s (τ = 350 ms). If the design treats a modification as instantaneous, that is inaccurate — cite the tween. `effect_state.csv` records the *applied* α each second, so the true trajectory is recoverable.
6. **Condition counterbalancing is not automated in this build.** `counterbalanceConditions()` exists and is deterministic, but nothing in the UI calls it — the RA assigns conditions manually per session. For the pilot this means condition order/assignment lives in the RA's procedure, not the software; document how it was actually done, and consider wiring the helper in for the main study (the lab's coding rules require randomization to be seeded and logged).

---

## 16. Paper-ready methods draft

A concise draft for the Application/Materials section, using only values verified above. 

> Conversations were conducted over a custom Electron desktop application (Lab Video Call, v3.0.0) developed for the lab. Two participants at separate computers held a video conversation while a researcher observed from a third, invisible station that coordinated the session and applied real-time modifications to each participant's outgoing audio and video. Each participant machine captured video at 1280×720 and, using an in-browser facial-landmark model (MediaPipe FaceLandmarker), tracked the mouth region and applied a triangular-mesh warp that displaced the mouth corners to increase or decrease apparent smiling. Smile intensity was controlled by a single parameter α (1.0 = unmodified); mouth-corner displacement scaled with mouth width and with |α−1|, moving the corners outward and upward at 25° for smiles (0.17 mouth-widths of travel per unit |α−1|) and downward-and-inward with a lower-lip pout for frowns (0.13 mouth-widths per unit |α−1|). Parameter changes were smoothed with a 350 ms exponential time constant (reaching ~95% of target in ~1 s). Voice pitch was shifted independently in semitones via a Web Audio delay-line pitch shifter. Modifications were delivered as named conditions: a sham/control condition (α = 1.0, no pitch shift, with the full processing pipeline running identically), subtle and strong smile increases (α = 1.35 and 1.90), subtle and strong frowns (α = 0.60 and 0.10), and two combined smile-plus-voice conditions (α = 1.25 with ±2 semitones). Modifications could be applied manually or triggered automatically by rules keyed to a participant's own detected expression. Participants saw the partner's modified video full-screen and their own unmodified camera in a small self-view; they never saw their own modification. Audio and video streamed peer-to-peer over the lab network; a coordination server on the researcher machine logged every event and applied-parameter value (at 1 Hz) to CSV and recorded each clean and modified stream to disk.

---

## 17. File-by-file index

### `main/` (Electron main process + server)
| File | Lines | Role |
|---|---|---|
| `main.ts` | 373 | App entry; kiosk lockdown; permissions; server start/stop IPC; streamed-recording IPC; folder picker; legacy capture IPC. |
| `server.ts` | 598 | `SessionServer`: seats, signaling relay, effect routing, phase, rule engine host, logging, LAN IP discovery. |
| `rules.ts` | 227 | `RuleEngine`: expression/timer triggers, holds, reverts, release modes; `describeRule`. |
| `presets.ts` | 99 | Modification conditions (the manipulation), `getPreset`, `counterbalanceConditions`. |
| `protocol.ts` | 250 | Wire protocol, all message types, `EffectState`, `ExpressionState`, `AutomationRule`, `Telemetry`, versions, port. |
| `logger.ts` | 183 | `SessionLogger`: `events.csv`, `effect_state.csv`, `session.json`, recording paths. |
| `preload.ts` | 24 | Context-bridge IPC (`window.ipc.invoke/on/send`). |
| `server-standalone.ts` | 32 | Browser-dev standalone server entry (`npm run server:dev`). |
| `helpers/create-window.ts` | 86 | Window creation + persisted window state. |

### `renderer/lib/` (transformation & networking)
| File | Lines | Role |
|---|---|---|
| `faceMorph.ts` | 519 | **FaceMorphProcessor**: MediaPipe detection, the smile/frown mesh warp, expression classifier. |
| `voice.ts` | 193 | **VoiceProcessor**: Web Audio delay-line pitch shifter. |
| `effects.ts` | 239 | **LiveEffects**: participant outgoing pipeline (clean + altered streams); test-face stream. |
| `capture.ts` | 361 | **CaptureStation**: legacy single-machine capture+record engine (dashboard mode). |
| `rtc.ts` | 102 | **PeerLink**: one WebRTC connection, perfect negotiation. |
| `signaling.ts` | 104 | **SignalClient**: resilient WebSocket + `normalizeServerUrl`. |
| `recording.ts` | 35 | MP4/WebM recorder-format selection. |
| `types.ts` | 60 | Legacy capture types + `SessionManifest` (v1). |
| `protocol.ts` / `presets.ts` | 6 / 5 | Renderer re-exports of the shared `main/` modules. |
| `ipcUtil.ts` | 29 | Typed IPC wrappers that no-op outside Electron. |

### `renderer/pages/` (UI)
| File | Lines | Role |
|---|---|---|
| `admin.tsx` | 1631 | Researcher dashboard (panels, sliders, presets, rules, banners, mic, recordings, event log). |
| `session.tsx` | 629 | Participant kiosk view (waiting/live/ended, PiP, banner, escape hatch, test-face panel). |
| `dashboard.tsx` | 357 | Legacy "DuckSoup Capture Station" single-machine UI. |
| `index.tsx` | 199 | Sign-in / role selection. |
| `_app.tsx` | 9 | Next.js app shell. |

### Assets & config
`renderer/public/mediapipe/` (vendored FaceLandmarker model + WASM); `renderer/public/images/test-faces/` (5 test faces); `smile_examples/` (5 calibration photos); `renderer/public/ducksoup.js` (vendored, unused); `resources/` (icons, mac entitlements); `electron-builder.yml`, `nextron.config.ts`, `renderer/next.config.ts`, `tsconfig*.json`, `.github/workflows/build-mac.yml`, `tests/e2e_test.py`.

---

*End of documentation.*

