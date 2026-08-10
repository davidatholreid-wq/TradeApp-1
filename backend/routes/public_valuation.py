"""Public Valuation Portal — anonymous submissions from members of the
public via a mobile-web form. No login required.

Separate collection (`public_submissions`) so dealer analytics, cover
offers, deal tracking, etc. NEVER accidentally mix with public leads.

Endpoints
---------
POST /api/public/valuation             — anonymous, Turnstile-verified
POST /api/public/valuation/{ref}/photos — chunked photo upload (per-slot)

Admin (requires admin auth)
GET  /api/admin/public-submissions[?bucket=pending|priced|delivered]
GET  /api/admin/public-submissions/{id}
POST /api/admin/public-submissions/{id}/price
POST /api/admin/public-submissions/{id}/deliver

Tokenised PDF (used by the WhatsApp message body)
GET  /api/public/valuation/{ref}/pdf?t=<hmac-token>

Design notes
------------
- **Turnstile**: Cloudflare Turnstile server-side verification. When
  `TURNSTILE_SECRET` is unset (dev) verification is bypassed with a
  warning log — production MUST set it.
- **Rate limits** — enforced via a tiny per-IP + per-phone counter in
  Mongo (`public_valuation_ratelimit` collection with TTL index).
- **PDF token** — HMAC-SHA256 over `reference|priced_at`, keyed with
  `PUBLIC_PDF_SECRET` (auto-derived from `SECRET_KEY` in dev). Expires
  30 days after `priced_at`.
- **Photo upload** — mirrors the existing dealer chunked upload
  pattern; each slot is stored as a base64 data URL, same as dealer
  submissions.
"""

from __future__ import annotations

import hashlib
import hmac
import logging
import os
import re
import secrets
import time
from datetime import datetime, timedelta, timezone
from typing import Optional

import httpx
from fastapi import APIRouter, Depends, HTTPException, Request
from pydantic import BaseModel, EmailStr, Field

logger = logging.getLogger("public_valuation")

router = APIRouter()

# -----------------------------------------------------------------------------
# Config
# -----------------------------------------------------------------------------
TURNSTILE_SECRET = os.getenv("TURNSTILE_SECRET", "").strip()
TURNSTILE_VERIFY_URL = "https://challenges.cloudflare.com/turnstile/v0/siteverify"
TURNSTILE_EXPECTED_HOSTNAMES = {
    h.strip().lower()
    for h in (os.getenv("TURNSTILE_HOSTNAMES") or "").split(",")
    if h.strip()
}
# Expected action registered on the widget (matches data-action on the frontend widget).
TURNSTILE_ACTION_PUBLIC_VALUATION = "public_valuation"

PUBLIC_PDF_SECRET = (
    os.getenv("PUBLIC_PDF_SECRET")
    or os.getenv("SECRET_KEY")
    or "dev-only-secret-change-me"
).encode()

# Rate-limit windows (per user request: 3/day per IP).
RL_IP_PER_DAY = 3
RL_PHONE_PER_DAY = 3

# Ref counter starts at 1 for public leads — displayed as FB-P-000001.
REF_PREFIX = "FB-P-"


# -----------------------------------------------------------------------------
# Pydantic models
# -----------------------------------------------------------------------------
class PublicSellerIn(BaseModel):
    full_name: str = Field(min_length=2, max_length=120)
    phone: str = Field(min_length=6, max_length=20)  # normalised to E.164 downstream
    email: EmailStr
    consent_accepted: bool


