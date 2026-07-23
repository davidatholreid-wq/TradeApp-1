"""bimmer.work factory-spec scraper.

bimmer.work is a free consumer-facing VIN decoder for BMW / MINI / Rolls-Royce
/ ALPINA vehicles. It has NO API, and the form is protected by Google
reCAPTCHA Enterprise (invisible v3-style).

Flow:

  1. Fire a headless Chromium via Playwright.
  2. Navigate to https://bimmer.work/ .
  3. Ask 2captcha to solve the reCAPTCHA-Enterprise token using the
     `googlekey` + `pageurl` + `enterprise=1` mode.
  4. Inject the returned token into the page (`grecaptcha.enterprise.execute`
     is overridden to always resolve with the pre-fetched token). This works
     because bimmer.work reads the token from `grecaptcha.enterprise.execute`
     right before it submits the form.
  5. Fill the VIN input, click submit, wait for navigation to the result
     page (URL becomes /vin/<VIN>).
  6. Parse the result page for build metadata + options list.
  7. Return a structured dict; the caller is responsible for persisting
     the snapshot on the submission.

Caching (both the caller-level submission snapshot AND 2captcha's own
cache) makes this cheap in the steady state — the same VIN will only
consume a solve credit once, ever.

The whole thing is guarded by generous timeouts and returns a structured
`{status, error, ...}` payload rather than raising, so the API endpoint
can surface a helpful message to the admin without a 500.
"""

from __future__ import annotations

import asyncio
import logging
import os
import re
from typing import Any, Optional

import httpx

logger = logging.getLogger("fourbuy.bimmer")

BIMMER_URL = "https://bimmer.work/"
# Sitekey is embedded in the bimmer.work homepage under
# `render=<sitekey>` on the enterprise recaptcha include. It is stable per
# domain; we hard-code it as a fast path but ALSO re-read it from the page
# so a bimmer.work rotation would be handled gracefully.
BIMMER_RECAPTCHA_SITEKEY = "6LfsY2QsAAAAABuy0k9x8b_JR9fKtWsRQatPpnBk"

# BMW Group makes that bimmer.work supports. We use this on the endpoint
# side to reject non-BMW submissions before wasting a captcha solve.
BIMMER_SUPPORTED_MAKES = {"BMW", "MINI", "ROLLS-ROYCE", "ROLLS ROYCE", "ALPINA"}


def is_bimmer_supported_make(make: Optional[str]) -> bool:
    if not make:
        return False
    return make.strip().upper() in BIMMER_SUPPORTED_MAKES


# -----------------------------------------------------------------------------
# 2captcha helpers (async HTTP)
# -----------------------------------------------------------------------------
_TWO_CAPTCHA_IN = "https://2captcha.com/in.php"
_TWO_CAPTCHA_RES = "https://2captcha.com/res.php"


async def _twocaptcha_solve_enterprise(
    *,
    api_key: str,
    sitekey: str,
    page_url: str,
    action: str = "verify",
    poll_interval_sec: int = 4,
    max_wait_sec: int = 180,
) -> str:
    """Submit an Enterprise reCAPTCHA task to 2captcha and return the g-recaptcha
    response token when solved. Raises RuntimeError on hard failure.

    2captcha docs for enterprise:
        https://2captcha.com/2captcha-api#solving_recaptchav3
    (adding ``enterprise=1``).
    """
    async with httpx.AsyncClient(timeout=60) as http:
        params_submit = {
            "key": api_key,
            "method": "userrecaptcha",
            "googlekey": sitekey,
            "pageurl": page_url,
            "version": "v3",
            "enterprise": 1,
            "action": action,
            "min_score": 0.3,
            "json": 1,
        }
        try:
            r = await http.post(_TWO_CAPTCHA_IN, data=params_submit)
            data = r.json()
        except Exception as e:  # noqa: BLE001
            raise RuntimeError(f"2captcha submit request failed: {e!r}") from e
        if data.get("status") != 1:
            raise RuntimeError(f"2captcha submit rejected: {data!r}")
        req_id = data["request"]
        logger.info("bimmer.work: 2captcha request id %s submitted", req_id)

        # Poll for the token. 2captcha needs ~15-45s for enterprise v3.
        deadline = asyncio.get_event_loop().time() + max_wait_sec
        last_msg = None
        while asyncio.get_event_loop().time() < deadline:
            await asyncio.sleep(poll_interval_sec)
            try:
                rr = await http.get(
                    _TWO_CAPTCHA_RES,
                    params={"key": api_key, "action": "get", "id": req_id, "json": 1},
                )
                rj = rr.json()
            except Exception as e:  # noqa: BLE001
                last_msg = f"poll error: {e!r}"
                continue
            if rj.get("status") == 1:
                return rj["request"]
            last_msg = str(rj)
            if rj.get("request") == "CAPCHA_NOT_READY":
                continue
            raise RuntimeError(f"2captcha result error: {rj!r}")
        raise RuntimeError(f"2captcha solve timed out (last={last_msg})")


