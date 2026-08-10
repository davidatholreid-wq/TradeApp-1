"""Kredo Vehicle Values + VIN accident/claim history + CarTrust routes.

Extracted from `backend/server.py` on 2026-08-09 as the third
proof-of-concept in the Phase 2 route-splitting effort.

Owns 10 routes:
    * GET  /kredo/makes, /kredo/models, /kredo/years, /kredo/derivatives
    * POST /kredo/value
    * POST /kredo/vin-history
    * POST /kredo/cartrust/order
    * GET  /kredo/cartrust/status/{submission_id}
    * POST /kredo/cartrust/callback     (public — HMAC-guarded)
    * GET  /kredo/cartrust/pdf/{submission_id}

All external secrets (Kredo access token, CarTrust HMAC keys) stay in
`backend/.env`; this module never handles them directly — it delegates
to `services/kredo_client.py`.
"""

from __future__ import annotations

import base64 as _base64
import hashlib as _hashlib
import hmac as _hmac
import httpx as _httpx
import json as _json
import os
import re
import uuid
from difflib import SequenceMatcher
from datetime import datetime, timedelta, timezone
from typing import Any, Optional

from fastapi import APIRouter, Depends, HTTPException, Request
from fastapi.responses import Response
from pydantic import BaseModel, Field

# Kredo / SA-ID / referral service clients — imported directly so that
# a future refactor of `server.py` won't break this module's
# dependencies. Also imported at the top of `server.py` because they're
# also needed by the auth/register flows.
from services.kredo_client import get_kredo_client, KredoAPIError
from services.sa_id import validate_sa_id  # noqa: F401 (kept for parity)
from services.referral import allocate_unique_code  # noqa: F401 (kept for parity)

# Late-import from `server` — safe because by the time this module is
# imported (at the bottom of `server.py`), the parent module has fully
# defined every name we pull in below.
from server import (
    db,
    get_current_user,
    now_utc,
    logger,
    _can_access_submission,
)


router = APIRouter()


def _kredo_502(e: KredoAPIError) -> HTTPException:
    """Map a KredoAPIError to a 502 with a safe, admin-visible detail."""
    return HTTPException(
        status_code=502,
        detail={
            "source": "kredo",
            "message": str(e),
            "upstream_status": e.upstream_status,
            "upstream_body": e.upstream_body,
        },
    )


def _select_kredo_model_by_year(candidates: list[str], year: int) -> Optional[str]:
    """Kredo's model list bakes production year ranges into the name, e.g.
    `HILUX 2005 - 2016`, `HILUX 2016 ON`. Pick the candidate whose range
    contains the given `year`, else fall back to the first candidate."""
    import re
    for m in candidates:
        range_match = re.search(r"(\d{4})\s*-\s*(\d{4})", m)
        if range_match:
            start, end = int(range_match.group(1)), int(range_match.group(2))
            if start <= year <= end:
                return m
        on_match = re.search(r"(\d{4})\s+ON\b", m, re.IGNORECASE)
        if on_match:
            start = int(on_match.group(1))
            if year >= start:
                return m
    return candidates[0] if candidates else None


