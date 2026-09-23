# Guide for researchers

This is a plain-language guide to running a session. For technical details, see the [technical reference](for-technical-users.md).

## Getting the app

Download the installer for your operating system from the [Releases page](https://github.com/alexmueller07/niedenthal-ducksoup-research-video-conferencing/releases) — grab the latest release, then the `.exe` (Windows) or `.dmg` (Mac). Since the app isn't code-signed yet, Windows may show a "Windows protected your PC" warning (click "More info" → "Run anyway") and Mac will refuse to open it on a double-click the first time (right-click the app → "Open" instead).

Once it's installed, you don't need to keep checking that page yourself: whenever a newer version is available, the **sign-in screen** (the very first screen, before you type your name or access code) shows an amber **"Update available"** banner. Clicking it downloads the new `.dmg`; install it the same way as the first time (right-click → Open).

## What the app does

Two participants sit at separate computers and have a conversation over video. A researcher (RA) sits at a third computer, invisible to both participants, and can:

- see and hear both participants (their real, unmodified video)
- change how "smiley" or "frowny" each participant looks *to their partner*
- change how each participant's voice sounds *to their partner* (pitch, higher/lower)
- send a text message that pops up on a participant's screen
- set up automatic rules, e.g. "when Participant 1 smiles for real, subtly make Participant 2 look happier"

Each participant only ever sees their **own real camera** (in a small corner box) and their **partner's modified video** (full screen). They never see their own modification. Everything — every button press, every message, every detected expression — is written to a log file, and every video/audio stream is recorded.

## The three seats

- **Participant 1 (P1)** and **Participant 2 (P2)** — the two people having the conversation.
- **Researcher (ADMIN)** — you. Your machine hosts the session; nothing works without it running.

## Signing in

Everyone uses the same sign-in screen. What you type in **Access code** decides your role:

| Type in Access code | You become |
|---|---|
| `admin` | Researcher (opens your dashboard) |
| `test` | Test participant (uses a still example face instead of a camera — for practice only) |
| (leave blank) | Participant |

Fill in name, participant ID, and dyad ID as usual. Under "Setup options" you can set the study ID and, for participants, the researcher machine's address (so they connect to the right session).

## Running a session

1. **Everyone signs in.** The researcher opens the dashboard; each participant's machine shows a waiting screen.
2. **Wait for both participants to connect.** The dashboard shows a colored dot per participant: gray = not connected, amber = connected but camera/mic not ready yet, green = ready.
3. **Press "Start conversation."** If both participants are fully ready, the call starts immediately. If not, you'll be asked to confirm starting anyway.
4. **During the call**, from your dashboard you can:
   - Drag the **Smile** slider to make a participant look more or less happy to their partner (or use a **preset** button for a pre-set amount).
   - Drag the **Voice pitch** slider to make their voice sound higher or lower to their partner.
   - Watch each participant's video (their real feed or the modified one their partner sees — toggle between the two).
   - See a live readout of whether each participant is currently smiling, frowning, or neutral.
   - Send a short **message banner** to a participant's screen (there are one-click templates for common messages).
   - Turn on your **microphone** to talk to a participant directly (or hold a button to talk only while pressed).
   - Set up **automation rules** so certain changes happen on their own (see below).
5. **Press "End session"** when the conversation is done. Both participants see an "ended" screen. Everything is saved automatically.
6. If needed, you can **restart** the same session (continues recording as a new file) or send participants back to the **waiting room**.

## Calibration

Before starting the conversation, run a calibration for each participant from the waiting room. **It is worth doing every time.** It is how the app learns what that specific person's face actually does — both for reading their expressions and, more importantly, for deciding how far to move their mouth when you modify it.

Without it, everyone gets the same fixed amount of change regardless of their face, which is why the effect used to look overdone on some people and invisible on others.

### Running it

1. In the waiting room, find the **Calibration** section under a participant's video and press **Run calibration**.
2. The participant is taken through four short takes, each with a prompt and a countdown on their screen:
   - **Relax your face** (3 seconds)
   - **Biggest smile, lips together** (4 seconds)
   - **Biggest smile, showing teeth** (4 seconds)
   - **Biggest frown** (4 seconds)

   About 22 seconds in total. Tell them beforehand to go as big as they comfortably can — a half-hearted smile here means the app underestimates their range for the whole session.
3. As each take finishes, a photo of their strongest moment appears under their video with the key numbers under it. The number in green or red is the change from their relaxed face — that is the one to look at. A take that barely moves off their relaxed face gets outlined in red with a short reason.
4. If a take doesn't look right, press **Redo** under that one photo. Only that take is repeated — they don't sit through all four again.
5. When all four look reasonable, press **Accept**.

Both smiles are needed, and they do different jobs. The **closed-lip** one decides how far the app moves their mouth corners, because when the mouth is open a lot of the corner movement is really the jaw dropping, which the app can't reproduce. The **open-mouth** one tells the app their real maximum for reading expressions, and how their jaw and mouth corners move together — which is what lets it tell talking apart from smiling later.

### What changes once it's accepted

- **The Smile slider changes meaning.** It now runs from −1 to 1, where 1 is that person's own biggest smile and −1 is their own biggest frown. The same setting on two people produces changes that suit each of their faces rather than being identical.
- **The app will never push them past their own maximum.** And the limit covers the total: if someone is already smiling on their own, the app only adds what's left over. So the same preset visibly does less on someone who is already grinning. That is intentional — going past what their face can do is exactly what looked fake before.
- **Presets get weaker-sounding numbers.** "Smile (strong)" is now 0.50 rather than 0.9, because 0.9 would now mean 90% of their real maximum. The change you see on screen is about the same as before.
- **Expression reading gets more accurate and noticeably quicker**, because it's now judged against their own relaxed face instead of one cutoff for everybody.

### Cheeks and eyebrows

The change isn't just the mouth. Calibration also measures how much that person's cheeks and eyebrows move, and the whole face moves together — a smile lifts their cheeks, a frown pulls their brows down and together. All from the same four takes; participants don't do anything extra.

It copies what each person actually does rather than assuming. If someone raises their eyebrows when they smile, theirs go up; if someone's drop, theirs drop.

The eyes themselves are left alone on purpose. Eyelids and eyelashes look obviously wrong if a change there is even slightly off, which is far more noticeable than a slightly stiff cheek.

**If a participant wears glasses**, have a quick look at their altered view before you start. The movement is deliberately kept away from where frames sit, but unusual frames — very large lenses, or ones sitting low on the cheek — could still catch. The 1-person test tool has a "Cheek & brow follow" slider you can turn down if so.

### Talking

The app now detects when someone is speaking, using both their mouth movement and their microphone. While they're talking, frowns are not reported — ordinary talking makes almost the same mouth shapes a frown does, so a frown logged mid-sentence is nearly always wrong. Smiles are still reported, since people genuinely smile while talking. The face modification isn't switched off during speech, just eased back while the mouth is wide open, where this kind of change looks least convincing anyway.

### What gets saved

Everything, into the session folder under `calibration/<participant id>/`: a `calibration.json` with every measurement from every take, plus the four photos. The event log records each take and the moment you accepted it. For the rest of the session, the per-second data file records their readings on their own scale alongside the raw ones.

A participant is **not** remembered between sessions — if the same person comes back another day, calibrate them again.

If someone was calibrated before the cheek and eyebrow update, calibrate them again to pick it up. Nothing will warn you — they'd just keep getting the mouth-only version.

### If you skip it

The app still works. It falls back to the old single fixed amount for everyone, and the panel under their video keeps saying **Not calibrated** so it's obvious from the dashboard which participants were and weren't done.

## Automation rules (optional)

Instead of pressing sliders by hand, you can set up simple rules in plain language, for example:

> WHEN Participant 1 is smiling for 1 second → THEN Participant 2 gets "Smile (subtle)" → when it stops, go back to how they were

or a timed rule:

> AT 5:00 into the conversation → THEN Participant 1 gets "Frown (subtle)" → revert after 30 seconds

Rules can be added, edited, or turned off at any time, including mid-call. A rule that's currently active is highlighted on the dashboard.

## Modification presets

Rather than picking raw numbers, you can apply a named condition with one click:

| Preset | What it does |
|---|---|
| Neutral / Sham | No change (control condition) |
| Smile (subtle) | Slightly increases smiling |
| Smile (strong) | Clearly increases smiling |
| Frown (subtle) | Slightly dampens toward a frown |
| Frown (strong) | Clearly shifts toward a frown |
| Lower voice | Slight smile lift + slightly lower voice |
| Higher voice | Slight smile lift + slightly higher voice |

## Test mode

Signing in with access code `test` lets one person try out the app on their own laptop without a real camera or a second person — it shows a still example face instead, and you can switch between five example expressions. A "TEST MODE" label always appears on screen so it's never mistaken for a real session. Use this to practice or check your setup before a real session.

## Leaving a participant station

Participant screens are locked down (full-screen, no way to click out) so participants can't accidentally close the app. To close a participant station, press **Ctrl+Shift+Q** (or **Cmd+Shift+Q** on a Mac), then type the word `Confirm` and press Enter.

## Where the data goes

Each session saves to its own folder (you can open it directly from the dashboard's "Data folder" button):

- A log of every event (connections, messages, button presses, detected expressions, calibration results, etc. — see [Calibration](#calibration) above)
- A log of exactly what was applied to each participant, once per second — including how much was actually applied after the per-person limit, and their smile/frown readings on their own scale if they were calibrated
- Each calibrated participant's measurements and photos, under `calibration/<participant id>/`
- A summary file once the session ends
- Video/audio recordings: each participant's real feed, each participant's modified feed, and the researcher's mic

## Troubleshooting

- **A participant's dot won't turn green** — their camera or microphone hasn't been detected yet; check their machine.
- **"Connecting to your partner…" shown mid-call** — the connection between the two participants briefly dropped; it will usually reconnect on its own.
- **Need to leave a participant station** — see "Leaving a participant station" above.
