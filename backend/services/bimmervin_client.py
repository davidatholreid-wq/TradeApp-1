"""Bimmervin / vinrequest.xyz API client for BMW-group factory spec.

Bimmervin exposes a small REST API at https://api.vinrequest.xyz that
returns BMW factory order data (colour code, fabric, series, type key,
SA codes = factory options) for a given VIN. Auth is client-credentials
OAuth2 with a JWT that lives for ~1 hour.

Why not scrape bimmer.work directly?
    bimmer.work is a consumer website protected by reCAPTCHA-Enterprise
    AND aggressive IP-level rate limiting (429 after ~1-2 lookups from
    a data-center IP). Bimmervin's sanctioned API is the exact same
    upstream data without the anti-scraping walls. See the earlier
    `services/bimmer_scraper.py` file for the scraping proof-of-concept
    that was superseded by this module.

Endpoints exposed here:

    * ``fetch_bimmer_spec(vin)`` — the public entry-point used by the
      API route. Returns a normalised dict shaped like the earlier
      scraper output so the frontend / PDF renderers don't have to
      change. Uses ``/vehicle-order-json`` under the hood which returns
      the compact factory-order payload for 3 credits per real call
      (free with a sandbox VIN).

The client keeps its JWT in-process (module-level) with an
expiry-safe refresh so back-to-back requests within the same hour
don't burn extra ``/auth/token`` calls.
"""

from __future__ import annotations

import asyncio
import logging
import os
from datetime import datetime, timezone
from typing import Any, Optional

import httpx

logger = logging.getLogger("fourbuy.bimmervin")

BIMMERVIN_API_BASE = os.getenv("BIMMERVIN_API_BASE", "https://api.vinrequest.xyz").rstrip("/")
BIMMERVIN_SANDBOX_VIN = "WBA00000000000000"

BIMMER_SUPPORTED_MAKES = {"BMW", "MINI", "ROLLS-ROYCE", "ROLLS ROYCE", "ALPINA"}


def is_bimmer_supported_make(make: Optional[str]) -> bool:
    if not make:
        return False
    return make.strip().upper() in BIMMER_SUPPORTED_MAKES


# -----------------------------------------------------------------------------
# JWT token cache (module-level; auto-refreshes on expiry).
# -----------------------------------------------------------------------------
_TOKEN_CACHE: dict[str, Any] = {"access_token": None, "expires_at": 0.0}
_TOKEN_LOCK = asyncio.Lock()


async def _get_access_token(client_id: str, client_secret: str) -> str:
    """Return a valid Bimmervin JWT — either from cache or freshly issued.

    A small safety margin (60s) is subtracted from the reported ``expires_in``
    so we never send a token that's about to expire mid-flight.
    """
    now = asyncio.get_event_loop().time()
    tok = _TOKEN_CACHE.get("access_token")
    exp = _TOKEN_CACHE.get("expires_at", 0.0)
    if tok and now < exp - 60:
        return tok  # type: ignore[return-value]
    async with _TOKEN_LOCK:
        # Re-check under lock so parallel callers don't each issue a fresh token.
        tok = _TOKEN_CACHE.get("access_token")
        exp = _TOKEN_CACHE.get("expires_at", 0.0)
        if tok and now < exp - 60:
            return tok  # type: ignore[return-value]
        async with httpx.AsyncClient(timeout=20) as http:
            r = await http.post(
                f"{BIMMERVIN_API_BASE}/auth/token",
                json={"client_id": client_id, "client_secret": client_secret},
            )
        if r.status_code != 200:
            raise RuntimeError(
                f"Bimmervin auth failed: {r.status_code} {r.text[:200]!r}"
            )
        data = r.json()
        access = data.get("access_token")
        if not access:
            raise RuntimeError(f"Bimmervin auth returned no access_token: {data!r}")
        expires_in = int(data.get("expires_in") or 3600)
        _TOKEN_CACHE["access_token"] = access
        _TOKEN_CACHE["expires_at"] = asyncio.get_event_loop().time() + expires_in
        logger.info("Bimmervin: issued fresh JWT, valid %ss", expires_in)
        return access