async def _resolve_kredo_identifiers(sub: dict) -> tuple[str, str, str, str]:
    """Map our internal (make_name, model_name, derivative_name, year) onto
    the exact identifiers Kredo Vehicle Values expects.

    Kredo uses ALL-CAPS make + year-ranged model names (e.g. `HILUX 2016
    ON`) + derivatives that carry the model prefix (e.g. `HILUX 2.4 GD-6
    RAIDER 4X4 A/T P/U D/C`). Submissions created through the flatfile
    picker already carry those Kredo-shaped strings; older submissions
    with simplified names need a best-effort resolve.

    Raises `ValueError` with a human-readable message if we can't match.
    """
    import re
    from difflib import SequenceMatcher

    make = (sub.get("make_name") or "").strip()
    model = (sub.get("model_name") or "").strip()
    derivative = (sub.get("derivative_name") or "").strip()
    year_raw = sub.get("year_of_production")
    if not (make and model and derivative and year_raw):
        raise ValueError("Missing vehicle fields required for a market lookup.")
    try:
        year = int(year_raw)
    except (TypeError, ValueError) as e:
        raise ValueError(f"Bad year: {year_raw}") from e

    kc = get_kredo_client()
    k_make = make.upper()

    # Model — try direct case-insensitive match, then look for models that
    # start with our name (with a year range appended), then substring.
    r = await kc.models(k_make)
    kredo_models: list[str] = r.get("data") or []
    if not kredo_models:
        raise ValueError(f"Kredo has no models for make '{k_make}'.")

    upper_model = model.upper()
    direct = [m for m in kredo_models if m.upper() == upper_model]
    if direct:
        k_model = direct[0]
    else:
        prefixed = [m for m in kredo_models if m.upper().startswith(upper_model + " ")]
        substring = [m for m in kredo_models if upper_model in m.upper()]
        candidates = prefixed or substring
        if not candidates:
            raise ValueError(f"Kredo has no model matching '{model}' for {k_make}.")
        k_model = _select_kredo_model_by_year(candidates, year) or candidates[0]

    # Year sanity — Kredo's `years` list is authoritative.
    r = await kc.years(k_make, k_model)
    kredo_years = {int(y) for y in (r.get("data") or []) if str(y).strip().isdigit()}
    if kredo_years and year not in kredo_years:
        raise ValueError(f"Kredo does not have year {year} for {k_make} {k_model}.")

    # Derivative — try exact, then strip the Kredo model prefix and compare,
    # then fall back to a similarity match.
    r = await kc.derivatives(make=k_make, model=k_model, year=str(year))
    kredo_derivs: list[str] = r.get("data") or []
    if not kredo_derivs:
        raise ValueError(f"Kredo has no derivatives for {k_make} {k_model} {year}.")

    upper_deriv = derivative.upper().strip()
    direct_d = [d for d in kredo_derivs if d.upper().strip() == upper_deriv]
    if direct_d:
        return k_make, k_model, str(year), direct_d[0]

    model_prefix = k_model.split(" ")[0]  # e.g. "HILUX"
    def _strip(d: str) -> str:
        s = d.upper()
        if s.startswith(model_prefix + " "):
            s = s[len(model_prefix) + 1:]
        return re.sub(r"\s+", " ", s).strip()

    stripped = [(d, _strip(d)) for d in kredo_derivs]
    exact_stripped = [d for d, s in stripped if s == upper_deriv]
    if exact_stripped:
        return k_make, k_model, str(year), exact_stripped[0]

    scored = sorted(
        ((d, SequenceMatcher(None, s, upper_deriv).ratio()) for d, s in stripped),
        key=lambda x: x[1],
        reverse=True,
    )
    best_d, best_score = scored[0]
    # We're lenient here — older submissions used simplified derivative
    # names (e.g. "2.4 GD-6 SR") that don't line up perfectly with Kredo's
    # verbose format (e.g. "HILUX 2.4 GD-6 RB SR P/U D/C"). Anything at or
    # above 0.55 is a plausible match; the resolved identifier is echoed
    # in the cached market_values so admins can audit the choice.
    if best_score >= 0.55:
        return k_make, k_model, str(year), best_d

    raise ValueError(
        f"Could not match derivative '{derivative}' to any Kredo derivative "
        f"for {k_make} {k_model} {year}. Best match: '{best_d}' "
        f"({int(best_score * 100)}%)."
    )


def _parse_kredo_value(raw: dict) -> dict:
    """Kredo's /value response nests the pricing JSON inside `data` as a
    string. Parse it out and normalise the keys to camel-friendly ints
    the frontend can use directly, and preserve the raw values for audit."""
    import json as _json
    body = raw.get("data")
    parsed: dict = {}
    if isinstance(body, str):
        try:
            parsed = _json.loads(body)
        except _json.JSONDecodeError:
            parsed = {}
    elif isinstance(body, dict):
        parsed = body
    # Convert stringy prices to numbers where possible so the client can
    # format them without extra parsing steps.
    def _num(v: Any) -> Optional[float]:
        try:
            return float(v) if v not in (None, "", 0) else float(v) if v == 0 else None
        except (TypeError, ValueError):
            return None

    # M&M code (Mead & McGrouther) — the SA trade's canonical vehicle
    # identifier. Kredo has varied the key name across responses, so try
    # a handful of plausible spellings before giving up.
    def _mm(*candidates: str) -> Optional[str]:
        for k in candidates:
            v = parsed.get(k)
            if v not in (None, "", 0, "0"):
                return str(v).strip() or None
        return None

    mm_code = _mm(
        "truetrade_mmCode",
        "mmCode",
        "mm_code",
        "MMCode",
        "MM_Code",
        "truetrade_mm_code",
    )

    return {
        "make": parsed.get("make"),
        "model": parsed.get("model"),
        "variant": parsed.get("variant"),
        "year": parsed.get("year"),
        "mm_code": mm_code,
        "new_price_zar": _num(parsed.get("truetrade_newPrice")),
        "retail_price_zar": _num(parsed.get("truetrade_retailPrice")),
        "market_price_zar": _num(parsed.get("truetrade_marketPrice")),
        "adjusted_retail_zar": _num(parsed.get("truetrade_adjustedRetailPrice")),
        "adjusted_trade_zar": _num(parsed.get("truetrade_adjustedTradePrice")),
        # Kredo also returns a full PDF valuation of the vehicle. We
        # forward it as-is (base64) so the client can offer it as an
        # optional preview without an extra round-trip.
        "pdf_base64": raw.get("file_base64"),
    }


