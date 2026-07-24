"""JLR Online Service History (OSH) scraper for Land Rover / Range Rover / Jaguar.

Scrapes ``https://osh.landrover.com`` — the free consumer JLR service-history
portal — by VIN. No API is offered by JLR; this uses a headless Chromium
Playwright session that:

  1. Loads the homepage.
  2. Submits the VIN via the primary form.
  3. Handles the "Please select your country" modal by clicking
     "South Africa" (which is auto-suggested from the VIN's world-manufacturer
     digits for locally-registered vehicles).
  4. Waits for the resulting `/home` page and parses:
        - Vehicle Details (VIN / Model / Model Year)
        - Last Service Recorded (Type, Distance, Date, Job Number,
          Repairer Name/Location/Type, Service Items list)
        - Outstanding Alerts list.

There's NO reCAPTCHA / Cloudflare / login gate on this portal, but bear
in mind JLR own the data and their Terms of Service govern automated
access. This module runs a single browser session per lookup and does
NOT hammer the endpoint — the API route that calls it caches the
result on the submission so a VIN is only ever scraped once.

The response shape mirrors what the existing report renderer expects
(``status``, ``vin``, ``vehicle``, ``last_service``, ``alerts``) so it
plugs into the same UI / PDF flow as the ``bmw_options`` report.
"""

from __future__ import annotations

import asyncio
import logging
import re
from datetime import datetime, timezone
from typing import Optional

logger = logging.getLogger("fourbuy.landrover_osh")

OSH_URL = "https://osh.landrover.com/"

# JLR marques we let dealers order this report for. VIN validation happens
# separately (17-char, not just any string), but this stops non-JLR
# submissions surfacing the report at all.
LANDROVER_SUPPORTED_MAKES = {
    "LAND ROVER",
    "LAND-ROVER",
    "LANDROVER",
    "RANGE ROVER",
    "RANGE-ROVER",
    "JAGUAR",
}


def is_landrover_supported_make(make: Optional[str]) -> bool:
    if not make:
        return False
    return make.strip().upper() in LANDROVER_SUPPORTED_MAKES


# -----------------------------------------------------------------------------
# HTML → structured dict parser
# -----------------------------------------------------------------------------
_TAG_RE = re.compile(r"<[^>]+>")


def _strip_tags(s: str) -> str:
    return _TAG_RE.sub(" ", s or "").replace("&nbsp;", " ").strip()


def _clean(s: Optional[str]) -> Optional[str]:
    if s is None:
        return None
    v = re.sub(r"\s+", " ", _strip_tags(s)).strip(" ,-—–:\t")
    return v or None


def _extract_label_value_pairs(html: str) -> dict[str, str]:
    """Find every ``label -> value`` pair in the JLR OSH document.

    JLR renders vehicle-details in two different layouts depending on
    which tab you're on:

    1. ``/home`` uses the classic table layout with
       ``<th class="label-column">LABEL</th><td>VALUE</td>``.

    2. ``/service-history`` uses a Bootstrap grid with
       ``<div class="…theme-coloured…"><strong>LABEL:</strong></div>
       <div …><span>VALUE</span></div>`` (or a variant where the value
       sits in a sibling ``<span>`` directly under the label wrapper).

    We collect from both patterns in a single pass and key everything
    lower-cased so downstream code can pick fields out by label without
    knowing which page the HTML came from.
    """
    pairs: dict[str, str] = {}

    # (1) Classic table layout — <th class="label-column"> / <td>
    for m in re.finditer(
        r'<th[^>]*class="label-column"[^>]*>(?P<label>[^<]+)</th>\s*(?:<td[^>]*>(?P<value>[\s\S]*?)</td>)',
        html,
        flags=re.I,
    ):
        label = _clean(m.group("label")) or ""
        value = _clean(m.group("value")) or ""
        if label:
            pairs[label.lower()] = value

    # (2) Bootstrap-grid layout used on /service-history — the label is
    # inside a `theme-coloured` cell as `<strong>Label:</strong>` and the
    # value is the next sibling column. Two flavours handled:
    #   (a) same row, two columns: label div + value div (Model, Engine, ...)
    #   (b) stacked: label div then a sibling <span> (Registration country)
    for m in re.finditer(
        r'(?is)<div[^>]*class="[^"]*theme-coloured[^"]*"[^>]*>\s*<strong>\s*(?P<label>[^<:]+?)\s*:?\s*</strong>\s*</div>\s*(?P<tail>(?:<div[^>]*>[\s\S]*?</div>|<span[^>]*>[\s\S]*?</span>))',
        html,
    ):
        label = _clean(m.group("label")) or ""
        value = _clean(m.group("tail")) or ""
        if label and value and label.lower() not in pairs:
            pairs[label.lower()] = value
    return pairs