# -----------------------------------------------------------------------------
# Payload → normalised response
# -----------------------------------------------------------------------------
def _normalise_vehicle_order(raw: dict) -> dict:
    """Map Bimmervin ``/vehicle-order-json`` payload into the shape the app
    already expects (the earlier bimmer.work scraper output shape).

    Sample raw ``vehicle_order``::

        {
          "vin": "WBA00000000000000",
          "date": "2026-05-10", "time": "20:48:44",
          "colour_code": "0475", "fa_version": "3", "fabric_code": "LCFK",
          "series": "G30", "type_key": "JC52", "time_criteria": "0317",
          "e_codes": ["A090", "KMKU"],
          "sa_codes": ["1CA", "1CB", "21N", ...],
          "ho_codes": []
        }

    We turn the SA / E / HO code arrays into a single ``options`` list so
    the UI can render one section, and we keep the raw payload for
    forensic display.
    """
    vo = raw.get("vehicle_order") or {}
    sa = vo.get("sa_codes") or []
    ec = vo.get("e_codes") or []
    ho = vo.get("ho_codes") or []
    options: list[dict[str, str]] = []
    seen: set[str] = set()
    # SA codes = factory options ("sonderausstattung"). This is what a
    # buyer / dealer actually cares about.
    for c in sa:
        code = str(c).strip().upper()
        if code and code not in seen:
            seen.add(code)
            options.append({"code": code, "kind": "SA"})
    for c in ec:
        code = str(c).strip().upper()
        if code and code not in seen:
            seen.add(code)
            options.append({"code": code, "kind": "E"})
    for c in ho:
        code = str(c).strip().upper()
        if code and code not in seen:
            seen.add(code)
            options.append({"code": code, "kind": "HO"})

    # Marketing name: Bimmervin's factory-order endpoint doesn't return a
    # marketing model string — only chassis series (e.g. "G30") + type_key
    # (e.g. "JC52"). We compose a friendly line the UI can render.
    series = vo.get("series") or ""
    type_key = vo.get("type_key") or ""
    model = " ".join(x for x in [series, type_key] if x).strip() or None

    return {
        "vin": raw.get("vin17") or vo.get("vin"),
        "vin_short": raw.get("vin7"),
        "sandbox": bool(raw.get("sandbox")),
        "model": model,
        "series": series or None,
        "type_key": type_key or None,
        "colour_code": vo.get("colour_code") or None,
        "fabric_code": vo.get("fabric_code") or None,
        "fa_version": vo.get("fa_version") or None,
        "time_criteria": vo.get("time_criteria") or None,
        "build_date": (vo.get("date") + (" " + vo.get("time") if vo.get("time") else "")).strip() if vo.get("date") else None,
        "options": options,
        "option_counts": {
            "sa": len(sa),
            "e": len(ec),
            "ho": len(ho),
        },
        "raw_vehicle_order": vo,  # keep the raw for debug / future rendering
        "source": "bimmervin.xyz",
        "captured_at": datetime.now(timezone.utc).isoformat(),
    }


# -----------------------------------------------------------------------------
# Public entry-point
# -----------------------------------------------------------------------------
async def fetch_bimmer_spec(
    vin: str,
    *,
    client_id: Optional[str] = None,
    client_secret: Optional[str] = None,
) -> dict:
    """Fetch factory spec (SA/E/HO codes + build meta) for a VIN.

    Returns a dict with a top-level ``status`` field of ``"ok"`` or
    ``"error"``. The caller is responsible for persisting a snapshot on
    the submission so subsequent clicks don't re-spend credits.

    Passing the sandbox VIN ``WBA00000000000000`` is FREE (counts toward
    the sandbox quota, not billed credits).
    """
    vin = (vin or "").strip().upper()
    if len(vin) not in (7, 17):
        return {"status": "error", "error": "VIN must be 7 or 17 characters."}

    cid = (client_id or os.getenv("BIMMERVIN_CLIENT_ID") or "").strip()
    cs = (client_secret or os.getenv("BIMMERVIN_CLIENT_SECRET") or "").strip()
    if not cid or not cs:
        return {"status": "error", "error": "Bimmervin credentials are not configured on the server."}

    try:
        token = await _get_access_token(cid, cs)
    except Exception as e:  # noqa: BLE001
        logger.warning("Bimmervin auth error: %s", e)
        return {"status": "error", "error": f"Auth failed: {e}"}

    try:
        async with httpx.AsyncClient(timeout=45) as http:
            r = await http.post(
                f"{BIMMERVIN_API_BASE}/vehicle-order-json",
                json={"vin": vin},
                headers={"Authorization": f"Bearer {token}"},
            )
    except Exception as e:  # noqa: BLE001
        logger.warning("Bimmervin request error: %s", e)
        return {"status": "error", "error": f"Request failed: {e}"}

    if r.status_code == 401:
        # Token was invalidated / rotated on their side; force refresh once.
        _TOKEN_CACHE["access_token"] = None
        _TOKEN_CACHE["expires_at"] = 0.0
        return {"status": "error", "error": "Bimmervin rejected our token — please retry."}

    if r.status_code != 200:
        return {
            "status": "error",
            "error": f"Bimmervin HTTP {r.status_code}: {r.text[:300]!r}",
        }

    try:
        data = r.json()
    except Exception as e:  # noqa: BLE001
        return {"status": "error", "error": f"Bimmervin returned invalid JSON: {e}"}

    # The API's own status field: "success" | "select_vehicle" | "error"
    api_status = data.get("status") or ""

    if api_status == "select_vehicle":
        # Multiple vehicles matched a 7-digit VIN — bubble that up so the
        # UI can prompt the admin to supply the full 17-digit VIN. Not an
        # error, but not a final result either.
        return {
            "status": "needs_full_vin",
            "error": data.get("message") or "Multiple vehicles matched — supply the full 17-digit VIN.",
            "candidates": data.get("vehicles") or [],
        }

    if api_status != "success" or not (data.get("vehicle_order")):
        return {
            "status": "error",
            "error": data.get("message") or "Bimmervin returned no vehicle order data.",
        }

    normalised = _normalise_vehicle_order(data)
    normalised["status"] = "ok"
    return normalised