async def _ensure_market_values(sub: dict, *, background: bool = False) -> dict:
    """Lazily populate a submission's cached Kredo Vehicle Values.

    Called from every GET /submissions/{id}. If we've already got a
    successful cached fetch, returns immediately. If the last attempt
    errored recently we back off for 60s so we don't spam Kredo. If
    the value hasn't been fetched yet we set a `loading` placeholder,
    kick off the real fetch as a background task, and return the
    placeholder so the caller can respond fast — the frontend will
    poll until `status` transitions to `ok` or `error`.

    Never raises — errors are captured in the cached document so the UI
    can render them, and the endpoint the caller was serving stays fast.
    """
    existing = sub.get("market_values") or {}
    # Already have a good snapshot.
    if isinstance(existing, dict) and existing.get("status") == "ok":
        return existing

    # If a fetch is currently in-flight (loading placeholder recently set),
    # don't kick off another one.
    if isinstance(existing, dict) and existing.get("status") == "loading":
        last_at = existing.get("fetched_at")
        if isinstance(last_at, datetime):
            age = (now_utc() - last_at).total_seconds()
            if age < 90:
                return existing

    # Back off on recent failure (60s).
    last_at = existing.get("fetched_at") if isinstance(existing, dict) else None
    if existing.get("status") == "error" and isinstance(last_at, datetime):
        try:
            age = (now_utc() - last_at).total_seconds()
            if age < 60:
                return existing
        except Exception:
            pass

    # Set a loading placeholder immediately.
    placeholder = {
        "status": "loading",
        "fetched_at": now_utc(),
    }
    await db.submissions.update_one({"id": sub["id"]}, {"$set": {"market_values": placeholder}})
    sub["market_values"] = placeholder

    # Kick off the real Kredo fetch as a background task so the caller
    # returns fast. The frontend polls GET /submissions/{id} until the
    # status transitions out of "loading".
    if not background:
        asyncio.create_task(_run_market_values_fetch(sub["id"]))
        return placeholder

    # `background=True` code path — run synchronously (used by the
    # manual refresh endpoint so we can return the fresh result inline).
    return await _run_market_values_fetch(sub["id"])


async def _run_market_values_fetch(sub_id: str) -> dict:
    """The real Kredo Vehicle Values fetch. Reads the current submission
    fresh from Mongo so concurrent updates don't clobber each other,
    resolves the Kredo identifiers, hits `/value`, joins the flatfile row
    for M&M code + new_list_price, and writes the result back onto the
    submission. Always returns the persisted `market_values` dict."""
    sub = await db.submissions.find_one({"id": sub_id}, {"_id": 0})
    if not sub:
        return {"status": "error", "error": "Submission not found", "fetched_at": now_utc()}

    mileage = sub.get("mileage") or 0
    try:
        k_make, k_model, k_year, k_derivative = await _resolve_kredo_identifiers(sub)

        # Flatfile lookup for M&M code + canonical new list price. Kredo's
        # Vehicle Values endpoint does not return `mm_code`, so this is
        # the only place it comes from.
        flat = await db.vehicle_specs.find_one(
            {
                "make": {"$regex": f"^{sub.get('make_name', '')}$", "$options": "i"},
                "model": k_model,
                "derivative": k_derivative,
                "year_of_production": int(k_year),
                "spec_source": "kredo",
            },
            {"_id": 0, "mm_code": 1, "new_list_price_zar": 1},
        )
        flat_mm = (flat or {}).get("mm_code")
        flat_new = (flat or {}).get("new_list_price_zar")

        raw = await get_kredo_client().value(
            make=k_make,
            model=k_model,
            year=k_year,
            derivative=k_derivative,
            mileage=int(mileage),
            condition="clean",
        )
        parsed = _parse_kredo_value(raw)
        mv = {
            "status": "ok",
            "new_list_price_zar": flat_new if flat_new is not None else parsed.get("new_price_zar"),
            "retail_price_zar": parsed.get("retail_price_zar"),
            "trade_price_zar": parsed.get("adjusted_trade_zar"),
            "adjusted_retail_zar": parsed.get("adjusted_retail_zar"),
            "market_price_zar": parsed.get("market_price_zar"),
            "mm_code": flat_mm or parsed.get("mm_code"),
            "fetched_at": now_utc(),
            "source": "kredo_vehicle_values",
            "input_condition": "clean",
            "input_mileage": int(mileage),
            "resolved_make": k_make,
            "resolved_model": k_model,
            "resolved_year": k_year,
            "resolved_derivative": k_derivative,
        }
    except ValueError as e:
        mv = {"status": "error", "error": str(e)[:240], "fetched_at": now_utc()}
    except KredoAPIError as e:
        mv = {"status": "error", "error": str(e)[:240], "fetched_at": now_utc()}
    except Exception as e:  # noqa: BLE001
        mv = {
            "status": "error",
            "error": f"Unexpected market-value lookup error: {e}"[:240],
            "fetched_at": now_utc(),
        }
    await db.submissions.update_one({"id": sub_id}, {"$set": {"market_values": mv}})
    return mv


@router.get("/kredo/makes")
async def kredo_makes(current: dict = Depends(get_current_user)):
    """Return the list of vehicle makes Kredo supports."""
    _ = current
    try:
        raw = await get_kredo_client().makes()
    except KredoAPIError as e:
        raise _kredo_502(e) from e
    return {"makes": raw.get("data") or [], "source": "kredo"}


@router.get("/kredo/models")
async def kredo_models(make: str, current: dict = Depends(get_current_user)):
    if not make:
        raise HTTPException(400, "make is required")
    try:
        raw = await get_kredo_client().models(make)
    except KredoAPIError as e:
        raise _kredo_502(e) from e
    return {"models": raw.get("data") or [], "make": make, "source": "kredo"}


@router.get("/kredo/years")
async def kredo_years(make: str, model: str, current: dict = Depends(get_current_user)):
    if not (make and model):
        raise HTTPException(400, "make and model are required")
    try:
        raw = await get_kredo_client().years(make, model)
    except KredoAPIError as e:
        raise _kredo_502(e) from e
    return {"years": raw.get("data") or [], "make": make, "model": model, "source": "kredo"}


