"""Partner API — Fourbuy as reseller for Outvin VIN decodes.

Public-facing REST endpoints under ``/api/partner/v1/`` that let external
partners (currently Kredo) query VIN factory-options data through us.

Design:

* **Auth** — API key in ``Authorization: Bearer <key>`` header. Keys are
  stored hashed (SHA-256) so a DB leak can't be replayed. Optional
  ``ip_allowlist`` per client for defence-in-depth.
* **Caching** — every successful Outvin response is stored perpetually
  in ``outvin_vin_cache`` keyed by VIN. Repeat lookups don't burn Outvin
  credits but still get billed at the client's per-lookup rate (that's
  the whole point of the reseller model).
* **Billing** — post-paid. Every call (successful or cache-served) that
  actually returns data is written into ``partner_api_calls`` with the
  client's contracted ``cost_billed_zar``. Failures are logged as
  ``status=failed`` and NOT billed. Admin can generate a monthly
  invoice-ready summary via ``GET /api/admin/partner-clients/{id}/usage``.
* **Whitelabel** — the response never mentions Outvin. Only Fourbuy-
  branded fields are exposed to the partner.
"""

from __future__ import annotations

import hashlib
import secrets
import uuid
from datetime import datetime, timedelta, timezone
from typing import Any, Optional

from fastapi import APIRouter, Depends, HTTPException, Header, Request, Query
from fastapi.responses import Response
from pydantic import BaseModel, Field

from services.outvin_client import fetch_outvin_spec, is_outvin_supported_make

from server import db, get_current_user, now_utc, logger

router = APIRouter()


# =============================================================================
# Client auth
# =============================================================================
def _hash_key(raw_key: str) -> str:
    """SHA-256 the raw key so we never store it in plaintext.
    We use SHA-256 (not bcrypt) because the key is high-entropy (32+
    bytes of urandom) so key-stretching is unnecessary and lookups need
    to be fast — every partner API call performs one."""
    return hashlib.sha256(raw_key.encode("utf-8")).hexdigest()


async def _resolve_partner_client(
    authorization: Optional[str] = Header(None),
    request: Request = None,  # type: ignore[assignment]
) -> dict:
    """Auth dependency for every partner endpoint.

    Rejects with 401 if the ``Authorization`` header is missing/malformed,
    the key doesn't match any active client, or (if the client has an
    ``ip_allowlist`` set) the caller's IP isn't in it.
    """
    if not authorization or not authorization.lower().startswith("bearer "):
        raise HTTPException(
            401,
            "Missing or malformed Authorization header. Use `Authorization: Bearer <API_KEY>`.",
        )
    raw = authorization.split(" ", 1)[1].strip()
    if not raw:
        raise HTTPException(401, "Empty API key.")
    hashed = _hash_key(raw)
    client = await db.partner_api_clients.find_one({"api_key_hash": hashed, "active": True})
    if not client:
        raise HTTPException(401, "Invalid or revoked API key.")
    # Optional IP allowlist — reject if set and caller isn't listed.
    allow = client.get("ip_allowlist") or []
    if allow and request is not None:
        # Best-effort IP resolution — prefer X-Forwarded-For (ingress in
        # a Kubernetes cluster like ours), fall back to socket address.
        xff = request.headers.get("x-forwarded-for") or ""
        client_ip = xff.split(",")[0].strip() if xff else (request.client.host if request.client else "")
        if client_ip and client_ip not in allow:
            logger.warning("partner_api: IP %s not on allowlist for client %s", client_ip, client.get("name"))
            raise HTTPException(403, "IP address not on this API key's allowlist.")
    return client


# =============================================================================
# Whitelabel response mapping
# =============================================================================
def _whitelabel_outvin(payload: dict) -> dict:
    """Strip Outvin-specific field names / branding out of a raw response
    before returning to the partner. Fourbuy is the vendor as far as the
    caller is concerned.
    """
    if not isinstance(payload, dict):
        return {}
    # Drop private / vendor-identifying keys.
    drop = {
        "__outvin_status__", "vendor", "provider", "source", "outvin",
        "credits_used", "credits_remaining",
    }
    out: dict[str, Any] = {}
    for k, v in payload.items():
        if k in drop:
            continue
        # Recursively whitelabel nested dicts (rare but possible).
        if isinstance(v, dict):
            out[k] = _whitelabel_outvin(v)
        else:
            out[k] = v
    return out