def _parse_service_items(html: str) -> list[str]:
    """Service items live inside a ``<td colspan="3">`` block as ``<div>``
    lines after the "Service Items" heading."""
    m = re.search(
        r'>\s*Service Items\s*</th>\s*<td[^>]*colspan="\d+"[^>]*>([\s\S]*?)</td>',
        html,
        flags=re.I,
    )
    if not m:
        return []
    block = m.group(1)
    items = [
        _clean(x) or ""
        for x in re.findall(r"<div[^>]*>([\s\S]*?)</div>", block)
    ]
    return [x for x in items if x]


def _parse_alerts(html: str) -> list[str]:
    m = re.search(
        r'Outstanding Alerts</h2>[\s\S]*?<ul>([\s\S]*?)</ul>',
        html,
        flags=re.I,
    )
    if not m:
        return []
    return [
        _clean(x) or ""
        for x in re.findall(r"<li[^>]*>([\s\S]*?)</li>", m.group(1))
    ] or []


def _parse_alert_count(html: str) -> Optional[int]:
    m = re.search(
        r'outstanding-alert-title[^>]*>\s*(\d+)\s+outstanding',
        html,
        flags=re.I,
    )
    if not m:
        return None
    try:
        return int(m.group(1))
    except ValueError:
        return None


def _parse_service_history_rows(html: str) -> list[dict]:
    """Extract the rows of the /service-history tab into structured dicts.

    JLR renders each service as a row inside ``#service-history-table``
    (or a similarly-named container). Each row has 5 cells in this fixed
    order: Repairer, Job Number, Job Date, Odometer, Details. Details
    can be either a short summary line, a link that expands to a list
    of items, or a nested ``<div>`` block.

    Kept intentionally forgiving — JLR occasionally shuffles the DOM.
    """
    rows: list[dict] = []
    # Find the "SERVICE HISTORY" section then walk each <tr> inside it.
    m = re.search(
        r'(?is)service\s*history\s*</h[12]>[\s\S]*?<table[^>]*>([\s\S]*?)</table>',
        html,
    )
    if not m:
        # Some JLR layouts drop the <h2> and only wrap the section in
        # a <div class="service-history…">. Try that too.
        m = re.search(
            r'(?is)<div[^>]*class="[^"]*service[-_]history[^"]*"[^>]*>([\s\S]*?)</div>\s*</section>',
            html,
        )
        if not m:
            return rows

    block = m.group(1)
    tr_re = re.compile(r"(?is)<tr[^>]*>([\s\S]*?)</tr>")
    td_re = re.compile(r"(?is)<t[dh][^>]*>([\s\S]*?)</t[dh]>")

    for tr_m in tr_re.finditer(block):
        cells = [_clean(x) or "" for x in td_re.findall(tr_m.group(1))]
        # Skip header rows and empty rows.
        if not cells or all(not c for c in cells):
            continue
        if any(c and c.lower() in {"repairer", "job number", "job date", "odometer", "details"} for c in cells):
            continue
        # Pad to 5 columns so the mapping is stable.
        while len(cells) < 5:
            cells.append("")
        rows.append(
            {
                "repairer": cells[0] or None,
                "job_number": cells[1] or None,
                "job_date": cells[2] or None,
                "odometer": cells[3] or None,
                "details": cells[4] or None,
            }
        )
    return rows