# -----------------------------------------------------------------------------
# Scraper
# -----------------------------------------------------------------------------
async def fetch_bimmer_spec(vin: str, *, twocaptcha_key: Optional[str] = None,
                            timeout_sec: int = 90) -> dict:
    """Scrape bimmer.work for factory spec of a VIN.

    Returns::
        {
            "status": "ok" | "error",
            "error": Optional[str],       # only when status=error
            "vin": <upper vin>,
            "build_date": Optional[str],  # e.g. "2019-03-12" or "Mar/2019"
            "plant": Optional[str],
            "destination": Optional[str],
            "model": Optional[str],       # marketing name (e.g. "320d Sedan")
            "model_type_code": Optional[str],  # e.g. "3D31" internal chassis code
            "options": [                  # ordered list
                {"code": "S1AC", "description": "Adaptive suspension"},
                ...
            ],
            "raw_url": <bimmer.work result URL>,
            "captured_at": <utc iso>,
        }
    """
    from datetime import datetime, timezone
    from playwright.async_api import async_playwright

    vin = (vin or "").strip().upper()
    if len(vin) != 17:
        return {"status": "error", "error": "VIN must be 17 characters."}

    key = (twocaptcha_key or os.getenv("TWOCAPTCHA_API_KEY") or "").strip()
    if not key:
        return {"status": "error", "error": "2captcha API key is not configured on the server."}

    async with async_playwright() as pw:
        browser = await pw.chromium.launch(
            headless=True,
            args=[
                "--no-sandbox",
                "--disable-blink-features=AutomationControlled",
                "--disable-dev-shm-usage",
            ],
        )
        try:
            ctx = await browser.new_context(
                user_agent=(
                    "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 "
                    "(KHTML, like Gecko) Chrome/149.0.0.0 Safari/537.36"
                ),
                viewport={"width": 1366, "height": 900},
                locale="en-GB",
            )
            # Block noisy 3rd-party ad/analytics content — otherwise Google
            # AdSense iframes sit on top of the Submit button and Playwright
            # cannot click through them. This also speeds the page up
            # significantly (~3× fewer requests). Google reCAPTCHA
            # endpoints are NOT blocked, they're still needed for site-key
            # validation on the server side.
            _AD_HOST_RE = re.compile(
                r"(doubleclick\.net|googlesyndication\.com|googletagmanager\.com|"
                r"google-analytics\.com|adservice\.google|pagead2\.googlesyndication\.com|"
                r"adsystem\.com|adsafeprotected\.com|scorecardresearch\.com)",
                re.I,
            )
            async def _block_ads(route):  # noqa: ANN001
                try:
                    if _AD_HOST_RE.search(route.request.url):
                        await route.abort()
                        return
                    await route.continue_()
                except Exception:
                    try:
                        await route.continue_()
                    except Exception:
                        pass
            await ctx.route("**/*", _block_ads)

            page = await ctx.new_page()
            await page.goto(BIMMER_URL, wait_until="domcontentloaded", timeout=30000)

            # Re-discover the sitekey defensively in case bimmer.work rotates it.
            sitekey = BIMMER_RECAPTCHA_SITEKEY
            try:
                html = await page.content()
                m = re.search(r"render=([A-Za-z0-9_-]{30,})", html)
                if m:
                    sitekey = m.group(1)
            except Exception:
                pass

            # Solve enterprise reCAPTCHA via 2captcha BEFORE clicking submit,
            # so we can inject the token into `grecaptcha.enterprise.execute`.
            try:
                token = await _twocaptcha_solve_enterprise(
                    api_key=key, sitekey=sitekey, page_url=BIMMER_URL,
                )
            except Exception as e:
                logger.warning("bimmer.work: captcha solve failed: %s", e)
                return {"status": "error", "error": f"reCAPTCHA solve failed: {e}"}

            # Override grecaptcha.enterprise.execute so ANY call from
            # bimmer.work's frontend resolves with our pre-fetched token,
            # AND directly write the token into the hidden #recaptcha_token
            # input which bimmer.work's own JS posts to /query.php.
            await page.evaluate(
                """(t) => {
                    const proxyExec = () => Promise.resolve(t);
                    if (window.grecaptcha && window.grecaptcha.enterprise) {
                        window.grecaptcha.enterprise.execute = proxyExec;
                        window.grecaptcha.enterprise.ready = (cb) => cb && cb();
                    }
                    // Also patch the classic API in case it's used anywhere.
                    if (window.grecaptcha) {
                        window.grecaptcha.execute = proxyExec;
                        window.grecaptcha.ready = (cb) => cb && cb();
                    }
                    // bimmer.work posts the token via a hidden field.
                    const hidden = document.getElementById('recaptcha_token')
                        || document.querySelector('input[name="recaptcha_token"]');
                    if (hidden) hidden.value = t;
                    // Some sites just read the token from a hidden textarea.
                    const el = document.getElementById('g-recaptcha-response');
                    if (el) el.value = t;
                }""",
                token,
            )

            # Find the VIN input + submit button. bimmer.work uses a plain
            # text input; the CSS looks stable enough to select by placeholder
            # or name. Fall back to any visible textbox on the page.
            filled = False
            for sel in [
                'input[name="vin"]',
                'input[placeholder="VIN"]',
                'input[type="text"]',
                'input[type="search"]',
            ]:
                try:
                    inp = page.locator(sel).first
                    if await inp.count() > 0:
                        await inp.fill(vin, timeout=5000)
                        filled = True
                        break
                except Exception:
                    continue
            if not filled:
                return {"status": "error", "error": "VIN input not found on bimmer.work homepage."}

            # Submit. Ads sometimes sit on top of the Submit button, so
            # rather than clicking (which Playwright refuses when
            # obstructed), we trigger form.requestSubmit() / .submit()
            # programmatically. Falls back to Enter-press if no form is
            # found.
            submitted = await page.evaluate(
                """() => {
                    const inp = document.querySelector('input[name=\"vin\"]')
                        || document.querySelector('input[type=\"text\"]')
                        || document.querySelector('input[type=\"search\"]');
                    if (!inp) return false;
                    const form = inp.form || inp.closest('form');
                    if (form && form.requestSubmit) { form.requestSubmit(); return true; }
                    if (form && form.submit) { form.submit(); return true; }
                    const btn = document.querySelector('button[type=\"submit\"], input[type=\"submit\"]');
                    if (btn) { btn.click(); return true; }
                    return false;
                }"""
            )
            if not submitted:
                try:
                    await page.keyboard.press("Enter")
                except Exception:
                    pass

            # Wait for the form POST to land somewhere — /vin/<VIN> on
            # success, /429/ if rate-limited, or /403/ on outright rejection.
            # We accept ANY of these and then classify from the URL/body.
            try:
                await page.wait_for_url(
                    re.compile(r"bimmer\.work/(vin/|429|403|error)", re.I),
                    timeout=timeout_sec * 1000,
                )
            except Exception:
                # Fall back: wait for either a stable result URL or common
                # result markup on the page.
                try:
                    await page.wait_for_load_state("networkidle", timeout=15000)
                except Exception:
                    pass

            result_url = page.url
            body_text = (await page.inner_text("body")) or ""
            # bimmer.work bounces us to /429/ when its free tier is
            # exhausted for the current IP/session. Surface that as a
            # distinct, actionable error rather than a generic timeout.
            if "/429" in result_url or "429 Too Many Requests" in body_text:
                return {
                    "status": "error",
                    "error": (
                        "bimmer.work rate-limited this request (HTTP 429). "
                        "The free lookup quota for this IP has been reached — "
                        "try again later, or subscribe to their paid API."
                    ),
                }
            if "/403" in result_url:
                return {"status": "error", "error": "bimmer.work rejected the request (HTTP 403)."}
            if "not found" in body_text.lower() and "vin" in body_text.lower():
                return {"status": "error", "error": "VIN not found on bimmer.work."}

            # ---- Parse ----------------------------------------------------
            # bimmer.work uses <table> rows and <li> lists in the modern UI.
            # We defensively extract the raw HTML and pull out:
            #   • Model / marketing name  (page <h1> / <h2>)
            #   • Build date / plant / destination (labelled rows or
            #     `<dt>Build Date</dt><dd>…</dd>`)
            #   • Options list (rows of "S1AC — Adaptive suspension" style)
            html = await page.content()

            def _rx_first(pattern: str) -> Optional[str]:
                m = re.search(pattern, html, flags=re.I)
                return m.group(1).strip() if m else None

            def _text_after_label(label: str) -> Optional[str]:
                """Find "<label>: value" or "<label></...>value</...>" pairs
                in the rendered text, whichever wins."""
                # Try labelled DL first
                m = re.search(
                    rf"<(?:dt|th|strong|b|span)[^>]*>\s*{re.escape(label)}\s*[:]?\s*</(?:dt|th|strong|b|span)>\s*<(?:dd|td|span|div)[^>]*>([^<]+)",
                    html, flags=re.I,
                )
                if m:
                    return m.group(1).strip()
                # Fallback: plain text
                m2 = re.search(rf"{re.escape(label)}\s*[:\-]\s*([^\n<]+)", body_text, flags=re.I)
                return m2.group(1).strip() if m2 else None

            # Marketing model name — try structured then falls back to first
            # H1/H2 on the page.
            model_name = _rx_first(r"<h1[^>]*>([^<]+)</h1>")
            if not model_name:
                model_name = _rx_first(r"<h2[^>]*>([^<]+)</h2>")

            model_type_code = (
                _text_after_label("Type code")
                or _text_after_label("Model code")
                or _text_after_label("Chassis")
            )
            build_date = (
                _text_after_label("Production date")
                or _text_after_label("Build date")
                or _text_after_label("Assembly date")
            )
            plant = _text_after_label("Plant") or _text_after_label("Assembly plant")
            destination = _text_after_label("Destination") or _text_after_label("Country")

            # Options list: match "SXXXX — <description>" or "SXXXX <description>"
            # patterns anywhere in the body. bimmer.work's option codes are
            # 4-char alphanumeric starting with S / P / etc.
            opts_seen: set[str] = set()
            options: list[dict[str, str]] = []
            for m in re.finditer(
                r"\b([SPZ][A-Z0-9]{3})\b\s*(?:[-–—:]\s*|</[a-z]+>\s*<[a-z]+[^>]*>)\s*([A-Z0-9][^\n<]{2,120}?)(?=<|\n|$)",
                html,
            ):
                code = m.group(1).strip().upper()
                desc = re.sub(r"\s+", " ", m.group(2)).strip(" .,-—–")
                if code in opts_seen:
                    continue
                opts_seen.add(code)
                options.append({"code": code, "description": desc})

            # Try a text-based fallback if the HTML pattern turned up nothing
            # (structure varies between BMW motorcycle vs car pages).
            if not options:
                for line in body_text.splitlines():
                    line = line.strip()
                    m = re.match(r"^([SPZ][A-Z0-9]{3})\s+(.{3,120})$", line)
                    if m:
                        code = m.group(1).upper()
                        if code in opts_seen:
                            continue
                        opts_seen.add(code)
                        options.append({"code": code, "description": m.group(2).strip()})

            if not options and not model_name and not build_date:
                return {"status": "error", "error": "bimmer.work returned no structured data — VIN may be invalid or the page structure changed."}

            return {
                "status": "ok",
                "vin": vin,
                "model": model_name,
                "model_type_code": model_type_code,
                "build_date": build_date,
                "plant": plant,
                "destination": destination,
                "options": options,
                "raw_url": result_url,
                "captured_at": datetime.now(timezone.utc).isoformat(),
                "source": "bimmer.work",
            }

        finally:
            await browser.close()