@router.get("/kredo/derivatives")
async def kredo_derivatives(
    make: str,
    model: str,
    year: str,
    current: dict = Depends(get_current_user),
):
    if not (make and model and year):
        raise HTTPException(400, "make, model and year are required")
    try:
        raw = await get_kredo_client().derivatives(make, model, year)
    except KredoAPIError as e:
        raise _kredo_502(e) from e
    return {
        "derivatives": raw.get("data") or [],
        "make": make,
        "model": model,
        "year": year,
        "source": "kredo",
    }


class KredoValueRequest(BaseModel):
    make: str
    model: str
    year: str
    derivative: str
    mileage: int
    # Kredo condition labels — kept as free-form string on the API so we
    # can accept both "Excellent" and any other label Kredo introduces.
    condition: str = "Good"


@router.post("/kredo/value")
async def kredo_value(
    payload: KredoValueRequest,
    current: dict = Depends(get_current_user),
):
    """Fetch a real Kredo valuation for a fully specified vehicle."""
    try:
        raw = await get_kredo_client().value(
            make=payload.make,
            model=payload.model,
            year=payload.year,
            derivative=payload.derivative,
            mileage=payload.mileage,
            condition=payload.condition,
        )
    except KredoAPIError as e:
        raise _kredo_502(e) from e
    return _parse_kredo_value(raw)


# ---------- VIN History (accident data) ----------

# Damage location keys we surface to the UI, in display order. The Kredo
# response uses "Y" / null so we normalise to booleans.
_DAMAGE_KEYS = [
    "front",
    "front-left",
    "front-right",
    "rear",
    "rear-left",
    "rear-right",
    "side-left",
    "side-right",
    "roof",
    "underbody",
    "interior",
    "mechanical",
]


def _normalise_vin_history(raw: dict) -> dict:
    """Flatten Kredo's nested `claim-history` payload into a shape the app
    can render directly."""
    ch = (raw or {}).get("claim-history") or {}
    result = ch.get("result") or {}
    claims_raw = result.get("claim") or []
    if isinstance(claims_raw, dict):
        # Kredo sometimes returns a single object instead of a list.
        claims_raw = [claims_raw]
    claims: list[dict] = []
    for c in claims_raw:
        dmg = ((c.get("damage") or {}).get("general") or {})
        glass = ((c.get("damage") or {}).get("glass") or {})
        veh = c.get("vehicle") or {}
        claims.append({
            "id": c.get("@id"),
            "accident_date": (c.get("claim") or {}).get("accident-date"),
            "creation_date": c.get("creation"),
            "country": c.get("country"),
            "manufacturer": veh.get("car-manufacturer"),
            "model": veh.get("car-model"),
            "mileage_at_claim": veh.get("mileage"),
            "first_registration": veh.get("first-registration"),
            "damage_locations": [k for k in _DAMAGE_KEYS if dmg.get(k) == "Y"],
            "glass_damage": bool(glass.get("front") == "Y"),
        })
    return {
        "claim_count": len(claims),
        "claims": claims,
        "vin": ((ch.get("request") or {}).get("vin")),
    }


class KredoVinHistoryRequest(BaseModel):
    vin: str
    submission_id: Optional[str] = None
    refresh: bool = False
    cache_only: bool = False
    # Dealers must explicitly accept the per-fetch charge before we hit
    # Kredo. Ignored for admins (their fetches are free).
    accepted_charge: bool = False


# Per-fetch cost the dealer sees on their next invoice for the accident /
# claim history VIN lookup. Admins pay nothing.
KREDO_VIN_HISTORY_DEALER_COST_ZAR = 100.0