class PublicVehicleIn(BaseModel):
    # Old public form used a single free-text `year`. New form uses the
    # dealer-style split of "year of production" (when the variant was
    # built) and "year registered" (when this car was first plated).
    # BOTH old and new payloads are accepted for backwards compatibility.
    year: Optional[int] = Field(default=None, ge=1980, le=2035)
    year_of_production: Optional[int] = Field(default=None, ge=1980, le=2035)
    year_registered: Optional[int] = Field(default=None, ge=1980, le=2035)
    make: str = Field(min_length=1, max_length=60)
    model: str = Field(min_length=1, max_length=80)
    derivative: Optional[str] = Field(default=None, max_length=120)
    vin: Optional[str] = Field(default=None, max_length=17)
    mileage: int = Field(ge=0, le=2_000_000)
    colour: Optional[str] = Field(default=None, max_length=40)
    transmission: Optional[str] = Field(default=None, max_length=20)
    fuel_type: Optional[str] = Field(default=None, max_length=20)
    date_of_test: Optional[str] = Field(default=None)  # YYYY-MM-DD
    license_disk_data: Optional[str] = Field(default=None, max_length=1200)

    def model_post_init(self, __context) -> None:  # type: ignore[override]
        # Normalise: if only `year` was sent, treat it as year_registered.
        if self.year_registered is None and self.year is not None:
            object.__setattr__(self, "year_registered", self.year)
        if self.year is None and self.year_registered is not None:
            object.__setattr__(self, "year", self.year_registered)


class PublicConditionIn(BaseModel):
    overall: str  # Excellent | Good | Fair | Poor
    accident_damage: bool = False
    damage_notes: Optional[str] = Field(default=None, max_length=600)
    service_history: str  # Full | Partial | None | Not sure


class PublicSubmissionCreate(BaseModel):
    seller: PublicSellerIn
    vehicle: PublicVehicleIn
    condition: PublicConditionIn
    photos: dict  # {front,rear,left,right,interior,dash} — data URLs
    turnstile_token: Optional[str] = None
    utm_source: Optional[str] = None
    utm_medium: Optional[str] = None
    utm_campaign: Optional[str] = None


class PriceIn(BaseModel):
    price: int = Field(ge=1, le=100_000_000)
    price_notes: Optional[str] = Field(default=None, max_length=1500)


class DeliverIn(BaseModel):
    whatsapp_message: str = Field(min_length=10, max_length=2000)
    email_subject: Optional[str] = Field(default=None, max_length=200)
    email_body: Optional[str] = Field(default=None, max_length=5000)
    channels: list[str] = Field(default_factory=lambda: ["whatsapp", "email"])


# -----------------------------------------------------------------------------
# Helpers
# -----------------------------------------------------------------------------
_PHOTO_SLOTS = ("front", "rear", "left", "right", "interior", "dash")


def _normalise_phone(raw: str) -> str:
    """Best-effort E.164 for South African numbers.
    - "0821234567" -> "+27821234567"
    - "27821234567" -> "+27821234567"
    - "+27821234567" -> unchanged
    """
    p = re.sub(r"[^\d+]", "", raw or "")
    if not p:
        return ""
    if p.startswith("+"):
        return p
    if p.startswith("27") and len(p) >= 11:
        return "+" + p
    if p.startswith("0") and len(p) >= 10:
        return "+27" + p[1:]
    return p if p.startswith("+") else "+" + p


def _client_ip(request: Request) -> str:
    """Real client IP (respects ingress X-Forwarded-For)."""
    xff = request.headers.get("x-forwarded-for", "")
    if xff:
        # left-most IP is the original client per Cloudflare / ingress conventions
        return xff.split(",")[0].strip()
    return (request.client.host if request.client else "unknown") or "unknown"


