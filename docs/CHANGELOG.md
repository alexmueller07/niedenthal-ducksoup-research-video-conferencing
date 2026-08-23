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
