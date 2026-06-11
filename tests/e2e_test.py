# End-to-end test of the 3-seat lab video call (browser harness).
# Requires: standalone session server on :8771, next dev on :8888.
import sys
import time
from playwright.sync_api import sync_playwright

BASE = "http://localhost:8888"
ART = "scratchpad"
FAILURES = []


def check(name, cond):
    print(("PASS  " if cond else "FAIL  ") + name)
    if not cond:
        FAILURES.append(name)


def sign_in(page, name, pid, dyad, code=""):
    page.goto(BASE, wait_until="networkidle")
    page.fill('input[placeholder="First and last name"]', name)
    if pid:
        page.fill('input[placeholder="e.g. 1043"]', pid)
    if dyad:
        page.fill('input[placeholder="e.g. D22"]', dyad)
    if code:
        page.fill('input[placeholder="Leave blank to join as participant"]', code)
    page.click("button:has-text('Open researcher dashboard')" if code.lower() == "admin"
               else "button:has-text('Join the call')")


def video_playing(locator):
    el = locator.first.element_handle(timeout=5000)
    if el is None:
        return False
    return el.evaluate("v => !!v.srcObject && v.videoWidth > 0 && !v.paused")


def panel(page, slot):
    return page.locator(f"section:has(h2:has-text('{slot}'))")


with sync_playwright() as p:
    browser = p.chromium.launch(
        headless=True,
        args=[
            "--use-fake-ui-for-media-stream",
            "--use-fake-device-for-media-stream",
            "--autoplay-policy=no-user-gesture-required",
        ],
    )
    ctx = browser.new_context(permissions=["camera", "microphone"])
    admin = ctx.new_page()
    p1 = ctx.new_page()
    p2 = ctx.new_page()
    for pg, label in [(admin, "admin"), (p1, "p1"), (p2, "p2")]:
        pg.on("console", lambda m, l=label: m.type == "error" and print(f"[{l} console.error] {m.text}"))
        pg.on("pageerror", lambda e, l=label: print(f"[{l} pageerror] {e}"))

    # --- Sign-ins ---
    sign_in(admin, "Test RA", "", "", code="Admin")
    admin.wait_for_selector("text=Researcher Dashboard", timeout=15000)
    check("admin reaches dashboard", True)

    sign_in(p1, "Alice Test", "101", "D7")
    p1.wait_for_selector("text=Please wait for the researcher to start", timeout=15000)
    check("p1 sees waiting screen", True)

    sign_in(p2, "Bob Test", "102", "D7")
    p2.wait_for_selector("text=Please wait for the researcher to start", timeout=15000)

    # --- Waiting room: both seats fill, previews arrive, Start enables ---
    admin.wait_for_selector("text=P1 · Alice Test", timeout=20000)
    admin.wait_for_selector("text=P2 · Bob Test", timeout=20000)
    check("admin shows both names", True)

    start = admin.locator("button:has-text('Start conversation')")
    for _ in range(60):  # effects pipeline warm-up (model download on first run)
        if start.is_enabled():
            break
        time.sleep(1)
    check("Start enabled once both ready", start.is_enabled())

    time.sleep(3)  # let preview WebRTC settle
    check("admin sees P1 preview video", video_playing(panel(admin, "P1").locator("video")))
    check("admin sees P2 preview video", video_playing(panel(admin, "P2").locator("video")))
    check("p1 still waiting (no partner view before start)",
          p1.locator("h1:has-text('Please wait for the researcher to start')").is_visible())

    admin.screenshot(path=f"{ART}/shot_admin_waiting.png", full_page=True)
    p1.screenshot(path=f"{ART}/shot_p1_waiting.png")

    # --- Start the conversation ---
    start.click()
    p1.wait_for_selector("div:text-is('Bob Test')", timeout=20000)
    p2.wait_for_selector("div:text-is('Alice Test')", timeout=20000)
    time.sleep(2)
    check("p1 sees partner video", video_playing(p1.locator("video.object-cover")))
    check("p2 sees partner video", video_playing(p2.locator("video.object-cover")))
    check("p1 self PiP playing", video_playing(p1.locator("div.bottom-6.right-6 video")))
    check("admin timer visible", admin.locator("text=End session").is_visible())

    # --- Effects: preset to P1, telemetry confirms applied ---
    panel(admin, "P1").locator("button:has-text('Smile + (strong)')").click()
    applied = False
    for _ in range(8):
        time.sleep(1)
        if panel(admin, "P1").locator("text=applied").count() > 0:
            applied = True
            break
    check("P1 effect applied (telemetry round-trip)", applied)
    check("P1 panel shows MODIFIED badge", panel(admin, "P1").locator("text=MODIFIED").is_visible())
    check("P2 panel NOT modified", not panel(admin, "P2").locator("text=MODIFIED").is_visible())

    # --- Banner ---
    admin.fill('input[placeholder="e.g. Five minutes remaining"]', "Test banner message")
    admin.locator("button:has-text('Send')").click()
    p1.wait_for_selector("text=Test banner message", timeout=8000)
    p2.wait_for_selector("text=Test banner message", timeout=8000)
    check("banner shows on both participants", True)

    # --- Researcher mic toggle (logging path) ---
    admin.locator("button:has-text('Unmute mic')").click()
    time.sleep(0.5)
    check("mic shows LIVE", admin.locator("button:has-text('Mic LIVE')").is_visible())
    admin.locator("button:has-text('Mic LIVE')").click()

    # --- Event log streaming ---
    check("event log shows effect command", admin.locator("text=preset_applied").first.is_visible())
    check("event log shows banner", admin.locator("text=banner_sent").first.is_visible())

    admin.screenshot(path=f"{ART}/shot_admin_live.png", full_page=True)
    p1.screenshot(path=f"{ART}/shot_p1_live.png")
    p2.screenshot(path=f"{ART}/shot_p2_live.png")

    # --- End session ---
    admin.locator("button:has-text('End session')").click()
    admin.locator("div.fixed button:has-text('End session')").click()
    p1.wait_for_selector("text=The conversation has ended", timeout=10000)
    p2.wait_for_selector("text=The conversation has ended", timeout=10000)
    check("participants see ended screen", True)
    admin.screenshot(path=f"{ART}/shot_admin_ended.png", full_page=True)
    p1.screenshot(path=f"{ART}/shot_p1_ended.png")

    browser.close()

print()
if FAILURES:
    print(f"{len(FAILURES)} FAILURES: {FAILURES}")
    sys.exit(1)
print("ALL CHECKS PASSED")