# =============================================================================
# GET /partner/v1/health — cheap unauthenticated ping
# =============================================================================
@router.get("/partner/v1/health")
async def partner_health():
    return {"ok": True, "service": "Fourbuy VIN Data API", "version": "1.0"}


# =============================================================================
# GET /partner/v1/vin-lookup/{vin} — the main proxy endpoint
# =============================================================================
@router.get("/partner/v1/vin-lookup/{vin}")
async def partner_vin_lookup(
    vin: str,
    request: Request,
    client: dict = Depends(_resolve_partner_client),
):
    """Return factory-options data for the given VIN.

    Response codes:
      200 — data returned, call was billed
      400 — malformed VIN
      404 — no data available for this VIN (NOT billed)
      429 — upstream rate-limit
      500 — internal error (NOT billed)
      502 — upstream vendor error (NOT billed)
    """
    vin = (vin or "").strip().upper()
    if len(vin) < 11 or len(vin) > 25:
        raise HTTPException(400, "Please provide a valid VIN (11–25 chars).")

    call_id = str(uuid.uuid4())
    started_at = now_utc()
    cost = int(client.get("cost_zar_per_lookup") or 0)

    # -----------------------------------------------------------------
    # Rate limit — sliding 60-second window keyed by client. Default 30
    # req/min (matches the published docs); configurable per client via
    # `rate_limit_per_min`. Rejected requests return 429 and are NOT
    # billed. Bots hitting the limit hard don't burn Outvin credits.
    # -----------------------------------------------------------------
    limit_per_min = int(client.get("rate_limit_per_min") or 30)
    if limit_per_min > 0:
        window_start_iso = (datetime.now(timezone.utc) - timedelta(seconds=60)).isoformat()
        recent = await db.partner_api_calls.count_documents({
            "client_id": client["id"],
            "started_at": {"$gte": window_start_iso},
        })
        if recent >= limit_per_min:
            # Log the throttle so the admin can see them in the usage
            # audit trail. cost_billed_zar stays 0 — rejected calls are
            # never billed.
            try:
                await db.partner_api_calls.insert_one({
                    "id": call_id,
                    "client_id": client["id"],
                    "client_name": client.get("name"),
                    "vin": vin,
                    "endpoint": "vin-lookup",
                    "status_code": 429,
                    "served_from_cache": False,
                    "outvin_hit": False,
                    "cost_billed_zar": 0,
                    "error": f"Rate limit exceeded ({limit_per_min}/min)",
                    "ip": (request.headers.get("x-forwarded-for") or "").split(",")[0].strip() or (request.client.host if request.client else ""),
                    "started_at": started_at,
                    "completed_at": now_utc(),
                })
            except Exception:  # pragma: no cover
                pass
            raise HTTPException(
                429,
                f"Rate limit exceeded — {limit_per_min} requests per minute. Try again shortly.",
            )

    served_from_cache = False
    payload: Optional[dict] = None
    error: Optional[str] = None
    outvin_hit = False       # true when we called Outvin (regardless of outcome)
    status_code = 200

    try:
        # -----------------------------------------------------------------
        # 1) Cache-first — perpetual cache; factory data never changes for
        #    a given VIN so we can serve forever from the first fetch.
        # -----------------------------------------------------------------
        cached = await db.outvin_vin_cache.find_one({"vin": vin}, {"_id": 0})
        if cached and cached.get("payload"):
            payload = cached["payload"]
            served_from_cache = True
        else:
            # -----------------------------------------------------------
            # 2) Cache miss — call Outvin. This burns 1 credit on their side.
            # -----------------------------------------------------------
            outvin_hit = True
            try:
                raw = await fetch_outvin_spec(vin)
            except Exception as e:
                # Payment-required / rate-limit / network — treat as 502
                # so Kredo knows we couldn't deliver. NOT billed.
                error = f"Upstream vendor error: {type(e).__name__}: {e}"
                status_code = 429 if "429" in str(e) else 502
                raise HTTPException(status_code, error)

            if (not raw) or (
                isinstance(raw, dict) and str(raw.get("status") or "").lower() in ("error", "not_found")
            ) or (
                isinstance(raw, dict) and raw.get("__outvin_status__") == "not_found"
            ):
                # Vendor has no data for this VIN — NOT billed.
                status_code = 404
                error = "No factory data available for this VIN."
                raise HTTPException(404, error)

            # Persist to the cache — first_billed_at is set to the time
            # the cache is populated so we always know when the underlying
            # Outvin credit was spent. Only successful decodes are cached
            # so a "not_found" doesn't poison the cache for that VIN.
            is_error_payload = isinstance(raw, dict) and str(raw.get("status") or "").lower() in ("error", "not_found")
            if not is_error_payload:
                await db.outvin_vin_cache.update_one(
                    {"vin": vin},
                    {"$setOnInsert": {
                        "vin": vin,
                        "payload": raw,
                        "fetched_at": now_utc(),
                        "first_billed_at": now_utc(),
                    }},
                    upsert=True,
                )
            payload = raw

        # Whitelabel + wrap.
        response = {
            "vin": vin,
            "data": _whitelabel_outvin(payload or {}),
            "source": "Fourbuy VIN Data API",
            "cached": served_from_cache,
            "call_id": call_id,
        }
        return response

    except HTTPException as e:
        # Rebubble but record for audit.
        status_code = e.status_code
        if not error:
            error = str(getattr(e, "detail", e))
        raise
    except Exception as e:  # pragma: no cover
        status_code = 500
        error = f"{type(e).__name__}: {e}"
        logger.exception("partner_api: unexpected error on VIN %s", vin)
        raise HTTPException(500, error)
    finally:
        # -----------------------------------------------------------------
        # Audit log — ALWAYS written (success OR failure) so the admin can
        # see every attempt. `cost_billed_zar` is 0 on failure so failures
        # never end up on the monthly invoice.
        # -----------------------------------------------------------------
        billed = status_code == 200
        try:
            await db.partner_api_calls.insert_one({
                "id": call_id,
                "client_id": client["id"],
                "client_name": client.get("name"),
                "vin": vin,
                "endpoint": "vin-lookup",
                "status_code": status_code,
                "served_from_cache": served_from_cache,
                "outvin_hit": outvin_hit,
                "cost_billed_zar": cost if billed else 0,
                "error": error,
                "ip": (request.headers.get("x-forwarded-for") or "").split(",")[0].strip() or (request.client.host if request.client else ""),
                "started_at": started_at,
                "completed_at": now_utc(),
            })
        except Exception:  # pragma: no cover
            logger.exception("partner_api: audit log write failed")


