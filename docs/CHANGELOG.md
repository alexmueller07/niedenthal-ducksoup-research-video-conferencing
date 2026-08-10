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