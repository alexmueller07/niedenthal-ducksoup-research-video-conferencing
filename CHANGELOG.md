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

* **Date:** 05-08-2026
* **Author:** Ismam Ferdous
* **Changes Made:** Add Conclude Study logging and smile dataset research note

* **Previous behavior:**
The researcher dashboard could end a session and write the normal manifest, but there was no separate final study-closure action or dedicated `study_concluded` event in `events.csv`.
* **New behavior:**
After a session ends, the researcher can use **Conclude Study** to log final closure in `events.csv` and add conclusion metadata to `session.json`. Recording format selections are also logged, and dataset research notes are stored in `scratchpad/smile-dataset-research.md`.
* **Why this matters:**
This gives the team a clearer audit trail for final study completion and a concrete starting point for reward/affiliative/dominance smile dataset evaluation.

---