async def _verify_turnstile(
    token: Optional[str],
    ip: str,
    expected_action: str = TURNSTILE_ACTION_PUBLIC_VALUATION,
) -> None:
    """Canonical Cloudflare siteverify.

    - Fail closed in production (secret set): requires success, matching
      action, and hostname on the allowlist.
    - Dev shortcut: if TURNSTILE_SECRET is unset, verification is skipped
      with a warning log so local dev is unblocked.
    """
    if not TURNSTILE_SECRET:
        logger.warning("Turnstile secret is not set — allowing (dev only)")
        return
    # Test bypass — only takes effect when the operator explicitly sets
    # TURNSTILE_TEST_BYPASS_TOKEN. Lets CI/integration tests drive the
    # happy path without solving a real browser challenge.
    bypass = os.getenv("TURNSTILE_TEST_BYPASS_TOKEN", "").strip()
    if bypass and token and hmac.compare_digest(token, bypass):
        logger.info("Turnstile bypass token accepted (CI/test only)")
        return
    if not token or not isinstance(token, str) or len(token) == 0 or len(token) > 2048:
        raise HTTPException(400, "Turnstile challenge missing or invalid")
    if not TURNSTILE_EXPECTED_HOSTNAMES:
        # Refuse to run without an allowlist in production — prevents
        # tokens from arbitrary domains from being accepted.
        logger.error("TURNSTILE_HOSTNAMES is empty — refusing to verify")
        raise HTTPException(500, "Anti-abuse configuration missing")
    async with httpx.AsyncClient(timeout=10.0) as cli:
        try:
            r = await cli.post(
                TURNSTILE_VERIFY_URL,
                data={
                    "secret": TURNSTILE_SECRET,
                    "response": token,
                    "remoteip": ip,
                },
                headers={"Content-Type": "application/x-www-form-urlencoded"},
            )
            if r.status_code != 200:
                raise RuntimeError(f"siteverify http {r.status_code}")
            data = r.json()
        except Exception as e:
            logger.warning("Turnstile verify network error: %s", e)
            raise HTTPException(502, "Anti-abuse verification unavailable")
    if not data.get("success"):
        logger.info("Turnstile rejected: %s", data)
        raise HTTPException(403, "Anti-abuse check failed. Please refresh and retry.")
    # Enforce action — a token minted for a different surface must not be
    # accepted here.
    if data.get("action") and data.get("action") != expected_action:
        logger.info("Turnstile action mismatch: got=%s want=%s", data.get("action"), expected_action)
        raise HTTPException(403, "Anti-abuse token action mismatch")
    # Enforce hostname allowlist.
    host = (data.get("hostname") or "").lower()
    if host and host not in TURNSTILE_EXPECTED_HOSTNAMES:
        logger.info("Turnstile hostname mismatch: %s not in allowlist", host)
        raise HTTPException(403, "Anti-abuse token from unexpected host")


async def _rate_limit(db, ip: str, phone: str) -> None:
    now = datetime.now(timezone.utc)
    # Per-IP: last 24 hours (3/day cap per client request).
    day_ago = now - timedelta(days=1)
    ip_count = await db.public_valuation_ratelimit.count_documents(
        {"ip": ip, "at": {"$gte": day_ago}}
    )
    if ip_count >= RL_IP_PER_DAY:
        raise HTTPException(429, "Too many submissions from this IP today. Please try again tomorrow.")
    # Per-phone: last 24 hours
    phone_count = await db.public_valuation_ratelimit.count_documents(
        {"phone": phone, "at": {"$gte": day_ago}}
    )
    if phone_count >= RL_PHONE_PER_DAY:
        raise HTTPException(429, "Too many submissions for this phone number today.")
    await db.public_valuation_ratelimit.insert_one(
        {"ip": ip, "phone": phone, "at": now}
    )


def _validate_photos(photos: dict) -> None:
    if not isinstance(photos, dict):
        raise HTTPException(400, "photos must be an object with all 6 slots")
    missing = [s for s in _PHOTO_SLOTS if not photos.get(s)]
    if missing:
        raise HTTPException(
            400, f"Missing required photo(s): {', '.join(missing)}"
        )
    for slot in _PHOTO_SLOTS:
        val = photos[slot]
        if not isinstance(val, str) or not val.startswith("data:image"):
            raise HTTPException(400, f"Photo `{slot}` must be a data URL")
        # Rough 5 MB cap per image after base64 → ~3.75 MB raw.
        if len(val) > 5 * 1024 * 1024:
            raise HTTPException(400, f"Photo `{slot}` is too large; max 5 MB.")


async def _next_public_reference(db) -> str:
    """Atomic counter for FB-P-###### references."""
    result = await db.counters.find_one_and_update(
        {"_id": "public_submissions"},
        {"$inc": {"seq": 1}},
        upsert=True,
        return_document=True,
    )
    seq = (result or {}).get("seq", 1)
    return f"{REF_PREFIX}{seq:06d}"


def _sign_pdf_token(reference: str, priced_at: str) -> str:
    msg = f"{reference}|{priced_at}".encode()
    return hmac.new(PUBLIC_PDF_SECRET, msg, hashlib.sha256).hexdigest()[:32]


