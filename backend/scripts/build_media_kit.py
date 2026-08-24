"""Generate the TradeAPP media-kit screenshots.
Uses Playwright directly (rather than the sandboxed screenshot_tool)
so the PNGs land on disk at /app/media_kit/screenshots/."""
import asyncio
from pathlib import Path
from playwright.async_api import async_playwright

OUT = Path("/app/media_kit/screenshots")
OUT.mkdir(parents=True, exist_ok=True)


async def login_dealer(page):
    await page.goto("http://localhost:3000/login", wait_until="domcontentloaded")
    await page.wait_for_function(
        "document.querySelector('#root') && document.querySelector('#root').innerText.trim().length > 0",
        timeout=45000,
    )
    await page.wait_for_timeout(3500)
    await page.get_by_test_id("login-email-input").fill("dave@tradeapp.co.za")
    await page.get_by_test_id("login-password-input").fill("Dave1234!")
    await page.get_by_test_id("login-submit-button").click()
    await page.wait_for_timeout(7000)
    try:
        agree = page.get_by_text("I agree", exact=False).first
        if await agree.is_visible():
            await agree.click()
            await page.wait_for_timeout(2000)
    except Exception:
        pass


async def login_admin(page):
    await page.goto("http://localhost:3000/login", wait_until="domcontentloaded")
    await page.wait_for_function(
        "document.querySelector('#root') && document.querySelector('#root').innerText.trim().length > 0",
        timeout=45000,
    )
    await page.wait_for_timeout(3500)
    await page.get_by_test_id("login-email-input").fill("admin@tradeapp.co.za")
    await page.get_by_test_id("login-password-input").fill("admin123")
    await page.get_by_test_id("login-submit-button").click()
    await page.wait_for_timeout(7000)


async def snap(page, filename: str, wait_ms: int = 5000):
    await page.wait_for_timeout(wait_ms)
    path = OUT / filename
    await page.screenshot(path=str(path), full_page=False, type="png")
    print(f"  ✓ {filename}  ({path.stat().st_size // 1024} KB)")


async def go(page, url: str, extra_ms: int = 5000):
    await page.goto(url, wait_until="domcontentloaded")
    try:
        await page.wait_for_function(
            "document.querySelector('#root') && document.querySelector('#root').innerText.trim().length > 0",
            timeout=15000,
        )
    except Exception:
        pass
    await page.wait_for_timeout(extra_ms)


async def main() -> None:
    async with async_playwright() as pw:
        browser = await pw.chromium.launch(headless=True, args=["--no-sandbox"])

        # -------- mobile 390×844 -------- #
        ctx = await browser.new_context(viewport={"width": 390, "height": 844})
        page = await ctx.new_page()

        # 01 — Login mobile
        await page.goto("http://localhost:3000/login", wait_until="domcontentloaded")
        await page.wait_for_function(
            "document.querySelector('#root') && document.querySelector('#root').innerText.trim().length > 0",
            timeout=45000,
        )
        await snap(page, "01_login_mobile.png", wait_ms=3500)

        # Log in as dealer for the rest of the mobile shots.
        await login_dealer(page)

        # 02 — Home dashboard (wait for hero video to freeze)
        await go(page, "http://localhost:3000/", extra_ms=13000)
        await snap(page, "02_home_mobile.png", wait_ms=0)

        # 03 — Submissions list
        await go(page, "http://localhost:3000/submissions")
        await snap(page, "03_submissions_list.png", wait_ms=0)

        # 04 — Submit form
        await go(page, "http://localhost:3000/submit")
        await snap(page, "04_submit_form.png", wait_ms=0)

        # 05 — Vehicle detail top (FB-000154 Range Rover Sport)
        await go(page, "http://localhost:3000/vehicle/501a96d4-a0d2-490f-b0c8-cf902ff69c95", extra_ms=6000)
        await snap(page, "05_vehicle_detail.png", wait_ms=0)

        # 06 + 07 — scroll to Market Values / AI Insights section
        await page.evaluate("window.scrollTo(0, 900)")
        await snap(page, "06_vehicle_market_values.png", wait_ms=2500)
        await page.evaluate("window.scrollTo(0, 1600)")
        await snap(page, "07_ai_insights.png", wait_ms=2500)

        # Try to open VIN reports + owner timeline modal for the 08 shot.
        try:
            toggle = page.get_by_text("Order a VIN-Linked Report", exact=False).first
            await toggle.click(timeout=5000)
            await page.wait_for_timeout(2500)
            chip = page.get_by_test_id("cartrust-ownership-ready")
            await chip.wait_for(timeout=10000)
            await chip.scroll_into_view_if_needed()
            await page.wait_for_timeout(1500)
            await snap(page, "08_vin_reports_owner_peek.png", wait_ms=0)
            await chip.click()
            await page.wait_for_timeout(2000)
            await snap(page, "09_owner_timeline.png", wait_ms=0)
        except Exception as e:
            print(f"  ⚠ owner timeline skipped: {e}")

        # 10 — Stock list
        await go(page, "http://localhost:3000/stock")
        await snap(page, "10_stock_list.png", wait_ms=0)

        # 11 — Billing
        await go(page, "http://localhost:3000/billing")
        await snap(page, "11_billing.png", wait_ms=0)

        # 12 — Rewards
        await go(page, "http://localhost:3000/rewards")
        await snap(page, "12_rewards.png", wait_ms=0)

        # 13 — Profile
        await go(page, "http://localhost:3000/profile")
        await snap(page, "13_profile.png", wait_ms=0)

        await ctx.close()

        # -------- desktop 1440×900 -------- #
        ctx = await browser.new_context(viewport={"width": 1440, "height": 900})
        page = await ctx.new_page()

        # 14 — Desktop login split-screen
        await page.goto("http://localhost:3000/login", wait_until="domcontentloaded")
        await page.wait_for_function(
            "document.querySelector('#root') && document.querySelector('#root').innerText.trim().length > 0",
            timeout=45000,
        )
        await snap(page, "14_login_desktop.png", wait_ms=4000)

        # 15 — Desktop dealer home
        await login_dealer(page)
        await go(page, "http://localhost:3000/", extra_ms=13000)
        await snap(page, "15_home_desktop.png", wait_ms=0)
        await ctx.close()

        # -------- admin cockpit -------- #
        ctx = await browser.new_context(viewport={"width": 1440, "height": 900})
        page = await ctx.new_page()
        await login_admin(page)
        await snap(page, "16_admin_cockpit_desktop.png", wait_ms=3000)
        await ctx.close()

        await browser.close()


if __name__ == "__main__":
    asyncio.run(main())
