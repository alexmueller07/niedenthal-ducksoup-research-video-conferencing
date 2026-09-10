# Project Changelog

*Note to team: Every time you make a significant update to the code, please copy the blank template below and paste a filled-out version right below the "Update History" header (so the most recent change is always on top).*

## Blank Template (Copy this)

* **Date:** [DD-MM-YYYY]
* **Author:** [Your Name]
* **Changes Made:** [Short title of the update]

* **Previous behavior:** 
[What did the app do before this change?]
* **New behavior:** 
[What does the app do now?]
* **Why this matters:** 
[Why was this change necessary?]

---

## Update History

* **Date:** 09-09-2026
* **Author:** Aditya Harshavardhan
* **Changes Made:** Fixed frown detection getting stuck after calibration

* **Previous behavior:**
The expression detector decided smiling vs. frowning by checking smile first every time, and while labeled "smiling" it needed the smile signal to drop below a low "stay smiling" bar before it would even consider a frown. Because a relaxed face can score a real smile signal even when not smiling, this could keep the label stuck (or block a genuine frown outright) — reported as: frowning during calibration worked, but frowning the same way afterward didn't show up as a frown.
* **New behavior:**
Smile and frown are now checked independently each frame; if both cross their threshold at once, whichever one is over its threshold by more wins. A held frown can now override a stale "smiling" label instead of needing smile to fade first.
* **Why this matters:**
The detected-expression label feeds the researcher screen and the session logs, so a frown that silently fails to register undercounts real frowns and can throw off anything downstream that relies on that label.

---

* **Date:** 09-09-2026
* **Author:** Aditya Harshavardhan
* **Changes Made:** Coupled eye/brow movement into the face morph and capped the test slider

* **Previous behavior:**
The face morph only moved the mouth region when smiling or frowning, leaving the eyes, brows, and forehead completely neutral — this mismatch was the biggest source of the effect looking fake. Separately, the 1-person test tool's smile slider went up to +/-2.00, well past the +/-0.90 ceiling any real session preset actually uses, and stopping a recording left the last altered frame frozen on screen instead of going blank like the clean feed.
* **New behavior:**
Smiling now also gives a subtle cheek-raise near the eyes, and frowning gives a subtle inner-brow lower/furrow, both scaled to a fraction of the mouth's intensity so they read as "the eyes are in on it" without becoming their own effect. The test tool's slider is capped to +/-0.75, and stopping a recording now blanks both the clean and altered video panes.
* **Why this matters:**
Real smiles and frowns engage more than just the mouth, so coupling in the eye/brow region should meaningfully reduce the uncanny look RAs flagged. Capping the slider keeps manual testing honest to what a real session can produce, and blanking both panes on stop avoids a stale frame looking like a lingering glitch.

---

* **Date:** 09-09-2026
* **Author:** Ismam Ferdous
* **Changes Made:** Improve calibrated face morph stability

-----DELETED-----

---

* **Date:** 08-09-2026
* **Author:** Aditya Harshavardhan
* **Changes Made:** Simplified the 1-person test tool and cleaned up the researcher screen

* **Previous behavior:**
The 1-person test tool (renamed from "capture station" to "1-Person Test Station") asked for study/RA/dyad/participant info before you could even test, had a voice slider even though it's video-only, let the smile slider go way past a sensible range, and didn't have the same face setup check the real 2-person sessions have. On the researcher screen, the setup check lived in its own separate box instead of next to each participant, had a confusing "run both" option, and some preset buttons were named inconsistently. A duration box also had distracting up/down arrows, and several places had leftover dashes and wordy text.
* **New behavior:**
The 1-person test tool now only asks for an output folder, saves each take into a plainly numbered folder ("self test 1", "self test 2", etc.), and runs the same automatic setup check as the real sessions before recording starts. The smile slider is capped to a sane range. On the researcher screen, each participant's setup check now sits right under their own preset buttons instead of a separate shared box, and preset buttons are grouped into clear rows (neutral, smile, frown, voice) with consistent naming. The setup check's numbers, and the fact that a participant got calibrated, are both written into the session files, and the per-session README now explains what those numbers mean with a real example. Cleaned up wording and removed stray dashes across both screens.
* **Why this matters:**
Makes it much faster to test the app by yourself without filling out study paperwork, keeps the smile effect from ever looking excessive, and makes the researcher screen easier to read and less error-prone during a real session.

