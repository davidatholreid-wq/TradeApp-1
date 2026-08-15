"""Outvin multi-make VIN datacard client (outvin.com).

Vendor: outvin.com — professional VIN decoder covering 30+ makes (same
operator family as bimmer.work / mb.vin / mbtools). Auth is HTTP Basic
with the dealership's Outvin login credentials (email + password).

Endpoint (v1.0.3):
    GET https://www.outvin.com/api/v1/vehicle/{VIN}
    Authorization: Basic base64(email:password)

Response envelope::

    {
      "available_requests": 14,     # remaining quota — we log this on every call
      "data": {
        "vehicle": {
          "vin": "…",
          "make": {"id": 3, "make": "Mercedes-Benz", "brandCode": "mercedes-benz"},
          "stream_map": {
            "production_date": {stream_result: "2023-12-01", translation:{translation_en:"Production date"}, ...},
            "model_name":      {stream_result: {"20678": {"description": "Mercedes-AMG C 43 4MATIC Sedan", ...}}, ...},
            "series":          {stream_result: {"…": {"description":"…"}}},
            "generation":      {…},
            "body_type":       {…},
            "type_code":       {stream_result: "42DT", …},   # scalar
            "engine_code":     {stream_result: "B58D", …},
            "system_power":    {stream_result: 285, …},
            "fuel_type":       {…},
            "displacement":    {stream_result: "2.00", …},
            "drive_type":      {…},
            "steering_side":   {…},
            "color_code":      {stream_result:{…"description":"Alpinweiss 3"}},
            "interior_code":   {…"description":"Leather Vernasca black seam blue"},
            "transmission_type":{…},
            "options":         {stream_result: { "7502":{"description":"M leather steering wheel"}, … }},
            "transmission_code":{…}
          }
        }
      }
    }

Every `stream_map` entry has the SAME shape — the actual value lives at
``stream_result`` and can be:
  * a **scalar** (string / number / bool) for simple fields.
  * a **dict of length 1** wrapping the selected option — pluck the
    ``description`` (or the record's ``code``) from the single value.
  * a **dict of many keys** — that's the ``options`` block, each value
    being an option record with a ``description``.
  * an **empty list ``[]``** — data unavailable for this VIN.
  * a **literal ``False``** — likewise unavailable.

We normalise this into the same shape the existing valuation-PDF / AI
market-analysis / mobile UI already know how to render for ``bimmer_spec``
and ``mb_spec`` — just a new payload under ``sub.outvin_spec``.
"""

from __future__ import annotations

import base64
import logging
import os
from typing import Any, Optional

import httpx

logger = logging.getLogger("outvin")

OUTVIN_API_BASE = os.environ.get("OUTVIN_API_BASE", "https://www.outvin.com/api/v1").rstrip("/")
OUTVIN_USERNAME = os.environ.get("OUTVIN_USERNAME", "")
OUTVIN_PASSWORD = os.environ.get("OUTVIN_PASSWORD", "")

# The 30+ marques Outvin's homepage lists as "Active brands". Kept in
# TITLE-case here so we can compare case-insensitively at the call
# site. Keep this list broad; the make-guard is defensive.
OUTVIN_SUPPORTED_MAKES: list[str] = [
    "Mercedes-Benz", "BMW", "Mini", "Lexus", "Toyota", "Volvo", "Opel",
    "Audi", "Volkswagen", "Skoda", "Renault", "Dacia", "Lancia",
    "Land Rover", "Jaguar", "Seat", "Polestar", "Peugeot", "Nissan",
    "Citroen", "Kia", "Hyundai", "Mazda", "DS", "Ford", "Chrysler",
    "Dodge", "Jeep", "Fiat", "Alfa Romeo", "Smart", "Chevrolet", "GMC",
    "Cadillac", "Buick", "Hummer", "Tesla",
]


def _normalise_make_for_compare(m: str) -> str:
    if not m:
        return ""
    return (
        m.upper()
        .replace(" ", "")
        .replace("-", "")
        .replace("_", "")
        .strip()
    )