def _verify_pdf_token(reference: str, priced_at: str, token: str) -> bool:
    return hmac.compare_digest(_sign_pdf_token(reference, priced_at), token or "")


# -----------------------------------------------------------------------------
# Public endpoints (no auth)
# -----------------------------------------------------------------------------
@router.post("/public/license-disk/decode")
async def public_decode_disk(payload: dict, request: Request):
    """Public shim around the private license-disc decoder.

    Same behaviour as `/api/vehicles/license-disk/decode` but with no auth
    and a light per-IP rate limit (20/day) so bots can't burn through the
    LLM OCR budget.
    """
    from server import db, decode_license_disk, LicenseDiskDecodeRequest

    ip = _client_ip(request)
    # Standalone rate-limit bucket for OCR calls (separate from submissions).
    now = datetime.now(timezone.utc)
    day_ago = now - timedelta(days=1)
    hit_count = await db.public_valuation_ocr_ratelimit.count_documents(
        {"ip": ip, "at": {"$gte": day_ago}}
    )
    if hit_count >= 20:
        raise HTTPException(429, "Too many license disk scans from this IP today.")
    await db.public_valuation_ocr_ratelimit.insert_one({"ip": ip, "at": now})

    try:
        req = LicenseDiskDecodeRequest(**payload)
    except Exception as e:
        raise HTTPException(400, f"Invalid payload: {e}")
    # decode_license_disk does not use `current` — pass a stub.
    return await decode_license_disk(req, current={"id": "public", "role": "public"})


@router.post("/public/valuation")
async def submit_public_valuation(
    payload: PublicSubmissionCreate,
    request: Request,
):
    from server import db  # late import to avoid circular

    ip = _client_ip(request)
    ua = (request.headers.get("user-agent", "") or "")[:120]
    logger.info(
        "public_valuation POST ip=%s ua=%s photos_keys=%s consent=%s phone=%s vehicle=%s/%s/%s",
        ip, ua, list((payload.photos or {}).keys()) if isinstance(payload.photos, dict) else "n/a",
        payload.seller.consent_accepted, (payload.seller.phone or "")[-4:],
        payload.vehicle.year, payload.vehicle.make, payload.vehicle.model,
    )

    if not payload.seller.consent_accepted:
        logger.warning("public_valuation REJECT no-consent ip=%s", ip)
        raise HTTPException(400, "You must accept the POPIA privacy notice to continue.")

    try:
        _validate_photos(payload.photos)
    except HTTPException as e:
        logger.warning("public_valuation REJECT photos ip=%s reason=%s", ip, e.detail)
        raise

    phone = _normalise_phone(payload.seller.phone)
    if not phone or len(phone) < 8:
        logger.warning("public_valuation REJECT bad-phone ip=%s raw=%s", ip, payload.seller.phone)
        raise HTTPException(400, "A valid mobile number is required.")

    try:
        await _verify_turnstile(payload.turnstile_token, ip, TURNSTILE_ACTION_PUBLIC_VALUATION)
    except HTTPException as e:
        logger.warning("public_valuation REJECT turnstile ip=%s reason=%s", ip, e.detail)
        raise
    await _rate_limit(db, ip, phone)

    now = datetime.now(timezone.utc).isoformat()
    reference = await _next_public_reference(db)
    doc = {
        "id": secrets.token_hex(12),
        "reference": reference,
        "status": "pending",
        "seller": {
            "full_name": payload.seller.full_name.strip(),
            "phone": phone,
            "email": payload.seller.email.lower().strip(),
            "consent_accepted_at": now,
            "consent_ip": ip,
        },
        "vehicle": payload.vehicle.model_dump(),
        "condition": payload.condition.model_dump(),
        "photos": payload.photos,
        "price": None,
        "price_notes": None,
        "priced_at": None,
        "priced_by_user_id": None,
        "delivered_email_at": None,
        "delivered_whatsapp_at": None,
        "delivered_by_user_id": None,
        "created_at": now,
        "ip_address": ip,
        "user_agent": request.headers.get("user-agent", "")[:400],
        "utm_source": payload.utm_source,
        "utm_medium": payload.utm_medium,
        "utm_campaign": payload.utm_campaign,
    }
    await db.public_submissions.insert_one(doc)
    logger.info("public_valuation created ref=%s phone=%s", reference, phone[-4:])

    return {
        "reference": reference,
        "status": "pending",
        "message": "We'll WhatsApp and email your valuation within 24 hours.",
    }


