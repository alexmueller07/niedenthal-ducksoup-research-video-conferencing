# Technical reference

Architecture and implementation details for the Lab Video Call app. For a plain-language walkthrough of running a session, see the [researcher guide](for-non-technical-users.md).

`APP_VERSION` (`main/protocol.ts`, mirrors `package.json`'s `version`) auto-bumps its patch number on every push to `main` — see §11.5 — so it will already have moved past `3.0.0` by the time you read this; check `package.json` for the current number.

## Contents

1. [Architecture](#1-architecture)
2. [Sign-in and roles](#2-sign-in-and-roles)
3. [The transformation pipeline](#3-the-transformation-pipeline)
4. [Expression detection](#4-expression-detection)
5. [Calibration](#5-calibration)
6. [Automation rules](#6-automation-rules)
7. [Networking](#7-networking)
8. [Session lifecycle](#8-session-lifecycle)
9. [Data outputs & logging](#9-data-outputs--logging)
10. [Test mode](#10-test-mode)
11. [Packaging & kiosk lockdown](#11-packaging--kiosk-lockdown)
12. [Constants reference](#12-constants-reference)
13. [Known limitations](#13-known-limitations)
14. [File index](#14-file-index)

---

## 1. Architecture

### 1.1 Stack

| Layer | Technology | Where |
|---|---|---|
| Desktop shell | Electron `^41.0.3` | `main/` |
| Scaffolding | Nextron `^10.0.0` (Next.js + Electron) | `nextron.config.ts` |
| UI | Next.js `^16.2.1`, React `^19.2.4`, TypeScript `^5.7.3` (strict) | `renderer/` |
| Styling | Tailwind CSS `^4.2.2` | `renderer/styles/globals.css` |
| Face detection | MediaPipe Tasks-Vision `^0.10.18` (FaceLandmarker, WASM/GPU) | `renderer/lib/faceMorph.ts` |
| Video morph | Canvas 2D triangular mesh warp, no external CV library | `renderer/lib/faceMorph.ts` |
| Voice shift | Web Audio API delay-line pitch shifter | `renderer/lib/voice.ts` |
| Realtime media | WebRTC, peer-to-peer | `renderer/lib/rtc.ts` |
| Signaling | `ws` `^8.18.0` WebSocket server | `main/server.ts` |
| Persistence | `electron-store` (preferences), Node `fs` write-streams (logs/recordings) | `main/main.ts`, `main/logger.ts` |
| Recording | `MediaRecorder`, streamed to disk | `renderer/lib/recording.ts`, `main/main.ts` |

### 1.2 The three seats

`SlotId = 'P1' | 'P2' | 'ADMIN'` (`main/protocol.ts`). Exactly one of each is allowed; a fourth connection is rejected. P1/P2 are kiosk-locked participant views; ADMIN is the researcher's dashboard and is never shown as a video tile.

### 1.3 Data flow

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

Key facts:
- **Media never passes through the server.** WebRTC carries audio/video directly between machines; the server only sees JSON control messages.
- **The server runs inside the researcher's Electron main process** (`main/main.ts`, `server:start` IPC), so rules and logging keep running even if the dashboard tab is busy.
- **The pipeline pre-warms in the waiting room.** The face model loads, the render loop runs, and the audio graph is live at neutral settings before the conversation starts, so the first modification command lands on an already-hot path.

---

## 2. Sign-in and roles

`renderer/pages/index.tsx`. Role is decided by the (case-insensitive, trimmed) **Access code** field (`index.tsx:36–39`):

| Access code | Role | Destination |
|---|---|---|
| `admin` | Researcher | `/admin` |
| `test` | Test participant (example faces) | `/session` (test mode) |
| anything else / blank | Participant | `/session` |

`Join` persists `serverAddr` / `studyId` to `electron-store`, writes a `labcall` object to `sessionStorage` (`{ role, testMode, serverAddr, identity }`), and routes accordingly. The admin always hosts on `localhost`; participants use the entered session address.

---

## 3. The transformation pipeline

The core manipulation. Runs entirely on each participant's own machine, on their outgoing stream. Owned by `LiveEffects` (`renderer/lib/effects.ts`), which produces two streams:

- **cleanStream** — raw camera + raw mic. Shown in the participant's own self-view and sent to the researcher for reference.
- **alteredStream** — face-morphed canvas video + pitch-shifted mic. This is what the partner sees/hears and what the researcher monitors.

Fault-tolerant by design: if the face model fails to load, video passes through unmorphed; if the audio graph fails, raw mic audio is used.

### 3.1 Camera capture

`renderer/lib/effects.ts:86–89`. `getUserMedia({ video: { width: 1280, height: 720 }, audio: { echoCancellation: true, noiseSuppression: true } })`. Negotiated resolution is read back for canvas sizing (falls back to 1280×720). Morphed canvas is published at **30 fps** (`canvas.captureStream(30)`).

### 3.2 Face-landmark detection

`renderer/lib/faceMorph.ts`. MediaPipe **FaceLandmarker** (WASM) runs once per rendered frame on the **raw** camera frame.

- Model: `face_landmarker.task` (float16), vendored at `renderer/public/mediapipe/`; CDN fallback only if local assets are missing.
- Options: `delegate: 'GPU'`, `runningMode: 'VIDEO'`, `numFaces: 1`, `outputFaceBlendshapes: true`.
- Produces a 468-point mesh plus blendshapes (used for expression detection, §4).
- Mouth ROI: 20 outer-lip landmarks (`LIP_INDICES`). Left corner = landmark **61**, right corner = **291**.
- Yaw estimate uses nose tip (**1**) and face edges (**234**, **454**).

If no face is found, the last expression is held for 1 s, then decays to neutral so rules don't hold forever.

### 3.3 Smile / frown morph

A triangular mesh warp of the mouth region, controlled by parameter **alpha (α)**:

- **α = 0** → neutral.
- **α > 0** → more smiling (corners out and up).
- **α < 0** → toward a frown (corners down and slightly in, plus a lower-lip pout).

**α is a fraction of that participant's own calibrated maximum.** α = 1.0 moves their mouth corners
exactly as far as their own biggest real smile (or frown); α = 0.5 moves them half that. How far that
is in pixels differs per person — that is the whole point, and it is what makes the result look like
their face rather than a generic one. Without a calibration profile the morph falls back to the old
fixed geometry, so α = 1.0 uncalibrated behaves exactly as α = 1.0 always did.

#### Per-person geometry (`calibration.ts`, `derived.smile` / `derived.frown`)

| From calibration | Replaces | Meaning |
|---|---|---|
| `cornerTravel` | `SMILE_GAIN` 0.17 / `FROWN_GAIN` 0.13 | Corner travel at their maximum, in mouth-widths |
| `cornerAngleRad` | `SMILE_ANGLE_RAD` 25° / `FROWN_INWARD` 0.25 | The direction their corners actually travel |
| `poutDrop` | `FROWN_POUT` 0.5 | Lower-lip-centre drop at their maximum frown |

Both directions now use one displacement formula, because the calibrated angle already points out+up
for a smile and down+in for a frown.

Safety rails, so a bad calibration cannot produce a dead or grotesque morph: `cornerTravel` is
clamped to `[0.04, 0.35]` mouth-widths and `cornerAngleRad` to `[10°, 45°]` (mirrored for a frown).

#### The total cap

The cap is on the **total**, not on the morph alone: a participant's own expression plus the
modification must never exceed what their face actually does. So the morph gets whatever headroom is
left over.

```
L        = live corner travel from their neutral, projected onto their calibrated
           direction, ÷ their calibrated max travel            → clamp01
headroom = 1 − L
applied  = min(|α_commanded|, headroom) × cornerTravel × yawScale × openScale
```

- At rest the full commanded α is available. At a genuine maximum smile the morph adds nothing.
- `L` is measured **geometrically**, from landmarks — the quantity being capped is corner
  displacement, so the cap has to be in the same units as the warp, not in blendshape scores.
- `L` is jaw-compensated (§3.6), so speech does not eat the headroom.
- The cap is applied to the **target** before the 350 ms tween, so headroom changes ease in rather
  than jittering frame to frame.
- **Consequence for analysis**: the commanded α is no longer ground truth. `effect_state_<seat>.csv`
  records `commanded_alpha`, `applied_alpha`, `live_level` and `headroom` per second;
  `applied_alpha` is the number to analyse.

#### Displacement field

Let `s` = the capped, faded α, `mag = |s| · W` where W is the current mouth width. For a mesh node
at `(sx, sy)` with normalized ROI coords `(u, v)`:

- `xn = (sx − centerX) / (W/2)` — horizontal position, ±1 at a corner
- `vy = exp(−(sy − centerY)² / (2·sigmaY²))` — vertical falloff about the mouth line, `sigmaY = 0.6·W`
- `win = sin(π·u) · sin(π·v)` — edge window (0 at ROI border, for a seamless blend)
- `cornerW = min(1.6, xn²) · vy · win` — corner weight

```
d  = mag · cornerTravel · cornerW
dx = sign(xn) · cos(cornerAngleRad) · d
dy = −sin(cornerAngleRad) · d
# frown only, a lower-lip pout:
centerW = max(0, 1 − xn²)
vb      = exp(−(sy − poutY)² / (2·poutSigma²))       # poutY = centerY + 0.22·W, poutSigma = 0.35·W
dy     += mag · poutDrop · centerW · vb · win
```

Each of the 192 triangles is affine-mapped from source to displaced destination and drawn from the
raw frame, so the warp tracks the actual mouth and does nothing when no face is present. ROI padding
`padX = 0.55·W`, `padY = 0.7·W`; mesh 12 × 8 (117 nodes / 192 triangles).

#### Head-yaw attenuation

`faceMorph.ts`:
```
dl = |nose.x − leftEdge.x| ;  dr = |rightEdge.x − nose.x|
symmetry = min(dl, dr) / max(dl, dr)
yawScale = clamp01((symmetry − 0.35) / (0.65 − 0.35))
```
Full strength at symmetry ≥ 0.65, ramps to 0 by symmetry ≤ 0.35 (side profile). Warp skipped
entirely if `yawScale ≤ 0.01`.

#### Timing

Applied alpha eases toward target via a frame-rate-independent exponential tween, τ = 350 ms:
```
dt = min(100, now − lastFrame)      # ms, capped
k  = 1 − exp(−dt / 350)
α_current += (α_target − α_current) · k
# snaps to target when |α_current − α_target| < 0.004
```

| Elapsed | Fraction reached |
|---|---|
| 100 ms | 25% |
| 350 ms (1τ) | 63% |
| 700 ms (2τ) | 86% |
| 1050 ms (3τ) | 95% |
| 1400 ms (4τ) | 98% |

In practice a change visibly develops over ~1 s and completes (snaps) around 1.6–1.9 s. Same tween
governs relaxation back to neutral, independent of actual frame rate.

### 3.6 Open mouths and talking

The warp only moves **mouth corners**, but an open mouth moves corners for reasons a corner-pull warp
cannot reproduce. Two problems — an open-mouth grin setting the maximum too high, and ordinary speech
reading as an expression — share one fix.

**Calibration records two smiles.** The closed-lip smile sets the morph gain; the open-mouth one sets
the detection range. The difference between them gives each participant's own jaw-to-corner coupling:

```
jawCoupling = (openTravel − closedTravel) / (openRatio_open − openRatio_closed)     # clamped [0, 1.5]
```

At runtime that is subtracted before anything else looks at the corner movement:
```
L = clamp01((projectedTravel − jawCoupling · max(0, openRatio − neutralOpen)) / cornerTravel)
```
which removes most of the talking artifact from both detection and the headroom cap.

**Talking detection** (`TalkingDetector`, `calibration.ts`). Speech is a *modulated* mouth shape; an
expression is a *sustained* one. Two signals, ANDed:

- `rollingStd(mouthOpenRatio, 600 ms) > 3 × neutral.geometry.mouthOpenRatio.std` — per-person, from
  calibration.
- Short-window mic RMS > 0.02, read off the existing Web Audio graph (`voice.ts:micLevel()`; the
  1-person station opens a minimal analyser of its own). Geometry alone mistakes chewing, laughing
  and yawning for speech.

It holds through the gaps between words (400 ms release) rather than flickering.

**What talking changes:**

| | Behaviour while talking |
|---|---|
| Frown labels | **Suppressed entirely.** Speech drives the same pucker / funnel / shrug-lower pout features the frown reading keys on, so a frown mid-sentence is usually a false positive. |
| Smile labels | Still published, with the dead zone raised ×1.5. Smiling while talking is real and common. |
| Morph | **Not frozen** — an effect that switches off mid-sentence is visible. Faded with mouth openness instead. |

The morph's open-mouth fade, same shape as the yaw fade:
```
openScale = 1 − 0.6 · clamp01((openRatio − neutralOpen) / (openSmileOpen − neutralOpen))
```
→ a 40% floor at a wide-open mouth. That is exactly where a planar corner-pull warp looks worst and
where the effect is least noticeable anyway. Continuous, so it never pulses during speech.

### 3.7 Voice pitch shift

`renderer/lib/voice.ts`. Real-time pitch/formant shift on the live mic via the delay-line modulation
("Jungle") technique: two cross-faded delay lines with linearly swept delay times. Genuine, audible,
and recorded into the altered audio track.

Constants: `DELAY_TIME = 0.1 s`, `FADE_TIME = 0.05 s`, `BUFFER_TIME = 0.1 s`.

`setSemitones(n)`:
```
mult = clamp(n / 12, −1, 1)     # ±12 semitones = ±1 octave = full range
route "shift up" buffers if mult > 0, else "shift down" buffers
setDelay(DELAY_TIME · |mult|)   # modulation depth, via setTargetAtTime τ = 0.01 s
```

- `n = 0` → bypass.
- Dashboard slider: −12…+12 st (step 1). The 1-Person Test Station has no voice control — it's
  video-only. Values beyond ±12 have no additional effect (clamped internally).
- Presets: "Lower voice" = −2 st, "Higher voice" = +2 st. All other presets = 0 st.
- Reference: pitch ratio ≈ `2^(n/12)`; +2 st ≈ 1.122×, −2 st ≈ 0.891×, ±12 st = 2×/0.5×.
- `micLevel()` exposes a short-window RMS of the raw mic for the talking detector (§3.6). Read-only;
  the pitch shifter's own signal path is untouched.

### 3.8 Modification presets

`main/presets.ts` (re-exported to renderer via `renderer/lib/presets.ts`). Each preset is a fixed
`(alpha, voiceSemitones)` pair, kept as named bundles rather than raw numbers for reproducibility.

| ID | Label | α | Voice (st) | Control? | Description |
|---|---|---|---|---|---|
| `neutral` | Neutral / Sham | 0 | 0 | yes | Full pipeline runs identically; face and voice unchanged. |
| `smile-subtle` | Smile (subtle) | 0.20 | 0 | no | A fifth of their own maximum smile. |
| `smile-strong` | Smile (strong) | 0.50 | 0 | no | Half of their own maximum smile. |
| `frown-subtle` | Frown (subtle) | −0.25 | 0 | no | A quarter of their own maximum frown. |
| `frown-strong` | Frown (strong) | −0.55 | 0 | no | Just over half of their own maximum frown. |
| `warm-voice` | Lower voice | 0.15 | −2 | no | Slight smile lift + slightly lower voice. |
| `bright-voice` | Higher voice | 0.15 | +2 | no | Slight smile lift + slightly higher voice. |

**These values were rescaled when calibration landed.** α now means "fraction of this person's own
maximum", so the old numbers (0.35 / 0.9 / −0.4 / −0.9) would have meant something far stronger. The
values above aim to keep the *visible* effect roughly where the old fixed geometry put it. They are
pilot settings — see §13.

Note that a preset also delivers less than its number whenever the participant is already expressing,
because their real face has taken part of the budget (§3.3). `applied_alpha` records what landed.

`DEFAULT_PRESET_ID = 'neutral'`. The sham/control condition runs the identical pipeline (detection,
canvas, audio graph, calibration all live) but leaves parameters unchanged, so it differs from a real
condition only in parameter values, not processing artifacts or latency.

`counterbalanceConditions(presetIds, nDyads)` returns a deterministic per-dyad condition order
(`order[k] = presetIds[k mod presetIds.length]`). **Not currently called anywhere in the shipped
UI** — condition assignment today is manual. See §13.


## 4. Expression detection

`renderer/lib/faceMorph.ts` (computation), `renderer/lib/calibration.ts` (per-person levels),
`main/protocol.ts` (types). Runs on the participant's **real** face — the raw camera frame — never
the morphed output, so a rule like "when P1 smiles" reacts to what actually happened.

### 4.1 Inputs (MediaPipe blendshapes, 0–1)

| Feature | Formula |
|---|---|
| `smile` | mean(`mouthSmileLeft`, `mouthSmileRight`) |
| `frown` | max(mean(`mouthFrownLeft`,`mouthFrownRight`), a pout term from `mouthPucker`/`mouthFunnel`/`mouthShrugLower`) |
| `lipPress` | mean(`mouthPressLeft`, `mouthPressRight`) |
| `openness` | mean(`mouthUpperUpLeft`,`mouthUpperUpRight`) + 0.8·`jawOpen` + 0.8·mean(`mouthLowerDownLeft`,`mouthLowerDownRight`) |
| `asymmetry` | `|smileL − smileR| + |pressL − pressR|` |
| `relAsymmetry` | `asymmetry / max(0.3, max(smileL, smileR))` |
| `eyeConstriction` | mean(`eyeSquintL`,`eyeSquintR`,`cheekSquintL`,`cheekSquintR`) — logged only, not used to classify |

All features are EMA-smoothed (**τ = 80 ms**) before thresholding. 18 raw MediaPipe scores are
smoothed individually and kept: 15 are streamed to `effect_state_<seat>.csv` as `raw_*` columns
(§9.3), and all 18 are recorded per calibration phase (§5). **These are MediaPipe's own
facial-movement scores, not OpenFace/FACS Action Units** — this app doesn't run OpenFace, so they
shouldn't be cited as FACS-coded AU data.

A parallel set of **landmark geometry** features (`computeGeometry`) is smoothed the same way —
`cornerSpreadX`, `cornerLiftY`, `lowerLipDropY`, `mouthOpenRatio`, `mouthWidthToFaceWidth`,
`mouthCornerTilt`, `yawSymmetry`, all normalized by face width so they are invariant to how far the
participant sits from the camera. Blendshape scores say how much of an expression is present;
geometry says how far the mouth actually moved, which is what the morph is measured in.

### 4.2 Per-person levels

With a calibration profile, every decision is made on the participant's own scale:

```
level    = clamp01((current − neutral.mean) / (peak.mean − neutral.mean))
deadZone = clamp(3 × neutral.std / range, 0.08, 0.6)
```

- Fires as soon as `level > deadZone`; releases at `0.6 × deadZone` (small hysteresis, flicker only —
  not a long averaging window).
- `level` clamps at 1.0 if someone exceeds what calibration measured; the overshoot is noted in the
  console so an under-measured calibration is visible rather than silent.
- The smile range comes from the **open-mouth** phase (their true maximum smile signal); the morph
  gain comes from the **closed-lip** one (§3.6).

Without a profile, the old global constants apply instead:

| Parameter | Value | Role |
|---|---|---|
| `smileOn` / `smileOff` | 0.60 / 0.45 | Enter/stay "smiling" (hysteresis) |
| `frownOn` / `frownOff` | 0.03 / 0.01 | Enter/stay "frowning" |
| `rewardOpenness` | 0.20 | Openness above this → reward smile |
| `dominanceRelAsymmetry` | 0.12 | Relative asymmetry above this → dominance smile |
| `minPublishedSubtypeConfidence` | 0.55 | Below this, sub-type is withheld/uncertain |
| `emaTauMs` | 80 ms | Blendshape and geometry smoothing |
| `debounceMs` | 100 ms | Minimum persistence before a label/sub-type is published |
| `talkingDeadZoneMultiplier` | 1.5 | Smile dead zone while speaking |

Smoothing and debounce were 220 ms / 350 ms before calibration existed. They were shortened because
a per-person dead zone removes the reason for the long averaging: it was there to suppress the false
positives a global threshold produced on faces whose resting smile score sits high. Reporting lag
drops from roughly 0.5–0.7 s to ~0.2 s.

### 4.3 Classification logic

1. **Label** (hysteresis): smile and frown are checked **independently** each frame, not smile-first.
   A relaxed face's raw `mouthSmile` can sit high enough that a fixed order would keep a stale
   "smiling" label or block a genuine frown. When both cross their bar, whichever is over it by the
   larger margin wins.
2. **Talking gate**: no new frown label is published while the participant is speaking (§3.6).
3. **Smile sub-type** (only while smiling): normalized `openness ≥ threshold` → **reward**; else
   `relAsymmetry ≥ 0.12` → **dominance**; else → **affiliative**.
4. **Confidence**: label confidence, smile-type confidence, classifier mode/version and a
   `smileTypeTrusted` flag are published alongside the label. A smiling frame with weak sub-type
   evidence is still a basic smile, but its sub-type is withheld and `smileTypeTrusted` is `false`.
5. **Debounce**: a candidate must hold ≥100 ms before being published.

If no face is found, the last expression is held for 1 s, then decays to neutral so rules don't hold
forever.

### 4.4 Framing

Sub-types follow the lab's smile-typology framework (cited in-code as Martin et al. 2021,
*Affective Science*; Rychlowska et al. 2021, *Cognition & Emotion*). The sub-type heuristic itself is
still calibrated against the five example photos in `smile_examples/` — per-participant calibration
fixes the smiling/frowning/neutral boundary, not the three-way sub-type split. Findings that shaped
it:

- `cheekSquint`/`noseSneer` are ~0 on every example (dead features on this model); `eyeSquint` is
  contaminated by blinking/looking down — so the classic Duchenne eye-constriction cue is **not**
  usable as a reward marker with this model (logged, not used);
- reward → mouth opens/teeth show (`mouthUpperUp ≈ 0.65` vs ≈0.005); dominance → asymmetry + lip
  press (rel. ≈0.21); affiliative → strong smile, closed lips, neither of the above.

### 4.5 `ExpressionState`

`main/protocol.ts`: `{ label, smileType, smile, frown, asymmetry, eyeConstriction, lipPress,
openness, faceShape, normalizedSmile, normalizedFrown, normalizedOpenness, smileMargin, frownMargin,
geometricSmileLevel, geometricFrownLevel, talking, labelConfidence, smileTypeConfidence,
smileTypeTrusted, classifierMode, classifierVersion, raw* (15 fields) }`. Streamed to the dashboard
and fed to the rule engine at up to 5 Hz (change-gated); label/sub-type changes are logged as
`expression_changed`. Basic "smiling" rules fire regardless of `smileTypeTrusted`; sub-type rules
require `smileTypeTrusted === true`.

---

## 5. Calibration

`renderer/lib/calibration.ts` (pure maths), `renderer/lib/calibrationRunner.ts` (the guided
sequence), `renderer/components/CalibrationPanel.tsx` (the researcher's review panel).

Calibration is what makes the morph look like a specific person's face instead of a generic one.
Before calibration the morph moved every participant's mouth corners by the same fixed 0.17
mouth-widths per unit α, regardless of whether their real maximum smile moves them 0.09 or 0.26 —
so one looked under-morphed and the other looked like a rubber mask.

### 6.1 The four phases

| Phase | Prompt | Record | Sets |
|---|---|---|---|
| `neutral` | "Relax your face" | 3 s | Baseline mean **and std** for every feature; the dead zone |
| `smileClosed` | "Biggest smile, lips together" | 4 s | **The morph gain** — corner travel and direction |
| `smileOpen` | "Biggest smile, show your teeth" | 4 s | **The detection range**, the openness scale, the open-mouth fade |
| `frown` | "Frown as hard as you can" | 4 s | Frown gain, direction and lower-lip pout |

Each phase gets 1.5 s of prep (prompt on screen and counting down, nothing recorded yet) and 0.65 s
to settle afterwards. ~22 s total. Both smiles are needed: see §3.6 for why, and for the jaw-coupling
they produce between them.

A phase's maximum is the **mean of its top 5 frames** by the relevant score, never a single frame.
The screenshot is the single strongest frame, snapshotted whenever a frame beats the running best —
a handful of small JPEG encodes rather than a buffer of full-resolution frames.

### 6.2 Validation and redo

A phase is flagged `needs-redo` when:

| Flag | Condition |
|---|---|
| `too_close_to_neutral` | `peak.mean − neutral.mean < max(floor, 3 × neutral.std)`; floors 0.06 smile / 0.015 frown |
| `mouth_open_during_closed_smile` | Peak `mouthOpenRatio > 0.12` — would inflate the morph gain |
| `face_not_visible` | Face tracked in < 80% of frames |
| `off_axis_face` | Mean `yawSymmetry < 0.55` |
| `not_relaxed` | Neutral phase with a pressed or open mouth |
| `insufficient_samples` | Fewer than 10 frames, or no peak |

The researcher **redoes a single flagged phase** rather than restarting: the redo is the same
`calibration-start` message carrying one phase, and its result merges into the existing set.

`buildCalibrationProfile()` returns `null` unless all four phases are present — a partial calibration
is worse than none, because the morph would be scaled against a range nobody measured.

### 6.3 Where it is stored

Session folder only. A returning participant is recalibrated from scratch.

```
calibration/<participant_id>/
├── calibration.json
├── neutral.jpg   max_smile_closed.jpg   max_smile_open.jpg   max_frown.jpg
```

`calibration.json` holds, per phase: every blendshape (mean + std), the combined scores, the
landmark geometry, the top-5 peak, the quality flags — plus a `derived` block with the numbers the
runtime actually uses (`cornerTravel`, `cornerAngleRad`, `range`, `deadZone`, `poutDrop`,
`jawCoupling`, `openScaleRange`, `talking.openRatioStdNeutral`). `parseCalibrationFile()` reloads it.

In the three-seat call the participant measures, the researcher's machine writes
(`SessionLogger.writeCalibration`). In the 1-person station the same files are written locally via
the `session:write-calibration` IPC, into a session folder now created up front rather than at save
time.

### 6.4 Matching participants to their calibration

Calibration describes one specific face; applying it to another would silently mis-scale that
person's morph. So:

- Each profile is stamped with the `participantId` and `dyadId` from that seat's `Identity` at
  capture time.
- `calibration-profile` is sent only to that seat's socket.
- `main/server.ts` already restores a seat by `participantId` on reconnect. `restoreCalibration()`
  re-sends the stored profile **only if** the reconnecting participant's ID matches; otherwise it
  drops the profile, tells the dashboard, and logs `calibration_cleared` with
  `reason=different_participant`.

### 6.5 Flow

```
admin.tsx  --calibration-start {target, phases}-->  server  -->  session.tsx
                                                                      |
                                                            calibrationRunner.ts
                                                            (prompt, countdown,
                                                             record, peak, shot)
                                                                      |
admin.tsx  <--calibration-phase {summary, jpeg}--  server  <----------+   (one per phase)
     |
  review panel: thumbnails + numbers, accept or redo one phase
     |
     +--calibration-apply {profile}-->  server  --calibration-profile-->  session.tsx
                                          |                                    |
                                    writes to disk                  FaceMorphProcessor
```

Screenshots cross the wire as base64 JPEG data URLs (~480 px wide, q0.7, ≈40 KB each; four per
participant) and are stripped before anything is written to `events.csv`.

The 1-person station runs the same `calibrationRunner` and the same review panel directly against
its own `CaptureStation`, with no server in between.


## 6. Automation rules

`main/rules.ts` (engine, runs on the server), `renderer/pages/admin.tsx:1166–1477` (builder UI), `main/protocol.ts:84–120` (types). Rules are authored on the dashboard, stored and executed server-side, and editable at any time including mid-call. Every firing is logged like a manual command.

### 6.1 Structure

```
{ id, enabled,
  trigger: { kind:'expression', slot:'P1'|'P2', expression, holdSec }
         | { kind:'timer', atSec },
  action:  { slot:'P1'|'P2', presetId },
  release: 'previous' | 'neutral' | 'none',      # expression rules only
  revertAfterSec: number | null }                # timer rules only
```

Trigger expressions: `smiling` (any type), `reward-smile`, `affiliative-smile`, `dominance-smile`, `frowning`.

### 6.2 Semantics

- **Expression rule** — while the watched participant holds the expression for `holdSec`, apply the preset to the target. When it stops: `previous` restores pre-rule state, `neutral` resets, `none` leaves it applied.
- **Timer rule** — at `atSec` into the live conversation, apply once; if `revertAfterSec` is set, restore after that many seconds.
- **Timing scope**: expression rules run in the waiting room **and** live; timer rules count only from when the conversation goes live. Ending the session or returning to the waiting room releases anything a rule left applied.
- Deleting/disabling a fired rule releases it first, so a removed rule can't leave a participant stuck mid-morph.
- Evaluation cadence: server ticks the engine every 250 ms (4 Hz).

### 6.3 Builder UI

Plain-language rows, e.g. `WHEN [P1] [is smiling] for [1] s THEN [P2] gets [Smile (subtle)] · when it stops: [back to how they were]`. Edits are debounced 400 ms; server echoes are ignored for 1.5 s while typing to avoid clobbering an in-progress edit. A "+ template: mirror smiles" button adds two reciprocal rules (each participant's genuine smile subtly lifts the partner's).

---

## 7. Networking

### 7.1 Wire protocol

`main/protocol.ts`. JSON over one WebSocket per client. `PROTOCOL_VERSION = 1`, `DEFAULT_PORT = 8771`. DOM-type-free so the Electron main process can import it directly.

- **Client → Server**: `hello`, `signal`, `ready`, `telemetry`, `expression`, `stream-map`, `client-event`; admin-only: `set-identity`, `set-effect`, `apply-preset`, `banner`, `set-phase`, `admin-mic`, `set-rules`.
- **Server → Client**: `welcome`, `roster`, `signal`, `effect-command`, `identity-assigned`, `banner`, `phase`, `peer-left`, `telemetry`, `expression`, `stream-map`, `log-row`, `rules`, `rule-status`, `rejected`.

Admin-only commands from a participant are rejected and logged as `blocked_action`.

### 7.2 Coordination server (`main/server.ts`)

Binds `0.0.0.0:8771`. Assigns seats: admin → ADMIN; participants → the seat their `participantId` last held (reconnect), else P1, then P2, else reject ("The call is full."). Identities and effects survive a reconnect. Heartbeat pings every 5 s; a missed pong terminates the client (`connection_lost`). Relays signaling, routes effect commands, owns the phase, and logs every event via `SessionLogger`.

### 7.3 WebRTC peer links (`renderer/lib/rtc.ts`)

One `PeerLink` per pair of seats, using "perfect negotiation" (polite/impolite) so either side can add tracks freely and glare resolves itself. Politeness: P2 yields to P1; the admin is always polite. Single STUN server (`stun:stun.l.google.com:19302`); **no TURN server** — media is expected to flow directly over the lab LAN. A failed connection drops the link and finalizes that seat's recorders so a reconnect starts fresh `_part` files.

### 7.4 Signaling client (`renderer/lib/signaling.ts`)

Resilient WebSocket, retries every 2 s, replays `hello` to recover the same seat. `normalizeServerUrl` turns whatever the RA types into a valid `ws://host:port` URL, defaulting to port 8771.

### 7.5 Stream identification

Each participant sends a `stream-map` telling the admin which stream id is altered vs clean, so the dashboard labels the two monitors correctly.

---

## 8. Session lifecycle

`Phase = 'waiting' | 'live' | 'ended'`. The admin drives transitions via `set-phase`; the server broadcasts to everyone.

- **waiting → live**: stamps a fresh `sessionStartedAt`; timer rules re-arm.
- **live → ended**: participants see the ended screen; recorders finalize; manifest written ~1.5 s later; rules release.
- **→ waiting**: clears the clock; rules release; expression state resets.
- Sessions are restartable: `ended → live` starts a fresh clock and continues recordings as `_partN` files; `ended/live → waiting` returns participants to the waiting room.

**Start gating**: enabled once both participants are connected. If both are also ready (`camera && voice`, server-side), it starts immediately; otherwise it asks for confirmation. The face model is reported but doesn't block start — video simply passes through unmorphed if it failed to load.

---

## 9. Data outputs & logging

`main/logger.ts` (CSV + manifest), `main/main.ts` (streamed recordings), `renderer/lib/recording.ts` (format selection).

### 9.1 Session folder layout

Default root `Documents/NiedenthalLab/video-call-sessions` (selectable via folder picker):

```
session_<YYYY-MM-DDTHH-MM-SS>/
├── README.txt               # plain-English column/convention reference
├── events.csv               # every discrete event
├── effect_state_P1.csv      # 1 Hz applied-state telemetry for P1 (ground truth)
├── effect_state_P2.csv      # 1 Hz applied-state telemetry for P2 (ground truth)
├── recordings.csv           # one row per saved recording, with start/stop times
├── session.json             # manifest (written on End)
├── calibration/             # one folder per calibrated participant (§5.3)
│   └── <participant_id>/
│       ├── calibration.json
│       └── neutral.jpg  max_smile_closed.jpg  max_smile_open.jpg  max_frown.jpg
└── recordings/
    ├── P1_<pid>_clean.mp4      P1_<pid>_altered.mp4
    ├── P2_<pid>_clean.mp4      P2_<pid>_altered.mp4
    └── researcher_mic.mp4      (…_part2, _part3 on restart/reconnect)
```

CSVs use append write-streams so rows hit disk as they happen; recording chunks flush every 1 s. A crash mid-session loses at most the OS buffer. `README.txt` (`main/logger.ts`, `README_CONTENT`) is written once per session so the column/convention reference travels with the actual data, not just with this doc.

Every CSV follows the same conventions:
- Column headers are plain English (e.g. `time`, not `ts_iso`), grouped left to right as **who/when → what happened → data-quality detail**, so the files are readable without a data dictionary.
- `date`/`time` (and `started_date`/`started_time`/`stopped_date`/`stopped_time`) are your computer's own local clock, split into two columns, written like `Aug 18, 2026` and `3:46:51.175 PM` — not UTC, not ISO 8601.
- `elapsed_ms` (and `elapsed_start_ms`/`elapsed_stop_ms`) is milliseconds since the session began, on the same clock across every file in the session, so a row in one file can be matched to a moment in another (or inside a recording) by comparing these numbers directly.
- `effect_state_<seat>.csv` also has `conversation_elapsed_ms`: milliseconds since the researcher started the *live conversation* specifically (blank while still in the waiting room), anchored to the same `sessionStartedAt` moment used to start recordings — so this number doubles as the row's approximate timestamp inside the recorded video, with no subtraction needed.

### 9.2 `events.csv`

Header: `seat, name, role, date, time, elapsed_ms, event, target, parameter, value, details` (`details` is CSV-escaped JSON).

Event names are plain English on purpose — this column is read by researchers, not just developers.

| Category | Events |
|---|---|
| App | `app_started`, `app_stopped` |
| Connection | `person_joined`, `join_blocked`, `person_left`, `connection_lost`, `camera_mic_ready`, `blocked_action` |
| Session phase | `moved_to_waiting_room`, `conversation_started`, `conversation_ended` |
| Modification | `setting_changed`, `preset_used`, `name_or_id_entered` |
| Automation | `rules_changed`, `rule_turned_on`, `rule_turned_off`, `rule_undone` |
| Expression | `expression_changed` (on label/sub-type change only) |
| Calibration | `calibration_started`, `calibration_step_completed`, `calibration_retake_recommended`, `calibration_finished`, `calibration_applied`, `calibration_cleared`, `calibration_rejected`, `calibration_profile_received`, `calibration_profile_cleared` |
| Researcher | `message_sent`, `researcher_mic_on`, `researcher_mic_off` |
| Recording | `recording_started`, `recording_stopped` |
| Participant client-events | `video_connection_lost`, `video_connection_restored`, `switched_away_from_call`, `switched_back_to_call`, `exit_attempt_started`, `exit_attempt_cancelled`, `exit_attempt_confirmed`, `exit_attempt_wrong_code`, `message_shown`, `change_shown`, `camera_video_problem`, `practice_mode_on`, `practice_face_changed` |

`video_connection_lost`/`video_connection_restored` are the only two states logged out of WebRTC's full connection-state machinery (new/connecting/connected/disconnected/failed/closed) — routine call setup and teardown isn't written, only an actual drop and its recovery.

Three earlier events were removed as pure internal bookkeeping with no research value: `stream_map` (matching up which video stream is the altered one — still happens, just isn't logged), `detector_info` (which expression-detection build was used — now written once into `session.json`'s `detection` field instead, see §9.4), and `recording_duration_patch_failed` (an internal repair-attempt failure — now only a developer-console warning).

A per-row sequence number is still sent to the live dashboard feed (for React list keys) but isn't written to the CSV — file order already reflects it.

### 9.3 `effect_state_P1.csv` / `effect_state_P2.csv`

One file per participant seat instead of one shared file, so each person's data stands alone and never needs to be filtered out of a mixed file.

Header: `pair_id, participant_id, partner_id, seat, date, time, elapsed_ms, conversation_elapsed_ms, phase, self_face_change, self_voice_change, partner_face_change, partner_voice_change, expression, smile_type, expression_confidence, smile_type_confidence, smile_type_trusted, normalized_smile, normalized_frown, normalized_openness, smile_margin, frown_margin, normalization_applied, normalization_version, calibrated, commanded_alpha, applied_alpha, live_level, headroom, talking, raw_mouth_smile_left, raw_mouth_smile_right, raw_mouth_frown_left, raw_mouth_frown_right, raw_lip_press_left, raw_lip_press_right, raw_upper_lip_raise_left, raw_upper_lip_raise_right, raw_jaw_open, raw_lower_lip_drop_left, raw_lower_lip_drop_right, raw_eye_squint_left, raw_eye_squint_right, raw_cheek_squint_left, raw_cheek_squint_right, face_detected, camera_on, frames_per_second`.

Written once per second from each participant's own telemetry — the authoritative record of what was actually applied and shown, independent of what was commanded. `self_face_change`/`self_voice_change` are this person's own applied morph (this is the old `alpha`/`voice_semitones`, renamed). `partner_face_change`/`partner_voice_change` are the *other* seat's applied morph at that same moment (pulled from the partner's last known telemetry — blank if the partner isn't connected yet), so a single row lets you compare self vs. partner without joining files. `pair_id` and `partner_id` come from `Identity.dyadId` and the other seat's `participantId`.

`commanded_alpha` is what the researcher asked for; **`applied_alpha` is what actually landed on the
face, and it is the number to analyse.** They differ because the cap is on the total (§3.3):
`live_level` is how far the participant's own face was toward their calibrated maximum at that
moment, `headroom` is what was left for the morph, and `applied_alpha` is additionally reduced by the
head-yaw and open-mouth fades. `calibrated` says whether this participant had been calibrated by that
point; when false the morph used the old fixed geometry for everybody.

`talking` is true while the participant was speaking. No frown label is published during speech
(§3.6), so a blank `expression` mid-sentence is expected behaviour rather than a detection dropout.

These replace the previous `calibration_state`, `calibration_detection_confidence`,
`calibration_morph_confidence`, `mouth_proportion_scale`, `smile_expressiveness_scale`,
`frown_expressiveness_scale` and `active_morph_scale` columns, which described the old ±15%
confidence-scaling scheme that calibration replaced.

`smile_type_trusted` replaces the old `uncertain` column (renamed *and* inverted — `true` now means "trust this reading," removing the double-negative); it's blank whenever the person isn't smiling, since it has nothing to describe in that case.

`raw_mouth_smile_left` through `raw_cheek_squint_right` are the 15 individual MediaPipe facial-movement scores behind the `expression`/`smile_type` label — see §4.1 for exactly which formula uses which raw score, and why they aren't OpenFace/FACS Action Units.

`detection_mode`/`detection_version` are **not** columns here — they never change during a session, so repeating them on every row was pure clutter. They're captured once per seat instead and written into `session.json`'s `detection` field (see §9.4).

### 9.3b `recordings.csv`

One row per saved recording (each participant's clean track, altered track, and the researcher mic), written once the recording stops — so if the app crashes mid-recording, that row is missing here but the start is still in `events.csv`.

Header: `seat, participant_id, type, started_date, started_time, stopped_date, stopped_time, elapsed_start_ms, elapsed_stop_ms, duration_sec, file_path, file_size_mb`. `type` is `clean`, `altered`, or `mic`. `recording_name` isn't a separate column — `seat` + `participant_id` + `type` already identify the recording, and `file_path` gives the actual filename.

### 9.4 Manifests

- **Three-seat call** (written on End): `{ schemaVersion:2, app:'Niedenthal Lab Video Call', appVersion:'3.0.0', writtenAt, sessionStartedAt, raName, participants:[{slot, identity}], recordings:[{label, bytes}], eventCount, detection:{P1:{classifierMode, classifierVersion}, P2:{...}} }` → `session.json`. `detection` is added automatically by `SessionLogger.writeManifest` from whatever each seat's telemetry reported first, so callers don't need to supply it.
- **1-Person Test Station** (`renderer/lib/capture.ts`): `{ schemaVersion:1, app:'DuckSoup Experimenter Platform', appVersion:'2.0.0', ... }` — a simplified manifest for quick self-testing (no study/dyad/participant IDs), not the PPS questionnaire pipeline's real intake format; see §13.

### 9.5 Recording format

`renderer/lib/recording.ts`. MP4 preferred (opens everywhere the lab works); candidates in order `video/mp4;codecs=avc1.640028,mp4a.40.2` → `avc1.42E01E,mp4a.40.2` → `video/mp4` → `video/webm;codecs=vp9,opus` → `video/webm`. Falls back to WebM if none of the MP4 variants are supported. Fragmented MP4 stays playable even if the app crashes mid-recording; chunks cut every 1 s.

---

## 10. Test mode

Access code `test` (`index.tsx:39`, `session.tsx:42–49, 275–301`). Runs the pipeline on a bundled example face image (letterboxed onto a 720p canvas, redrawn every 66 ms → ~15 fps, `captureStream(15)`) plus a silent oscillator audio track, so morph/detection/ready-gate/WebRTC all behave as with a real camera. A panel switches live among five faces (Straight, Reward smile, Affiliative smile, Dominance smile, Frown) under `renderer/public/images/test-faces/`. Every use is logged (`practice_mode_on`, `practice_face_changed`) with an on-screen "TEST MODE" indicator, so a real session can never quietly run on an example face.

---

## 11. Packaging & kiosk lockdown

### 11.1 Build & distribution

- `electron-builder.yml`: appId `edu.wisc.niedenthal.labvideocall`, product name "Lab Video Call". Windows: NSIS installer. macOS: universal (Intel + Apple Silicon) DMG + ZIP.
- macOS CI (`.github/workflows/build-mac.yml`) builds on every push/PR to `main`, on a GitHub `macos-latest` runner (no Mac needed locally), and uploads the DMG/ZIP as a 30-day workflow artifact — useful for testing a branch, but requires a GitHub login with repo access and expires.
- Note: local builds (`npm run build:mac`) are only signed with the same stable certificate if `CSC_LINK`/`CSC_KEY_PASSWORD` are also set in your local shell environment; otherwise electron-builder falls back to ad-hoc signing and the repeated-prompt issue can reappear for locally built copies.
- **Releases** (`.github/workflows/release.yml`): every push to `main` auto-bumps the patch version (§11.5), builds both Windows (NSIS `.exe`) and macOS (`.dmg`/`.zip`), and publishes them to a single GitHub Release tagged `latest` — a permanent, public-facing download page, no repo access or expiry involved. Each push overwrites the previous download with the new build, so `main` should only be updated when the app is in a shareable state.
- Windows builds are unsigned (no code-signing certificate) — testers may see a SmartScreen warning ("More info" → "Run anyway"). macOS builds are signed with a free Apple ID personal-team certificate (`CSC_LINK`/`CSC_KEY_PASSWORD` secrets in `build-mac.yml`/`release.yml`), but not notarized — testers must still right-click → Open on first launch.
- Camera/mic Info.plist strings and entitlements (`resources/entitlements.mac.plist`) work with this signed build. Permission grants are tied to the code signature, and a personal-team certificate keeps that signature stable across rebuilds, so a fresh install/rebuild should no longer re-prompt for camera/mic access. The certificate needs renewing roughly once a year. A paid Apple Developer ID would still be the more permanent fix, and would also enable true silent auto-update (see §11.5 and known limitation #7).

### 11.2 Kiosk lockdown (participant machines)

`main/main.ts:149–216`. On participant sign-in the window becomes a locked kiosk: `setKiosk(true)`, `setAlwaysOnTop(true, 'screen-saver')`, `setClosable(false)`, min size 800×600, `powerSaveBlocker` keeps the display awake. Blocked: `F5/F11/F12`, reload/close/new-window/zoom combos, devtools combos in production.

The only exit is **Ctrl/Cmd+Shift+Q → type "Confirm"**, handled in three places (global shortcut, per-window `before-input-event`, renderer `keydown`) because an Electron global shortcut can only be claimed by one process per machine, which made the combo unreliable with multiple windows open on one laptop for testing.

The researcher window is a normal window; closing it mid-live prompts a confirmation (it shuts the server down for everyone).

### 11.3 Permissions & autoplay

`autoplay-policy=no-user-gesture-required` (so the researcher's audio can start without a participant click). On macOS the app proactively requests camera/mic access up front.

### 11.4 Dev vs. production

Dev: `npm run dev` (Nextron) runs Next.js on port 8888 + Electron; `startupDelay:30000` gives the renderer time to bind. `npm run server:dev` runs the standalone WebSocket server (`main/server-standalone.ts`) so the full three-client flow can be tested in three browser tabs without Electron (CSVs land in `scratchpad/dev-sessions/`). Production serves the statically-exported Next.js app from `app://` via `electron-serve`.

### 11.5 Update checker

`main/main.ts` (`app:check-update`, `app:open-external` IPC handlers), surfaced on the sign-in screen (`renderer/pages/index.tsx`) — the first thing anyone sees, before choosing a role — not on the dashboard. Not a real auto-updater — see known limitation #7.

- **Versioning**: `scripts/bump-version.mjs` bumps `package.json`'s patch version and mirrors it into `APP_VERSION` (`main/protocol.ts`). `.github/workflows/release.yml` runs this on every push to `main`, before building, and pushes the bump back (commit message `chore: bump version [skip ci]` — the `[skip ci]` stops that push from re-triggering the same workflow). This is what makes each release a distinct, comparable version instead of every build claiming to be the same number.
- On sign-in page load, the main process calls the GitHub Releases API for this repo's `latest` release, finds the `.dmg` asset, and pulls a version number out of its filename (`Lab-Video-Call-<version>-<arch>.dmg`).
- If that version is newer than `APP_VERSION` (`main/protocol.ts`), an amber "Update available" banner appears above the sign-in card; clicking it opens the `.dmg` download URL in the default browser (`shell.openExternal`, restricted to `https://` URLs).
- Installing it is still the same manual step as today: open the downloaded `.dmg`, right-click the app → Open.
- Fails silently (no banner, nothing logged) if offline, rate-limited, or the release has no matching asset — this is a convenience, not something a session depends on.

---

## 12. Constants reference

### Morph & timing

Corner travel and direction are **per participant** (§3.3). The values below are the uncalibrated
fallbacks, which reproduce the pre-calibration geometry exactly.

| Constant | Value |
|---|---|
| Fallback smile travel / angle | 0.17 mouth-widths / 25° above horizontal |
| Fallback frown travel / angle | 0.134 mouth-widths / −104° (0.25 inward, 1.0 down × 0.13) |
| Fallback frown pout | 0.065 mouth-widths |
| Calibrated travel clamp | 0.04 … 0.35 mouth-widths |
| Calibrated angle clamp | 10° … 45° (mirrored for a frown) |
| Open-mouth fade | ×0.4 floor at a fully open mouth |
| Alpha tween τ | 350 ms |
| Warp skip threshold | `|α| < 0.02` |
| Tween snap threshold | `|α−α_target| < 0.004` |
| Yaw full/off symmetry | 0.65 / 0.35 |
| Mesh resolution | 12 × 8 (117 nodes / 192 triangles) |
| Vertical falloff σ | 0.6 × mouth width |
| ROI padding | 0.55×W (x), 0.7×W (y) |

### Voice

| Constant | Value |
|---|---|
| `DELAY_TIME` | 0.1 s |
| `FADE_TIME` | 0.05 s |
| `BUFFER_TIME` | 0.1 s |
| Octave clamp | `n/12 ∈ [−1, 1]` |
| Delay smoothing τ | 0.01 s |
| Admin slider range/step | −12…+12 st / 1 |
| Legacy slider range/step | −8…+8 st / 1 |

### Detection

Smile and frown bars are **per participant** once calibrated (§4.2). The on/off values below are the
uncalibrated fallbacks.

| Constant | Value |
|---|---|
| Fallback smileOn / smileOff | 0.60 / 0.45 |
| Fallback frownOn / frownOff | 0.03 / 0.01 |
| Calibrated dead zone | `3σ of neutral ÷ range`, clamped 0.08 … 0.6 |
| Dead-zone release | ×0.6 of the on-bar |
| Talking smile dead zone | ×1.5 |
| rewardOpenness | 0.20 |
| dominanceRelAsymmetry | 0.12 |
| EMA τ | 80 ms |
| debounce | 100 ms |

### Calibration

| Constant | Value |
|---|---|
| Phases | neutral, smileClosed, smileOpen, frown |
| Prep / settle per phase | 1500 ms / 650 ms |
| Record: neutral | 3000 ms |
| Record: each expression | 4000 ms |
| Sample interval | 33 ms (~30 Hz) |
| Peak = mean of top | 5 frames |
| Redo threshold | peak − neutral < max(floor, 3σ); floors 0.06 smile / 0.015 frown |
| Max closed-smile mouth-open ratio | 0.12 |
| Min yaw symmetry | 0.55 |
| Min face-visible ratio | 0.80 |
| Jaw coupling clamp | 0 … 1.5 |
| Screenshot | ~480 px wide JPEG, quality 0.7 |
| Talking window / release | 600 ms / 400 ms |
| Talking mouth-wobble threshold | 3 × neutral mouth-open σ |
| Talking mic RMS threshold | 0.02 |

### Cadences & networking

| Item | Value |
|---|---|
| Default port | 8771 |
| Render loop | requestAnimationFrame (~60 Hz), dt capped 100 ms |
| Telemetry send | 1 Hz |
| Expression check/send | 5 Hz, change-gated |
| Rule engine tick | 4 Hz |
| Heartbeat ping | 5 s |
| Reconnect retry | 2 s |
| Recording chunk | 1 s |
| Effect slider throttle | 90 ms (forced commit on release) |
| Rule send debounce | 400 ms |
| Edit-echo ignore window | 1.5 s |
| Canvas captureStream | 30 fps (test mode 15 fps) |
| Camera request | 1280×720 |
| Banner default/range | 8 s / 1–120 s |
| STUN | stun.l.google.com:19302 (no TURN) |

### UI control ranges

| Control | Range | Step | Neutral |
|---|---|---|---|
| Smile α (dashboard) | −1…1 | 0.05 | 0 |
| Voice pitch (dashboard) | −12…+12 st | 1 | 0 |
| Smile α (1-Person Test Station) | −1…1 | 0.05 | 0 |
| Rule hold time | 0…30 s | 0.5 | — |
| Timer minute/second | 0–180 / 0–59 | 1 | — |
| Monitor volume | 0…1 | 0.05 | 0 (muted) |

---

## 13. Known limitations

Things to know before citing or relying on this software in a study.

1. **Preset intensities are pilot settings.** α is now a fraction of each participant's own calibrated maximum, and the preset values were rescaled to that meaning to keep the visible effect near where the old fixed geometry put it (§3.8). That rescaling was a judgement call, not a measurement. No psychophysical validation (detection threshold, naturalness, believability) has been run — describe presets as pilot settings, not validated intensities, and revisit the numbers once real per-participant corner-travel data exists.
2. **The smile sub-type classifier is a heuristic tuned to five still images**, not validated against FACS-coded or human-rated video. The Duchenne eye-constriction cue is deliberately unused (unreliable on webcams with this model). Treat sub-type as exploratory unless independently validated.
3. **The morph is a 2-D planar mesh warp, not a 3-D face model.** It moves mouth-corner geometry and a lower-lip pout only — no Duchenne eye/cheek changes, teeth, or lighting consistent with a real smile. It fades out on head turn and does nothing when no face is detected, so brief head turns or tracking dropouts show the unmodified partner. Check `face_detected` in `effect_state_P1.csv`/`effect_state_P2.csv` for affected frames.
4. **Detection latency**: ~5 Hz sampling, 80 ms EMA smoothing, 100 ms debounce — expression onset is reported with roughly ~0.2 s latency (down from ~0.5–0.7 s before calibration allowed the longer windows to be shortened). Interpret rule "hold" durations accordingly.
5. **Effect ease-in**: a commanded change reaches ~95% of target in ~1.05 s (τ = 350 ms) — not instantaneous. `effect_state_P1.csv`/`effect_state_P2.csv` record the true per-second trajectory.
6. **Condition counterbalancing isn't automated.** `counterbalanceConditions()` exists and is deterministic but isn't called from the UI — condition assignment is currently manual (RA's procedure). Document how it was done for the study; consider wiring the helper in for the main study.
7. **There is no silent auto-update on macOS.** `electron-updater`'s Mac update mechanism (Squirrel.Mac) requires a real Apple Developer ID signature to verify updates come from the same publisher, which this app doesn't have. Instead, the sign-in screen checks GitHub Releases for a newer version and links the RA to the new installer (§11.5); installing it is still a manual right-click → Open, same as today.
8. **The 1-Person Test Station is a testing tool, not for study data collection.** `renderer/pages/dashboard.tsx`/`renderer/lib/capture.ts` share the same `0 = neutral` alpha convention as the three-seat call app — there is no alpha-convention mismatch to adjust for. It runs the same calibration sequence, the same maths and the same review panel as the three-seat app, but it has no participant intake, so its calibration folder is always named `self-test`. Its `SessionManifest` is a simplified shape (no study/dyad/participant IDs) meant for quick self-testing, not the PPS questionnaire pipeline's real intake format.

9. **The researcher can no longer over-drive a participant past their own maximum.** α is clamped to ±1 and the total cap subtracts whatever the participant's real face is already doing, so a preset delivers less than its nominal value whenever they are already expressing. This is deliberate (it is what keeps the morph looking like their face), but it means the commanded value is not the manipulation — always analyse `applied_alpha` from `effect_state_<seat>.csv`, not the preset's α or `commanded_alpha`.

10. **Calibration is not reused across sessions.** It is written into the session folder only, so a participant who returns for a second session is calibrated again from scratch. Their two sessions may therefore be scaled against slightly different measurements.

11. **The frown reading is suppressed during speech.** Ordinary talking produces the pucker/funnel mouth shapes the frown reading keys on, so frowns are not published while the microphone and mouth movement both say the participant is speaking (§3.6). Genuine frowns made *while talking* will be missed. `talking` is logged per second so affected stretches can be identified.

12. **The camera-free replay test runs on a synthetic fixture.** `tests/fixtures/calibration_frames.json` is generated by `tests/make_calibration_fixture.ts`, not recorded from a real face — it exercises the maths, not MediaPipe's behaviour on real footage. Replace it with a real `FaceMorphProcessor.sample()` dump when one is available; the test reads the file and needs no changes.

---

## 14. File index

### `main/` — Electron main process + server

| File | Role |
|---|---|
| `main.ts` | App entry; kiosk lockdown; permissions; server start/stop IPC; streamed-recording IPC; folder picker; 1-Person Test Station IPC; update check (§11.5). |
| `server.ts` | `SessionServer`: seats, signaling relay, effect + calibration routing, phase, rule engine host, logging, LAN IP discovery. |
| `rules.ts` | `RuleEngine`: expression/timer triggers, holds, reverts, release modes. |
| `presets.ts` | Modification conditions, `getPreset`, `counterbalanceConditions`. |
| `protocol.ts` | Wire protocol, message types, `EffectState`, `ExpressionState`, `AutomationRule`, `Telemetry`, versions, port. |
| `logger.ts` | `SessionLogger`: `events.csv`, `effect_state_<seat>.csv`, `recordings.csv`, `session.json`, `calibration/<pid>/`, recording paths. |
| `preload.ts` | Context-bridge IPC (`window.ipc.invoke/on/send`). |
| `server-standalone.ts` | Browser-dev standalone server entry (`npm run server:dev`). |
| `helpers/create-window.ts` | Window creation + persisted window state. |

### `renderer/lib/` — transformation & networking

| File | Role |
|---|---|
| `faceMorph.ts` | `FaceMorphProcessor`: MediaPipe detection, landmark geometry, calibrated mesh warp + total cap, expression classifier, calibration frame sampling and screenshots. |
| `calibration.ts` | Pure calibration maths: phase summaries, peak selection, validation, profile building/reloading, per-person levels, the morph cap, `TalkingDetector`. |
| `calibrationRunner.ts` | The guided four-phase sequence (prompts, countdown, recording, peak screenshot), shared by both modes. |
| `voice.ts` | `VoiceProcessor`: Web Audio delay-line pitch shifter, plus `micLevel()` for the talking detector. |
| `effects.ts` | `LiveEffects`: participant outgoing pipeline (clean + altered streams); test-face stream. |
| `capture.ts` | `CaptureStation`: single-machine, single-person capture+record engine; runs the shared calibration sequence on request (1-Person Test Station). |
| `rtc.ts` | `PeerLink`: one WebRTC connection, perfect negotiation. |
| `signaling.ts` | `SignalClient`: resilient WebSocket + `normalizeServerUrl`. |
| `recording.ts` | MP4/WebM recorder-format selection. |
| `types.ts` | Legacy capture types + `SessionManifest` (v1). |
| `protocol.ts` / `presets.ts` | Renderer re-exports of the shared `main/` modules. |
| `ipcUtil.ts` | Typed IPC wrappers that no-op outside Electron. |

### `renderer/components/` — shared UI

| File | Role |
|---|---|
| `CalibrationPanel.tsx` | The calibration strip under a participant's video: four phase thumbnails with their numbers (or "Not calibrated"), quality flags, live cap readout, run/redo/accept. Used by both modes. |

### `renderer/pages/` — UI

| File | Role |
|---|---|
| `admin.tsx` | Researcher dashboard (panels, sliders, presets, rules, banners, mic, recordings, event log). |
| `session.tsx` | Participant kiosk view (waiting/live/ended, PiP, banner, escape hatch, test-face panel). |
| `dashboard.tsx` | 1-Person Test Station: single-machine capture UI, calibration panel, alpha slider. |
| `index.tsx` | Sign-in / role selection; update-checker banner (§11.5). |
| `_app.tsx` | Next.js app shell. |

### Assets & config

`renderer/public/mediapipe/` (vendored FaceLandmarker model + WASM); `renderer/public/images/test-faces/` (5 test faces); `smile_examples/` (5 calibration photos); `renderer/public/ducksoup.js` (vendored, unused); `resources/` (icons, mac entitlements); `electron-builder.yml`, `nextron.config.ts`, `renderer/next.config.ts`, `tsconfig*.json`, `.github/workflows/build-mac.yml`, `.github/workflows/release.yml`, `scripts/bump-version.mjs` (version auto-bump, §11.5).

### `tests/`

`npm test` runs the four TypeScript contract suites; the Playwright suite is run by hand.

| File | Role |
|---|---|
| `calibration_contract_test.ts` | Phase summaries, peak selection, validation flags, derived ranges and corner travel, profile reload. |
| `morph_contract_test.ts` | Per-person gain, the total cap, jaw compensation, the open-mouth fade, the uncalibrated fallbacks, `TalkingDetector`. |
| `expression_contract_test.ts` | `RuleEngine` behaviour against expression states. |
| `calibration_replay_test.ts` | Camera-free end-to-end replay of a frame timeline through calibration, detection and the cap. |
| `make_calibration_fixture.ts` | Regenerates `fixtures/calibration_frames.json` (`npm run test:fixture`). |
| `e2e_test.py` | Playwright three-seat run. Set `CALIBRATION_Y4M` to a recorded face clip to exercise calibration without a camera. |