_SUPPORTED_KEYS = {_normalise_make_for_compare(x) for x in OUTVIN_SUPPORTED_MAKES}
# Extra spellings — historical variants stored in the DB.
_SUPPORTED_KEYS.update({
    _normalise_make_for_compare("MERCEDES"),
    _normalise_make_for_compare("MERCEDES AMG"),
    _normalise_make_for_compare("MERCEDES-AMG"),
    _normalise_make_for_compare("MERCEDES-MAYBACH"),
    _normalise_make_for_compare("MAYBACH"),
    _normalise_make_for_compare("ALFA"),          # short-form the trade often uses
    _normalise_make_for_compare("LANDROVER"),
    _normalise_make_for_compare("RANGE ROVER"),   # Range Rover models classified under Land Rover on Outvin
    _normalise_make_for_compare("VW"),
    _normalise_make_for_compare("CHEVY"),
})


def is_outvin_supported_make(make: str | None) -> bool:
    """True when the SA-market spelling of ``make`` maps to an Outvin
    marque. Case- and punctuation-insensitive."""
    if not make:
        return False
    return _normalise_make_for_compare(make) in _SUPPORTED_KEYS


async def _fetch_raw(vin: str) -> dict[str, Any]:
    """GET the raw Outvin payload. Never leaks the password into logs.

    Retries once on transient upstream errors (502/504/read timeout) —
    Outvin's origin sits behind Cloudflare and periodically 502s while
    the origin cold-starts. A single retry with a short backoff usually
    clears it. Repeated 5xx after retry is surfaced as ``not_found`` so
    the dealer sees the friendly "no data available" toast instead of
    a scary error (no charge either way; caller decides).
    """
    if not (OUTVIN_USERNAME and OUTVIN_PASSWORD):
        raise RuntimeError(
            "outvin: OUTVIN_USERNAME / OUTVIN_PASSWORD not configured."
        )
    creds = f"{OUTVIN_USERNAME}:{OUTVIN_PASSWORD}".encode("utf-8")
    auth_hdr = "Basic " + base64.b64encode(creds).decode("ascii")
    url = f"{OUTVIN_API_BASE}/vehicle/{vin}"
    headers = {"Authorization": auth_hdr, "Accept": "application/json"}

    last_status: int | None = None
    last_body: str = ""
    import asyncio as _asyncio
    for attempt in range(2):
        try:
            async with httpx.AsyncClient(timeout=25.0) as h:
                r = await h.get(url, headers=headers)
            last_status = r.status_code
            last_body = r.text[:400] if r.text else ""

            if r.status_code == 200:
                try:
                    return r.json()
                except Exception as e:
                    raise RuntimeError(f"outvin returned non-JSON body: {e} — {r.text[:200]!r}")

            if r.status_code in (401, 403):
                raise RuntimeError(
                    f"outvin auth error {r.status_code} — check OUTVIN_USERNAME/PASSWORD."
                )
            if r.status_code == 404:
                return {"__outvin_status__": "not_found"}
            if r.status_code == 402:
                # Vendor-reported "Payment Required" — the Outvin
                # subscription has run out of credits. Distinct from 429
                # (rate-limit) because 402 needs a manual top-up on
                # outvin.com and the caller can't retry their way out.
                raise RuntimeError(
                    "outvin: no API credits remaining on your subscription. "
                    "Top up at https://www.outvin.com/dashboard "
                    "(or contact support@outvin.com) before ordering more decodes."
                )
            if r.status_code == 429:
                raise RuntimeError(
                    "outvin: quota exhausted — top up your Outvin account or wait for reset."
                )
            if 500 <= r.status_code < 600:
                # Transient origin/gateway error. Retry once, then give up
                # gracefully with a "not_found"-like signal so the caller
                # renders "no data available for this VIN" instead of a
                # red error.
                logger.warning(
                    "outvin: transient upstream %s on attempt %d (body head=%r)",
                    r.status_code, attempt + 1, last_body[:120],
                )
                if attempt == 0:
                    await _asyncio.sleep(1.5)
                    continue
                return {
                    "__outvin_status__": "not_found",
                    "__outvin_transient__": True,
                    "__upstream_status__": r.status_code,
                }
            # Any other non-2xx we haven't classified.
            raise RuntimeError(
                f"outvin unexpected status {r.status_code}: {r.text[:200]!r}"
            )
        except (httpx.TimeoutException, httpx.NetworkError) as e:
            last_status = -1
            last_body = f"{type(e).__name__}: {e}"
            logger.warning("outvin: %s on attempt %d", type(e).__name__, attempt + 1)
            if attempt == 0:
                await _asyncio.sleep(1.5)
                continue
            # Repeated network failure — treat like transient upstream,
            # surface as "not_found" so the dealer isn't blocked by a
            # red error and isn't charged.
            return {
                "__outvin_status__": "not_found",
                "__outvin_transient__": True,
                "__upstream_status__": -1,
            }

    # Should never reach here — the loop always returns or raises.
    return {
        "__outvin_status__": "not_found",
        "__outvin_transient__": True,
        "__upstream_status__": last_status or -1,
    }