# =============================================================================
# GET /partner/v1/usage/current-month — partner-facing usage summary
# =============================================================================
@router.get("/partner/v1/usage/current-month")
async def partner_usage_current_month(
    client: dict = Depends(_resolve_partner_client),
):
    now = datetime.now(timezone.utc)
    start = datetime(now.year, now.month, 1, tzinfo=timezone.utc)
    pipeline = [
        {"$match": {"client_id": client["id"], "started_at": {"$gte": start.isoformat()}}},
        {"$group": {
            "_id": None,
            "successful_lookups": {"$sum": {"$cond": [{"$eq": ["$status_code", 200]}, 1, 0]}},
            "failed_lookups": {"$sum": {"$cond": [{"$ne": ["$status_code", 200]}, 1, 0]}},
            "amount_zar": {"$sum": "$cost_billed_zar"},
        }},
    ]
    agg = [d async for d in db.partner_api_calls.aggregate(pipeline)]
    row = agg[0] if agg else {"successful_lookups": 0, "failed_lookups": 0, "amount_zar": 0}
    return {
        "client": client.get("name"),
        "month": start.strftime("%Y-%m"),
        "cost_zar_per_lookup": client.get("cost_zar_per_lookup"),
        "successful_lookups": row.get("successful_lookups", 0),
        "failed_lookups": row.get("failed_lookups", 0),
        "amount_zar": row.get("amount_zar", 0),
    }


# =============================================================================
# ---------- Admin-only endpoints for managing partner clients -----------------
# =============================================================================
class PartnerClientCreate(BaseModel):
    name: str = Field(..., min_length=1)
    cost_zar_per_lookup: int = Field(10, ge=0)
    rate_limit_per_min: int = Field(30, ge=0, description="0 disables the limit; default 30")
    ip_allowlist: list[str] = Field(default_factory=list)
    contact_email: Optional[str] = None
    notes: Optional[str] = None