@router.post("/kredo/vin-history")
async def kredo_vin_history(
    payload: KredoVinHistoryRequest,
    current: dict = Depends(get_current_user),
):
    """Fetch (or return cached) Kredo VIN history.

    Access rules:
    * **Dealers only** may trigger a fresh Kredo lookup — each new fetch
      is billed R100 to the dealership. Cache hits are free and re-used
      across the dealer's app and web sessions.
    * **Admins may only view cached data** the dealer has already
      ordered. Admin requests are forced to `cache_only` mode — if the
      dealer hasn't ordered it, the admin sees `result=None` and the
      accident-history panel stays hidden. This keeps reports strictly
      dealer-initiated and prevents admin-side "shadow ordering".

    Modes:
    * `cache_only=True`  → return cached result if present, else `null`.
      Never touches Kredo. Used to auto-populate the screen on mount.
    * `refresh=False` (default) → return cached result if present; otherwise
      call Kredo and cache + bill the fresh response (dealer only).
    * `refresh=True` → always call Kredo. Rewrites the cache. Billed (dealer only).
    """
    is_admin = current.get("role") == "admin"
    # Admins are hard-gated to cache-only. A fresh fetch would either
    # trigger billing (unfair) or bypass billing (revenue leak) and would
    # let admins see reports the dealer never ordered — the user's product
    # rule is "the report must only be visible to the admin if the user
    # has ordered the report".
    if is_admin:
        payload.cache_only = True
        payload.refresh = False
    vin = (payload.vin or "").strip().upper()
    if not vin:
        raise HTTPException(400, "vin is required")

    sub: Optional[dict] = None
    if payload.submission_id:
        sub = await db.submissions.find_one(
            {"id": payload.submission_id}, {"_id": 0}
        )
        if not sub:
            raise HTTPException(404, "Submission not found")
        # Dealers may only look up VINs on their own dealership's submissions.
        if not is_admin and not await _can_access_submission(sub, current):
            raise HTTPException(403, "You cannot access this submission")

        cached = ((sub.get("reports") or {}).get("kredo_vin_history") or None)
        if cached and not payload.refresh:
            return {
                "result": cached.get("result"),
                "cached_at": cached.get("fetched_at"),
                "source": "cache",
                "vin": vin,
                "cost_zar": 0.0,
            }
        if payload.cache_only:
            return {
                "result": None,
                "cached_at": None,
                "source": "cache",
                "vin": vin,
                "cost_zar": 0.0,
            }
    elif not is_admin:
        # A dealer must always call this against a specific submission — we
        # need a submission id to enforce dealership access and to attach
        # the R100 bill to.
        raise HTTPException(400, "submission_id is required for dealer lookups")

    # Fresh call to Kredo below — dealers must have accepted the charge.
    if not is_admin and not payload.accepted_charge:
        raise HTTPException(
            400,
            f"Please accept the R{int(KREDO_VIN_HISTORY_DEALER_COST_ZAR)} charge before requesting the accident / claim history.",
        )

    try:
        raw = await get_kredo_client().vin_history(vin)
    except KredoAPIError as e:
        raise _kredo_502(e) from e
    normalised = _normalise_vin_history(raw)
    now = now_utc()

    billed_amount = 0.0
    if payload.submission_id:
        await db.submissions.update_one(
            {"id": payload.submission_id},
            {"$set": {"reports.kredo_vin_history": {
                "result": normalised,
                "fetched_at": now,
                "fetched_by_id": current["id"],
                "fetched_by_role": current.get("role"),
            }}},
        )
        # Dealer billing — one charge per (submission, kredo_vin_history)
        # even if they hit refresh again later. We ALWAYS update the
        # `result_data` field so the valuation PDF can render the full
        # accident-and-claim details on its own page (the PDF renderer
        # skips report_orders rows whose `result_data` is None).
        dealer_id = current.get("dealership_id")
        existing_bill = await db.report_orders.find_one(
            {"submission_id": payload.submission_id, "type": "kredo_vin_history"}
        )
        if not existing_bill:
            if not is_admin and dealer_id:
                await db.report_orders.insert_one({
                    "id": str(uuid.uuid4()),
                    "submission_id": payload.submission_id,
                    "dealer_id": dealer_id,
                    "vin": vin,
                    "type": "kredo_vin_history",
                    "name": "Accident / Claim History (Kredo VIN)",
                    "cost_zar": KREDO_VIN_HISTORY_DEALER_COST_ZAR,
                    "status": "delivered",
                    "ordered_at": now,
                    "ordered_by": current["id"],
                    "delivered_at": now,
                    "note": "Kredo VIN accident / claim history live lookup.",
                    "result_data": normalised,
                })
                billed_amount = KREDO_VIN_HISTORY_DEALER_COST_ZAR
                logger.info(
                    "kredo_vin_history: billed R%s to dealer %s for sub %s",
                    int(billed_amount), dealer_id, payload.submission_id,
                )
        else:
            # Refresh / cache hit — keep the delivered `result_data`
            # up-to-date so the PDF always renders the latest fetch.
            await db.report_orders.update_one(
                {"id": existing_bill["id"]},
                {"$set": {
                    "result_data": normalised,
                    "delivered_at": now,
                }},
            )

    return {
        "result": normalised,
        "cached_at": now,
        "source": "kredo",
        "vin": vin,
        "cost_zar": billed_amount,
    }


# ---------- CarTrust PDF (async, webhook) ----------

import hmac as _hmac  # noqa: E402
import hashlib as _hashlib  # noqa: E402
import base64 as _base64  # noqa: E402
import json as _json  # noqa: E402
import httpx as _httpx  # noqa: E402

CARTRUST_COST_ZAR = float(os.environ.get("CARTRUST_COST_ZAR", "0"))
# Kredo/Whozhoo callback signature header — captured from a real callback
# on 2026-07-24 (see /app/backend/logs/kredo_cartrust_callback.log).
# Both X-WZ-Signature (base64 HMAC-SHA256) and X-WZ-Timestamp (epoch
# seconds) are sent by their v2 webhook signer.
CARTRUST_HMAC_HEADER = os.environ.get("KREDO_CARTRUST_HMAC_HEADER", "x-wz-signature")
CARTRUST_TIMESTAMP_HEADER = os.environ.get("KREDO_CARTRUST_TIMESTAMP_HEADER", "x-wz-timestamp")


def _condition_label_from_score(score: Optional[int]) -> str:
    """Map our 1-10 condition score to a Kredo `vehicle_condition` label
    (per the docs: Excellent / Very Good / Good / Fair / Poor)."""
    if score is None:
        return "Good"
    try:
        s = int(score)
    except (TypeError, ValueError):
        return "Good"
    if s >= 9:
        return "Excellent"
    if s >= 7:
        return "Very Good"
    if s >= 5:
        return "Good"
    if s >= 3:
        return "Fair"
    return "Poor"