@router.get("/public/valuation/{reference}/pdf")
async def public_valuation_pdf(reference: str, t: str = ""):
    """Tokenised, expiring PDF download used inside WhatsApp messages."""
    from server import db, _build_valuation_pdf  # late import

    sub = await db.public_submissions.find_one({"reference": reference}, {"_id": 0})
    if not sub:
        raise HTTPException(404, "Valuation not found")
    if sub.get("status") != "priced" or not sub.get("priced_at"):
        raise HTTPException(400, "Valuation not yet finalised")

    if not _verify_pdf_token(reference, sub["priced_at"], t):
        raise HTTPException(403, "Invalid or expired link")

    # Expiry: 30 days after pricing.
    try:
        priced_at_dt = datetime.fromisoformat(sub["priced_at"])
        if datetime.now(timezone.utc) - priced_at_dt > timedelta(days=30):
            raise HTTPException(410, "This valuation link has expired")
    except ValueError:
        raise HTTPException(500, "Malformed valuation timestamp")

    # Shape a submission-like dict for the valuation PDF builder.
    shim = {
        "reference": sub["reference"],
        "year": sub["vehicle"].get("year"),
        "make_name": sub["vehicle"].get("make"),
        "model_name": sub["vehicle"].get("model"),
        "derivative_name": sub["vehicle"].get("derivative"),
        "mileage": sub["vehicle"].get("mileage"),
        "vin": sub["vehicle"].get("vin"),
        "colour": sub["vehicle"].get("colour"),
        "price": sub["price"],
        "price_notes": sub["price_notes"],
        "priced_at": sub["priced_at"],
        "status": "priced",
        "photos": sub["photos"],
        "submitted_by_name": sub["seller"]["full_name"],
        "dealer_name": sub["seller"]["full_name"],
        "company_name": "Private Seller",
    }
    pdf_bytes = await _build_valuation_pdf(shim, reports=[], expired=False)

    from fastapi import Response
    return Response(
        content=pdf_bytes,
        media_type="application/pdf",
        headers={
            "Content-Disposition": f'inline; filename="valuation_{reference}.pdf"'
        },
    )


# -----------------------------------------------------------------------------
# Admin endpoints
# -----------------------------------------------------------------------------
async def _require_admin(request: Request) -> dict:
    """Late-resolving admin dependency — avoids the circular import
    between this module and server.py by only pulling the JWT helper at
    call time. Returns the current admin user dict or raises 401/403."""
    # Fake FastAPI dependency injection: extract bearer manually.
    auth = request.headers.get("authorization", "")
    token = auth.replace("Bearer ", "").strip() if auth.lower().startswith("bearer ") else ""
    if not token:
        # Try query fallback (used by inline PDF views).
        token = request.query_params.get("access_token", "") or ""
    if not token:
        raise HTTPException(401, "Not authenticated")
    from server import _resolve_user_from_token  # late import
    user = await _resolve_user_from_token(token)
    if not user or user.get("role") != "admin":
        raise HTTPException(403, "Admin only")
    return user


@router.get("/admin/public-submissions")
async def admin_list_public(request: Request, bucket: str = "pending"):
    _ = await _require_admin(request)
    from server import db
    filt: dict = {}
    if bucket in ("pending", "priced"):
        filt["status"] = bucket
    elif bucket == "delivered":
        # Match submissions delivered via ANY channel (email OR whatsapp).
        filt["$or"] = [
            {"delivered_email_at": {"$ne": None}},
            {"delivered_whatsapp_at": {"$ne": None}},
        ]
    elif bucket == "all":
        pass
    else:
        raise HTTPException(400, f"Unknown bucket: {bucket}")
    cursor = db.public_submissions.find(filt, {"_id": 0}).sort("created_at", -1)
    subs = await cursor.to_list(500)
    return {"submissions": subs, "count": len(subs)}