@router.post("/admin/partner-clients")
async def admin_create_partner_client(
    payload: PartnerClientCreate,
    current: dict = Depends(get_current_user),
):
    if current.get("role") != "admin":
        raise HTTPException(403, "Admin only")
    raw_key = "fbp_" + secrets.token_urlsafe(32)
    client_id = str(uuid.uuid4())
    doc = {
        "id": client_id,
        "name": payload.name,
        "api_key_hash": _hash_key(raw_key),
        "api_key_prefix": raw_key[:8] + "…" + raw_key[-4:],
        "cost_zar_per_lookup": payload.cost_zar_per_lookup,
        "rate_limit_per_min": payload.rate_limit_per_min,
        "ip_allowlist": payload.ip_allowlist,
        "contact_email": payload.contact_email,
        "notes": payload.notes,
        "active": True,
        "created_at": now_utc(),
        "created_by": current["id"],
    }
    await db.partner_api_clients.insert_one(doc)
    return {
        "client_id": client_id,
        "name": payload.name,
        "api_key": raw_key,
        "api_key_prefix": doc["api_key_prefix"],
        "cost_zar_per_lookup": payload.cost_zar_per_lookup,
        "rate_limit_per_min": payload.rate_limit_per_min,
        "warning": "This is the ONLY time the raw API key is shown. Save it now — it cannot be retrieved later.",
    }


@router.get("/admin/partner-clients")
async def admin_list_partner_clients(current: dict = Depends(get_current_user)):
    if current.get("role") != "admin":
        raise HTTPException(403, "Admin only")
    rows = [
        r async for r in db.partner_api_clients.find(
            {}, {"_id": 0, "api_key_hash": 0}
        ).sort("created_at", -1)
    ]
    return {"clients": rows}


@router.post("/admin/partner-clients/{client_id}/rotate-key")
async def admin_rotate_partner_key(
    client_id: str,
    current: dict = Depends(get_current_user),
):
    if current.get("role") != "admin":
        raise HTTPException(403, "Admin only")
    client = await db.partner_api_clients.find_one({"id": client_id})
    if not client:
        raise HTTPException(404, "Client not found")
    raw_key = "fbp_" + secrets.token_urlsafe(32)
    await db.partner_api_clients.update_one(
        {"id": client_id},
        {"$set": {
            "api_key_hash": _hash_key(raw_key),
            "api_key_prefix": raw_key[:8] + "…" + raw_key[-4:],
            "key_rotated_at": now_utc(),
        }},
    )
    return {
        "client_id": client_id,
        "api_key": raw_key,
        "warning": "Old key is invalidated immediately. Save the new key now.",
    }


@router.post("/admin/partner-clients/{client_id}/revoke")
async def admin_revoke_partner_client(
    client_id: str,
    current: dict = Depends(get_current_user),
):
    if current.get("role") != "admin":
        raise HTTPException(403, "Admin only")
    r = await db.partner_api_clients.update_one(
        {"id": client_id},
        {"$set": {"active": False, "revoked_at": now_utc()}},
    )
    if r.matched_count == 0:
        raise HTTPException(404, "Client not found")
    return {"ok": True}


class PartnerClientUpdate(BaseModel):
    """Fields the admin can adjust on an existing client without rotating
    the key. All fields optional — only supplied ones are updated."""
    cost_zar_per_lookup: Optional[int] = Field(None, ge=0)
    rate_limit_per_min: Optional[int] = Field(None, ge=0)
    ip_allowlist: Optional[list[str]] = None
    contact_email: Optional[str] = None
    notes: Optional[str] = None
    active: Optional[bool] = None


@router.patch("/admin/partner-clients/{client_id}")
async def admin_update_partner_client(
    client_id: str,
    payload: PartnerClientUpdate,
    current: dict = Depends(get_current_user),
):
    if current.get("role") != "admin":
        raise HTTPException(403, "Admin only")
    updates = {k: v for k, v in payload.dict(exclude_none=True).items()}
    if not updates:
        raise HTTPException(400, "No fields to update.")
    updates["updated_at"] = now_utc()
    r = await db.partner_api_clients.update_one({"id": client_id}, {"$set": updates})
    if r.matched_count == 0:
        raise HTTPException(404, "Client not found")
    row = await db.partner_api_clients.find_one({"id": client_id}, {"_id": 0, "api_key_hash": 0})
    return {"client": row}


