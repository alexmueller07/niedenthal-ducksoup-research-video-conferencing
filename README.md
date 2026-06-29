# Hey Ben — getting the Lab Video Call app running on a Mac

Hi Ben,

This is the Mac version of our lab video call app. It's not in the App Store, so the
first time you open it there are a couple of extra clicks to get macOS to trust it — that's
totally normal and I'll walk you through every bit of it below. Should only take you about
5 minutes start to finish. Just go in order.

## 1. Grab the app file

If I already sent you the file (`Lab-Video-Call-3.0.0-universal.dmg`) over Slack or email,
great — save it somewhere easy like your Desktop and skip to step 2.

Otherwise you can download it yourself:

1. Go to this page: **https://github.com/alexmueller07/niedenthal-ducksoup-research-video-conferencing/actions**
2. Click the most recent **"Build macOS app"** run at the top that has a **green check** next
   to it (a yellow dot means it's still building — just wait a few minutes).
3. Scroll all the way to the bottom of that page. Under **Artifacts**, click
   **`lab-video-call-macos`**. It'll download as a `.zip`.
4. Double-click the `.zip` to unzip it. Inside you'll find
   **`Lab-Video-Call-3.0.0-universal.dmg`** — that's the installer.

## 2. Install it

1. Double-click the `.dmg` file. A little window pops open with the app icon next to an
   **Applications** folder.
2. Drag the **Lab Video Call** icon onto the **Applications** folder. That's it — it's
   installed. You can close that window.

## 3. Open it for the first time (this is the slightly annoying macOS part)

Don't just double-click it the first time — macOS will refuse and act like it's a virus.
It's not, it's just unsigned. Here's how to get past it:

1. Open your **Applications** folder and find **Lab Video Call**.
2. **Right-click** it (or hold the **Control** key and click), then choose **Open**.
3. A box pops up warning it's from an "unidentified developer" — click **Open** again.
4. Done. It opens, and from now on you can just double-click it like any other app.

**If you don't get an "Open" button, or it still blocks you:** try to open it once (let it
get blocked), then go to **System Settings → Privacy & Security**, scroll down until you see
a line saying *"Lab Video Call was blocked…"*, and click **Open Anyway**.

**If it says "Lab Video Call is damaged and can't be opened":** don't worry, it's not
actually damaged — that's just macOS being dramatic about the unsigned thing. Open
**Terminal** (hit `Cmd + Space`, type `Terminal`, press Enter), paste this exact line, and
press Enter:

```
xattr -dr com.apple.quarantine "/Applications/Lab Video Call.app"
```

Then open the app again the normal way.

## 4. Let it use the camera and microphone

It's a video call app, so the first time it runs macOS will ask for **camera** and
**microphone** access. Click **Allow / OK** on both.

If you fat-finger "Don't Allow" by accident, you can fix it in **System Settings → Privacy
& Security → Camera** (and again under **Microphone**): just flip the switch **on** for
**Lab Video Call**, then quit and reopen it.

## 5. Quick check that it actually works

You need three machines for a real session, but here's how to confirm the Mac build itself
is healthy on one:

1. The app opens to a **sign-in** screen.
2. Type any name, put **`Admin`** in the access code box, and click **Open researcher
   dashboard**. If the dashboard loads and shows a little address at the top, you're good —
   it works. ✅
3. To get out of the locked fullscreen mode, press **Control + Shift + Q** (the **Control**
   key, *not* Command ⌘), then type `Confirm` when it asks.

---

That's everything. If anything acts weird or you get stuck on any step, just screenshot it
and text or email me and I'll sort it out fast.

Thanks for testing this!

— Alex
