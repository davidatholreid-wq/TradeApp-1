"""Mercedes-Benz VIN datacard client (mbtools.com / mb.vin).

Vendor: mbtools.com — the sanctioned developer API behind the mb.vin
consumer front-end (confirmed same operator as bimmer.work / Bimmervin).
This is the Mercedes twin of `services.bimmervin_client`.

Auth:
    Simple `apiKey=<hex64>` query string, no OAuth handshake. The key is
    read from ``MBTOOLS_API_KEY`` in the backend .env.

Endpoint:
    GET https://api.mbtools.com/vehicle/{VIN}?language=en&apiKey=…

Response shape (as of Nov 2026):
    {
      "chassis": "206",
      "saCodes": [{"saCode": "250A"}, {"saCode": "250", "salesTerm": "AMG Driver's package"}, ...],
      "vehicle": "null null" | "<model description>",
      "body":    "sedan" | null,
      "vin":     "W1K…",
      "modelYear": "804",
      "image":   "" | "<url>",
      "model":   "087",
      "fuel":    "Petrol" | "Diesel" | ...,
      "year":    2024,
      "isFacelift": false,
      "headunit": {"generation": ["NTG 7"], "isHigh": true, "naviData": {…}},
      "controlUnits": ["ic223", …],
      "possibleCodings": [ {…retrofit options…} ],
      "notes": [ … ]
    }

We normalise this into the same shape as the BMW `bimmer_spec` so the
existing PDF renderer + admin UI + valuation summary path stays
unchanged — just a new `is_mb_supported_make()` guard toggles it on for
Mercedes-family vehicles.
"""

from __future__ import annotations

import logging
import os
from typing import Any, Optional

import httpx

logger = logging.getLogger("mbtools")

MBTOOLS_API_BASE = os.environ.get("MBTOOLS_API_BASE", "https://api.mbtools.com").rstrip("/")
MBTOOLS_API_KEY = os.environ.get("MBTOOLS_API_KEY", "")

# Every SA make spelling we accept as "Mercedes-family". These get
# whitelisted in REPORT_CATALOG so the mb_options button only surfaces
# on the right cars. Keep this list broad so we catch typos / variants.
MB_SUPPORTED_MAKES: list[str] = [
    "MERCEDES-BENZ",
    "MERCEDES BENZ",
    "MERCEDES",
    "MERCEDES-AMG",
    "MERCEDES AMG",
    "AMG",
    "MERCEDES-MAYBACH",
    "MERCEDES MAYBACH",
    "MAYBACH",
    "SMART",
]


def is_mb_supported_make(make: str | None) -> bool:
    """True when the given raw make string maps to a Mercedes-family
    marque supported by mbtools.com. Comparison is case- and
    punctuation-insensitive.
    """
    if not make:
        return False
    m = make.upper().strip()
    if m in MB_SUPPORTED_MAKES:
        return True
    # Fallback substring — catches oddities like "MERCEDES BENZ SA" or
    # "MERCEDES-BENZ COMMERCIAL VEHICLES".
    for token in ("MERCEDES", "MAYBACH"):
        if token in m:
            return True
    if m == "SMART":
        return True
    return False


async def _fetch_raw(vin: str) -> dict[str, Any]:
    """Raw GET against mbtools with proper timeouts + retries.

    Only raises for hard transport errors — application-level errors
    (bad VIN, no data) are returned inside the dict for the caller to
    interpret.
    """
    if not MBTOOLS_API_KEY:
        raise RuntimeError(
            "mbtools: MBTOOLS_API_KEY not configured — cannot make live lookup."
        )
    url = f"{MBTOOLS_API_BASE}/vehicle/{vin}"
    params = {"language": "en", "apiKey": MBTOOLS_API_KEY}
    async with httpx.AsyncClient(timeout=30.0) as http:
        r = await http.get(url, params=params)
    if r.status_code == 401 or r.status_code == 403:
        raise RuntimeError(
            f"mbtools auth error {r.status_code} — check MBTOOLS_API_KEY. "
            f"body={r.text[:200]!r}"
        )
    if r.status_code == 404:
        # mbtools returns 404 when no data exists for this VIN.
        return {"__mbtools_status__": "not_found"}
    if r.status_code >= 500:
        raise RuntimeError(
            f"mbtools upstream error {r.status_code}: {r.text[:200]!r}"
        )
    if r.status_code != 200:
        raise RuntimeError(
            f"mbtools unexpected status {r.status_code}: {r.text[:200]!r}"
        )
    try:
        return r.json()
    except Exception as e:
        raise RuntimeError(f"mbtools returned non-JSON body: {e} — {r.text[:200]!r}")


def describe_option_code(code: str, sa_codes: list[dict[str, Any]]) -> Optional[str]:
    """Return the English `salesTerm` for a Mercedes SA code if the API
    supplied one. Unknown codes return None so the UI can render code-only.
    """
    if not code:
        return None
    c = code.upper().strip()
    for entry in sa_codes or []:
        if not isinstance(entry, dict):
            continue
        if str(entry.get("saCode", "")).upper().strip() == c:
            term = entry.get("salesTerm")
            if term and isinstance(term, str):
                return term.strip()
            return None
    return None