def _extract_plate_from_license_disk(sub: dict) -> Optional[str]:
    """Best-effort extract of the SA number plate from a submission.

    Submissions store the raw license-disc scan string in `license_disk_data`
    as `%`-separated tokens; we look for the first token that matches a
    generic SA plate pattern (letters+digits+optional letters, 5-10 chars).
    Falls back to `sub.license_plate` / `sub.plate` if those top-level
    fields ever get set explicitly.
    """
    import re as _re
    top = (
        sub.get("license_plate")
        or sub.get("licence_no")
        or sub.get("plate")
    )
    if top:
        return str(top).strip().upper().replace(" ", "")
    raw = sub.get("license_disk_data")
    if not isinstance(raw, str):
        return None
    # Plate pattern: 2-3 letters, 1-6 digits, 0-4 letters. Rejects pure-
    # numeric tokens and the 12-char alnum disc number.
    pat = _re.compile(r"^[A-Z]{2,3}[0-9]{2,6}[A-Z]{0,4}$")
    tokens = [t.strip().upper() for t in raw.split("%") if t.strip()]
    for tok in tokens:
        # Skip the disc-number token (typically 12 alnum chars, all-caps).
        if len(tok) == 12 and tok.isalnum():
            continue
        if pat.match(tok):
            return tok
    return None


class KredoCartrustOrderRequest(BaseModel):
    submission_id: str


@router.post("/kredo/cartrust/order")
async def kredo_cartrust_order(
    payload: KredoCartrustOrderRequest,
    current: dict = Depends(get_current_user),
):
    """Order a CarTrust PDF report for a submission.

    Only the owning dealer may place the order — admins can VIEW a
    delivered CarTrust report but cannot order one on behalf of a
    dealer. This mirrors the same rule the `/submissions/{id}/reports`
    endpoint enforces for other VIN reports (JLR OSH, BMW options,
    etc.), so admins never appear to have "shadow-ordered" a report the
    dealer didn't ask for.

    Kredo processes the request asynchronously and will POST to
    `/api/kredo/cartrust/callback` when the PDF is ready.
    """
    if current.get("role") == "admin":
        raise HTTPException(
            403,
            "Admins cannot order reports on behalf of a dealer. The dealer must place the order themselves.",
        )
    sub = await db.submissions.find_one({"id": payload.submission_id}, {"_id": 0})
    if not sub:
        raise HTTPException(404, "Submission not found")
    # Access control — dealers only their own dealership.
    if sub.get("dealership_id") != current.get("dealership_id"):
        raise HTTPException(403, "You cannot order a report for another dealership")

    vin = (sub.get("vin") or "").strip().upper()
    if not vin or vin == "TBC":
        raise HTTPException(400, "Submission does not have a valid VIN")

    # Guard: don't re-order if we already have a pending or completed report.
    existing = ((sub.get("reports") or {}).get("kredo_cartrust") or None)
    if existing and existing.get("status") in ("pending", "completed"):
        return {"status": existing.get("status"), "report": existing}

    dealer_info = current.get("dealer_info") or {}
    licence_no = _extract_plate_from_license_disk(sub)
    if not licence_no:
        raise HTTPException(
            400,
            "Registration number could not be determined for this submission. "
            "Kredo CarTrust requires the license plate — please re-scan the license disc.",
        )

    # Use the strongest condition rating we have available — cosmetic tends
    # to be what buyers care about for a history report.
    condition_label = _condition_label_from_score(
        sub.get("cosmetic_condition") or sub.get("condition")
    )

    try:
        raw = await get_kredo_client().order_cartrust_pdf(
            requester_name=(dealer_info.get("first_name") or current.get("email") or "Dealer"),
            requester_surname=(dealer_info.get("last_name") or "User"),
            requester_email=current.get("email") or "noreply@fourbuy.co.za",
            requester_phone=(dealer_info.get("phone") or "0000000000"),
            vin=vin,
            registration_number=(licence_no or ""),
            mileage=int(sub.get("mileage") or 0),
            vehicle_condition=condition_label,
            service_history=str(sub.get("service_history") or ""),
        )
    except KredoAPIError as e:
        raise _kredo_502(e) from e

    now = now_utc()
    record = {
        "status": "pending",
        "ordered_at": now,
        "ordered_by_id": current["id"],
        "ordered_by_email": current.get("email"),
        "ack": raw,  # Kredo's sync acknowledgement (order id, etc.)
        "vin": vin,
        "cost_zar": CARTRUST_COST_ZAR,
    }
    await db.submissions.update_one(
        {"id": payload.submission_id},
        {"$set": {"reports.kredo_cartrust": record}},
    )
    return {"status": "pending", "report": record}


@router.get("/kredo/cartrust/status/{submission_id}")
async def kredo_cartrust_status(
    submission_id: str,
    current: dict = Depends(get_current_user),
):
    """Poll the current CarTrust order status for a submission."""
    sub = await db.submissions.find_one({"id": submission_id}, {"_id": 0})
    if not sub:
        raise HTTPException(404, "Submission not found")
    if current.get("role") != "admin":
        if sub.get("dealership_id") != current.get("dealership_id"):
            raise HTTPException(403, "You cannot view a report for another dealership")
    report = ((sub.get("reports") or {}).get("kredo_cartrust") or None)
    if not report:
        return {"status": "not_ordered", "report": None}
    return {"status": report.get("status", "unknown"), "report": report}