def parse_osh_home_page(html: str, vin: str) -> dict:
    """Turn the HTML of the ``/home?…`` result page into a structured dict.

    Returns ``{status:"ok"|"error", ...}`` — the calling API endpoint is
    then responsible for persisting the snapshot on the submission.
    """
    pairs = _extract_label_value_pairs(html)
    vehicle = {
        "vin": pairs.get("vehicle identification number (vin)") or vin.upper(),
        # "Model" on the SERVICE HISTORY tab looks like "Defender / L663";
        # on other tabs the label is "Model Name". Fall back through both.
        "model_name": pairs.get("model") or pairs.get("model name"),
        "model_year": pairs.get("model year"),
        "engine": pairs.get("engine"),
        "colour": pairs.get("colour") or pairs.get("color"),
        "warranty_start_date": pairs.get("warranty start date"),
        "registration_country": pairs.get("registration country") or None,
    }
    last_service = {
        "type": pairs.get("type"),
        "distance": pairs.get("distance"),
        "date": pairs.get("date"),
        "job_number": pairs.get("job number"),
        "repairer_name": pairs.get("repairer name"),
        "repairer_location": pairs.get("repairer location"),
        "repairer_type": pairs.get("repairer type"),
        "service_items": _parse_service_items(html),
    }
    alerts = _parse_alerts(html)
    alert_count = _parse_alert_count(html)
    services = _parse_service_history_rows(html)

    if not vehicle["model_name"] and not last_service["type"] and not alerts and not services:
        return {
            "status": "error",
            "error": (
                "JLR OSH returned no structured data for this VIN — the "
                "vehicle may not be in their South African service database "
                "or the page structure changed."
            ),
        }

    # Any last-service field being populated means we've got a real record.
    has_last_service = any(
        last_service.get(k) for k in
        ("type", "distance", "date", "job_number", "repairer_name")
    )

    return {
        "status": "ok",
        "vin": vin.upper(),
        "vehicle": vehicle,
        "last_service": last_service if has_last_service else None,
        "services": services,
        "alerts": alerts,
        "alert_count": alert_count if alert_count is not None else len(alerts),
        "source": "osh.landrover.com",
        "captured_at": datetime.now(timezone.utc).isoformat(),
    }