def _normalise_datacard(raw: dict[str, Any]) -> dict[str, Any]:
    """Map mbtools /vehicle/{VIN} payload into the same shape the app
    already renders for BMW factory options (`bimmer_spec`).

    Output shape::

        {
          "status": "ok",
          "provider": "mbtools",
          "vin": "…",
          "series": "206",           # chassis code, e.g. W206
          "model_code": "087",       # internal model
          "model_year_code": "804",
          "year": 2024,
          "fuel": "Petrol",
          "body": None | "sedan",
          "is_facelift": False,
          "vehicle_desc": "C 63 …",  # empty when API returns "null null"
          "image_url": "" | "…",
          "headunit": {"generation": "NTG 7", "is_high": True,
                       "navi_region": "Africa/Middle East"},
          "options": [
            {"code": "250A", "kind": "SA", "description": None},
            {"code": "250",  "kind": "SA", "description": "AMG Driver's package"},
            …
          ],
          "options_with_desc": 60,
          "options_total":     153,
          "raw": {…}                 # kept for the admin forensic view
        }
    """
    sa_codes = raw.get("saCodes") or []

    options: list[dict[str, Any]] = []
    seen: set[str] = set()
    for entry in sa_codes:
        if not isinstance(entry, dict):
            continue
        code = str(entry.get("saCode", "")).strip().upper()
        if not code or code in seen:
            continue
        seen.add(code)
        term = entry.get("salesTerm")
        options.append({
            "code": code,
            "kind": "SA",  # Mercedes uses "Sonderausstattung" like BMW
            "description": (term.strip() if isinstance(term, str) and term.strip() else None),
        })

    headunit_in = raw.get("headunit") or {}
    navi_data = headunit_in.get("naviData") or {}
    headunit_out = {
        "generation": (headunit_in.get("generation") or [None])[0]
                       if isinstance(headunit_in.get("generation"), list)
                       else headunit_in.get("generation"),
        "is_high": bool(headunit_in.get("isHigh")),
        "navi_region": navi_data.get("regionDisplayName") or navi_data.get("region"),
    }

    veh_desc = raw.get("vehicle")
    if isinstance(veh_desc, str) and veh_desc.strip() in ("", "null null", "null"):
        veh_desc = ""

    # Chassis: mbtools sometimes returns raw digits (e.g. "206") and
    # sometimes with the "W" prefix. The renderers prepend "W", so strip
    # any leading letters here to guarantee no double-prefix (e.g. "WW206"
    # if the vendor later switches to returning "W206").
    _chassis = raw.get("chassis")
    if isinstance(_chassis, str):
        _stripped = _chassis.upper().lstrip("W").strip()
        _chassis = _stripped or None

    return {
        "status": "ok",
        "provider": "mbtools",
        "vin": raw.get("vin"),
        "series": _chassis,           # chassis code, e.g. "206" (renderers prepend "W")
        "model_code": raw.get("model"),
        "model_year_code": raw.get("modelYear"),
        "year": raw.get("year"),
        "fuel": raw.get("fuel"),
        "body": raw.get("body"),
        "is_facelift": bool(raw.get("isFacelift")),
        "vehicle_desc": veh_desc,
        "image_url": raw.get("image") or "",
        "headunit": headunit_out,
        "options": options,
        "options_total": len(options),
        "options_with_desc": sum(1 for o in options if o.get("description")),
        # Keep the raw payload so /submissions/{id} can still show the
        # untouched vendor blob if we ever add a "raw JSON" toggle in the
        # admin UI.
        "raw": raw,
    }


async def fetch_mb_datacard(vin: str) -> dict[str, Any]:
    """Public entry point — fetch & normalise the datacard for a VIN.

    Never raises for expected failures — returns
    ``{"status": "error"|"not_found", "error": "…"}`` instead. This
    mirrors ``fetch_bimmer_spec`` so `server.py`'s create_report_order
    branch can treat both identically.
    """
    if not vin:
        return {"status": "error", "error": "VIN is required."}
    vin = vin.strip().upper()
    if len(vin) < 11:
        return {"status": "error", "error": f"VIN {vin!r} looks too short."}

    try:
        raw = await _fetch_raw(vin)
    except Exception as e:
        logger.exception("mbtools: raw fetch failed for VIN %s", vin)
        return {"status": "error", "error": str(e)}

    if raw.get("__mbtools_status__") == "not_found":
        return {
            "status": "not_found",
            "error": (
                "mbtools has no data on file for this VIN. This is common "
                "for very new (< a few weeks) vehicles and for grey imports."
            ),
        }

    # Ensure we got at least SOME useful signal.
    if not (raw.get("saCodes") or raw.get("chassis") or raw.get("vin")):
        return {
            "status": "not_found",
            "error": "mbtools returned an empty payload for this VIN.",
        }

    try:
        return _normalise_datacard(raw)
    except Exception as e:
        logger.exception("mbtools: normalise failed for VIN %s", vin)
        return {"status": "error", "error": f"Could not parse response: {e}"}