@router.get("/admin/partner-clients/{client_id}/usage")
async def admin_partner_usage(
    client_id: str,
    month: Optional[str] = Query(None, description="YYYY-MM. Defaults to current month."),
    current: dict = Depends(get_current_user),
):
    """Monthly usage summary for a specific partner client — feeds the
    admin's invoicing workflow."""
    if current.get("role") != "admin":
        raise HTTPException(403, "Admin only")
    client = await db.partner_api_clients.find_one({"id": client_id})
    if not client:
        raise HTTPException(404, "Client not found")
    if month:
        try:
            y, m = month.split("-")
            start = datetime(int(y), int(m), 1, tzinfo=timezone.utc)
        except Exception:
            raise HTTPException(400, "month must be YYYY-MM")
    else:
        now = datetime.now(timezone.utc)
        start = datetime(now.year, now.month, 1, tzinfo=timezone.utc)
    # end = 1st of next month
    end_m = start.month + 1
    end_y = start.year
    if end_m > 12:
        end_m = 1
        end_y += 1
    end = datetime(end_y, end_m, 1, tzinfo=timezone.utc)

    q = {"client_id": client_id, "started_at": {"$gte": start.isoformat(), "$lt": end.isoformat()}}
    pipeline = [
        {"$match": q},
        {"$group": {
            "_id": None,
            "successful_lookups":       {"$sum": {"$cond": [{"$eq": ["$status_code", 200]}, 1, 0]}},
            "failed_lookups":           {"$sum": {"$cond": [{"$ne": ["$status_code", 200]}, 1, 0]}},
            "served_from_cache":        {"$sum": {"$cond": [{"$eq": ["$served_from_cache", True]}, 1, 0]}},
            "outvin_credits_burned":    {"$sum": {"$cond": [{"$eq": ["$outvin_hit", True]}, 1, 0]}},
            "amount_zar":               {"$sum": "$cost_billed_zar"},
        }},
    ]
    agg = [d async for d in db.partner_api_calls.aggregate(pipeline)]
    stats = agg[0] if agg else {
        "successful_lookups": 0, "failed_lookups": 0,
        "served_from_cache": 0, "outvin_credits_burned": 0, "amount_zar": 0,
    }
    # Recent calls for the admin to eyeball.
    recent = [
        r async for r in db.partner_api_calls.find(q, {"_id": 0}).sort("started_at", -1).limit(50)
    ]
    return {
        "client": {
            "id": client.get("id"),
            "name": client.get("name"),
            "cost_zar_per_lookup": client.get("cost_zar_per_lookup"),
        },
        "month": start.strftime("%Y-%m"),
        "stats": stats,
        "recent_calls": recent,
    }