# ---------------------------------------------------------------------------
# stream_map decoding helpers
# ---------------------------------------------------------------------------
def _stream_result_display(entry: Any) -> Optional[str]:
    """Extract a human-readable value from a single stream_map entry.

    Handles the four shapes documented in the module docstring:
      * scalar (str/int/float/bool)  → returned verbatim (bools/False → None)
      * empty list ``[]``            → None
      * dict of length 1 wrapping a
        record with ``description``  → the description string
      * anything else                → best-effort ``str(...)``
    """
    if entry is None:
        return None
    val = entry.get("stream_result") if isinstance(entry, dict) else entry
    if val is False or val is None or val == []:
        return None
    if isinstance(val, (int, float)):
        return str(val)
    if isinstance(val, str):
        s = val.strip()
        return s or None
    if isinstance(val, dict):
        if not val:
            return None
        # Single-value dict — pluck description / code from the sole record.
        rec = next(iter(val.values()))
        if isinstance(rec, dict):
            desc = rec.get("description") or rec.get("code") or rec.get("value")
            if desc and isinstance(desc, str):
                return desc.strip() or None
        return None
    return None


def _normalise_datacard(raw: dict[str, Any]) -> dict[str, Any]:
    """Map the Outvin payload into the same shape the app already renders
    for ``bimmer_spec`` / ``mb_spec`` — see module docstring.

    Output shape::

        {
          "status": "ok",
          "provider": "outvin",
          "vin": "…",
          "make":      "Mercedes-Benz",
          "brand_code":"mercedes-benz",
          "model":     "Mercedes-AMG C 43 4MATIC Sedan",
          "series":    "C-Class",
          "generation":"W206",
          "body_type": "Sedan",
          "type_code": "206084",
          "engine_code": "M139m",
          "power_kw":  285,
          "fuel_type": "Petrol",
          "displacement": "2.00",
          "drive_type":"awd",
          "transmission":"automatic",
          "transmission_code": None,
          "colour":    "Alpinweiss 3",
          "interior":  "Leather Vernasca black seam blue",
          "production_date": "2023-12-01",
          "available_requests": 14,
          "options": [
            {"code": "7502", "kind": "OPT", "description": "M leather steering wheel"},
            …
          ],
          "options_total":      148,
          "options_with_desc":  148,
          "raw": {…}  # kept verbatim for the admin forensic view
        }
    """
    vehicle = ((raw.get("data") or {}).get("vehicle")) or {}
    make_obj = vehicle.get("make") or {}
    sm = vehicle.get("stream_map") or {}

    def sr(key: str) -> Optional[str]:
        return _stream_result_display(sm.get(key))

    # Options — the one field whose stream_result is a dict of MANY.
    options_out: list[dict[str, Any]] = []
    opts_entry = sm.get("options") or {}
    opts_res = opts_entry.get("stream_result") if isinstance(opts_entry, dict) else None
    if isinstance(opts_res, dict):
        for code_key, rec in opts_res.items():
            if not isinstance(rec, dict):
                continue
            desc = rec.get("description") or rec.get("code") or None
            if isinstance(desc, str):
                desc = desc.strip() or None
            options_out.append({
                "code": str(rec.get("code") or code_key or "").strip(),
                "kind": "OPT",       # Outvin doesn't split by SA/E/HO — everything is a plain option
                "description": desc,
            })

    # `system_power` on Outvin looks like kW (285 for X4 M40i ~= 285kW).
    power_kw: Optional[int] = None
    pw_raw = _stream_result_display(sm.get("system_power"))
    if pw_raw:
        try:
            power_kw = int(float(pw_raw))
        except (TypeError, ValueError):
            power_kw = None

    return {
        "status": "ok",
        "provider": "outvin",
        "vin": vehicle.get("vin"),
        "make": make_obj.get("make"),
        "brand_code": make_obj.get("brandCode"),
        "model": sr("model_name"),
        "series": sr("series"),
        "generation": sr("generation"),
        "body_type": sr("body_type"),
        "type_code": sr("type_code"),
        "engine_code": sr("engine_code"),
        "power_kw": power_kw,
        "fuel_type": sr("fuel_type"),
        "displacement": sr("displacement"),
        "drive_type": sr("drive_type"),
        "transmission": sr("transmission_type"),
        "transmission_code": sr("transmission_code"),
        "colour": sr("color_code"),
        "interior": sr("interior_code"),
        "steering_side": sr("steering_side"),
        "production_date": sr("production_date"),
        "available_requests": raw.get("available_requests"),
        "options": options_out,
        "options_total": len(options_out),
        "options_with_desc": sum(1 for o in options_out if o.get("description")),
        "raw": raw,
    }


