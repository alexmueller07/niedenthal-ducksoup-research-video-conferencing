# Technical reference

Architecture and implementation details for the Lab Video Call app. For a plain-language walkthrough of running a session, see the [researcher guide](for-non-technical-users.md).

App version documented: `3.0.0` (`APP_VERSION` in `main/protocol.ts`).

## Contents

1. [Architecture](#1-architecture)
2. [Sign-in and roles](#2-sign-in-and-roles)
3. [The transformation pipeline](#3-the-transformation-pipeline)
4. [Expression detection](#4-expression-detection)
5. [Automation rules](#5-automation-rules)
6. [Networking](#6-networking)
7. [Session lifecycle](#7-session-lifecycle)
8. [Data outputs & logging](#8-data-outputs--logging)
9. [Test mode](#9-test-mode)
10. [Packaging & kiosk lockdown](#10-packaging--kiosk-lockdown)
11. [Constants reference](#11-constants-reference)
12. [Known limitations](#12-known-limitations)
13. [File index](#13-file-index)

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

- **α = 1.0** → neutral.
- **α > 1** → more smiling (corners out and up).
- **α < 1** → toward a frown (corners down and slightly in, plus a lower-lip pout).

Everything scales with **mouth width W** (distance between landmarks 61 and 291), so the effect is invariant to face distance from camera.

#### Tuning constants (`faceMorph.ts:55–64`)

| Constant | Value | Meaning |
|---|---|---|
| `SMILE_ANGLE_RAD` | 25° | Corner travel direction for a smile (mostly outward, some up) |
| `SMILE_GAIN` | 0.17 | Corner travel per unit `(α−1)`, in mouth-widths |
| `FROWN_GAIN` | 0.13 | Corner-down travel per unit `(1−α)`, in mouth-widths |
| `FROWN_INWARD` | 0.25 | Fraction of frown travel applied inward |
| `FROWN_POUT` | 0.5 | Lower-lip-centre drop relative to corner drop |
| `ALPHA_TWEEN_TAU_MS` | 350 ms | Time constant of the smoothing tween |
| `YAW_FADE_START` / `YAW_FADE_END` | 0.65 / 0.35 | Face symmetry range over which the morph fades with head turn |
| mesh `cols × rows` | 12 × 8 | 117 nodes, 192 triangles |

Other geometric constants: `sigmaY = 0.6·W` (vertical falloff), `poutY = centerY + 0.22·W`, `poutSigma = 0.35·W`, ROI padding `padX = 0.55·W`, `padY = 0.7·W`.

#### Displacement field

Let `s = (α_current − 1) · yawScale`, `mag = |s| · W`. For a mesh node at `(sx, sy)` with normalized ROI coords `(u, v)`:

- `xn = (sx − centerX) / (W/2)` — horizontal position, ±1 at a corner
- `vy = exp(−(sy − centerY)² / (2·sigmaY²))` — vertical falloff about the mouth line
- `win = sin(π·u) · sin(π·v)` — edge window (0 at ROI border, for a seamless blend)
- `cornerW = min(1.6, xn²) · vy · win` — corner weight

**Smile (s > 0):**
```
d  = mag · SMILE_GAIN · cornerW
dx = sign(xn) · cos(25°) · d     (outward)
dy = −sin(25°) · d               (upward)
```

**Frown (s < 0):**
```
d       = mag · FROWN_GAIN · cornerW
dx      = −sign(xn) · FROWN_INWARD · d
dy      = d                       (down)
# plus a lower-lip pout:
centerW = max(0, 1 − xn²)
vb      = exp(−(sy − poutY)² / (2·poutSigma²))
dy     += mag · FROWN_GAIN · FROWN_POUT · centerW · vb · win
```

Each of the 192 triangles is affine-mapped from source to displaced destination and drawn from the raw frame (`drawTriangle`, `faceMorph.ts:447–505`), so the warp tracks the actual mouth and does nothing when no face is present.

**Nominal corner travel** (at the mouth corner, ignoring window/falloff attenuation): smile = `0.17·|α−1|` mouth-widths (`0.1541` horizontal, `0.0719` vertical); frown = `0.13·|α−1|` mouth-widths (`0.0325` inward, pout peaking at `0.065`).

#### Per-condition displacement

| Preset | α | `|α−1|` | Corner travel | Horizontal | Vertical | Extra |
|---|---|---|---|---|---|---|
| Neutral / Sham | 1.00 | 0 | — | — | — | none |
| Smile + (subtle) | 1.35 | 0.35 | 0.0595 W | 0.0539 W out | +0.0251 W up | — |
| Smile + (strong) | 1.90 | 0.90 | 0.1530 W | 0.1387 W out | +0.0647 W up | — |
| Lower voice | 1.25 | 0.25 | 0.0425 W | 0.0385 W out | +0.0180 W up | voice −2 st |
| Higher voice | 1.25 | 0.25 | 0.0425 W | 0.0385 W out | +0.0180 W up | voice +2 st |
| Frown (subtle) | 0.60 | 0.40 | 0.0520 W | 0.0130 W in | −0.0520 W down | pout 0.0260 W |
| Frown (strong) | 0.10 | 0.90 | 0.1170 W | 0.0293 W in | −0.1170 W down | pout 0.0585 W |

The dashboard's manual sliders allow α ∈ [−1, 3] (step 0.05); the legacy capture station allows α ∈ [−2, 5] (step 0.1). Presets are the intended experimental conditions; free sliders are for calibration.

At a mouth spanning ~150 px, "Smile + (strong)" moves each corner ≈23 px (≈21 out, ≈10 up). Exact figure scales with the participant's face size in frame.

#### Head-yaw attenuation

`faceMorph.ts:238–248`:
```
dl = |nose.x − leftEdge.x| ;  dr = |rightEdge.x − nose.x|
symmetry = min(dl, dr) / max(dl, dr)
yawScale = clamp01((symmetry − 0.35) / (0.65 − 0.35))
```
Full strength at symmetry ≥ 0.65, ramps to 0 by symmetry ≤ 0.35 (side profile). Warp skipped entirely if `yawScale ≤ 0.01`.

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

In practice a smile visibly develops over ~1 s and completes (snaps) around 1.6–1.9 s. Same tween governs relaxation back to neutral, independent of actual frame rate.

### 3.4 Voice pitch shift

`renderer/lib/voice.ts`. Real-time pitch/formant shift on the live mic via the delay-line modulation ("Jungle") technique: two cross-faded delay lines with linearly swept delay times. Genuine, audible, and recorded into the altered audio track.

Constants: `DELAY_TIME = 0.1 s`, `FADE_TIME = 0.05 s`, `BUFFER_TIME = 0.1 s`.

`setSemitones(n)`:
```
mult = clamp(n / 12, −1, 1)     # ±12 semitones = ±1 octave = full range
route "shift up" buffers if mult > 0, else "shift down" buffers
setDelay(DELAY_TIME · |mult|)   # modulation depth, via setTargetAtTime τ = 0.01 s
```

- `n = 0` → bypass.
- Dashboard slider: −12…+12 st (step 1); legacy capture station: −8…+8 st. Values beyond ±12 have no additional effect (clamped internally).
- Presets: "Lower voice" = −2 st, "Higher voice" = +2 st (both with α = 1.25). All other presets = 0 st.
- Reference: pitch ratio ≈ `2^(n/12)`; +2 st ≈ 1.122×, −2 st ≈ 0.891×, ±12 st = 2×/0.5×.

### 3.5 Modification presets

`main/presets.ts` (re-exported to renderer via `renderer/lib/presets.ts`). Each preset is a fixed `(alpha, voiceSemitones)` pair, kept as named bundles rather than raw numbers for reproducibility.

| ID | Label | α | Voice (st) | Control? | Description |
|---|---|---|---|---|---|
| `neutral` | Neutral / Sham | 1.0 | 0 | yes | Full pipeline runs identically; face and voice unchanged. |
| `smile-subtle` | Smile + (subtle) | 1.35 | 0 | no | Mildly increases smile intensity, often below conscious detection. |
| `smile-strong` | Smile + (strong) | 1.9 | 0 | no | Clearly increases smile intensity. |
| `frown-subtle` | Frown (subtle) | 0.6 | 0 | no | Mildly dampens the smile toward neutral/negative. |
| `frown-strong` | Frown (strong) | 0.1 | 0 | no | Clearly shifts the mouth toward a frown. |
| `warm-voice` | Lower voice | 1.25 | −2 | no | Subtle smile lift + slightly lower voice. |
| `bright-voice` | Higher voice | 1.25 | +2 | no | Subtle smile lift + slightly higher voice. |

`DEFAULT_PRESET_ID = 'neutral'`. The sham/control condition runs the identical pipeline (detection, canvas, audio graph all live) but leaves parameters unchanged, so it differs from a real condition only in parameter values, not processing artifacts or latency.

`counterbalanceConditions(presetIds, nDyads)` (`main/presets.ts:92–99`) returns a deterministic per-dyad condition order (`order[k] = presetIds[k mod presetIds.length]`). **Not currently called anywhere in the shipped UI** — condition assignment today is manual. See §12.

---

## 4. Expression detection

`renderer/lib/faceMorph.ts:276–367` (computation), `main/protocol.ts:46–72` (types). Runs on the participant's **real** face — the raw camera frame — never the morphed output, so a rule like "when P1 smiles" reacts to what actually happened.

### 4.1 Inputs (MediaPipe blendshapes, 0–1)

| Feature | Formula |
|---|---|
| `smile` | mean(`mouthSmileLeft`, `mouthSmileRight`) |
| `frown` | mean(`mouthFrownLeft`, `mouthFrownRight`) |
| `lipPress` | mean(`mouthPressLeft`, `mouthPressRight`) |
| `openness` | mean(`mouthUpperUpLeft`,`mouthUpperUpRight`) + 0.8·`jawOpen` + 0.8·mean(`mouthLowerDownLeft`,`mouthLowerDownRight`) |
| `asymmetry` | `|smileL − smileR| + |pressL − pressR|` |
| `relAsymmetry` | `asymmetry / max(0.3, max(smileL, smileR))` |
| `eyeConstriction` | mean(`eyeSquintL`,`eyeSquintR`,`cheekSquintL`,`cheekSquintR`) — logged only, not used to classify |

All features are EMA-smoothed (τ = 220 ms) before thresholding.

### 4.2 Thresholds (`DETECTION_TUNING`, `faceMorph.ts:85–102`)

| Parameter | Value | Role |
|---|---|---|
| `smileOn` / `smileOff` | 0.60 / 0.45 | Enter/stay "smiling" (hysteresis) |
| `frownOn` / `frownOff` | 0.03 / 0.01 | Enter/stay "frowning" |
| `frownSmileGate` | 0.75 | Frown only counts while smile is below this |
| `rewardOpenness` | 0.20 | Openness above this → reward smile |
| `dominanceRelAsymmetry` | 0.12 | Relative asymmetry above this → dominance smile |
| `minPublishedSubtypeConfidence` | 0.55 | Below this, sub-type is withheld/uncertain |
| `emaTauMs` | 220 ms | Blendshape smoothing |
| `debounceMs` | 350 ms | Minimum persistence before a label/sub-type is published |

### 4.3 Classification logic

1. **Label** (hysteresis): once smiling, stays smiling while smile ≥ `smileOff`; frowning requires `frown ≥ frownOn` **and** `smile < frownSmileGate`.
2. **Smile sub-type** (only while smiling): `openness ≥ 0.20` → **reward**; else `relAsymmetry ≥ 0.12` → **dominance**; else → **affiliative**.
3. **Confidence**: label confidence, smile-type confidence, classifier mode/version, and an `uncertain` flag are published alongside the label. A smiling frame with weak sub-type evidence is still a basic smile, but its sub-type is withheld or marked uncertain.
4. **Debounce**: a candidate must hold ≥350 ms before being published.

### 4.4 Framing and calibration

Sub-types follow the lab's smile-typology framework (cited in-code as Martin et al. 2021, *Affective Science*; Rychlowska et al. 2021, *Cognition & Emotion*). Thresholds were calibrated against the five example photos in `smile_examples/`:

- a relaxed "straight" face can score `mouthSmile ≈ 0.54`, hence the smiling threshold sits well above that;
- `cheekSquint`/`noseSneer` are ~0 on every example (dead features on this model); `eyeSquint` is contaminated by blinking/looking down — so the classic Duchenne eye-constriction cue is **not** usable as a reward marker with this model (logged, not used);
- reward → mouth opens/teeth show (`mouthUpperUp ≈ 0.65` vs ≈0.005); dominance → asymmetry + lip press (rel. ≈0.21); affiliative → strong smile, closed lips, none of the above;
- the frown example peaked at `mouthFrown ≈ 0.12` with smile ≈ 0.

### 4.5 `ExpressionState`

`main/protocol.ts:60–72`: `{ label, smileType, smile, frown, asymmetry, eyeConstriction, lipPress, openness, labelConfidence, smileTypeConfidence, uncertain, classifierMode, classifierVersion }`. Streamed to the dashboard and fed to the rule engine at up to 5 Hz (change-gated); label/sub-type changes are logged as `expression_changed`. Basic "smiling" rules fire on uncertain smiles; sub-type rules require a confident, non-uncertain smile type.

---

## 5. Automation rules

`main/rules.ts` (engine, runs on the server), `renderer/pages/admin.tsx:1166–1477` (builder UI), `main/protocol.ts:84–120` (types). Rules are authored on the dashboard, stored and executed server-side, and editable at any time including mid-call. Every firing is logged like a manual command.

### 5.1 Structure

```
{ id, enabled,
  trigger: { kind:'expression', slot:'P1'|'P2', expression, holdSec }
         | { kind:'timer', atSec },
  action:  { slot:'P1'|'P2', presetId },
  release: 'previous' | 'neutral' | 'none',      # expression rules only
  revertAfterSec: number | null }                # timer rules only
```

Trigger expressions: `smiling` (any type), `reward-smile`, `affiliative-smile`, `dominance-smile`, `frowning`.

### 5.2 Semantics

- **Expression rule** — while the watched participant holds the expression for `holdSec`, apply the preset to the target. When it stops: `previous` restores pre-rule state, `neutral` resets, `none` leaves it applied.
- **Timer rule** — at `atSec` into the live conversation, apply once; if `revertAfterSec` is set, restore after that many seconds.
- **Timing scope**: expression rules run in the waiting room **and** live; timer rules count only from when the conversation goes live. Ending the session or returning to the waiting room releases anything a rule left applied.
- Deleting/disabling a fired rule releases it first, so a removed rule can't leave a participant stuck mid-morph.
- Evaluation cadence: server ticks the engine every 250 ms (4 Hz).

### 5.3 Builder UI

Plain-language rows, e.g. `WHEN [P1] [is smiling] for [1] s THEN [P2] gets [Smile + (subtle)] · when it stops: [back to how they were]`. Edits are debounced 400 ms; server echoes are ignored for 1.5 s while typing to avoid clobbering an in-progress edit. A "+ template: mirror smiles" button adds two reciprocal rules (each participant's genuine smile subtly lifts the partner's).

---

## 6. Networking

### 6.1 Wire protocol

`main/protocol.ts`. JSON over one WebSocket per client. `PROTOCOL_VERSION = 1`, `DEFAULT_PORT = 8771`. DOM-type-free so the Electron main process can import it directly.

- **Client → Server**: `hello`, `signal`, `ready`, `telemetry`, `expression`, `stream-map`, `client-event`; admin-only: `set-identity`, `set-effect`, `apply-preset`, `banner`, `set-phase`, `admin-mic`, `set-rules`.
- **Server → Client**: `welcome`, `roster`, `signal`, `effect-command`, `identity-assigned`, `banner`, `phase`, `peer-left`, `telemetry`, `expression`, `stream-map`, `log-row`, `rules`, `rule-status`, `rejected`.

Admin-only commands from a participant are rejected and logged as `unauthorized_command`.

### 6.2 Coordination server (`main/server.ts`)

Binds `0.0.0.0:8771`. Assigns seats: admin → ADMIN; participants → the seat their `participantId` last held (reconnect), else P1, then P2, else reject ("The call is full."). Identities and effects survive a reconnect. Heartbeat pings every 5 s; a missed pong terminates the client (`client_timeout`). Relays signaling, routes effect commands, owns the phase, and logs every event via `SessionLogger`.

### 6.3 WebRTC peer links (`renderer/lib/rtc.ts`)

One `PeerLink` per pair of seats, using "perfect negotiation" (polite/impolite) so either side can add tracks freely and glare resolves itself. Politeness: P2 yields to P1; the admin is always polite. Single STUN server (`stun:stun.l.google.com:19302`); **no TURN server** — media is expected to flow directly over the lab LAN. A failed connection drops the link and finalizes that seat's recorders so a reconnect starts fresh `_part` files.

### 6.4 Signaling client (`renderer/lib/signaling.ts`)

Resilient WebSocket, retries every 2 s, replays `hello` to recover the same seat. `normalizeServerUrl` turns whatever the RA types into a valid `ws://host:port` URL, defaulting to port 8771.

### 6.5 Stream identification

Each participant sends a `stream-map` telling the admin which stream id is altered vs clean, so the dashboard labels the two monitors correctly.

---

## 7. Session lifecycle

`Phase = 'waiting' | 'live' | 'ended'`. The admin drives transitions via `set-phase`; the server broadcasts to everyone.

- **waiting → live**: stamps a fresh `sessionStartedAt`; timer rules re-arm.
- **live → ended**: participants see the ended screen; recorders finalize; manifest written ~1.5 s later; rules release.
- **→ waiting**: clears the clock; rules release; expression state resets.
- Sessions are restartable: `ended → live` starts a fresh clock and continues recordings as `_partN` files; `ended/live → waiting` returns participants to the waiting room.

**Start gating**: enabled once both participants are connected. If both are also ready (`camera && voice`, server-side), it starts immediately; otherwise it asks for confirmation. The face model is reported but doesn't block start — video simply passes through unmorphed if it failed to load.

---

## 8. Data outputs & logging

`main/logger.ts` (CSV + manifest), `main/main.ts` (streamed recordings), `renderer/lib/recording.ts` (format selection).

### 8.1 Session folder layout

Default root `Documents/NiedenthalLab/video-call-sessions` (selectable via folder picker):

```
session_<YYYY-MM-DDTHH-MM-SS>/
├── events.csv          # every discrete event
├── effect_state.csv    # 1 Hz applied-state telemetry (ground truth)
├── session.json        # manifest (written on End)
└── recordings/
    ├── P1_<pid>_clean.mp4      P1_<pid>_altered.mp4
    ├── P2_<pid>_clean.mp4      P2_<pid>_altered.mp4
    └── researcher_mic.mp4      (…_part2, _part3 on restart/reconnect)
```

CSVs use append write-streams so rows hit disk as they happen; recording chunks flush every 1 s. A crash mid-session loses at most the OS buffer.

### 8.2 `events.csv`

Header: `ts_iso, t_rel_ms, seq, actor_role, actor_slot, actor_name, event, target, param, value, detail` (`detail` is CSV-escaped JSON).

| Category | Events |
|---|---|
| Server | `server_started`, `server_stopped` |
| Connection | `client_connected`, `client_rejected`, `client_disconnected`, `client_timeout`, `client_ready`, `unauthorized_command`, `stream_map` |
| Session phase | `session_waiting`, `session_live`, `session_ended` |
| Modification | `effect_command`, `preset_applied`, `identity_set_by_admin` |
| Automation | `rules_updated`, `rule_fired`, `rule_released`, `rule_reverted` |
| Expression | `expression_changed` (on label/sub-type change only) |
| Researcher | `banner_sent`, `admin_mic_live`, `admin_mic_muted` |
| Recording | `recording_started`, `recording_stopped` |
| Participant client-events | `rtc_state`, `window_blur`, `window_focus`, `escape_dialog_opened`, `escape_dialog_cancelled`, `escape_confirmed`, `banner_shown`, `effect_applied`, `media_pipeline_error`, `test_face_mode_enabled`, `test_face_changed` |

### 8.3 `effect_state.csv`

Header: `ts_iso, t_rel_ms, slot, participant_id, phase, alpha, voice_semitones, face_found, fps, camera_on, expression, smile_type, label_confidence, smile_type_confidence, uncertain, classifier_mode, classifier_version`. Written once per second from each participant's telemetry — the authoritative record of what was actually applied and shown, independent of what was commanded.

### 8.4 Manifests

- **Three-seat call** (written on End): `{ schemaVersion:2, app:'Niedenthal Lab Video Call', appVersion:'3.0.0', writtenAt, sessionStartedAt, raName, participants:[{slot, identity}], recordings:[{label, bytes}], eventCount }` → `session.json`.
- **Legacy capture station** (`renderer/lib/capture.ts:310–330`): `{ schemaVersion:1, app:'DuckSoup Experimenter Platform', appVersion:'2.0.0', ... }` — the format the PPS questionnaire app reads. **The two formats differ**; see §12.

### 8.5 Recording format

`renderer/lib/recording.ts`. MP4 preferred (opens everywhere the lab works); candidates in order `video/mp4;codecs=avc1.640028,mp4a.40.2` → `avc1.42E01E,mp4a.40.2` → `video/mp4` → `video/webm;codecs=vp9,opus` → `video/webm`. Falls back to WebM if none of the MP4 variants are supported. Fragmented MP4 stays playable even if the app crashes mid-recording; chunks cut every 1 s.

---

## 9. Test mode

Access code `test` (`index.tsx:39`, `session.tsx:42–49, 275–301`). Runs the pipeline on a bundled example face image (letterboxed onto a 720p canvas, redrawn every 66 ms → ~15 fps, `captureStream(15)`) plus a silent oscillator audio track, so morph/detection/ready-gate/WebRTC all behave as with a real camera. A panel switches live among five faces (Straight, Reward smile, Affiliative smile, Dominance smile, Frown) under `renderer/public/images/test-faces/`. Every use is logged (`test_face_mode_enabled`, `test_face_changed`) with an on-screen "TEST MODE" indicator, so a real session can never quietly run on an example face.

---

## 10. Packaging & kiosk lockdown

### 10.1 Build & distribution

- `electron-builder.yml`: appId `edu.wisc.niedenthal.labvideocall`, product name "Lab Video Call". Windows: NSIS installer. macOS: universal (Intel + Apple Silicon) DMG + ZIP.
- macOS CI (`.github/workflows/build-mac.yml`) builds on every push/PR to `main`, on a GitHub `macos-latest` runner (no Mac needed locally), and uploads the DMG/ZIP as a 30-day workflow artifact — useful for testing a branch, but requires a GitHub login with repo access and expires.
- **Releases** (`.github/workflows/release.yml`): every push to `main` builds both Windows (NSIS `.exe`) and macOS (`.dmg`/`.zip`) and publishes them to a single GitHub Release tagged `latest` — a permanent, public-facing download page, no repo access or expiry involved, no manual tagging or version bumping required. Each push overwrites the previous download with the new build, so `main` should only be updated when the app is in a shareable state.
- Builds are **unsigned** on both platforms (no code-signing certificate) — macOS testers must right-click → Open on first launch; Windows may show a SmartScreen warning ("More info" → "Run anyway").
- Camera/mic Info.plist strings and entitlements (`resources/entitlements.mac.plist`) are set for a future signed build. On unsigned macOS builds, permission grants are tied to the code signature, so a fresh install may re-prompt for camera/mic access — a code-signing limitation, not a bug.

### 10.2 Kiosk lockdown (participant machines)

`main/main.ts:149–216`. On participant sign-in the window becomes a locked kiosk: `setKiosk(true)`, `setAlwaysOnTop(true, 'screen-saver')`, `setClosable(false)`, min size 800×600, `powerSaveBlocker` keeps the display awake. Blocked: `F5/F11/F12`, reload/close/new-window/zoom combos, devtools combos in production.

The only exit is **Ctrl/Cmd+Shift+Q → type "Confirm"**, handled in three places (global shortcut, per-window `before-input-event`, renderer `keydown`) because an Electron global shortcut can only be claimed by one process per machine, which made the combo unreliable with multiple windows open on one laptop for testing.

The researcher window is a normal window; closing it mid-live prompts a confirmation (it shuts the server down for everyone).

### 10.3 Permissions & autoplay

`autoplay-policy=no-user-gesture-required` (so the researcher's audio can start without a participant click). On macOS the app proactively requests camera/mic access up front.

### 10.4 Dev vs. production

Dev: `npm run dev` (Nextron) runs Next.js on port 8888 + Electron; `startupDelay:30000` gives the renderer time to bind. `npm run server:dev` runs the standalone WebSocket server (`main/server-standalone.ts`) so the full three-client flow can be tested in three browser tabs without Electron (CSVs land in `scratchpad/dev-sessions/`). Production serves the statically-exported Next.js app from `app://` via `electron-serve`.

---

## 11. Constants reference

### Morph & timing

| Constant | Value |
|---|---|
| Smile corner angle | 25° above horizontal |
| `SMILE_GAIN` | 0.17 mouth-widths per unit `|α−1|` |
| `FROWN_GAIN` | 0.13 mouth-widths per unit `|α−1|` |
| Frown inward fraction | 0.25 |
| Frown pout fraction | 0.5 |
| Alpha tween τ | 350 ms |
| Warp skip threshold | `|α−1| < 0.02` |
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

| Constant | Value |
|---|---|
| smileOn / smileOff | 0.60 / 0.45 |
| frownOn / frownOff | 0.03 / 0.01 |
| frownSmileGate | 0.75 |
| rewardOpenness | 0.20 |
| dominanceRelAsymmetry | 0.12 |
| EMA τ | 220 ms |
| debounce | 350 ms |

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
| Smile α (dashboard) | −1…3 | 0.05 | 1 |
| Voice pitch (dashboard) | −12…+12 st | 1 | 0 |
| Smile α (legacy capture) | −2…5 | 0.1 | 1 |
| Voice pitch (legacy capture) | −8…+8 st | 1 | 0 |
| Rule hold time | 0…30 s | 0.5 | — |
| Timer minute/second | 0–180 / 0–59 | 1 | — |
| Monitor volume | 0…1 | 0.05 | 0 (muted) |

---

## 12. Known limitations

Things to know before citing or relying on this software in a study.

1. **Manipulation intensities are un-calibrated placeholders.** `main/presets.ts` notes the current α values are starting points, reduced from earlier values after a demo. No psychophysical validation (detection threshold, naturalness, believability) has been run — describe presets as pilot settings, not validated intensities.
2. **The smile sub-type classifier is a heuristic tuned to five still images**, not validated against FACS-coded or human-rated video. The Duchenne eye-constriction cue is deliberately unused (unreliable on webcams with this model). Treat sub-type as exploratory unless independently validated.
3. **The morph is a 2-D planar mesh warp, not a 3-D face model.** It moves mouth-corner geometry and a lower-lip pout only — no Duchenne eye/cheek changes, teeth, or lighting consistent with a real smile. It fades out on head turn and does nothing when no face is detected, so brief head turns or tracking dropouts show the unmodified partner. Check `face_found` in `effect_state.csv` for affected frames.
4. **Detection latency**: ~5 Hz sampling, 220 ms EMA smoothing, 350 ms debounce — expression onset is reported with up to ~0.5–0.7 s latency. Interpret rule "hold" durations accordingly.
5. **Effect ease-in**: a commanded change reaches ~95% of target in ~1.05 s (τ = 350 ms) — not instantaneous. `effect_state.csv` records the true per-second trajectory.
6. **Condition counterbalancing isn't automated.** `counterbalanceConditions()` exists and is deterministic but isn't called from the UI — condition assignment is currently manual (RA's procedure). Document how it was done for the study; consider wiring the helper in for the main study.

---

## 13. File index

### `main/` — Electron main process + server

| File | Role |
|---|---|
| `main.ts` | App entry; kiosk lockdown; permissions; server start/stop IPC; streamed-recording IPC; folder picker; legacy capture IPC. |
| `server.ts` | `SessionServer`: seats, signaling relay, effect routing, phase, rule engine host, logging, LAN IP discovery. |
| `rules.ts` | `RuleEngine`: expression/timer triggers, holds, reverts, release modes. |
| `presets.ts` | Modification conditions, `getPreset`, `counterbalanceConditions`. |
| `protocol.ts` | Wire protocol, message types, `EffectState`, `ExpressionState`, `AutomationRule`, `Telemetry`, versions, port. |
| `logger.ts` | `SessionLogger`: `events.csv`, `effect_state.csv`, `session.json`, recording paths. |
| `preload.ts` | Context-bridge IPC (`window.ipc.invoke/on/send`). |
| `server-standalone.ts` | Browser-dev standalone server entry (`npm run server:dev`). |
| `helpers/create-window.ts` | Window creation + persisted window state. |

### `renderer/lib/` — transformation & networking

| File | Role |
|---|---|
| `faceMorph.ts` | `FaceMorphProcessor`: MediaPipe detection, smile/frown mesh warp, expression classifier. |
| `voice.ts` | `VoiceProcessor`: Web Audio delay-line pitch shifter. |
| `effects.ts` | `LiveEffects`: participant outgoing pipeline (clean + altered streams); test-face stream. |
| `capture.ts` | `CaptureStation`: legacy single-machine capture+record engine (dashboard mode). |
| `rtc.ts` | `PeerLink`: one WebRTC connection, perfect negotiation. |
| `signaling.ts` | `SignalClient`: resilient WebSocket + `normalizeServerUrl`. |
| `recording.ts` | MP4/WebM recorder-format selection. |
| `types.ts` | Legacy capture types + `SessionManifest` (v1). |
| `protocol.ts` / `presets.ts` | Renderer re-exports of the shared `main/` modules. |
| `ipcUtil.ts` | Typed IPC wrappers that no-op outside Electron. |

### `renderer/pages/` — UI

| File | Role |
|---|---|
| `admin.tsx` | Researcher dashboard (panels, sliders, presets, rules, banners, mic, recordings, event log). |
| `session.tsx` | Participant kiosk view (waiting/live/ended, PiP, banner, escape hatch, test-face panel). |
| `dashboard.tsx` | Legacy "DuckSoup Capture Station" single-machine UI. |
| `index.tsx` | Sign-in / role selection. |
| `_app.tsx` | Next.js app shell. |

### Assets & config

`renderer/public/mediapipe/` (vendored FaceLandmarker model + WASM); `renderer/public/images/test-faces/` (5 test faces); `smile_examples/` (5 calibration photos); `renderer/public/ducksoup.js` (vendored, unused); `resources/` (icons, mac entitlements); `electron-builder.yml`, `nextron.config.ts`, `renderer/next.config.ts`, `tsconfig*.json`, `.github/workflows/build-mac.yml`, `.github/workflows/release.yml`, `tests/e2e_test.py`.