---

* **Date:** 07-09-2026
* **Author:** Ismam Ferdous
* **Changes Made:** Make setup checks wait for participant readiness

* **Previous behavior:**
The waiting-room setup check started filling the progress bar almost immediately, so participants could feel rushed and the app could finish a sample before the participant had clearly made the requested face.
* **New behavior:**
Each setup step now gives participants more time and waits for the requested face before filling the progress bar. The bar fills only while the participant holds the correct general expression, completed steps turn green, and failed captures still retry automatically on the same step.
* **Why this matters:**
This makes calibration calmer and more accurate. Participants have time to read the prompt, the app collects cleaner face-specific values, and RAs should need fewer manual retakes during testing.

---

* **Date:** 07-09-2026
* **Author:** Ismam Ferdous
* **Changes Made:** Retry failed setup checks automatically

* **Previous behavior:**
If a participant's waiting-room setup check failed because their face was not visible, they were off-axis, the closed-mouth smile showed teeth, or the expression was too weak, the failed result was sent to the researcher and the flow relied on manual retake handling.
* **New behavior:**
The participant screen now retries the same failed setup step automatically before moving on. If the step succeeds on retry, only the clean result is sent forward. If it keeps failing after the retry limit, the participant remains paused on that step and the researcher can review it.
* **Why this matters:**
This reduces researcher interruption, prevents bad calibration values from being accepted too easily, and keeps the setup process smoother for pilot testing.

---

* **Date:** 06-09-2026
* **Author:** Ismam Ferdous
* **Changes Made:** Add session-only face-shape normalization after setup check

* **Previous behavior:**
The waiting-room setup check could collect and accept neutral, closed-mouth smile, and frown values, but those accepted values only stayed in the researcher UI/log. The live expression detector still used the same global thresholds for every participant.
* **New behavior:**
Accepted setup values now build a session-only face-shape normalization profile for that participant. The participant machine receives the profile, compares future smile/frown/open-mouth readings against that participant's own baseline, and writes normalized values plus margins to `effect_state.csv`.
* **Why this matters:**
This makes expression detection less dependent on one-size-fits-all thresholds. Participants with different resting expressions, mouth sizes, camera angles, or face proportions can be judged against their own setup values, while the app keeps raw values for audit.

---

* **Date:** 23-08-2026
* **Author:** Aditya Harshavardhan
* **Changes Made:** Make 0 mean "no change" for the face/voice numbers, instead of 1

* **Previous behavior:**
The face-change number used 1 to mean "no change," with higher or lower numbers meaning more smiling or more frowning. This didn't match the voice-pitch number, which already used 0 for "no change."
* **New behavior:**
The face-change number now also uses 0 for "no change," matching the voice number. This only applies to the new three-person call app — the older single-computer tool still uses 1, since it feeds a separate outside program.
* **Why this matters:**
Both numbers now follow the same "0 = no change" rule, which is easier to remember and matches what most people expect.

---

* **Date:** 23-08-2026
* **Author:** Aditya Harshavardhan
* **Changes Made:** Split the combined date-and-time column into two columns

* **Previous behavior:**
Every timestamp was written into a single column, mixing the date and the time of day together in one cell.
* **New behavior:**
The date and time are now two separate columns everywhere.
* **Why this matters:**
Makes it easy to sort or filter by date and by time separately.

---

* **Date:** 23-08-2026
* **Author:** Aditya Harshavardhan
* **Changes Made:** Add video-matched timing, raw face readings, a clearer confidence column, and a session guide

* **Previous behavior:**
There was no way to line up a data row with a moment in the recorded video without doing your own math. The file only showed the final smiling/frowning guess, not the individual face readings behind it. The confidence column was a confusing double negative. A camera that just turned on could show an oddly low speed reading. None of the column conventions were written down anywhere handy.
* **New behavior:**
A new column shows time since the conversation actually started, matching the recordings. New columns show the individual face readings behind each smiling/frowning guess. The confusing confidence column was renamed and flipped so it reads naturally. The speed reading no longer looks artificially low right when the camera turns on. Every session folder now includes a short guide explaining all of this in plain English.
* **Why this matters:**
Researchers can match a data point to the video without doing math, see the evidence behind a smiling/frowning call instead of trusting a single label, and read the confidence column without reversing it in their head.