async def fetch_outvin_spec(vin: str) -> dict[str, Any]:
    """Public entry — fetch + normalise Outvin's datacard for ``vin``.

    Returns a dict with ``status`` ∈ {"ok","not_found","error"}. Never
    raises for expected failures.
    """
    if not vin:
        return {"status": "error", "error": "VIN is required."}
    vin = vin.strip().upper()
    if len(vin) < 11:
        return {"status": "error", "error": f"VIN {vin!r} looks too short."}

    try:
        raw = await _fetch_raw(vin)
    except Exception as e:
        logger.exception("outvin: raw fetch failed for VIN %s", vin)
        return {"status": "error", "error": str(e)}

    if raw.get("__outvin_status__") == "not_found":
        # Distinguish a genuine "no data on file" from a transient
        # upstream failure that we downgraded to not_found on retry
        # exhaustion — helps the app show a slightly better message
        # ("try again shortly" vs "not in dataset yet").
        if raw.get("__outvin_transient__"):
            us = raw.get("__upstream_status__") or "network"
            return {
                "status": "not_found",
                "error": (
                    "No factory data available for this vehicle right now "
                    f"(vendor upstream returned {us}). Please try again in "
                    "a few minutes — no charge has been applied."
                ),
            }
        return {
            "status": "not_found",
            "error": (
                "No factory data available for this VIN on Outvin's "
                "dataset. Not all models are covered — please try again "
                "in a few weeks. No charge has been applied."
            ),
        }

    veh = (raw.get("data") or {}).get("vehicle")
    if not isinstance(veh, dict) or not veh.get("vin"):
        return {
            "status": "not_found",
            "error": "Outvin returned an empty payload for this VIN.",
        }

    try:
        normalised = _normalise_datacard(raw)
    except Exception as e:
        logger.exception("outvin: normalise failed for VIN %s", vin)
        return {"status": "error", "error": f"Could not parse Outvin response: {e}"}

    logger.info(
        "outvin: decoded VIN=%s make=%s model=%s options=%d/%d (%d requests remaining)",
        vin,
        normalised.get("make"),
        normalised.get("model"),
        normalised.get("options_with_desc") or 0,
        normalised.get("options_total") or 0,
        normalised.get("available_requests") or -1,
    )
    return normalised