def _verify_cartrust_signature(body: bytes, provided_signature: str) -> bool:
    """Verify the HMAC-SHA256 signature Kredo sends on callback POSTs.

    Shared secret is the Kredo API key (confirmed by the vendor).
    Accepts hex-encoded or base64-encoded signatures with optional
    "sha256=" prefix, which are the two schemes commonly used.

    While KREDO_CARTRUST_SKIP_HMAC=1 is set, verification is bypassed
    entirely — this is the "learn mode" used when first activating
    Kredo's callback so we can capture the exact signing scheme they
    use before locking verification back on.
    """
    if os.environ.get("KREDO_CARTRUST_SKIP_HMAC") == "1":
        logger.warning(
            "cartrust_callback: HMAC verification BYPASSED via KREDO_CARTRUST_SKIP_HMAC=1"
        )
        return True
    secret = os.environ["KREDO_API_KEY"].encode("utf-8")
    mac = _hmac.new(secret, body, _hashlib.sha256)
    hex_sig = mac.hexdigest()
    b64_sig = _base64.b64encode(mac.digest()).decode("ascii")
    provided = (provided_signature or "").strip()
    if provided.lower().startswith("sha256="):
        provided = provided.split("=", 1)[1].strip()
    if not provided:
        return False
    return (
        _hmac.compare_digest(provided.lower(), hex_sig)
        or _hmac.compare_digest(provided, b64_sig)
    )


async def _fetch_and_host_cartrust_pdf(
    submission_id: str, download_url: str
) -> Optional[dict]:
    """Fetch the CarTrust PDF from Kredo's presigned S3 URL.

    Returns a dict describing where the PDF now lives:
        {"pdf_b64": "<base64 bytes>", "size_bytes": <int>}

    We store the PDF inline (base64) on the submission's report record —
    CarTrust PDFs are ~50 KB so document size stays well within Mongo's
    16 MB per-doc limit even with a couple of them per submission, and
    inline storage lets us serve authenticated downloads through our own
    backend without leaning on any third-party delivery config.

    Cloudinary upload is also attempted best-effort as a redundant
    backup — the same authenticated bytes can then be replayed later if
    Mongo ever loses the record.
    """
    async with _httpx.AsyncClient(timeout=60.0) as http:
        r = await http.get(download_url)
        r.raise_for_status()
        pdf_bytes = r.content

    result: dict[str, Any] = {
        "pdf_b64": _base64.b64encode(pdf_bytes).decode("ascii"),
        "size_bytes": len(pdf_bytes),
    }

    # Optional Cloudinary backup — never blocks primary storage.
    if CLOUDINARY_ENABLED:
        try:
            data_url = f"data:application/pdf;base64,{result['pdf_b64']}"
            res = cloudinary.uploader.upload(
                data_url,
                folder=f"fourbuy/submissions/{submission_id}",
                public_id="cartrust_pdf",
                resource_type="raw",
                type="authenticated",
                overwrite=True,
                format="pdf",
            )
            result["pdf_public_id"] = res.get("public_id")
        except Exception:
            logger.exception("cartrust_callback: cloudinary backup failed (non-fatal)")

    return result