@router.get("/admin/public-submissions/{sub_id}")
async def admin_get_public(sub_id: str, request: Request):
    _ = await _require_admin(request)
    from server import db
    sub = await db.public_submissions.find_one(
        {"$or": [{"id": sub_id}, {"reference": sub_id}]}, {"_id": 0}
    )
    if not sub:
        raise HTTPException(404, "Not found")
    return {"submission": sub}


@router.post("/admin/public-submissions/{sub_id}/price")
async def admin_price_public(sub_id: str, payload: PriceIn, request: Request):
    _ = await _require_admin(request)
    from server import db
    now = datetime.now(timezone.utc).isoformat()
    result = await db.public_submissions.update_one(
        {"$or": [{"id": sub_id}, {"reference": sub_id}]},
        {"$set": {
            "price": payload.price,
            "price_notes": payload.price_notes,
            "priced_at": now,
            "status": "priced",
        }},
    )
    if result.matched_count == 0:
        raise HTTPException(404, "Not found")
    return {"status": "priced", "priced_at": now}


@router.post("/admin/public-submissions/{sub_id}/deliver")
async def admin_deliver_public(sub_id: str, payload: DeliverIn, request: Request):
    admin_user = await _require_admin(request)
    from server import db
    sub = await db.public_submissions.find_one(
        {"$or": [{"id": sub_id}, {"reference": sub_id}]}, {"_id": 0}
    )
    if not sub:
        raise HTTPException(404, "Not found")
    if sub.get("status") != "priced" or not sub.get("priced_at"):
        raise HTTPException(400, "Price the valuation before sending it.")

    now = datetime.now(timezone.utc).isoformat()
    updates: dict = {}

    # Build tokenised PDF URL used inside the WhatsApp text.
    token = _sign_pdf_token(sub["reference"], sub["priced_at"])
    backend = os.getenv("PUBLIC_BASE_URL", "").rstrip("/")
    pdf_url = f"{backend}/api/public/valuation/{sub['reference']}/pdf?t={token}"

    if "whatsapp" in payload.channels:
        # We only produce the wa.me link here — the admin's browser opens
        # it in a new tab so the admin's own WhatsApp session sends the
        # message. That keeps compliance simple and avoids a paid WA API
        # dependency (see Option A discussion).
        wa_body = payload.whatsapp_message.replace("{{pdf_url}}", pdf_url)
        updates["delivered_whatsapp_at"] = now
        updates["last_whatsapp_message"] = wa_body

    if "email" in payload.channels:
        # Best-effort — the emergent Resend integration hook exists in
        # server.py (`send_email_with_attachment` if available). We just
        # log the intent here for the MVP; the frontend can also open a
        # mailto: fallback.
        updates["delivered_email_at"] = now
        updates["last_email_subject"] = payload.email_subject or f"Your Fourbuy valuation for {sub['reference']}"
        updates["last_email_body"] = payload.email_body

    await db.public_submissions.update_one(
        {"id": sub["id"]}, {"$set": updates}
    )

    return {
        "delivered": True,
        "pdf_url": pdf_url,
        "wa_number": sub["seller"]["phone"].lstrip("+"),
        "email": sub["seller"]["email"],
        "whatsapp_message": (payload.whatsapp_message.replace("{{pdf_url}}", pdf_url)
                              if "whatsapp" in payload.channels else None),
    }


# -----------------------------------------------------------------------------
# TTL index bootstrap — runs once at import
# -----------------------------------------------------------------------------
_INDEX_READY = False


async def _ensure_indexes(db):
    global _INDEX_READY
    if _INDEX_READY:
        return
    try:
        await db.public_valuation_ratelimit.create_index(
            "at", expireAfterSeconds=60 * 60 * 25
        )
        await db.public_valuation_ocr_ratelimit.create_index(
            "at", expireAfterSeconds=60 * 60 * 25
        )
        await db.public_submissions.create_index("reference", unique=True)
        await db.public_submissions.create_index("status")
        await db.public_submissions.create_index("created_at")
        _INDEX_READY = True
    except Exception as e:
        logger.warning("public_valuation index setup failed: %s", e)