# =============================================================================
# GET /partner-api/docs.pdf — downloadable API spec (public, no auth)
# =============================================================================
def _build_partner_api_docs_pdf() -> bytes:
    """Render the Fourbuy VIN Data API spec as a printable PDF.

    Public — no auth. Same content as `/kredo-api/docs`, formatted for
    A4. Kept in sync with the docs page manually (both are short and
    change rarely).
    """
    from io import BytesIO
    from reportlab.lib.pagesizes import A4
    from reportlab.lib.styles import getSampleStyleSheet, ParagraphStyle
    from reportlab.lib.units import mm
    from reportlab.lib import colors as rl_colors
    from reportlab.platypus import (
        SimpleDocTemplate, Paragraph, Spacer, Table, TableStyle, Preformatted,
    )

    styles = getSampleStyleSheet()
    body   = ParagraphStyle("body", parent=styles["Normal"], fontSize=10, leading=14)
    small  = ParagraphStyle("small", parent=styles["Normal"], fontSize=8, leading=11, textColor=rl_colors.grey)
    h2     = ParagraphStyle("h2", parent=styles["Heading2"], fontSize=13, leading=16,
                            textColor=rl_colors.HexColor("#0F172A"), spaceBefore=12, spaceAfter=6)
    h3     = ParagraphStyle("h3", parent=styles["Heading3"], fontSize=10, leading=13,
                            textColor=rl_colors.HexColor("#334155"), spaceBefore=6, spaceAfter=4,
                            textTransform="uppercase")
    mono   = ParagraphStyle("mono", parent=styles["Code"], fontSize=9, leading=12,
                            textColor=rl_colors.HexColor("#0F172A"))

    buf = BytesIO()
    doc = SimpleDocTemplate(
        buf, pagesize=A4,
        leftMargin=18 * mm, rightMargin=18 * mm,
        topMargin=15 * mm, bottomMargin=18 * mm,
        title="Fourbuy VIN Data API — Integration Guide",
        author="TRADE AI powered by FOURBUY",
    )
    story: list = []

    # ---- Brand header ----
    hdr = Table([[
        Paragraph("<font color='white' size='18'><b>FOURBUY VIN DATA API</b></font><br/>"
                  "<font color='white' size='10'>Integration Guide — v1.0 (November 2026)</font>", body),
    ]], colWidths=[174 * mm])
    hdr.setStyle(TableStyle([
        ("BACKGROUND", (0, 0), (-1, -1), rl_colors.HexColor("#0F172A")),
        ("LEFTPADDING", (0, 0), (-1, -1), 14),
        ("RIGHTPADDING", (0, 0), (-1, -1), 14),
        ("TOPPADDING", (0, 0), (-1, -1), 14),
        ("BOTTOMPADDING", (0, 0), (-1, -1), 14),
    ]))
    story.append(hdr)
    strip = Table([[""]], colWidths=[174 * mm], rowHeights=[3])
    strip.setStyle(TableStyle([("BACKGROUND", (0, 0), (-1, -1), rl_colors.HexColor("#22C55E"))]))
    story.append(strip)
    story.append(Spacer(1, 4 * mm))

    story.append(Paragraph(
        "Whitelabel VIN factory-options decode service. "
        "Base URL: <font color='#2563EB'><b>https://api.fourbuy.co.za/api/partner/v1</b></font>",
        body,
    ))

    # ---- Authentication ----
    story.append(Paragraph("Authentication", h2))
    story.append(Paragraph(
        "Every request must include your API key in an <b>Authorization</b> header using the Bearer scheme:",
        body,
    ))
    story.append(Preformatted("Authorization: Bearer fbp_XXXXXXXXXXXX", mono))
    story.append(Paragraph(
        "Keys are provisioned per client. Contact your Fourbuy account manager to receive one. "
        "Keep it server-side — never embed in a browser or mobile app.",
        body,
    ))

    # ---- Health ----
    story.append(Paragraph("Health check", h2))
    story.append(Preformatted("GET /api/partner/v1/health", mono))
    story.append(Paragraph("Returns 200 OK if the service is available. No auth required.", body))
    story.append(Preformatted(
        '{\n  "ok": true,\n  "service": "Fourbuy VIN Data API",\n  "version": "1.0"\n}',
        mono,
    ))

    # ---- VIN lookup ----
    story.append(Paragraph("VIN Lookup", h2))
    story.append(Preformatted("GET /api/partner/v1/vin-lookup/{vin}", mono))
    story.append(Paragraph(
        "Returns factory-options data (OEM datacard) for the supplied VIN. "
        "Successful calls are billed to your account at your contracted per-lookup rate. "
        "Failed calls (404 / 502 / 500) are NOT billed.",
        body,
    ))

    story.append(Paragraph("Example", h3))
    story.append(Preformatted(
        "curl -H 'Authorization: Bearer $FOURBUY_API_KEY' \\\n"
        "  https://api.fourbuy.co.za/api/partner/v1/vin-lookup/WVGZZZ5NZJW402485",
        mono,
    ))

    story.append(Paragraph("Response 200 OK", h3))
    story.append(Preformatted(
        '{\n'
        '  "vin": "WVGZZZ5NZJW402485",\n'
        '  "data": {\n'
        '    "model": "Touareg III",\n'
        '    "series": "CR7",\n'
        '    "build_date": "2018-04-11",\n'
        '    "colour_code": "LB7W",\n'
        '    "options": [\n'
        '      { "code": "0YR", "description": "Panoramic sunroof" },\n'
        '      { "code": "8IU", "description": "LED Matrix headlights" }\n'
        '    ]\n'
        '  },\n'
        '  "source": "Fourbuy VIN Data API",\n'
        '  "cached": false,\n'
        '  "call_id": "6a30..."\n'
        '}',
        mono,
    ))

    story.append(Paragraph("Response codes", h3))
    codes = [
        ["200 OK",                "Data returned. Call is billed."],
        ["400 Bad Request",       "VIN missing or malformed (11–25 chars)."],
        ["401 Unauthorized",      "Missing / invalid / revoked API key."],
        ["403 Forbidden",         "IP address not on the client's allowlist."],
        ["404 Not Found",         "No factory data available for this VIN. Not billed."],
        ["429 Too Many Requests", "Upstream rate limit. Not billed."],
        ["500 Internal Error",    "Fourbuy-side error. Not billed."],
        ["502 Bad Gateway",       "Upstream vendor error. Not billed."],
    ]
    tbl = Table(
        [[Paragraph(f"<b>{c}</b>", body), Paragraph(d, body)] for c, d in codes],
        colWidths=[40 * mm, 134 * mm],
    )
    tbl.setStyle(TableStyle([
        ("LEFTPADDING", (0, 0), (-1, -1), 6),
        ("RIGHTPADDING", (0, 0), (-1, -1), 6),
        ("TOPPADDING", (0, 0), (-1, -1), 4),
        ("BOTTOMPADDING", (0, 0), (-1, -1), 4),
        ("VALIGN", (0, 0), (-1, -1), "TOP"),
        ("LINEBELOW", (0, 0), (-1, -1), 0.25, rl_colors.HexColor("#E2E8F0")),
        ("BACKGROUND", (0, 0), (0, -1), rl_colors.HexColor("#F1F5F9")),
    ]))
    story.append(tbl)

    # ---- Usage ----
    story.append(Paragraph("Usage summary", h2))
    story.append(Preformatted("GET /api/partner/v1/usage/current-month", mono))
    story.append(Paragraph(
        "Returns your calling account's usage in the current calendar month so you can reconcile against your invoice.",
        body,
    ))
    story.append(Preformatted(
        '{\n'
        '  "client": "Kredo",\n'
        '  "month": "2026-11",\n'
        '  "cost_zar_per_lookup": 10,\n'
        '  "successful_lookups": 1240,\n'
        '  "failed_lookups": 17,\n'
        '  "amount_zar": 12400\n'
        '}',
        mono,
    ))

    # ---- Caching / limits / billing ----
    story.append(Paragraph("Caching", h2))
    story.append(Paragraph(
        "Every VIN lookup is cached forever on our side (factory build data does not change for a given VIN). "
        "Repeat lookups for the same VIN return the same payload with <b>\"cached\": true</b> and are still billed — "
        "this is the value of the reseller service.",
        body,
    ))

    story.append(Paragraph("Rate limits", h2))
    story.append(Paragraph(
        "Currently: 30 requests / minute per API key. Contact your account manager if you need higher throughput. "
        "Bursts above the limit receive HTTP 429 and are not billed.",
        body,
    ))

    story.append(Paragraph("Billing", h2))
    story.append(Paragraph(
        "Post-paid, invoiced monthly. Only successful lookups (HTTP 200) are counted; "
        "all failure responses are free of charge.",
        body,
    ))

    # ---- Support ----
    story.append(Paragraph("Support", h2))
    story.append(Paragraph(
        "<b>David Reid</b> — WhatsApp only: <font color='#2563EB'><b>+27 84 881 9073</b></font>",
        body,
    ))
    story.append(Paragraph(
        "Contact for API keys, IP allowlist changes, rate-limit increases, and monthly reconciliation.",
        body,
    ))

    story.append(Spacer(1, 8 * mm))
    story.append(Paragraph(
        "<font color='#64748B'>&#169; TRADE AI powered by FOURBUY — Fourbuy VIN Data API v1.0</font>",
        small,
    ))

    doc.build(story)
    buf.seek(0)
    return buf.read()


@router.get("/partner-api/docs.pdf")
async def partner_api_docs_pdf():
    """Public — anyone with the URL can download the integration guide."""
    try:
        pdf_bytes = _build_partner_api_docs_pdf()
    except Exception as e:  # pragma: no cover
        logger.exception("partner_api docs PDF build failed")
        raise HTTPException(500, f"Failed to build PDF: {e}")
    return Response(
        content=pdf_bytes,
        media_type="application/pdf",
        headers={"Content-Disposition": 'inline; filename="fourbuy-vin-data-api-guide.pdf"'},
    )