@router.post("/kredo/cartrust/callback")
async def kredo_cartrust_callback(request: Request):
    """Webhook receiver for Kredo CarTrust PDF completions.

    Kredo POSTs here with an HMAC-signed body containing the presigned
    `download_url` (15-min TTL). We verify the signature, fetch the PDF,
    re-host it on Cloudinary for permanence, and mark the submission's
    report record as completed.

    NOTE: this endpoint is intentionally unauthenticated (no Bearer). It
    is protected by the HMAC signature only.
    """
    body = await request.body()

    # --- Diagnostic capture ------------------------------------------------
    # First-callback learn-mode: log every header + full raw body to a
    # dedicated file so we can reverse-engineer the exact signing scheme
    # Kredo uses (header name, encoding, algorithm, secret). Safe to leave
    # on — the file is under /app/backend/logs and rotates naturally.
    try:
        os.makedirs("/app/backend/logs", exist_ok=True)
        with open("/app/backend/logs/kredo_cartrust_callback.log", "a") as fh:
            fh.write("=" * 72 + "\n")
            fh.write(f"ts={datetime.utcnow().isoformat()}Z\n")
            fh.write(f"remote={request.client.host if request.client else '?'}\n")
            fh.write("headers:\n")
            for k, v in request.headers.items():
                fh.write(f"  {k}: {v}\n")
            fh.write(f"body ({len(body)} bytes):\n")
            try:
                fh.write(body.decode("utf-8"))
            except Exception:
                fh.write(repr(body[:2048]))
            fh.write("\n")
        logger.info(
            "cartrust_callback received: %d bytes, sig-headers=%s",
            len(body),
            {k: v for k, v in request.headers.items() if "sign" in k.lower() or "hmac" in k.lower() or "hub" in k.lower()},
        )
    except Exception:
        logger.exception("cartrust_callback: diagnostic capture failed")

    provided = request.headers.get(CARTRUST_HMAC_HEADER) or request.headers.get(
        CARTRUST_HMAC_HEADER.title()
    ) or ""
    if not _verify_cartrust_signature(body, provided):
        logger.warning("cartrust_callback: HMAC verification failed")
        raise HTTPException(status_code=401, detail="signature verification failed")

    try:
        payload = _json.loads(body.decode("utf-8"))
    except Exception:
        raise HTTPException(status_code=400, detail="invalid JSON body") from None

    # The docs describe the callback as containing at minimum:
    #   { "vin": ..., "download_url": ..., "client_guid": ..., "status": ... }
    # We tolerate different top-level keys defensively.
    vin = (payload.get("vin") or "").strip().upper()
    download_url = (
        payload.get("download_url")
        or payload.get("downloadUrl")
        or payload.get("url")
    )
    kredo_status = (payload.get("status") or "completed").lower()

    # Locate the submission by the pending order (VIN + status=pending).
    sub = await db.submissions.find_one(
        {"vin": vin, "reports.kredo_cartrust.status": "pending"}, {"_id": 0, "id": 1}
    )
    if not sub:
        # Fallback: any submission with a pending kredo_cartrust order that
        # matches the client_guid on the ack.
        client_guid = payload.get("client_guid") or payload.get("clientGuid")
        if client_guid:
            sub = await db.submissions.find_one(
                {"reports.kredo_cartrust.ack.client_guid": client_guid},
                {"_id": 0, "id": 1},
            )
    if not sub:
        logger.warning("cartrust_callback: no matching submission for vin=%s", vin)
        return {"ok": True, "matched": False}

    sub_id = sub["id"]
    now = now_utc()

    if kredo_status in ("failed", "error", "rejected"):
        await db.submissions.update_one(
            {"id": sub_id},
            {"$set": {
                "reports.kredo_cartrust.status": "failed",
                "reports.kredo_cartrust.failed_at": now,
                "reports.kredo_cartrust.error": payload.get("error") or payload.get("message"),
            }},
        )
        return {"ok": True, "matched": True, "status": "failed"}

    fetched: Optional[dict] = None
    fetch_error: Optional[str] = None
    if download_url:
        try:
            fetched = await _fetch_and_host_cartrust_pdf(sub_id, download_url)
        except Exception as e:
            fetch_error = f"{type(e).__name__}: {e}"
            logger.exception("cartrust_callback: fetch/host failed")

    set_updates: dict = {
        "reports.kredo_cartrust.status": "completed" if fetched else "failed",
        "reports.kredo_cartrust.completed_at": now,
        # Keep the original Kredo presigned URL for a short debug window.
        "reports.kredo_cartrust.pdf_url": download_url,
        "reports.kredo_cartrust.callback_payload": payload,
        "reports.kredo_cartrust.fetch_error": fetch_error,
    }
    if fetched:
        set_updates["reports.kredo_cartrust.pdf_b64"] = fetched["pdf_b64"]
        set_updates["reports.kredo_cartrust.pdf_size_bytes"] = fetched["size_bytes"]
        set_updates["reports.kredo_cartrust.pdf_public_id"] = fetched.get("pdf_public_id")
        set_updates["reports.kredo_cartrust.hosted_on_cloudinary"] = bool(fetched.get("pdf_public_id"))

    await db.submissions.update_one({"id": sub_id}, {"$set": set_updates})
    return {"ok": True, "matched": True, "status": "completed"}


@router.get("/kredo/cartrust/pdf/{submission_id}")
async def kredo_cartrust_pdf(
    submission_id: str,
    current: dict = Depends(get_current_user),
):
    """Stream the stored CarTrust PDF back to authorised callers.

    Dealers may only read their own dealership's PDFs; admins may read
    any. The PDF bytes are stored inline (base64) on the submission's
    report record — see `_fetch_and_host_cartrust_pdf` for why.
    """
    sub = await db.submissions.find_one(
        {"id": submission_id},
        {"_id": 0, "dealership_id": 1, "reports.kredo_cartrust": 1, "reference": 1},
    )
    if not sub:
        raise HTTPException(404, "Submission not found")
    if current.get("role") != "admin":
        if sub.get("dealership_id") != current.get("dealership_id"):
            raise HTTPException(403, "You cannot access this report")
    report = ((sub.get("reports") or {}).get("kredo_cartrust") or None)
    if not report or report.get("status") != "completed":
        raise HTTPException(404, "No completed CarTrust report for this submission")

    pdf_b64 = report.get("pdf_b64")
    if not pdf_b64:
        raise HTTPException(404, "PDF bytes missing — report may have been ordered before PDF hosting was enabled. Please re-order.")

    try:
        pdf_bytes = _base64.b64decode(pdf_b64)
    except Exception:
        raise HTTPException(500, "Stored PDF is corrupt") from None

    filename = f"cartrust_{sub.get('reference') or submission_id}.pdf"
    return Response(
        content=pdf_bytes,
        media_type="application/pdf",
        headers={
            "Content-Disposition": f'inline; filename="{filename}"',
            "Cache-Control": "private, max-age=300",
        },
    )




__all__ = ["router"]