---

* **Date:** 23-08-2026
* **Author:** Aditya Harshavardhan
* **Changes Made:** Make session files easier for researchers to read

* **Previous behavior:**
Session data was one shared file, with short coded column names, UTC timestamps, and technical event names like `rtc_state` and `window_blur`.
* **New behavior:**
Each participant now gets their own file, with plain-English column names and your computer's own local time. Every event name is now a plain phrase (e.g. `connection_lost` instead of `client_timeout`), and a few events with no research value were removed.
* **Why this matters:**
Researchers can now read every file top to bottom without a lookup table.

---

* **Date:** 11-08-2026
* **Author:** Ismam Ferdous
* **Changes Made:** Add safer station navigation and researcher entry checks

* **Previous behavior:**
Researchers could open the dashboard without entering their name, so session logs could be missing the RA identity. Participant station exit used an experimenter login screen, and leaving the researcher dashboard or capture station during an active session could stop the flow without clearly guiding the RA through saving and returning home.
* **New behavior:**
Opening the researcher dashboard now requires the RA to enter a full name first. Participant station exit is back to the typed `confirm` flow, while still safely returning to the home screen and releasing kiosk lockdown. The researcher dashboard now has a Back button, and both the dashboard and capture station warn before leaving active sessions. If recording is active, the app ends the session, finalizes recordings, writes the session manifest, and then returns home.
* **Why this matters:**
These changes make the app harder to misuse during lab sessions. RAs get clearer navigation, participant stations stay protected, session metadata is more complete, and recordings/manifests are less likely to be lost by accidentally backing out mid-session.

---

* **Date:** 10-08-2026
* **Author:** Aditya Harshavardhan
* **Changes Made:** Rename voice presets to "Lower voice" / "Higher voice"

* **Previous behavior:** 
The two voice-shift presets were labeled "Warmer voice" and "Brighter voice."
* **New behavior:** 
Same presets, relabeled "Lower voice" and "Higher voice" to describe the actual pitch change plainly.
* **Why this matters:** 
Clearer for RAs picking a condition — "lower/higher" describes what the voice does, not a vague feeling.

---

* **Date:** 10-08-2026
* **Author:** Aditya Harshavardhan
* **Changes Made:** Fix broken recordings (corrupted files, wrong duration)

* **Previous behavior:** 
Session recordings sometimes came out corrupted, and finished videos often showed a bogus duration (tens of thousands of seconds) instead of the real length.
* **New behavior:** 
Recording chunks are now written to disk strictly in order, so files can no longer come out scrambled or missing their last second. Finished .mp4 files now get their real duration written in, instead of a placeholder value.
* **Why this matters:** 
Corrupted or mislabeled recordings could make session footage unusable for research.

---

* **Date:** 03-08-2026
* **Author:** Aditya Harshavardhan
* **Changes Made:** Add a way to open a second window on Mac

* **Previous behavior:** 
On Mac, double-clicking the app a second time just refocused the existing window — no way to run a researcher and a test participant on one laptop.
* **New behavior:** 
A "open another window" link on the sign-in screen (Mac only) launches a fully separate copy of the app. Doesn't touch the camera/video code at all.
* **Why this matters:** 
Requested for testing the app solo on one Mac. Note: switching focus between windows still has the video lag issue — this only solves opening a second window, not that.

---

* **Date:** 03-08-2026
* **Author:** Aditya Harshavardhan
* **Changes Made:** Add automatic build + download page

* **Previous behavior:** 
No easy way to get the app — it had to be built from source code.
* **New behavior:** 
Every push to `main` automatically builds a Windows and a Mac installer and publishes them to a "latest" GitHub Release page.
* **Why this matters:** 
Anyone can now download a ready-to-run copy of the app without touching any code.

---

* **Date:** 03-08-2026
* **Author:** Aditya Harshavardhan
* **Changes Made:** Split README into a short summary plus separate guides

* **Previous behavior:** 
One long README mixed a casual overview, deep technical detail, and an audit into a single cluttered file.
* **New behavior:** 
README is now a short summary with links to a researcher guide, a technical reference, and this changelog, all under `docs/`.
* **Why this matters:** 
Makes it much faster for both RAs and developers to find what they actually need.
