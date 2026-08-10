# Guide for researchers

This is a plain-language guide to running a session. For technical details, see the [technical reference](for-technical-users.md).

## Getting the app

Download the installer for your operating system from the [Releases page](https://github.com/alexmueller07/niedenthal-ducksoup-research-video-conferencing/releases) — grab the latest release, then the `.exe` (Windows) or `.dmg` (Mac). Since the app isn't code-signed yet, Windows may show a "Windows protected your PC" warning (click "More info" → "Run anyway") and Mac will refuse to open it on a double-click the first time (right-click the app → "Open" instead).

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

## Automation rules (optional)

Instead of pressing sliders by hand, you can set up simple rules in plain language, for example:

> WHEN Participant 1 is smiling for 1 second → THEN Participant 2 gets "Smile + (subtle)" → when it stops, go back to how they were

or a timed rule:

> AT 5:00 into the conversation → THEN Participant 1 gets "Frown (subtle)" → revert after 30 seconds

Rules can be added, edited, or turned off at any time, including mid-call. A rule that's currently active is highlighted on the dashboard.

## Modification presets

Rather than picking raw numbers, you can apply a named condition with one click:

| Preset | What it does |
|---|---|
| Neutral / Sham | No change (control condition) |
| Smile + (subtle) | Slightly increases smiling |
| Smile + (strong) | Clearly increases smiling |
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

- A log of every event (connections, messages, button presses, detected expressions, etc.)
- A log of exactly what was applied to each participant, once per second
- A summary file once the session ends
- Video/audio recordings: each participant's real feed, each participant's modified feed, and the researcher's mic

## Troubleshooting

- **A participant's dot won't turn green** — their camera or microphone hasn't been detected yet; check their machine.
- **"Connecting to your partner…" shown mid-call** — the connection between the two participants briefly dropped; it will usually reconnect on its own.
- **Need to leave a participant station** — see "Leaving a participant station" above.