# -----------------------------------------------------------------------------
# Scraper
# -----------------------------------------------------------------------------
async def fetch_landrover_osh(vin: str, *, country_label: str = "South Africa",
                              timeout_sec: int = 60) -> dict:
    """Fetch service history for a Land Rover / Range Rover / Jaguar VIN.

    ``country_label`` is the visible-text label used to click the country
    from JLR's country picker. Defaults to South Africa since Fourbuy is
    a ZA business — override for edge cases (e.g. an imported vehicle
    still under service in another market).
    """
    try:
        from playwright.async_api import async_playwright
    except Exception as exc:  # pragma: no cover
        logger.exception("Playwright import failed")
        return {
            "status": "error",
            "error": f"Service history lookup is temporarily unavailable ({exc.__class__.__name__}). Please try again shortly.",
        }

    vin = (vin or "").strip().upper()
    if len(vin) != 17:
        return {"status": "error", "error": "VIN must be 17 characters."}

    try:
        async with async_playwright() as pw:
            try:
                browser = await pw.chromium.launch(
                    headless=True,
                    args=[
                        "--no-sandbox",
                        "--disable-blink-features=AutomationControlled",
                        "--disable-dev-shm-usage",
                    ],
                )
            except Exception as exc:
                logger.exception("Playwright chromium launch failed")
                return {
                    "status": "error",
                    "error": "Service history lookup is temporarily unavailable — the browser runtime is not ready. Please try again shortly.",
                }
            try:
                ctx = await browser.new_context(
                    user_agent=(
                        "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 "
                        "(KHTML, like Gecko) Chrome/149.0.0.0 Safari/537.36"
                    ),
                    viewport={"width": 1366, "height": 900},
                    locale="en-GB",
                )
                page = await ctx.new_page()
                await page.goto(OSH_URL, wait_until="domcontentloaded", timeout=30000)

                # Fill VIN + submit.
                await page.fill('input[name="vin"]', vin, timeout=8000)
                await page.click("#lookup-vin", timeout=8000)

                # JLR shows a modal-based country picker after the first submit.
                # The country choice is a clickable `<div data-country="XX">` — not
                # a semantic button. Country code is a stable ISO-3166 alpha-2
                # value derived from the country label; we support the two we
                # actually need in ZA today, with a text-based fallback for any
                # future country label we don't recognise.
                _ISO_BY_LABEL = {"south africa": "ZA"}
                iso = _ISO_BY_LABEL.get((country_label or "").strip().lower())
                try:
                    await page.wait_for_selector("#country-modal.in", timeout=8000)
                    if iso:
                        await page.click(f'.modal-country[data-country="{iso}"]', timeout=8000)
                    else:
                        # Text fallback — scope inside the modal to avoid clicking
                        # the disambiguating dropdown row of the same name.
                        await page.locator(
                            f'#country-modal .modal-country:has-text("{country_label}")'
                        ).first.click(timeout=8000)
                except Exception:
                    # No modal — fine.
                    pass

                # Wait for the /home page with vehicle details.
                try:
                    await page.wait_for_url(
                        re.compile(r"osh\.landrover\.com/home", re.I),
                        timeout=timeout_sec * 1000,
                    )
                except Exception:
                    pass

                # Outstanding Alerts are loaded lazily via AJAX after the main
                # page renders. Give the network a chance to settle so we
                # capture the alert list too. This also acts as a fallback
                # when wait_for_url above didn't hit /home for some reason.
                try:
                    await page.wait_for_load_state("networkidle", timeout=15000)
                except Exception:
                    pass

                result_url = page.url
                if "/home" not in result_url:
                    # Common failure: server 5xx or the VIN is unknown to JLR SA.
                    body_txt = (await page.inner_text("body"))[:300]
                    return {
                        "status": "error",
                        "error": f"JLR OSH did not return a result page (URL={result_url}). Body: {body_txt!r}",
                    }

                html = await page.content()
                parsed = parse_osh_home_page(html, vin)
                parsed["result_url"] = result_url

                # If the home page succeeded, click through to the
                # SERVICE HISTORY tab and merge its extra data — the full
                # per-service table + richer vehicle details (Engine,
                # Colour, Warranty Start Date, Registration Country).
                if parsed.get("status") == "ok":
                    try:
                        # Direct URL rewrite is far more reliable than
                        # clicking the nav-tab — JLR keeps the session
                        # token in the query string, so we just swap the
                        # path segment and let their server redirect us
                        # to the tabbed view. If it 404s, we still have
                        # the /home data already parsed.
                        sh_target = re.sub(
                            r"osh\.landrover\.com/home",
                            "osh.landrover.com/service-history",
                            result_url,
                            count=1,
                            flags=re.I,
                        )
                        await page.goto(
                            sh_target,
                            wait_until="domcontentloaded",
                            timeout=20000,
                        )
                        try:
                            await page.wait_for_load_state("networkidle", timeout=10000)
                        except Exception:
                            pass
                        sh_html = await page.content()
                        # Re-parse with the service-history HTML — it
                        # contains the fuller vehicle-details block AND
                        # the service-history table.
                        sh_parsed = parse_osh_home_page(sh_html, vin)
                        if sh_parsed.get("status") == "ok":
                            # Preserve any keys populated on /home that
                            # aren't repeated on /service-history.
                            merged_vehicle = {
                                **(parsed.get("vehicle") or {}),
                                **{
                                    k: v
                                    for k, v in (sh_parsed.get("vehicle") or {}).items()
                                    if v
                                },
                            }
                            parsed["vehicle"] = merged_vehicle
                            services = sh_parsed.get("services") or []
                            if services:
                                parsed["services"] = services
                            parsed["service_history_url"] = page.url
                    except Exception:
                        logger.exception(
                            "landrover_osh: SERVICE HISTORY tab enrichment failed "
                            "(returning /home data only)"
                        )
                return parsed
            finally:
                try:
                    await browser.close()
                except Exception:
                    pass
    except Exception as exc:
        logger.exception("JLR OSH scrape failed unexpectedly")
        return {
            "status": "error",
            "error": f"Service history lookup failed unexpectedly ({exc.__class__.__name__}). Please try again shortly.",
        }
