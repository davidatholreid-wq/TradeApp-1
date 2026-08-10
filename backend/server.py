from fastapi import FastAPI, APIRouter, HTTPException, Depends, Header, Query, Request
from fastapi.responses import Response
from dotenv import load_dotenv
from starlette.middleware.cors import CORSMiddleware
from motor.motor_asyncio import AsyncIOMotorClient
import os
import re
import asyncio
import base64
import logging
import uuid
import bcrypt
import jwt as pyjwt
import httpx
from pathlib import Path
from pydantic import BaseModel, Field, EmailStr
from typing import Any, List, Optional, Literal
from datetime import datetime, timezone, timedelta

from emergentintegrations.llm.chat import LlmChat, UserMessage

ROOT_DIR = Path(__file__).parent
load_dotenv(ROOT_DIR / '.env')

MONGO_URL = os.environ['MONGO_URL']
DB_NAME = os.environ['DB_NAME']
JWT_SECRET = os.environ.get('JWT_SECRET', 'dev_secret')
JWT_EXPIRES_IN = int(os.environ.get('JWT_EXPIRES_IN', '604800'))
ADMIN_EMAIL = os.environ.get('ADMIN_EMAIL', 'admin@autopricepro.com')
ADMIN_PASSWORD = os.environ.get('ADMIN_PASSWORD', 'admin123')

PUSH_BASE_URL = "https://integrations.emergentagent.com"
PUSH_KEY = os.environ.get("EMERGENT_PUSH_KEY", "placeholder")
EMERGENT_LLM_KEY = os.environ.get("EMERGENT_LLM_KEY", "")

# ============ Cloudinary (image hosting) ============
# Photos are uploaded to Cloudinary server-side; MongoDB stores only the
# returned secure HTTPS URL. Legacy base64 photos from prior submissions are
# left untouched (Option B) — the helper is a no-op for anything that is
# already an https URL.
import cloudinary
import cloudinary.uploader

CLOUDINARY_CLOUD_NAME = os.environ.get("CLOUDINARY_CLOUD_NAME", "")
CLOUDINARY_API_KEY = os.environ.get("CLOUDINARY_API_KEY", "")
CLOUDINARY_API_SECRET = os.environ.get("CLOUDINARY_API_SECRET", "")
CLOUDINARY_ENABLED = bool(
    CLOUDINARY_CLOUD_NAME and CLOUDINARY_API_KEY and CLOUDINARY_API_SECRET
)
if CLOUDINARY_ENABLED:
    cloudinary.config(
        cloud_name=CLOUDINARY_CLOUD_NAME,
        api_key=CLOUDINARY_API_KEY,
        api_secret=CLOUDINARY_API_SECRET,
        secure=True,
    )


def _looks_like_base64_image(value) -> bool:
    """True if value is a base64 data URL (data:image/...;base64,....) that
    should be uploaded to Cloudinary. Ignores http(s) URLs and empty values."""
    if not value or not isinstance(value, str):
        return False
    if value.startswith("http://") or value.startswith("https://"):
        return False
    return value.startswith("data:image") or len(value) > 500


def _valid_front_photo(value):
    """Return `value` if it looks like a renderable photo (Cloudinary/https
    URL, or a base64 data URL big enough to be a real image), else None."""
    if not value or not isinstance(value, str):
        return None
    if value.startswith("http://") or value.startswith("https://"):
        return value
    # base64 payload — must be big enough to not be a 1x1 placeholder pixel
    return value if len(value) > 500 else None


def upload_image_to_cloudinary(
    value: Optional[str],
    folder: str,
    public_id: Optional[str] = None,
) -> Optional[str]:
    """Upload a base64 data-URL to Cloudinary and return the secure_url.

    - Returns the value unchanged if it is empty, already an https URL, or
      too small to be a real photo.
    - Returns None on upload failure (logs the error) so callers can decide
      to fall back to the original base64 payload if desired.
    """
    if not CLOUDINARY_ENABLED:
        return value
    if not _looks_like_base64_image(value):
        return value
    payload = value if value.startswith("data:") else f"data:image/jpeg;base64,{value}"
    try:
        params = {
            "folder": folder,
            "resource_type": "image",
            "overwrite": True,
            "unique_filename": public_id is None,
        }
        if public_id:
            params["public_id"] = public_id
        res = cloudinary.uploader.upload(payload, **params)
        return res.get("secure_url") or value
    except Exception as e:
        logging.getLogger(__name__).error(
            "Cloudinary upload failed (folder=%s, public_id=%s): %s",
            folder, public_id, e,
        )
        # Fall back to keeping the base64 payload so nothing is lost.
        return value


def upload_photos_dict_to_cloudinary(
    photos: Optional[dict],
    sub_id: str,
) -> Optional[dict]:
    """Upload every base64 photo in a submission's photos dict to Cloudinary
    and return a new dict with the same keys mapped to secure URLs."""
    if not photos or not isinstance(photos, dict):
        return photos
    if not CLOUDINARY_ENABLED:
        return photos
    out: dict = {}
    folder = f"fourbuy/submissions/{sub_id}"
    for key, val in photos.items():
        if _looks_like_base64_image(val):
            out[key] = upload_image_to_cloudinary(val, folder, public_id=str(key))
        else:
            out[key] = val
    return out

client = AsyncIOMotorClient(MONGO_URL)
db = client[DB_NAME]

app = FastAPI()
api_router = APIRouter(prefix="/api")

logging.basicConfig(level=logging.INFO, format='%(asctime)s - %(name)s - %(levelname)s - %(message)s')
logger = logging.getLogger(__name__)

_push_client = httpx.AsyncClient(
    base_url=PUSH_BASE_URL,
    headers={"X-Push-Key": PUSH_KEY},
    timeout=10.0,
)


# ============ Helpers ============
ARCHIVE_AFTER_DAYS = 14
BILLING_FEE_ZAR = 50.0
BILLING_SLA_HOURS = 24

# ============ Fourbuy Rewards ============
# 1 point per submission that becomes billable. 50 points redeems for a
# R500 Takealot voucher. Points are per USER (not per dealership).
REWARD_POINT_LABEL = "Fourbuy Rewards"
REWARD_POINTS_PER_VOUCHER = 50
REWARD_VOUCHER_VALUE_ZAR = 500
REWARD_VOUCHER_PROVIDER = "Takealot"

# Vehicle report catalogue — dealers may purchase these against a submission's
# VIN after an offer has been received. Cost is added to the dealer's monthly
# billing (alongside the R50 valuation fee). Real APIs are wired up later; for
# now the order is stored as PENDING so the UI can reflect it.
REPORT_CATALOG = {
    "lightstone_verification": {
        "name": "Lightstone Vehicle Verification Report",
        "cost_zar": 100.0,
    },
    "lightstone_repair": {
        "name": "Lightstone Vehicle Repair History Report",
        "cost_zar": 50.0,
    },
    "car_vertical": {
        "name": "Car Vertical Report",
        "cost_zar": 200.0,
    },
    # BMW-family VIN-linked report — sourced live from Bimmervin (BMW
    # factory order). Currently offered on BMW and MINI vehicles only.
    # Front-end filters this out of the catalog for other brands.
    "bmw_options": {
        "name": "BMW Factory Options",
        "cost_zar": 20.0,
        "supported_makes": ["BMW", "MINI"],
    },
    # JLR Online Service History — Land Rover / Range Rover / Jaguar.
    # Scraped live from https://osh.landrover.com. Result caches on the
    # submission so a given VIN is only scraped once. Only offered on
    # JLR-family submissions.
    "landrover_osh": {
        "name": "Land Rover / Jaguar Service History",
        "cost_zar": 20.0,
        "supported_makes": [
            "LAND ROVER", "LAND-ROVER", "LANDROVER",
            "RANGE ROVER", "RANGE-ROVER",
            "JAGUAR",
        ],
    },
    # Kredo VIN accident / claim history — live lookup, per-lookup
    # dealer charge. Front-end also references this via the same
    # REPORT_CATALOG so the "OPEN FULL REPORT PDF" download endpoint
    # accepts it.
    "kredo_vin_history": {
        "name": "Accident / Claim History (Kredo VIN)",
        "cost_zar": 100.0,
    },
}


def now_utc() -> str:
    return datetime.now(timezone.utc).isoformat()


def parse_iso(ts: Optional[str]) -> Optional[datetime]:
    if not ts:
        return None
    try:
        dt = datetime.fromisoformat(ts)
        if dt.tzinfo is None:
            dt = dt.replace(tzinfo=timezone.utc)
        return dt
    except Exception:
        return None


def is_billable(sub: dict) -> bool:
    """A submission is billable only if it was PRICED within BILLING_SLA_HOURS
    (24h) of being submitted. If admin took longer than the SLA, no fee.
    """
    if sub.get("status") != "priced":
        return False
    created = parse_iso(sub.get("created_at"))
    priced = parse_iso(sub.get("priced_at"))
    if not created or not priced:
        return False
    delta = priced - created
    if delta < timedelta(0):
        return False
    return delta <= timedelta(hours=BILLING_SLA_HOURS)


# ============ Fourbuy Rewards helpers ============
# Ledger-based points system. Every point delta (award or spend) is an event
# in `reward_ledger` so we always have a full audit trail. The balance is the
# net sum, computed on read (cheap for typical dealer volumes).

async def award_reward_point_for_submission(sub: dict) -> None:
    """Award 1 point to the submitter when their submission becomes billable.
    Idempotent — safe to call multiple times for the same submission; the
    `sub_id` unique index on the ledger prevents duplicate awards.

    ALSO awards a matching 1 point to the submitter's referrer (if any),
    using a `referral_of_user_id` + `referral_of_reference` tag so the
    Rewards screen can render it as "Referred point from FB-000XXX" — no
    car details, no dealership leaks between accounts.
    """
    if not is_billable(sub):
        return
    user_id = sub.get("submitted_by_user_id") or sub.get("dealer_id")
    if not user_id:
        return
    sub_id = sub.get("id")
    reference = sub.get("reference") or (sub_id[:8] if sub_id else "?")
    # Idempotency guard — check if an "earn" event already exists for this sub.
    existing = await db.reward_ledger.find_one({"type": "earn", "sub_id": sub_id})
    if not existing:
        doc = {
            "id": str(uuid.uuid4()),
            "user_id": user_id,
            "dealership_id": sub.get("dealership_id"),
            "type": "earn",
            "delta": 1,
            "sub_id": sub_id,
            "note": f"Billable valuation · {reference}",
            "at": now_utc(),
        }
        try:
            await db.reward_ledger.insert_one(doc)
        except Exception as e:
            # Partial unique index (type=earn, sub_id) blocks concurrent duplicates.
            # Anything else we log and swallow — rewards must never break pricing.
            if "duplicate" not in str(e).lower():
                logger.warning("Reward award insert failed (non-blocking): %s", e)

    # Mirror the point onto the submitter's referrer (if they have one).
    submitter = await db.users.find_one({"id": user_id}, {"_id": 0, "referred_by_user_id": 1})
    referrer_id = (submitter or {}).get("referred_by_user_id")
    if not referrer_id:
        return
    # Idempotency on the referrer side — one referral point per submission.
    existing_ref = await db.reward_ledger.find_one({"type": "referral_earn", "sub_id": sub_id})
    if existing_ref:
        return
    ref_doc = {
        "id": str(uuid.uuid4()),
        "user_id": referrer_id,
        "type": "referral_earn",
        "delta": 1,
        "sub_id": sub_id,
        # Deliberately NO car details — only the reference number.
        "referral_of_reference": reference,
        "referral_of_user_id": user_id,
        "note": f"Referred point · {reference}",
        "at": now_utc(),
    }
    try:
        await db.reward_ledger.insert_one(ref_doc)
    except Exception as e:
        if "duplicate" not in str(e).lower():
            logger.warning("Referral point insert failed (non-blocking): %s", e)


async def get_user_reward_balance(user_id: str) -> int:
    """Sum of all ledger deltas for this user. Never returns negative."""
    total = 0
    async for e in db.reward_ledger.find({"user_id": user_id}, {"_id": 0, "delta": 1}):
        total += int(e.get("delta") or 0)
    return max(0, total)


async def spend_points(user_id: str, points: int, redemption_id: str, note: str) -> None:
    """Debit points from a user's balance. Called at Redeem-time so the same
    user can't double-redeem before the admin actions the request."""
    doc = {
        "id": str(uuid.uuid4()),
        "user_id": user_id,
        "type": "spend",
        "delta": -abs(int(points)),
        "redemption_id": redemption_id,
        "note": note,
        "at": now_utc(),
    }
    await db.reward_ledger.insert_one(doc)


async def refund_points(user_id: str, points: int, redemption_id: str, note: str) -> None:
    """Refund points when an admin REJECTS a redemption."""
    doc = {
        "id": str(uuid.uuid4()),
        "user_id": user_id,
        "type": "refund",
        "delta": abs(int(points)),
        "redemption_id": redemption_id,
        "note": note,
        "at": now_utc(),
    }
    await db.reward_ledger.insert_one(doc)


def compute_bucket(sub: dict) -> str:
    """Return 'incoming', 'priced' or 'archived' based on status + priced_at age.

    - status == 'pending'  → 'incoming'
    - status == 'priced' and priced_at within ARCHIVE_AFTER_DAYS → 'priced'
    - status == 'priced' and priced_at older than ARCHIVE_AFTER_DAYS → 'archived'
    - status == 'declined' — decisioned (no offer). Grouped into the 'priced'
      bucket so it lives with other decisioned cars, and archives after the
      same window using declined_at as the reference.
    """
    status = sub.get("status") or "pending"
    if status == "declined":
        declined_at_raw = sub.get("declined_at")
        if not declined_at_raw:
            return "priced"
        try:
            declined_at = datetime.fromisoformat(declined_at_raw)
            if declined_at.tzinfo is None:
                declined_at = declined_at.replace(tzinfo=timezone.utc)
        except Exception:
            return "priced"
        if datetime.now(timezone.utc) - declined_at > timedelta(days=ARCHIVE_AFTER_DAYS):
            return "archived"
        return "priced"
    if status != "priced":
        return "incoming"
    priced_at_raw = sub.get("priced_at")
    if not priced_at_raw:
        return "priced"
    try:
        priced_at = datetime.fromisoformat(priced_at_raw)
        if priced_at.tzinfo is None:
            priced_at = priced_at.replace(tzinfo=timezone.utc)
    except Exception:
        return "priced"
    age = datetime.now(timezone.utc) - priced_at
    if age > timedelta(days=ARCHIVE_AFTER_DAYS):
        return "archived"
    return "priced"


def hash_password(pw: str) -> str:
    return bcrypt.hashpw(pw.encode(), bcrypt.gensalt(10)).decode()


def verify_password(pw: str, hashed: str) -> bool:
    try:
        return bcrypt.checkpw(pw.encode(), hashed.encode())
    except Exception:
        return False


def sign_token(user_id: str, email: str, role: str) -> str:
    payload = {
        "sub": user_id,
        "email": email,
        "role": role,
        "exp": datetime.now(timezone.utc) + timedelta(seconds=JWT_EXPIRES_IN),
    }
    return pyjwt.encode(payload, JWT_SECRET, algorithm="HS256")


async def get_current_user(authorization: Optional[str] = Header(None)) -> dict:
    if not authorization or not authorization.startswith("Bearer "):
        raise HTTPException(401, "Missing or invalid Authorization header")
    token = authorization.split(" ", 1)[1]
    try:
        decoded = pyjwt.decode(token, JWT_SECRET, algorithms=["HS256"])
    except pyjwt.ExpiredSignatureError:
        raise HTTPException(401, "Token expired")
    except Exception:
        raise HTTPException(401, "Invalid token")
    user = await db.users.find_one({"id": decoded["sub"]}, {"_id": 0, "password_hash": 0})
    if not user:
        raise HTTPException(401, "User not found")
    return user


async def _resolve_user_from_token(token: str) -> dict:
    """Decode a raw JWT (from Authorization header or `access_token` query param).

    Used by GET endpoints that need to be embed-able inside a mobile in-app
    browser (WebBrowser.openBrowserAsync) which cannot forward custom headers.
    """
    try:
        decoded = pyjwt.decode(token, JWT_SECRET, algorithms=["HS256"])
    except pyjwt.ExpiredSignatureError:
        raise HTTPException(401, "Token expired")
    except Exception:
        raise HTTPException(401, "Invalid token")
    user = await db.users.find_one({"id": decoded["sub"]}, {"_id": 0, "password_hash": 0})
    if not user:
        raise HTTPException(401, "User not found")
    return user


async def get_user_flexible(
    authorization: Optional[str] = Header(None),
    access_token: Optional[str] = Query(None),
) -> dict:
    """Auth dependency that accepts either the Authorization header OR an
    `?access_token=` query parameter. Only intended for GET endpoints that
    return blob content (PDFs) previewable in an in-app browser.
    """
    if authorization and authorization.startswith("Bearer "):
        return await _resolve_user_from_token(authorization.split(" ", 1)[1])
    if access_token:
        return await _resolve_user_from_token(access_token)
    raise HTTPException(401, "Missing authentication")


async def get_optional_user(
    authorization: Optional[str] = Header(None),
) -> Optional[dict]:
    """Best-effort auth. Returns the user if a valid Bearer token is
    present, otherwise returns None WITHOUT raising. Used by public-ish
    GET endpoints (e.g. `/vehicles/options`) that want to serve
    unauthenticated callers with the default rules but apply role-based
    tweaks when the caller happens to be logged in.
    """
    if not authorization or not authorization.startswith("Bearer "):
        return None
    token = authorization.split(" ", 1)[1]
    try:
        return await _resolve_user_from_token(token)
    except HTTPException:
        return None
    except Exception:
        return None


async def require_admin(current: dict = Depends(get_current_user)) -> dict:
    if current.get("role") != "admin":
        raise HTTPException(403, "Admin access required")
    return current


async def send_push(recipients: List[str], data: dict) -> None:
    if not recipients:
        return
    payload = {"recipients": recipients, "data": data}
    try:
        resp = await _push_client.post("/api/v1/push/trigger", json=payload)
        if resp.status_code >= 400:
            logger.warning(f"Push send failed status={resp.status_code} body={resp.text[:200]}")
    except Exception as e:
        logger.warning(f"Push send error: {e}")


async def next_reference_number() -> str:
    """Generate an auto-incrementing FB-000001 reference."""
    result = await db.counters.find_one_and_update(
        {"_id": "submission_ref"},
        {"$inc": {"seq": 1}},
        upsert=True,
        return_document=True,
    )
    seq = result["seq"] if result else 1
    return f"FB-{seq:06d}"


# ============ Models ============
# The registration/dealership request schemas were extracted 2026-08-09
# to `backend/models/registration.py`. Re-imported here so every downstream
# reference in `server.py` (route handlers, docstrings, etc.) keeps working
# without touching a single call-site. All other Pydantic models still live
# inline further down in this file — they'll migrate as their surrounding
# route groups are peeled off in later phases.
from models.registration import (
    DealerInfo,
    CompanyInfo,
    RegisterRequest,
    AdminInviteUserRequest,
    DealershipUpdate,
    DealershipCreate,
)


async def _ensure_dealership_for_user(user: dict) -> str:
    """Idempotently create a Dealership for a legacy dealer user that
    doesn't have one yet. Returns the dealership id.

    Behaviour:
    - If the user already has `dealership_id`, returns it.
    - Otherwise creates a new dealership using the user's `company_info` and
      links the user to it, marking the user as an active member.
    """
    if user.get("dealership_id"):
        return user["dealership_id"]
    ci = user.get("company_info") or {}
    dealership_id = str(uuid.uuid4())
    doc = {
        "id": dealership_id,
        "name": ci.get("company_name") or f"Dealership {dealership_id[:8]}",
        "address": ci.get("company_address") or "",
        "company_reg_no": ci.get("company_reg_no"),
        "vat_no": ci.get("vat_no"),
        "active": True,
        "created_at": now_utc(),
    }
    await db.dealerships.insert_one(doc)
    await db.users.update_one(
        {"id": user["id"]},
        {"$set": {"dealership_id": dealership_id}},
    )
    logger.info("Migrated user %s -> dealership %s (%s)", user.get("email"), dealership_id, doc["name"])
    return dealership_id


async def _get_user_dealership_id(user: dict) -> Optional[str]:
    """Return the user's dealership_id, creating one on the fly for a legacy
    dealer that doesn't yet have one. Admins return None."""
    if user.get("role") != "dealer":
        return None
    if user.get("dealership_id"):
        return user["dealership_id"]
    return await _ensure_dealership_for_user(user)


async def _can_access_submission(sub: dict, user: dict) -> bool:
    """A user may access a submission when they're an admin OR when the
    submission belongs to the same dealership (all users of a dealership
    share visibility). Pricing agents may access ANY non-draft submission
    that is not from their own dealership — the response is sanitised
    downstream so they never see the Fourbuy admin offer/pricing.
    Falls back to the legacy `dealer_id == user.id` check for
    pre-migration submissions that don't yet carry a `dealership_id`.
    """
    if user.get("role") == "admin":
        return True
    if sub.get("dealership_id"):
        if sub["dealership_id"] == await _get_user_dealership_id(user):
            return True
    elif sub.get("dealer_id") == user.get("id"):
        return True
    # Pricing agents: cross-dealership read-only access for cover placement.
    if user.get("is_pricing_agent") and sub.get("status") != "draft":
        my_dship = await _get_user_dealership_id(user)
        if sub.get("dealership_id") and sub.get("dealership_id") != my_dship:
            return True
    return False


class LoginRequest(BaseModel):
    email: EmailStr
    password: str


class RegisterPushBody(BaseModel):
    platform: str
    device_token: str


class VehicleSubmission(BaseModel):
    # Progressive-filter picks (all now driven by /api/vehicles/options)
    make: str
    fuel_type: str
    year_of_production: int
    transmission: str
    model: str
    derivative: str
    year_registered: int

    # Optional: full manufacture-year range for the selected variant from the
    # Kredo flatfile. Included when the client resolves it at submission time.
    variant_manufacture_range: Optional[dict] = None
    # True iff `year_registered > variant_manufacture_range.max` — the vehicle
    # was registered after this variant was discontinued.
    registered_after_discontinued: Optional[bool] = None

    # Auto-filled from the license disc scan (may be "TBC")
    colour: str
    vin: Optional[str] = "TBC"
    engine_number: Optional[str] = "TBC"
    license_disk_data: Optional[str] = None
    # Base64 photo of the physical licence disc (from live-camera capture or
    # a gallery upload). Uploaded to Cloudinary on submit for permanent
    # attachment to the submission.
    license_disk_photo: Optional[str] = None

    # "Vehicle Unseen, Subject to View & Less to Spend" flag. When the dealer
    # is requesting a desktop valuation without having inspected the car,
    # every physical-inspection field below (condition ratings, recon,
    # service history, damage) becomes non-mandatory and the valuation is
    # flagged loudly in every UI + the PDF.
    unseen: Optional[bool] = False

    # Four condition pillars (1-10). We took over the old exterior/tyre
    # fields with the new mechanical/cosmetic/history pillars — interior
    # stays as-is. exterior_condition / tyre_condition are kept as optional
    # for backwards compatibility with legacy submissions.
    # When `unseen=True` these become optional (defaulted to a neutral 5
    # so scoring & downstream analytics don't blow up); the UI hides the
    # rating cards entirely in that mode.
    mechanical_condition: int = Field(default=5, ge=1, le=10)
    cosmetic_condition: int = Field(default=5, ge=1, le=10)
    interior_condition: int = Field(default=5, ge=1, le=10)
    history_condition: int = Field(default=5, ge=1, le=10)
    # Legacy (deprecated) — accepted but not required by the new mobile form.
    exterior_condition: Optional[int] = Field(default=None, ge=1, le=10)
    tyre_condition: Optional[int] = Field(default=None, ge=1, le=10)
    # Windscreen — three simple options after the flow rewrite. "Chip" and
    # "Crack" from the legacy schema are still accepted for historical
    # submissions but new submissions must use one of the new options.
    # Optional when `unseen=True` (the dealer hasn't inspected the glass yet).
    windscreen_condition: Optional[Literal[
        "Perfect", "Chip Repairs", "Needs Replacement",
        "Chip", "Crack",  # legacy
    ]] = None

    # Service history — optional when `unseen=True`.
    service_history: Optional[Literal[
        "Full Service History with Agents",
        "Full Service History with Agents & Non-Agents",
        "Partial Service History",
        "No Service History",
    ]] = None
    last_service_date: Optional[str] = None   # ISO date or None → "TBC"
    last_service_mileage: Optional[int] = None

    # Photos: {front, driver_side, passenger_side, rear, interior}
    photos: dict
    mileage: int

    # Damage / paint — optional when the vehicle is unseen (we can't
    # know paint or accident history without inspecting).
    paint_evidence: Optional[bool] = None
    # Optional detail selected when paint_evidence == True
    paint_quality: Optional[Literal["Excellent", "Fair", "Poor"]] = None
    accident_damage: Optional[bool] = None
    # Multiple damage categories identifiable in the dealer's inspection.
    # Free-string list so the enum can grow without a migration; the UI
    # currently offers: Cosmetic, Structural, Mechanical, Glass,
    # Electrical/Functional.
    accident_damage_types: list[str] = []
    # Rim size in inches — no longer collected on the form (removed 2026-07)
    # but the field is kept optional so historic drafts / API callers still
    # validate. The AI tyre estimate now assumes OEM factory rim size.
    rim_size: Optional[int] = Field(default=None, ge=12, le=26)

    # Reconditioning costs: list of {label: str, amount_zar: float}
    reconditioning_items: list[dict] = []

    # Factory Warranty & Maintenance Plan status (dealer-declared at
    # valuation time). Kept independent so a car can be under Maintenance
    # Plan but not Factory Warranty, or vice versa. `None` = not answered
    # (legacy submissions).
    factory_warranty_status: Optional[Literal["active", "expired"]] = None
    maintenance_plan_status: Optional[Literal["active", "expired"]] = None

    # Compliance
    billing_accepted: bool = False


class PriceOffer(BaseModel):
    price: float
    notes: Optional[str] = None
    # Optional free-form comment attached to THIS price change (why the number
    # moved). Stored in `price_history` for full auditability. If omitted, an
    # auto-generated comment ("Initial offer" or "Price updated") is used.
    change_comment: Optional[str] = None


class DeclineOffer(BaseModel):
    admin_note: Optional[str] = None  # internal note, not shown to the dealer


class DealerEditRequest(BaseModel):
    first_name: Optional[str] = None
    last_name: Optional[str] = None
    phone: Optional[str] = None
    # Free-text job title (e.g. "Sales Manager"). Empty string clears it.
    job_title: Optional[str] = None
    email: Optional[EmailStr] = None
    company_name: Optional[str] = None
    company_address: Optional[str] = None


class DealerPasswordReset(BaseModel):
    new_password: str = Field(min_length=6)


class DealerActiveToggle(BaseModel):
    active: bool


class DealerPhotoUpload(BaseModel):
    profile_pic: Optional[str] = None   # base64 data URL, empty string clears
    cover_photo: Optional[str] = None   # base64 data URL, empty string clears


class ReportOrderCreate(BaseModel):
    type: Literal["lightstone_verification", "lightstone_repair", "car_vertical", "bmw_options", "landrover_osh"]
    accepted_charge: bool = False


# ============ Auth routes ============
@api_router.post("/auth/register")
async def register(payload: RegisterRequest):  # noqa: ARG001 - schema kept for client compatibility
    """Public self-registration is disabled.

    All dealer users must be created by a Fourbuy administrator through
    `POST /api/admin/dealerships/{dealership_id}/users` (or by creating a new
    dealership from the admin cockpit). Returning 403 here keeps the client
    contract explicit while making it impossible for the public web form to
    create accounts.
    """
    raise HTTPException(
        status_code=403,
        detail=(
            "Dealer accounts are created by Fourbuy administrators. "
            "Please contact your Fourbuy admin to be added to your dealership."
        ),
    )


@api_router.post("/auth/login")
async def login(payload: LoginRequest):
    user = await db.users.find_one({"email": payload.email.lower()})
    if not user or not verify_password(payload.password, user["password_hash"]):
        raise HTTPException(401, "Invalid email or password")
    # Suspended or archived dealers cannot log in. Admins are always allowed.
    if user.get("role") == "dealer":
        if user.get("archived_at"):
            raise HTTPException(
                403,
                "This dealer account has been archived. Please contact Fourbuy.",
            )
        if user.get("active") is False:
            raise HTTPException(
                403,
                "Your account has been suspended. Please contact Fourbuy to settle any outstanding balance.",
            )
    token = sign_token(user["id"], user["email"], user["role"])
    # Ensure legacy dealer users have a dealership_id — the startup migration
    # covers this too, but a lazy fallback keeps login robust on fresh dumps.
    dealership_id = None
    referral_code = user.get("referral_code")
    referred_by_payload = None
    if user["role"] == "dealer":
        dealership_id = await _get_user_dealership_id(user)
        # Lazily assign a lifetime referral code to any dealer that doesn't
        # already have one, so the Profile screen renders it immediately
        # after login (instead of only after the next /auth/me refresh).
        if not referral_code:
            async def _code_exists(c: str) -> bool:
                return (await db.users.count_documents({"referral_code": c})) > 0
            referral_code = await allocate_unique_code(_code_exists)
            await db.users.update_one(
                {"id": user["id"]}, {"$set": {"referral_code": referral_code}}
            )
        # Mirror the /auth/me referred_by enrichment so the Profile screen
        # can render "Referred by …" without waiting for a second call.
        rb_id = user.get("referred_by_user_id")
        if rb_id:
            referrer = await db.users.find_one(
                {"id": rb_id},
                {"_id": 0, "dealer_info": 1, "dealership_id": 1, "referral_code": 1},
            )
            if referrer:
                info = referrer.get("dealer_info") or {}
                first = (info.get("first_name") or "").strip()
                last = (info.get("last_name") or "").strip()
                name = (first + " " + last).strip() or "a Fourbuy dealer"
                rb_dship_name = None
                if referrer.get("dealership_id"):
                    rdship = await db.dealerships.find_one(
                        {"id": referrer["dealership_id"]}, {"_id": 0, "name": 1}
                    )
                    rb_dship_name = (rdship or {}).get("name")
                referred_by_payload = {
                    "name": name,
                    "dealership": rb_dship_name,
                    "code": user.get("referred_by_code") or referrer.get("referral_code"),
                }
    return {
        "token": token,
        "user": {
            "id": user["id"],
            "email": user["email"],
            "role": user["role"],
            "active": user.get("active", True),
            "archived_at": user.get("archived_at"),
            "agreement_accepted_at": user.get("agreement_accepted_at"),
            "dealer_info": user.get("dealer_info"),
            "company_info": user.get("company_info"),
            "profile_pic": user.get("profile_pic"),
            "cover_photo": user.get("cover_photo"),
            "dealership_id": dealership_id,
            "referral_code": referral_code,
            "referred_by": referred_by_payload,
            "is_pricing_agent": bool(user.get("is_pricing_agent")),
        },
    }


# ==================================================================
# Password reset via email magic link (Emergent-managed Resend)
# ------------------------------------------------------------------
# Flow:
#   1. Dealer taps "Forgot password?" on the sign-in screen.
#   2. Frontend calls POST /api/auth/forgot-password with their email.
#   3. Backend generates a short-lived, signed reset token (JWT with
#      `type: pwreset`, 30-min TTL), stores its jti in the
#      `password_resets` collection so we can enforce single-use, then
#      emails a magic link:
#          {APP_BASE_URL}/reset-password?token=<jwt>
#   4. Dealer clicks the link -> ResetPassword screen -> POST
#      /api/auth/reset-password with token + new password.
#   5. Backend validates the token + jti (not consumed, not expired),
#      bcrypt-hashes the new password, marks the jti as consumed so it
#      cannot be replayed.
#
# The forgot-password endpoint intentionally returns the same generic
# payload whether or not the email exists — this prevents attackers
# from enumerating registered dealers. Rate limiting also applies at
# the per-email level (max 3 requests per hour).
# ==================================================================
import secrets as _pw_secrets  # local alias avoids clobbering existing `secrets`


class ForgotPasswordRequest(BaseModel):
    email: EmailStr


class ResetPasswordRequest(BaseModel):
    token: str
    new_password: str


PASSWORD_RESET_TTL_SECONDS = 30 * 60          # 30 minutes
PASSWORD_RESET_MAX_PER_HOUR = 3               # per email
PASSWORD_RESET_TOKEN_TYPE = "pwreset"


def _app_base_url_from_request(request: Optional[Request]) -> str:
    """Resolve the customer-facing origin for building the reset link.
    Priority:
      1. `APP_BASE_URL` env var (explicit override, wins in production)
      2. `Origin` request header (works both in dev and preview)
      3. Fallback constant for local dev
    """
    env_url = (os.environ.get("APP_BASE_URL") or "").strip().rstrip("/")
    if env_url:
        return env_url
    if request is not None:
        origin = request.headers.get("origin") or request.headers.get("referer")
        if origin:
            # Strip everything after the host if it's a full URL.
            m = re.match(r"^(https?://[^/]+)", origin)
            if m:
                return m.group(1)
    return "http://localhost:3000"


async def _send_password_reset_email(
    to_email: str, reset_link: str, display_name: Optional[str] = None
) -> None:
    """Fire-and-forget dispatch of the reset email via the Emergent-
    managed Resend proxy. Failures are logged but do not raise — the
    caller's response must be identical regardless (to avoid email
    enumeration)."""
    email_key = (os.environ.get("EMERGENT_EMAIL_KEY") or "").strip()
    from_name = (os.environ.get("EMAIL_FROM_NAME") or "Fourbuy Car Buying Co.").strip()
    if not email_key:
        logger.error("EMERGENT_EMAIL_KEY not configured — cannot send reset email")
        return

    greeting = f"Hi {display_name}," if display_name else "Hi,"
    html = f"""
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#0B0F14;padding:32px 0;font-family:Arial,Helvetica,sans-serif;color:#E5E7EB;">
      <tr>
        <td align="center">
          <table role="presentation" width="520" cellpadding="0" cellspacing="0" style="background:#111827;border:1px solid #1F2937;border-radius:14px;padding:32px;">
            <tr>
              <td style="font-size:20px;font-weight:800;color:#F9FAFB;padding-bottom:8px;">Reset your Fourbuy password</td>
            </tr>
            <tr>
              <td style="font-size:14px;color:#D1D5DB;line-height:1.5;padding-bottom:20px;">
                {greeting}<br><br>
                We received a request to reset the password for your Fourbuy Car Buying Co. account. Click the button below to choose a new one. This link is valid for 30 minutes and can only be used once.
              </td>
            </tr>
            <tr>
              <td align="center" style="padding:8px 0 20px 0;">
                <a href="{reset_link}"
                   style="display:inline-block;background:#F59E0B;color:#111827;text-decoration:none;padding:12px 22px;border-radius:8px;font-weight:800;letter-spacing:.3px;">
                  Reset password
                </a>
              </td>
            </tr>
            <tr>
              <td style="font-size:12px;color:#9CA3AF;line-height:1.5;">
                If the button doesn't work, copy and paste this link into your browser:<br>
                <span style="color:#93C5FD;word-break:break-all;">{reset_link}</span>
              </td>
            </tr>
            <tr>
              <td style="font-size:11px;color:#6B7280;padding-top:24px;border-top:1px solid #1F2937;margin-top:24px;">
                Didn't ask for this? You can safely ignore this email — your current password will keep working.
              </td>
            </tr>
          </table>
          <div style="font-size:11px;color:#6B7280;padding-top:16px;">
            © Fourbuy Car Buying Co.
          </div>
        </td>
      </tr>
    </table>
    """
    payload = {
        "to": [to_email],
        "subject": "Reset your Fourbuy password",
        "html": html,
        "from_name": from_name,
    }
    try:
        async with httpx.AsyncClient(timeout=15) as client:
            resp = await client.post(
                "https://integrations.emergentagent.com/api/v1/email/send",
                headers={"X-Email-Key": email_key},
                json=payload,
            )
            resp.raise_for_status()
    except httpx.HTTPStatusError as e:
        logger.error(
            "Password-reset email send failed: status=%s body=%s",
            e.response.status_code, e.response.text[:400],
        )
    except Exception as e:
        logger.error("Password-reset email send error: %s", e)


@api_router.post("/auth/forgot-password")
async def forgot_password(payload: ForgotPasswordRequest, request: Request):
    """Kick off a password-reset flow. Always returns the same generic
    payload so callers can't enumerate which emails are registered."""
    generic = {
        "status": "ok",
        "message": "If that email is registered, a reset link has been sent.",
    }
    email = payload.email.lower().strip()
    if not email:
        return generic

    # Rate-limit: max PASSWORD_RESET_MAX_PER_HOUR requests per email in
    # the last hour. Silently swallow anything over-limit — again to
    # avoid revealing whether the account exists.
    cutoff = datetime.now(timezone.utc) - timedelta(hours=1)
    recent_count = await db.password_resets.count_documents({
        "email": email, "created_at": {"$gte": cutoff.isoformat()},
    })
    if recent_count >= PASSWORD_RESET_MAX_PER_HOUR:
        logger.info("Password-reset rate-limited for %s (%d in last hour)", email, recent_count)
        return generic

    user = await db.users.find_one(
        {"email": email},
        {"_id": 0, "id": 1, "email": 1, "role": 1, "dealer_info": 1, "active": 1, "archived_at": 1},
    )

    if user and not user.get("archived_at"):
        # Suspended dealers can still reset — resetting itself doesn't
        # bypass any suspension check, and support may deliberately ask
        # them to reset before we lift a suspension.
        jti = _pw_secrets.token_urlsafe(24)
        now = datetime.now(timezone.utc)
        expires_at = now + timedelta(seconds=PASSWORD_RESET_TTL_SECONDS)
        token_body = {
            "sub": user["id"],
            "email": user["email"],
            "type": PASSWORD_RESET_TOKEN_TYPE,
            "jti": jti,
            "iat": int(now.timestamp()),
            "exp": int(expires_at.timestamp()),
        }
        token = pyjwt.encode(token_body, JWT_SECRET, algorithm="HS256")
        await db.password_resets.insert_one({
            "jti": jti,
            "user_id": user["id"],
            "email": email,
            "created_at": now.isoformat(),
            "expires_at": expires_at.isoformat(),
            "consumed_at": None,
            "request_ip": request.client.host if request and request.client else None,
        })
        base = _app_base_url_from_request(request)
        # `/reset-password?token=...` — file lives at
        # /app/frontend/app/(auth)/reset-password.tsx (the auth group
        # is a routing convenience, the URL doesn't include it).
        reset_link = f"{base}/reset-password?token={token}"
        logger.info("reset_link built: %s", reset_link)

        # Best-effort personalisation.
        info = user.get("dealer_info") or {}
        display_name = (info.get("first_name") or "").strip() or None
        await _send_password_reset_email(user["email"], reset_link, display_name=display_name)
        logger.info("Password reset email dispatched to %s (jti=%s)", email, jti)
    else:
        # Log-only — do NOT reveal to the caller that the user is missing.
        logger.info("Password reset requested for unknown email: %s", email)

    return generic


@api_router.post("/auth/reset-password")
async def reset_password(payload: ResetPasswordRequest):
    """Consume a reset token and set the new password. Enforces:
      • JWT signature + type + expiry
      • jti has not already been consumed (single-use)
      • Minimum password length (6 chars, matches /auth/register)
    """
    new_password = (payload.new_password or "").strip()
    if len(new_password) < 6:
        raise HTTPException(400, "Password must be at least 6 characters.")
    try:
        decoded = pyjwt.decode(payload.token, JWT_SECRET, algorithms=["HS256"])
    except pyjwt.ExpiredSignatureError:
        raise HTTPException(400, "This reset link has expired. Please request a new one.")
    except pyjwt.InvalidTokenError:
        raise HTTPException(400, "This reset link is invalid. Please request a new one.")

    if decoded.get("type") != PASSWORD_RESET_TOKEN_TYPE:
        raise HTTPException(400, "This reset link is invalid.")

    jti = decoded.get("jti")
    user_id = decoded.get("sub")
    if not jti or not user_id:
        raise HTTPException(400, "This reset link is invalid.")

    record = await db.password_resets.find_one({"jti": jti})
    if not record:
        raise HTTPException(400, "This reset link is invalid.")
    if record.get("consumed_at"):
        raise HTTPException(400, "This reset link has already been used. Please request a new one.")

    user = await db.users.find_one({"id": user_id}, {"_id": 0, "id": 1, "email": 1})
    if not user:
        raise HTTPException(400, "Account no longer exists.")

    # Atomically mark the jti consumed BEFORE writing the new hash so a
    # race between two clicks can't set two different passwords.
    consumed = await db.password_resets.update_one(
        {"jti": jti, "consumed_at": None},
        {"$set": {"consumed_at": datetime.now(timezone.utc).isoformat()}},
    )
    if consumed.modified_count != 1:
        raise HTTPException(400, "This reset link has already been used. Please request a new one.")

    new_hash = hash_password(new_password)
    await db.users.update_one(
        {"id": user_id},
        {"$set": {
            "password_hash": new_hash,
            # Legacy field kept in sync (some older code still reads it).
            "password_hashed": new_hash,
            # Reset lockout state so a locked account can log in again
            # immediately after a successful reset.
            "failed_login_count": 0,
            "account_locked_until": None,
            "password_updated_at": datetime.now(timezone.utc).isoformat(),
        }},
    )

    return {"status": "ok", "message": "Password updated. You can now sign in."}


@api_router.get("/stats/covers-30d")
async def public_covers_last_30_days(current: dict = Depends(get_current_user)):
    """Sum of Fourbuy Cover Prices given to dealers in the last 30 days.

    Rendered on the home-page "Earn Rewards" flip banner so every user
    sees a live running figure of how much cover Fourbuy has issued
    recently. Uses `priced_at` and the dealer-facing offer amount
    (`price` / `offer_to_dealer_zar` / `admin_pricing.offer_to_dealer_zar`).
    Auth is required (uses `get_current_user`) so the number stays behind
    the login wall.
    """
    cutoff = datetime.now(timezone.utc) - timedelta(days=30)
    cutoff_iso = cutoff.isoformat()
    total = 0
    count = 0
    cursor = db.submissions.find(
        {
            "status": "priced",
            "priced_at": {"$gte": cutoff_iso},
        },
        {"_id": 0, "price": 1, "offer_to_dealer_zar": 1, "admin_pricing": 1, "priced_at": 1},
    )
    async for s in cursor:
        # Prefer the explicit `price` field (top-level, set when the admin
        # priced the vehicle); fall back to `offer_to_dealer_zar` and then
        # to the nested `admin_pricing.offer_to_dealer_zar`.
        amt = s.get("price") or s.get("offer_to_dealer_zar")
        if amt is None and isinstance(s.get("admin_pricing"), dict):
            amt = s["admin_pricing"].get("offer_to_dealer_zar")
        if amt is None:
            continue
        try:
            total += int(amt)
            count += 1
        except (TypeError, ValueError):
            continue
    return {"total_zar": total, "count": count, "since": cutoff_iso}


@api_router.get("/stats/deal-outcomes")
async def deal_outcomes_stats(current: dict = Depends(get_current_user)):
    """Roll-up of deal-tracking outcomes across the caller's visible
    submissions. Powers the Home-screen "Deal Outcomes" reporting tile.

    Scope:
      • Admin — all non-pending submissions across every dealership.
      • Pricing agent — same scope as an admin (they see their own
        dealership's submissions, and the Give Cover flow is separate).
      • Dealer — submissions owned by their DEALERSHIP (any teammate).

    Outcome buckets:
      • pending   — dealer hasn't answered "Did you do the deal?" yet
                     (deal is null OR deal.done is null/missing).
      • deal_done — dealer answered Yes (deal.done === true).
      • no_deal   — dealer answered No  (deal.done === false).

    Also returns two derived counters that are useful on the same tile:
      • sold          — how many "deal_done" also have deal.sold === true.
      • gross_profit_zar — sum of profits across sold submissions (may be
                            negative if the dealer took a loss).

    We deliberately EXCLUDE `status == "pending"` submissions from every
    bucket because the deal-tracking UI is hidden until the vehicle is
    priced — nothing to record an outcome against yet.
    """
    role = current.get("role")
    # Build the mongo filter for submissions we should count.
    query: dict = {"status": {"$ne": "pending"}}
    if role != "admin":
        my_dship = await _get_user_dealership_id(current)
        if my_dship:
            query["$or"] = [
                {"dealership_id": my_dship},
                # Legacy submissions without dealership_id — fall back to
                # the ownership check.
                {"dealer_id": current.get("id")},
            ]
        else:
            query["dealer_id"] = current.get("id")

    pending = 0
    deal_done = 0
    no_deal = 0
    sold = 0
    profit_total = 0
    cursor = db.submissions.find(
        query,
        {"_id": 0, "deal": 1, "status": 1, "dealership_id": 1, "dealer_id": 1},
    )
    async for s in cursor:
        deal = s.get("deal") or {}
        done_val = deal.get("done")
        if done_val is True:
            deal_done += 1
            if deal.get("sold") is True:
                sold += 1
                # Reuse the same helper the vehicle detail page uses so
                # this figure ALWAYS matches the P&L rendered elsewhere.
                p = _compute_deal_profit(deal).get("profit_zar")
                if isinstance(p, (int, float)):
                    profit_total += int(p)
        elif done_val is False:
            no_deal += 1
        else:
            pending += 1

    total = pending + deal_done + no_deal
    return {
        "pending": pending,
        "deal_done": deal_done,
        "no_deal": no_deal,
        "sold": sold,
        "total": total,
        "gross_profit_zar": profit_total,
    }


@api_router.get("/admin/stats/deal-outcomes-by-dealer")
async def deal_outcomes_by_dealer(current: dict = Depends(require_admin)):
    """Per-dealership deal-outcomes roll-up for the Admin Cockpit home.

    Returns a list of dealerships (sorted with the most pending outcomes
    at the top so the admin can prioritise chasing them), each with
    pending / deal_done / no_deal counts, how many of the "deal done"
    submissions ultimately sold, and their combined gross-P&L. Legacy
    submissions without a `dealership_id` are grouped under a synthetic
    dealership derived from the `dealer_name` snapshot.
    """
    # Build a dealer_id -> dealership_id map so we can bucket legacy
    # submissions (that only have `dealer_id` on them) into the right
    # dealership. Dealers with `dealership_id` on the user record fall
    # into their own dealership; the rest map to a "no dealership" catch
    # all so nothing is lost from the report.
    users_cursor = db.users.find(
        {"role": "dealer"},
        {"_id": 0, "id": 1, "dealership_id": 1, "dealer_info": 1, "email": 1},
    )
    dealer_to_dship: dict = {}
    dealer_display: dict = {}
    async for u in users_cursor:
        dealer_to_dship[u.get("id")] = u.get("dealership_id")
        info = u.get("dealer_info") or {}
        dealer_display[u.get("id")] = (
            f"{info.get('first_name','').strip()} {info.get('last_name','').strip()}".strip()
            or u.get("email")
            or "Unknown dealer"
        )

    dealerships_cursor = db.dealerships.find(
        {}, {"_id": 0, "id": 1, "name": 1, "trading_name": 1}
    )
    dship_name: dict = {}
    async for d in dealerships_cursor:
        dship_name[d.get("id")] = (
            d.get("trading_name") or d.get("name") or "Unnamed dealership"
        )

    # Aggregate submissions.
    buckets: dict = {}  # key -> stats dict

    def _b(key: str, name: str) -> dict:
        if key not in buckets:
            buckets[key] = {
                "dealership_id": key,
                "name": name,
                "pending": 0,
                "deal_done": 0,
                "no_deal": 0,
                "sold": 0,
                "gross_profit_zar": 0,
                "total": 0,
            }
        return buckets[key]

    cursor = db.submissions.find(
        {"status": {"$ne": "pending"}},
        {"_id": 0, "deal": 1, "dealership_id": 1, "dealer_id": 1, "dealer_name": 1, "company_name": 1},
    )
    async for s in cursor:
        dship_id = s.get("dealership_id") or dealer_to_dship.get(s.get("dealer_id"))
        if dship_id:
            key = f"dship:{dship_id}"
            name = dship_name.get(dship_id) or s.get("company_name") or "Unnamed dealership"
        else:
            # Legacy submission with no dealership — group by the dealer
            # user id so at least each seller shows up separately.
            did = s.get("dealer_id") or "unknown"
            key = f"user:{did}"
            name = (
                dealer_display.get(did)
                or s.get("dealer_name")
                or s.get("company_name")
                or "Legacy / unassigned"
            )
        b = _b(key, name)
        b["total"] += 1
        deal = s.get("deal") or {}
        done_val = deal.get("done")
        if done_val is True:
            b["deal_done"] += 1
            if deal.get("sold") is True:
                b["sold"] += 1
                p = _compute_deal_profit(deal).get("profit_zar")
                if isinstance(p, (int, float)):
                    b["gross_profit_zar"] += int(p)
        elif done_val is False:
            b["no_deal"] += 1
        else:
            b["pending"] += 1

    # Sort: most-pending first, then by total desc, then name.
    dealers = sorted(
        buckets.values(),
        key=lambda x: (-x["pending"], -x["total"], x["name"].lower()),
    )
    return {"dealers": dealers, "dealership_count": len(dealers)}







@api_router.get("/auth/me")
async def me(current: dict = Depends(get_current_user)):
    # Include billing-related fields that the client uses to gate flows.
    current["active"] = current.get("active", True)
    # Lazily assign a lifetime referral code to any dealer that doesn't
    # already have one (covers users created before referral codes were
    # introduced). Admins do NOT get a code — referrals are dealer-only.
    if current.get("role") == "dealer" and not current.get("referral_code"):
        async def _code_exists(c: str) -> bool:
            return (await db.users.count_documents({"referral_code": c})) > 0
        code = await allocate_unique_code(_code_exists)
        await db.users.update_one({"id": current["id"]}, {"$set": {"referral_code": code}})
        current["referral_code"] = code
    # Enrich with dealership info so the client can render "Submitted by
    # …" chips and a "Team" screen without a second round-trip.
    if current.get("role") == "dealer":
        dealership_id = await _get_user_dealership_id(current)
        if dealership_id:
            current["dealership_id"] = dealership_id
            dship = await db.dealerships.find_one({"id": dealership_id}, {"_id": 0})
            if dship:
                current["dealership"] = dship
        # Attach a friendly "referred_by" payload so the Profile screen can
        # render a "Referred by …" line without a second round-trip. We only
        # expose safe fields (name + dealership) — never id/email/phone.
        rb_id = current.get("referred_by_user_id")
        if rb_id:
            referrer = await db.users.find_one(
                {"id": rb_id},
                {"_id": 0, "dealer_info": 1, "dealership_id": 1, "referral_code": 1},
            )
            if referrer:
                info = referrer.get("dealer_info") or {}
                first = (info.get("first_name") or "").strip()
                last = (info.get("last_name") or "").strip()
                name = (first + " " + last).strip() or "a Fourbuy dealer"
                rb_dship_name = None
                if referrer.get("dealership_id"):
                    rdship = await db.dealerships.find_one(
                        {"id": referrer["dealership_id"]}, {"_id": 0, "name": 1}
                    )
                    rb_dship_name = (rdship or {}).get("name")
                current["referred_by"] = {
                    "name": name,
                    "dealership": rb_dship_name,
                    "code": current.get("referred_by_code") or referrer.get("referral_code"),
                }
    current["is_pricing_agent"] = bool(current.get("is_pricing_agent"))
    return {"user": current}


@api_router.get("/referral/lookup")
async def referral_lookup(code: str):
    """PUBLIC endpoint — no auth required. Given a referral code, return
    a minimal safe payload the register/invitation screen can use to
    render "Referred by <name>" for a prospective dealer arriving via a
    shared link. Returns 404 for unknown codes."""
    normalised = (code or "").strip().upper()
    if not normalised:
        raise HTTPException(400, "Referral code required.")
    user = await db.users.find_one(
        {"referral_code": normalised, "role": "dealer"},
        {"_id": 0, "id": 1, "dealer_info": 1, "dealership_id": 1},
    )
    if not user:
        raise HTTPException(404, "Referral code not found.")
    dship = None
    if user.get("dealership_id"):
        dship = await db.dealerships.find_one(
            {"id": user["dealership_id"]}, {"_id": 0, "name": 1}
        )
    info = user.get("dealer_info") or {}
    first = (info.get("first_name") or "").strip()
    last = (info.get("last_name") or "").strip()
    name = (first + " " + last).strip() or "a Fourbuy dealer"
    return {
        "code": normalised,
        "referrer_name": name,
        "referrer_first_name": first or None,
        "referrer_dealership": (dship or {}).get("name"),
    }


class SelfProfileUpdate(BaseModel):
    first_name: Optional[str] = None
    last_name: Optional[str] = None
    phone: Optional[str] = None
    job_title: Optional[str] = None


@api_router.patch("/auth/me")
async def update_me(
    payload: SelfProfileUpdate,  # noqa: ARG001 - kept for schema compatibility
    current: dict = Depends(get_current_user),
):
    """Self-service profile editing is disabled.

    Dealer profile fields (name, phone, job title, etc.) must be maintained
    by a Fourbuy admin from Manage Dealers so that role, job title and
    contact details are auditable. This endpoint returns 403 for every
    caller to keep the client contract explicit.
    """
    _ = current  # touch to silence unused-var
    raise HTTPException(
        status_code=403,
        detail=(
            "Profile edits are managed by Fourbuy administrators. "
            "Please contact your Fourbuy admin to update your details."
        ),
    )


# ============ Billing agreement ============
@api_router.get("/agreement/status")
async def agreement_status(current: dict = Depends(get_current_user)):
    user = await db.users.find_one({"id": current["id"]}, {"_id": 0, "password_hash": 0})
    return {
        "accepted": bool(user and user.get("agreement_accepted_at")),
        "accepted_at": (user or {}).get("agreement_accepted_at"),
        "fee_zar": BILLING_FEE_ZAR,
        "sla_hours": BILLING_SLA_HOURS,
    }


@api_router.post("/agreement/accept")
async def agreement_accept(current: dict = Depends(get_current_user)):
    if current["role"] != "dealer":
        raise HTTPException(400, "Only dealers accept the agreement")
    ts = now_utc()
    await db.users.update_one(
        {"id": current["id"]},
        {"$set": {"agreement_accepted_at": ts}},
    )
    return {"accepted_at": ts}


# ============ Push registration ============
@api_router.post("/register-push", status_code=201)
async def register_push(body: RegisterPushBody, current: dict = Depends(get_current_user)):
    try:
        resp = await _push_client.post(
            "/api/v1/push/users/register",
            json={"user_id": current["id"], "platform": body.platform, "device_token": body.device_token},
        )
        if resp.status_code == 401:
            logger.warning("EMERGENT_PUSH_KEY invalid; register-push not effective yet")
        elif resp.status_code >= 500:
            raise HTTPException(502, "Push provider unavailable")
    except HTTPException:
        raise
    except Exception as e:
        logger.warning(f"register-push relay error: {e}")
    return {"status": "registered"}


# ============ Vehicle DB (seeded) ============
@api_router.get("/vehicles/makes")
async def get_makes():
    makes = await db.makes.find({}, {"_id": 0}).sort("name", 1).to_list(1000)
    return {"makes": makes}


@api_router.get("/vehicles/models")
async def get_models(make_id: str):
    models = await db.models.find({"make_id": make_id}, {"_id": 0}).sort("name", 1).to_list(1000)
    return {"models": models}


@api_router.get("/vehicles/derivatives")
async def get_derivatives(model_id: str):
    derivatives = await db.derivatives.find({"model_id": model_id}, {"_id": 0}).sort("name", 1).to_list(1000)
    return {"derivatives": derivatives}


@api_router.get("/vehicles/options")
async def vehicle_options(
    make: Optional[str] = None,
    fuel_type: Optional[str] = None,
    year_of_production: Optional[int] = None,
    transmission: Optional[str] = None,
    model: Optional[str] = None,
    derivative: Optional[str] = None,
    current: Optional[dict] = Depends(get_optional_user),
):
    """Progressive filter over the seeded Disk Drive-shaped vehicle spec DB.

    Given any subset of filters, returns the DISTINCT remaining values for
    every other field. The mobile submit form uses this to eliminate options
    as the dealer moves through the wheel-picker sequence:
    Make → Fuel Type → Year → Transmission → Model → Derivative.

    `derivative` is an optional post-selection filter used by the client to
    look up the full manufacture-year range of a single variant so we can
    warn when the registration year falls outside it.

    Admin-visibility filter: dealers (and unauthenticated callers) never
    see makes or models that the admin has disabled in the Make
    Catalogue. Admins bypass the filter so they can still see the full
    flatfile for review purposes.
    """
    query: dict = {}
    if make:
        query["make"] = make
    if fuel_type:
        query["fuel_type"] = fuel_type
    if year_of_production is not None:
        query["year_of_production"] = year_of_production
    if transmission:
        query["transmission"] = transmission
    if model:
        query["model"] = model
    if derivative:
        query["derivative"] = derivative

    rows = await db.vehicle_specs.find(query, {"_id": 0}).to_list(50000)

    # Apply the admin curation for non-admin callers.
    is_admin = bool(current and current.get("role") == "admin")
    if not is_admin:
        settings = await _load_catalogue_settings()
        disabled_makes = set(settings.get("disabled_makes") or [])
        disabled_models = {
            k: set(v or []) for k, v in (settings.get("disabled_models") or {}).items()
        }
        if disabled_makes or disabled_models:
            def _keep(row: dict) -> bool:
                mk = row.get("make")
                md = row.get("model")
                if mk in disabled_makes:
                    return False
                if mk and md and md in disabled_models.get(mk, set()):
                    return False
                return True
            rows = [r for r in rows if _keep(r)]

    def distinct_sorted(key: str, numeric: bool = False):
        vals = sorted({r[key] for r in rows if r.get(key) is not None}, reverse=numeric)
        return list(vals)

    return {
        "makes": distinct_sorted("make"),
        "fuel_types": distinct_sorted("fuel_type"),
        "years": distinct_sorted("year_of_production", numeric=True),
        "transmissions": distinct_sorted("transmission"),
        "models": distinct_sorted("model"),
        "derivatives": distinct_sorted("derivative"),
        "count": len(rows),
    }


# ============ Admin: Make/Model catalogue curation ============
# `catalogue_settings` holds a single doc with the sets of makes and
# models the admin has hidden from the dealer submit dropdown. We store
# the DISABLED sets (not the enabled ones) so the default state — an
# empty document — means "everything is visible", which matches the
# behaviour that shipped before this feature.
CATALOGUE_SETTINGS_ID = "singleton"


async def _load_catalogue_settings() -> dict:
    doc = await db.catalogue_settings.find_one(
        {"_id": CATALOGUE_SETTINGS_ID}, {"_id": 0}
    )
    if not doc:
        return {"disabled_makes": [], "disabled_models": {}}
    return {
        "disabled_makes": list(doc.get("disabled_makes") or []),
        # `disabled_models` is stored as {make: [model, model, ...]}. We
        # rebuild empty containers defensively so callers can always
        # `.get(make, [])` without KeyErrors.
        "disabled_models": {
            str(k): list(v or []) for k, v in (doc.get("disabled_models") or {}).items()
        },
    }


async def _is_make_visible_to_dealer(make: str) -> bool:
    """Fast helper for dealer-facing filters. Returns True unless the
    make is in the disabled set."""
    if not make:
        return True
    settings = await _load_catalogue_settings()
    return make not in set(settings.get("disabled_makes") or [])


@api_router.get("/admin/makes-catalogue")
async def admin_get_makes_catalogue(current: dict = Depends(get_current_user)):
    """Admin-only. Returns every make + model in the seeded vehicle_specs
    collection along with an `enabled` flag and per-item live-submission
    counts (so the admin can see the impact of hiding a brand). The
    payload is designed to power the "Make Catalogue" screen in
    WebAdminDashboard."""
    if current.get("role") != "admin":
        raise HTTPException(403, "Admin only")

    # 1) Pull every distinct make/model pair from the flatfile-seeded
    # vehicle_specs collection. `distinct` on a compound is not ideal
    # in Motor, so we do an aggregation.
    pipe = [
        {"$group": {"_id": {"make": "$make", "model": "$model"}}},
        {"$sort": {"_id.make": 1, "_id.model": 1}},
    ]
    pairs = await db.vehicle_specs.aggregate(pipe).to_list(50000)

    make_to_models: dict[str, list[str]] = {}
    for row in pairs:
        _id = row.get("_id") or {}
        mk = _id.get("make")
        md = _id.get("model")
        if not mk:
            continue
        make_to_models.setdefault(mk, [])
        if md and md not in make_to_models[mk]:
            make_to_models[mk].append(md)

    # 2) Live submission counts (grouped by make → model). Useful UX
    # signal: "hiding this make will remove 34 submissions from dealer
    # dropdowns, though existing ones still open fine". We just count
    # non-draft submissions.
    sub_pipe = [
        {"$match": {"status": {"$ne": "draft"}}},
        {"$group": {"_id": {"make": "$make", "model": "$model"}, "n": {"$sum": 1}}},
    ]
    sub_counts = await db.submissions.aggregate(sub_pipe).to_list(50000)
    make_counts: dict[str, int] = {}
    model_counts: dict[tuple, int] = {}
    for row in sub_counts:
        _id = row.get("_id") or {}
        mk = _id.get("make")
        md = _id.get("model")
        n = int(row.get("n") or 0)
        if not mk:
            continue
        make_counts[mk] = make_counts.get(mk, 0) + n
        if md:
            model_counts[(mk, md)] = model_counts.get((mk, md), 0) + n

    # 3) Merge with current enabled/disabled state.
    settings = await _load_catalogue_settings()
    disabled_makes = set(settings.get("disabled_makes") or [])
    disabled_models = {
        k: set(v or []) for k, v in (settings.get("disabled_models") or {}).items()
    }

    makes_out = []
    for mk in sorted(make_to_models.keys(), key=lambda s: s.lower()):
        models = make_to_models[mk]
        makes_out.append({
            "name": mk,
            "enabled": mk not in disabled_makes,
            "submission_count": make_counts.get(mk, 0),
            "model_count": len(models),
            "models": [
                {
                    "name": md,
                    "enabled": md not in disabled_models.get(mk, set()),
                    "submission_count": model_counts.get((mk, md), 0),
                }
                for md in sorted(models, key=lambda s: s.lower())
            ],
        })

    return {
        "makes": makes_out,
        "total_makes": len(makes_out),
        "enabled_makes": sum(1 for m in makes_out if m["enabled"]),
    }


class MakesCataloguePatch(BaseModel):
    # Full replace semantics — the client sends the complete current
    # disabled sets. This makes multi-toggle UX trivial and avoids
    # accidental drift from partial updates.
    disabled_makes: list[str] = []
    disabled_models: dict[str, list[str]] = {}


@api_router.patch("/admin/makes-catalogue")
async def admin_patch_makes_catalogue(
    payload: MakesCataloguePatch, current: dict = Depends(get_current_user)
):
    """Admin-only. Replaces the disabled makes / models sets."""
    if current.get("role") != "admin":
        raise HTTPException(403, "Admin only")

    # Sanitise: drop empties, dedupe, and drop entries for makes that
    # aren't in the flatfile any more (so a Kredo refresh doesn't leave
    # ghost rules around).
    known_makes = await db.vehicle_specs.distinct("make")
    known_makes_set = {m for m in known_makes if m}

    disabled_makes = sorted({m.strip() for m in (payload.disabled_makes or []) if m and m.strip() in known_makes_set})

    disabled_models_clean: dict[str, list[str]] = {}
    for mk, mds in (payload.disabled_models or {}).items():
        mk_clean = (mk or "").strip()
        if not mk_clean or mk_clean not in known_makes_set:
            continue
        # Only keep model names that still exist for that make.
        known_models = await db.vehicle_specs.distinct("model", {"make": mk_clean})
        known_models_set = {m for m in known_models if m}
        cleaned = sorted({m.strip() for m in (mds or []) if m and m.strip() in known_models_set})
        if cleaned:
            disabled_models_clean[mk_clean] = cleaned

    await db.catalogue_settings.update_one(
        {"_id": CATALOGUE_SETTINGS_ID},
        {"$set": {
            "disabled_makes": disabled_makes,
            "disabled_models": disabled_models_clean,
            "updated_at": datetime.now(timezone.utc).isoformat(),
            "updated_by": current.get("id"),
        }},
        upsert=True,
    )
    return {
        "status": "ok",
        "disabled_makes": disabled_makes,
        "disabled_models": disabled_models_clean,
    }


# ============ License disc decoder ============
class LicenseDiskDecodeRequest(BaseModel):
    """Request payload for the license-disc PDF-417 decoder.

    Exactly one of `image_base64` or `raw` should be supplied.
      - `image_base64`: a full `data:image/...;base64,...` URL (or bare
        base64) — the server decodes the PDF-417 barcode server-side.
      - `raw`: an already-decoded PDF-417 string (from an on-device scan).
    """
    image_base64: Optional[str] = None
    raw: Optional[str] = None


def _parse_license_disk_string(raw: str) -> dict:
    """Parse a decoded SA licence-disc PDF-417 string into structured fields.

    Field layout is not perfectly standardised across issuers, so we use
    positional AND heuristic detection (VIN = 17-char alnum, expiry =
    YYYY-MM-DD, colour = known dictionary token, etc). Mirrors the
    frontend `decodeLicenseDisk` utility used by the live-camera path so
    both entry points return the same shape.
    """
    tokens = [t.strip() for t in (raw or "").split("%") if t.strip()]
    out: dict = {}

    # VIN — 17 char alphanumeric.
    vin_re = re.compile(r"^[A-HJ-NPR-Z0-9]{17}$", re.I)
    for t in tokens:
        if vin_re.match(t):
            out["vin"] = t.upper()
            break

    # Expiry — YYYY-MM-DD (or YYYY/MM/DD).
    date_re = re.compile(r"^\d{4}[-/]\d{2}[-/]\d{2}$")
    for t in tokens:
        if date_re.match(t):
            out["expiryDate"] = t.replace("/", "-")
            break

    # Colour — known SA vocabulary.
    colours = {
        "WHITE", "BLACK", "SILVER", "GREY", "GRAY", "RED", "BLUE",
        "GREEN", "YELLOW", "GOLD", "BROWN", "BEIGE", "ORANGE",
        "PURPLE", "MAROON", "BURGUNDY", "PINK", "BRONZE",
    }
    for t in tokens:
        if t.upper() in colours:
            out["colour"] = t.upper().title()
            break

    # Make — sample of common SA makes (aligned with the flatfile Kredo
    # imports). Not exhaustive; we just want a confident match so we can
    # anchor the following token as the model.
    common_makes = {
        "TOYOTA", "VOLKSWAGEN", "VW", "FORD", "BMW", "MERCEDES-BENZ", "MERCEDES",
        "HYUNDAI", "KIA", "NISSAN", "MAZDA", "HONDA", "SUZUKI", "AUDI", "SUBARU",
        "MITSUBISHI", "LEXUS", "PORSCHE", "MINI", "JEEP", "LAND", "JAGUAR",
        "VOLVO", "PEUGEOT", "RENAULT", "CITROEN", "FIAT", "OPEL", "CHEVROLET",
        "ISUZU", "DAIHATSU", "HAVAL", "GWM", "CHERY", "TATA", "MAHINDRA",
        "ALFA", "BAIC", "GEELY", "SEAT", "SKODA", "DODGE", "CADILLAC",
    }
    make_idx = -1
    for i, t in enumerate(tokens):
        if t.upper() in common_makes:
            out["make"] = t.upper()
            make_idx = i
            break

    # Model — token immediately after the make (skip pure numeric tokens).
    if make_idx >= 0:
        for j in range(make_idx + 1, len(tokens)):
            t = tokens[j]
            if t.isdigit() or len(t) < 2:
                continue
            if t.upper() in colours:  # don't grab the colour
                continue
            out["model"] = t.upper()
            break

    # Description — anything matching common body-style words.
    body_styles = re.compile(
        r"^(SEDAN|HATCH[- ]?BACK|HATCH|SUV|COUPE|COUP[EÉ]|CONVERTIBLE|"
        r"PICKUP|BAKKIE|WAGON|STATION[- ]?WAGON|VAN|MPV|CROSSOVER|MOTOR CAR).*$",
        re.I,
    )
    for t in tokens:
        if body_styles.match(t):
            out["description"] = t.title()
            break

    # Registration plate — 2-3 letters/digits, hyphen or space, and a suffix.
    plate_re = re.compile(r"^[A-Z]{1,3}[- ]?\d{1,4}[- ]?[A-Z]{0,3}$", re.I)
    for t in tokens:
        if plate_re.match(t) and t.upper() != (out.get("vin") or ""):
            out["registration"] = t.upper()
            break

    # Engine — the token IMMEDIATELY AFTER the VIN is conventionally the
    # engine number on SA discs (see the frontend decoder for the same
    # rule). We prefer that positional heuristic over regex to avoid
    # misclassifying similar-looking tokens elsewhere in the payload.
    if "vin" in out:
        try:
            vin_idx = tokens.index(out["vin"])
            if vin_idx + 1 < len(tokens):
                cand = tokens[vin_idx + 1]
                if 4 <= len(cand) <= 20 and cand.upper() != out["vin"]:
                    out["engineNo"] = cand.upper()
        except ValueError:
            pass

    return out


@api_router.post("/vehicles/license-disk/decode")
async def decode_license_disk(payload: LicenseDiskDecodeRequest, current: dict = Depends(get_current_user)):
    """Decode a SA license-disc PDF-417 barcode from either a raw scanned
    string OR an uploaded photograph.

    Two-stage strategy for the photo path:
      1. **PDF-417 barcode decode** via zxing-cpp — fastest, structured,
         always tried first. Works when the barcode itself is captured
         clean & sharp.
      2. **LLM vision OCR fallback** — when zxing can't find a barcode
         (small photos, glare, cropped, oblique angle, etc.) we send the
         image to Gemini and ask it to read the printed VIN and engine
         number directly off the disc. Slower + costs a fraction of a
         cent per request, but MUCH more forgiving on real dealer
         photos. The extracted VIN/engine still populate the same fields
         the barcode path would.
    """
    raw = (payload.raw or "").strip() or None
    ocr_used = False
    if not raw:
        if not payload.image_base64:
            raise HTTPException(400, "Provide `image_base64` or `raw`.")
        # Strip any `data:image/...;base64,` prefix and decode.
        b64_full = payload.image_base64
        b64 = b64_full.split(",", 1)[1] if "," in b64_full else b64_full
        try:
            img_bytes = base64.b64decode(b64)
        except Exception:
            raise HTTPException(400, "image_base64 is not valid base64")

        # ---- Stage 1: PDF-417 barcode decode ----
        try:
            import zxingcpp
            from PIL import Image as PILImage
            from io import BytesIO
            pil_img = PILImage.open(BytesIO(img_bytes)).convert("RGB")
            results = zxingcpp.read_barcodes(pil_img)
            if not results:
                w, h = pil_img.size
                if max(w, h) < 1600:
                    pil_img2 = pil_img.resize((w * 2, h * 2), PILImage.LANCZOS)
                    results = zxingcpp.read_barcodes(pil_img2)
            if results:
                pdf417 = [r for r in results if str(getattr(r, "format", "")).lower().replace("-", "") in ("pdf417", "pdf_417")]
                chosen = (pdf417 or results)[0]
                raw = chosen.text if hasattr(chosen, "text") else str(chosen)
        except Exception:
            logger.exception("zxing barcode decode threw; falling back to OCR")

        # ---- Stage 2: LLM vision OCR fallback ----
        if not raw:
            logger.info("No PDF-417 barcode detected — falling back to LLM OCR")
            ocr_used = True
            try:
                # Down-scale huge phone photos to keep the LLM payload
                # small (Gemini vision handles up to ~1600px on the long
                # edge just fine and cuts round-trip cost noticeably).
                try:
                    from PIL import Image as PILImage
                    from io import BytesIO
                    pil_img = PILImage.open(BytesIO(img_bytes)).convert("RGB")
                    w, h = pil_img.size
                    if max(w, h) > 1600:
                        scale = 1600.0 / max(w, h)
                        pil_img = pil_img.resize((int(w * scale), int(h * scale)), PILImage.LANCZOS)
                    buf = BytesIO()
                    pil_img.save(buf, format="JPEG", quality=85)
                    img_bytes_small = buf.getvalue()
                except Exception:
                    img_bytes_small = img_bytes  # Best effort

                b64_small = base64.b64encode(img_bytes_small).decode("ascii")
                from emergentintegrations.llm.chat import ImageContent
                system_prompt = (
                    "You are an expert at reading South African vehicle "
                    "license disks. The user will send a photograph of a "
                    "physical SA license disk (the round paper disk fixed to "
                    "the windscreen). Extract ONLY the printed text values. "
                    "If a field is not legible, use null. NEVER invent "
                    "values. Return STRICT JSON only — no prose, no fences."
                )
                user_prompt = (
                    "Read the following fields off the license disc "
                    "photograph and return JSON exactly matching this "
                    "schema:\n"
                    "{\n"
                    '  "vin": "17-char VIN (exclude I/O/Q) or null",\n'
                    '  "engineNo": "engine number as printed or null",\n'
                    '  "registration": "number-plate / registration or null",\n'
                    '  "make": "vehicle make in ALL CAPS or null",\n'
                    '  "model": "vehicle model in ALL CAPS or null",\n'
                    '  "colour": "vehicle colour Title-Cased or null",\n'
                    '  "description": "body-type description or null",\n'
                    '  "expiryDate": "YYYY-MM-DD expiry or null"\n'
                    "}\n"
                    "Return JSON ONLY. Nothing else."
                )
                chat = LlmChat(
                    api_key=EMERGENT_LLM_KEY,
                    session_id=f"license-disk-ocr-{uuid.uuid4()}",
                    system_message=system_prompt,
                ).with_model("gemini", "gemini-2.5-flash")
                reply = await chat.send_message(
                    UserMessage(text=user_prompt, file_contents=[ImageContent(image_base64=b64_small)])
                )
                # The LLM may return with or without code fences — strip
                # both defensively so `json.loads` sees pure JSON.
                text = (reply or "").strip()
                if text.startswith("```"):
                    text = re.sub(r"^```(?:json)?\s*", "", text)
                    text = re.sub(r"\s*```$", "", text)
                import json as _json
                try:
                    parsed_ocr = _json.loads(text)
                except Exception:
                    logger.warning("LLM OCR did not return valid JSON: %s", text[:200])
                    raise HTTPException(422, "Could not read the license disc. Try a clearer, close-up photo with the whole disc in-frame and no glare.")

                # Whitelist + normalise the LLM's output so a misbehaved
                # response can't leak weird keys back to the frontend.
                out: dict = {}
                for k in ("vin", "engineNo", "registration", "make", "model", "colour", "description", "expiryDate"):
                    v = parsed_ocr.get(k)
                    if isinstance(v, str) and v.strip() and v.strip().lower() not in ("null", "none", "n/a", "unknown", "-", ""):
                        out[k] = v.strip()
                # VIN sanity — 17 alnum, exclude I/O/Q.
                if "vin" in out:
                    if not re.match(r"^[A-HJ-NPR-Z0-9]{17}$", out["vin"], re.I):
                        # If Gemini returned something close-but-off, drop
                        # it rather than pretend we have a real VIN.
                        out.pop("vin", None)
                    else:
                        out["vin"] = out["vin"].upper()
                if not out.get("vin") and not out.get("engineNo"):
                    raise HTTPException(422, "Could not read the VIN or engine number on the disc. Try a clearer, close-up photo.")
                return {
                    "raw": None,
                    "parsed": out,
                    "source": "ocr",
                }
            except HTTPException:
                raise
            except Exception as exc:
                logger.exception("LLM OCR fallback failed")
                raise HTTPException(422, "Could not read the barcode or text on that photo. Try a clearer close-up.")

    parsed = _parse_license_disk_string(raw or "")
    return {"raw": raw, "parsed": parsed, "source": "ocr" if ocr_used else "barcode"}


# ============ Submissions ============
@api_router.post("/submissions")
async def create_submission(payload: VehicleSubmission, current: dict = Depends(get_current_user)):
    if current["role"] != "dealer":
        raise HTTPException(403, "Only dealers can submit vehicles")
    if current.get("active") is False:
        raise HTTPException(
            403,
            "Your account has been suspended. Please contact Fourbuy to settle any outstanding balance.",
        )
    # Must have accepted the one-time master agreement.
    user_doc = await db.users.find_one({"id": current["id"]}, {"agreement_accepted_at": 1})
    if not user_doc or not user_doc.get("agreement_accepted_at"):
        raise HTTPException(
            409,
            "You must accept the Fourbuy Pricing Agreement before submitting vehicles.",
        )
    # Per-submission acceptance popup ("R50 incl. VAT / no fee if not priced within 24h").
    if not payload.billing_accepted:
        raise HTTPException(400, "Billing acceptance is required for each submission")
    # Guardrail — every 1-10 rating we actually care about. Skipped when
    # the submission is flagged as `unseen` (dealer hasn't inspected).
    if not payload.unseen:
        for rating, name in [
            (payload.mechanical_condition, "mechanical"),
            (payload.cosmetic_condition, "cosmetic"),
            (payload.interior_condition, "interior"),
            (payload.history_condition, "history"),
        ]:
            if not (1 <= rating <= 10):
                raise HTTPException(400, f"{name.title()} condition must be 1-10")
        if not payload.service_history:
            raise HTTPException(400, "Service history is required")
        # NOTE: windscreen is no longer a required condition field. If the
        # windscreen is damaged the dealer records it as a reconditioning
        # line item ("Windscreen" category) instead.
    total_recon = sum((r.get("amount_zar", 0) or 0) for r in payload.reconditioning_items)
    sub_id = str(uuid.uuid4())
    reference = await next_reference_number()
    # Upload photos to Cloudinary (server-side). Old submissions with base64
    # in the DB are left untouched. New submissions store the returned https
    # secure URL instead of the huge base64 payload.
    photos_uploaded = upload_photos_dict_to_cloudinary(payload.photos, sub_id)
    license_disk_uploaded = upload_image_to_cloudinary(
        payload.license_disk_data,
        folder=f"fourbuy/submissions/{sub_id}",
        public_id="license_disk",
    )
    # Physical licence-disc photograph (camera capture or gallery upload).
    # Kept alongside the decoded PDF-417 blob so admins can visually
    # verify the disc if the decode ever looks off.
    license_disk_photo_uploaded = upload_image_to_cloudinary(
        payload.license_disk_photo,
        folder=f"fourbuy/submissions/{sub_id}",
        public_id="license_disk_photo",
    )
    # Reconditioning items may carry EITHER a legacy single `photo` (old
    # clients) OR a `photos` list of up to 5 base64 data URLs (new clients).
    # We upload every base64 photo to Cloudinary and normalise storage so
    # downstream code (mobile, web admin, PDF) can just read `photos`.
    recon_folder = f"fourbuy/submissions/{sub_id}/recon"
    recon_items_uploaded: list[dict] = []
    for idx, item in enumerate(payload.reconditioning_items or []):
        clean = dict(item)

        # Collect every candidate photo — the new `photos` list first,
        # falling back to the legacy single `photo` slot.
        raw_photos: list = []
        if isinstance(clean.get("photos"), list):
            raw_photos.extend([p for p in clean["photos"] if p])
        if clean.get("photo"):
            raw_photos.append(clean["photo"])

        uploaded_photos: list[str] = []
        for pidx, ph in enumerate(raw_photos[:5]):
            if _looks_like_base64_image(ph):
                url = upload_image_to_cloudinary(
                    ph, folder=recon_folder,
                    public_id=f"item_{idx}_photo_{pidx}",
                )
                if url:
                    uploaded_photos.append(url)
            elif isinstance(ph, str) and ph.startswith("http"):
                uploaded_photos.append(ph)

        clean["photos"] = uploaded_photos
        # Keep legacy `photo` field pointing at the first image so any
        # unmigrated read-side code (older mobile/web build) still sees a
        # thumbnail.
        clean["photo"] = uploaded_photos[0] if uploaded_photos else None

        # If a category was supplied, mirror it into `label` for
        # backwards compatibility with the existing PDF / admin views
        # that render `label`. The frontend also allows a custom `note`
        # if the dealer wants to add detail (e.g. "left front tyre").
        cat = clean.get("category")
        if cat and not clean.get("label"):
            clean["label"] = cat
        elif cat and clean.get("label") and clean["label"] != cat:
            # keep both — label was set explicitly, category is separate.
            pass

        recon_items_uploaded.append(clean)
    dealership_id = await _get_user_dealership_id(current)
    dealer_first = current["dealer_info"].get("first_name", "")
    dealer_last = current["dealer_info"].get("last_name", "")
    submitted_by_job_title = current["dealer_info"].get("job_title") or None
    doc = {
        "id": sub_id,
        "reference": reference,
        # `dealer_id` historically = the submitting user's id. It now doubles
        # as `submitted_by_user_id` while `dealership_id` is the new
        # aggregate for multi-user dealerships.
        "dealer_id": current["id"],
        "dealership_id": dealership_id,
        "submitted_by_user_id": current["id"],
        "submitted_by_name": (dealer_first + " " + dealer_last).strip(),
        "submitted_by_job_title": submitted_by_job_title,
        "submitted_at": now_utc(),
        "dealer_email": current["email"],
        "dealer_name": f"{dealer_first} {dealer_last}",
        "dealer_first_name": dealer_first,
        "dealer_phone": current["dealer_info"].get("phone", ""),
        "company_name": current["company_info"]["company_name"],
        # Vehicle spec (progressive filter)
        "make_name": payload.make,
        "model_name": payload.model,
        "derivative_name": payload.derivative,
        "fuel_type": payload.fuel_type,
        "year_of_production": payload.year_of_production,
        "transmission": payload.transmission,
        "year": payload.year_registered,  # keep legacy alias
        "year_registered": payload.year_registered,
        # Kredo manufacture-range context so admins can see the discrepancy
        # on the pricing screen without recomputing.
        "variant_manufacture_range": payload.variant_manufacture_range,
        "registered_after_discontinued": bool(payload.registered_after_discontinued),
        # Identity
        "vin": payload.vin or "TBC",
        "engine_number": payload.engine_number or "TBC",
        "colour": payload.colour,
        "license_disk_data": license_disk_uploaded,
        "license_disk_photo": license_disk_photo_uploaded,
        # Loud UI flag — set when the dealer is requesting a desktop
        # valuation without physically inspecting the vehicle. Downstream
        # renderers (PDF, admin dashboard, dealer detail, list views)
        # display a "Vehicle Unseen, Subject to View & Less to Spend"
        # banner and hide condition/recon-derived numbers.
        "unseen": bool(payload.unseen),
        # Condition — 4 weighted pillars form the overall condition score:
        #   Mechanical 30% · Cosmetic 25% · Interior 25% · History 20%.
        # exterior/tyre kept for legacy compatibility with older submissions.
        "mechanical_condition": payload.mechanical_condition,
        "cosmetic_condition": payload.cosmetic_condition,
        "interior_condition": payload.interior_condition,
        "history_condition": payload.history_condition,
        "exterior_condition": payload.exterior_condition,
        "tyre_condition": payload.tyre_condition,
        "windscreen_condition": payload.windscreen_condition,
        # Legacy analytics alias — rounded weighted score.
        "condition": round(
            payload.mechanical_condition * 0.30
            + payload.cosmetic_condition * 0.25
            + payload.interior_condition * 0.25
            + payload.history_condition * 0.20
        ),
        # Service history
        "service_history": payload.service_history,
        "last_service_date": payload.last_service_date or "TBC",
        "last_service_mileage": payload.last_service_mileage,  # None → treated as TBC
        # Damage
        "paint_evidence": payload.paint_evidence,
        "paint_quality": payload.paint_quality if payload.paint_evidence else None,
        "accident_damage": payload.accident_damage,
        "accident_damage_types": payload.accident_damage_types if payload.accident_damage else [],
        "rim_size": payload.rim_size,
        # Reconditioning
        "reconditioning_items": recon_items_uploaded,
        "reconditioning_total_zar": round(float(total_recon), 2),
        # Warranty & Maintenance Plan (dealer-declared at valuation).
        # Legacy `factory_warranty` bool is mirrored from
        # `factory_warranty_status == "active"` so any downstream code
        # that still reads the bool keeps working.
        "factory_warranty_status": payload.factory_warranty_status,
        "maintenance_plan_status": payload.maintenance_plan_status,
        "factory_warranty": (payload.factory_warranty_status == "active"),
        # Photos & mileage
        "mileage": payload.mileage,
        "photos": photos_uploaded,
        "status": "pending",
        "price": None,
        "price_notes": None,
        "priced_at": None,
        "market_analysis": None,
        "market_analysis_at": None,
        "tyre_estimate": None,
        "tyre_estimate_at": None,
        "billing_accepted_at": now_utc(),
        "created_at": now_utc(),
    }
    await db.submissions.insert_one(doc)
    doc.pop("_id", None)
    return {"submission": {k: v for k, v in doc.items() if k != "photos"}, "id": sub_id}


@api_router.get("/submissions/my")
async def get_my_submissions(current: dict = Depends(get_current_user)):
    # Fetch full docs so we can pluck just the front photo for the list card,
    # then drop the rest of the base64 payload to keep the response small.
    # Scope by dealership so ALL users of a dealership see the same list.
    dealership_id = await _get_user_dealership_id(current)
    query: dict
    if dealership_id:
        # Include legacy submissions that pre-date dealership_id but were
        # authored by this user, so nothing goes missing during migration.
        query = {"$or": [
            {"dealership_id": dealership_id},
            {"dealer_id": current["id"], "dealership_id": {"$in": [None, ""]}},
        ]}
    else:
        query = {"dealer_id": current["id"]}
    subs = await db.submissions.find(query, {"_id": 0}).sort("created_at", -1).to_list(1000)
    # Hide archived submissions from the dealer mobile app (they still exist in
    # the DB and remain visible in the desktop admin archive).
    visible = []
    for s in subs:
        bucket = compute_bucket(s)
        s["bucket"] = bucket
        photos = s.pop("photos", {}) or {}
        # Only expose the front photo if it looks like a real image. Sub-500
        # byte base64 payloads are almost certainly 1x1 placeholder pixels
        # that would render as an ugly blank square on the mobile card.
        # Cloudinary URLs are short (~130 chars) so we accept any http(s) URL.
        front = photos.get("front") or None
        s["front_photo"] = _valid_front_photo(front)
        if bucket != "archived":
            visible.append(s)
    return {"submissions": visible}


def _match_search(sub: dict, q: str) -> bool:
    """Case-insensitive contains-match across reference, make, model, VIN."""
    q = q.lower()
    for field in ("reference", "make_name", "model_name", "vin"):
        v = sub.get(field)
        if v and q in str(v).lower():
            return True
    return False


@api_router.get("/history")
async def submission_history(
    q: Optional[str] = None,
    status: Optional[Literal["all", "pending", "priced", "declined"]] = "all",
    current: dict = Depends(get_current_user),
):
    """Full submission history including archived records.

    - Dealers see only their own submissions.
    - Admins see submissions from every dealer.
    - `q` searches (case-insensitive contains) across reference, make, model, VIN.
    - `status` filters by workflow status (all|pending|priced|declined).
    """
    if current["role"] == "admin":
        query: dict = {}
    else:
        dealership_id = await _get_user_dealership_id(current)
        if dealership_id:
            query = {"$or": [
                {"dealership_id": dealership_id},
                {"dealer_id": current["id"], "dealership_id": {"$in": [None, ""]}},
            ]}
        else:
            query = {"dealer_id": current["id"]}
    if status and status != "all":
        query["status"] = status

    subs = await db.submissions.find(query, {"_id": 0}).sort("created_at", -1).to_list(4000)

    results = []
    for s in subs:
        s["bucket"] = compute_bucket(s)
        if is_billable_available := is_billable(s):
            s["billable"] = is_billable_available
        photos = s.pop("photos", {}) or {}
        front = photos.get("front") or None
        s["front_photo"] = _valid_front_photo(front)
        if q and not _match_search(s, q):
            continue
        results.append(s)

    # For admins, attach dealer email / name in each row for the search results.
    if current["role"] == "admin" and results:
        dealer_ids = list({s["dealer_id"] for s in results if s.get("dealer_id")})
        dealers = await db.users.find(
            {"id": {"$in": dealer_ids}},
            {"_id": 0, "id": 1, "email": 1, "dealer_info": 1, "company_info": 1},
        ).to_list(2000)
        dmap = {d["id"]: d for d in dealers}
        for s in results:
            d = dmap.get(s.get("dealer_id"), {})
            info = d.get("dealer_info") or {}
            co = d.get("company_info") or {}
            s["dealer_email"] = d.get("email")
            s["dealer_name"] = f"{info.get('first_name', '')} {info.get('last_name', '')}".strip()
            s["company_name"] = co.get("company_name") or ""

    return {"submissions": results, "total": len(results)}


# ============ Submission drafts ============
class SubmissionDraft(BaseModel):
    id: Optional[str] = None
    label: Optional[str] = None
    data: dict  # arbitrary partial form-state; validated when finalised


@api_router.get("/drafts")
async def list_drafts(current: dict = Depends(get_current_user)):
    if current.get("role") == "admin":
        # Admins do not have their own drafts to submit vehicles.
        return {"drafts": []}
    drafts = await db.submission_drafts.find(
        {"dealer_id": current["id"]}, {"_id": 0}
    ).sort("updated_at", -1).to_list(200)
    return {"drafts": drafts}


@api_router.get("/drafts/{draft_id}")
async def get_draft(draft_id: str, current: dict = Depends(get_current_user)):
    d = await db.submission_drafts.find_one(
        {"id": draft_id, "dealer_id": current["id"]}, {"_id": 0}
    )
    if not d:
        raise HTTPException(404, "Draft not found")
    return {"draft": d}


@api_router.post("/drafts")
async def upsert_draft(payload: SubmissionDraft, current: dict = Depends(get_current_user)):
    """Create or update a submission draft for the current dealer.

    Drafts store the raw form state (partial fields, any subset of the final
    SubmissionCreate schema plus a friendly label). They are NEVER exposed to
    admins and never counted for billing. Deleting a draft is permanent.
    """
    if current.get("role") == "admin":
        raise HTTPException(403, "Drafts are dealer-only")
    now = now_utc()
    # Upload any base64 photos in the draft's form-state to Cloudinary so the
    # draft document itself stays small. We reuse the draft id (or generate
    # one now for a brand-new draft) as the Cloudinary sub-folder so an
    # updated draft overwrites its own images rather than piling up copies.
    draft_id = payload.id or str(uuid.uuid4())
    data = dict(payload.data or {})
    if isinstance(data.get("photos"), dict):
        data["photos"] = upload_photos_dict_to_cloudinary(data["photos"], draft_id) or {}
    if _looks_like_base64_image(data.get("license_disk_data")):
        data["license_disk_data"] = upload_image_to_cloudinary(
            data["license_disk_data"],
            folder=f"fourbuy/submissions/{draft_id}",
            public_id="license_disk",
        )
    # Recon items may carry an optional per-line base64 photo — upload them
    # so drafts stay small in Mongo too.
    if isinstance(data.get("recon_items"), list):
        recon_folder = f"fourbuy/submissions/{draft_id}/recon"
        new_items: list[dict] = []
        for idx, item in enumerate(data["recon_items"] or []):
            if not isinstance(item, dict):
                new_items.append(item)
                continue
            clean = dict(item)
            photo_val = clean.get("photo")
            if _looks_like_base64_image(photo_val):
                clean["photo"] = upload_image_to_cloudinary(
                    photo_val, folder=recon_folder, public_id=f"item_{idx}",
                )
            new_items.append(clean)
        data["recon_items"] = new_items
    payload_data = data
    if payload.id:
        existing = await db.submission_drafts.find_one(
            {"id": payload.id, "dealer_id": current["id"]}, {"_id": 0}
        )
        if not existing:
            raise HTTPException(404, "Draft not found")
        update = {
            "data": payload_data,
            "label": payload.label or existing.get("label"),
            "updated_at": now,
        }
        await db.submission_drafts.update_one(
            {"id": payload.id, "dealer_id": current["id"]}, {"$set": update}
        )
        return {"draft": {**existing, **update}}
    # New draft — synthesize a friendly label from the vehicle bits if the
    # client didn't provide one.
    data = payload_data
    label = payload.label or " ".join(
        str(x) for x in [
            data.get("year_registered") or data.get("year_of_production") or data.get("year"),
            data.get("make_name"),
            data.get("model_name"),
        ] if x
    ) or "Untitled draft"
    doc = {
        "id": draft_id,
        "dealer_id": current["id"],
        "data": data,
        "label": label,
        "created_at": now,
        "updated_at": now,
    }
    await db.submission_drafts.insert_one(doc)
    doc.pop("_id", None)
    return {"draft": doc}


@api_router.delete("/drafts/{draft_id}")
async def delete_draft(draft_id: str, current: dict = Depends(get_current_user)):
    res = await db.submission_drafts.delete_one(
        {"id": draft_id, "dealer_id": current["id"]}
    )
    if res.deleted_count == 0:
        raise HTTPException(404, "Draft not found")
    return {"status": "deleted"}


@api_router.get("/submissions/{sub_id}")
async def get_submission(sub_id: str, current: dict = Depends(get_current_user)):
    sub = await db.submissions.find_one({"id": sub_id}, {"_id": 0})
    if not sub:
        raise HTTPException(404, "Submission not found")
    if not await _can_access_submission(sub, current):
        raise HTTPException(403, "Not authorized")
    # Prevent dealers from opening an archived submission from a stale link.
    # Pricing agents accessing OTHER dealerships' submissions must not be
    # blocked here — the whole point of Give Cover is that they can still
    # place a binding cover on older/archived stock (and they need the
    # detail page to update / review existing covers).
    is_owner_dealer = (
        current.get("role") == "dealer"
        and sub.get("dealership_id")
        and sub["dealership_id"] == await _get_user_dealership_id(current)
    )
    if is_owner_dealer and compute_bucket(sub) == "archived":
        raise HTTPException(404, "Submission not found")
    sub["bucket"] = compute_bucket(sub)
    # Lazy-fetch + cache Kredo market values (new list / retail / trade /
    # M&M code) — this only calls Kredo the FIRST time an admin or dealer
    # opens the submission; subsequent GETs are instant. Errors are
    # captured on the submission document so the UI can render them.
    try:
        await _ensure_market_values(sub)
    except Exception as e:  # ultra-defensive; helper already swallows errors
        logging.warning("market_values lookup crashed for %s: %s", sub_id, e)
    # Attach report orders (dealer-visible list of ordered VIN reports).
    reports = await db.report_orders.find(
        {"submission_id": sub_id}, {"_id": 0}
    ).sort("ordered_at", -1).to_list(50)
    sub["report_orders"] = reports
    # If a pricing agent (from a different dealership) is reading the
    # submission via the standard endpoint, strip the Fourbuy admin
    # offer/pricing so their cover isn't anchored by our number.
    is_owner = sub.get("dealership_id") and sub["dealership_id"] == await _get_user_dealership_id(current)
    if (
        current.get("role") != "admin"
        and current.get("is_pricing_agent")
        and not is_owner
    ):
        sub = _sanitise_sub_for_pricing_agent(sub)
        # Also hide the current price banner + price history — those
        # reveal what Fourbuy offered.
        for k in ("price", "price_notes", "price_history", "priced_at",
                  "declined_at", "declined_note"):
            sub.pop(k, None)
        # Strip cover_offer entries from report_orders — a pricing agent
        # must never see OTHER agents' covers on the same submission.
        agent_id = current.get("id")
        sub["report_orders"] = [
            r for r in (sub.get("report_orders") or [])
            if r.get("type") != "cover_offer" or r.get("ordered_by") == agent_id
        ]
    else:
        # Non-pricing-agent path (owner dealership member OR admin).
        # Attach a derived profit block so the client can render the P&L
        # without re-computing on every field change.
        if isinstance(sub.get("deal"), dict):
            sub["deal_profit"] = _compute_deal_profit(sub["deal"])

    # Enrich with the submitter's profile pic + cover photo so the
    # detail page can show a WhatsApp-Business-style header banner
    # without a separate request. Now exposed to EVERY viewer — admins,
    # owner-dealership members AND pricing agents — so the "Give Cover"
    # network can see who's submitting the vehicle they're pricing.
    submitter_uid = sub.get("submitted_by_user_id") or sub.get("dealer_id")
    if submitter_uid:
        submitter = await db.users.find_one(
            {"id": submitter_uid},
            {"_id": 0, "profile_pic": 1, "cover_photo": 1},
        )
        if submitter:
            if submitter.get("profile_pic"):
                sub["submitter_profile_pic"] = submitter["profile_pic"]
            if submitter.get("cover_photo"):
                sub["submitter_cover_photo"] = submitter["cover_photo"]

    return {"submission": sub}


@api_router.post("/submissions/{sub_id}/market-values/refresh")
async def refresh_market_values(sub_id: str, current: dict = Depends(get_current_user)):
    """Trigger a Kredo Vehicle Values fetch — but ONLY when we don't
    already hold a successful snapshot.

    Trade + retail values form part of this submission's valuation record
    and must not drift after the fact. So once
    `market_values.status == "ok"` this endpoint becomes a no-op and
    returns the cached snapshot with `locked: true`. Loading placeholders
    and previously-errored snapshots can still be retried.
    """
    sub = await db.submissions.find_one({"id": sub_id}, {"_id": 0})
    if not sub:
        raise HTTPException(404, "Submission not found")
    if not await _can_access_submission(sub, current):
        raise HTTPException(403, "Not authorized")
    existing = sub.get("market_values") or {}
    if isinstance(existing, dict) and existing.get("status") == "ok":
        return {"market_values": existing, "locked": True}
    await db.submissions.update_one({"id": sub_id}, {"$unset": {"market_values": ""}})
    sub.pop("market_values", None)
    mv = await _ensure_market_values(sub, background=True)
    return {"market_values": mv, "locked": False}


@api_router.post("/admin/submissions/{sub_id}/bimmer-spec")
async def fetch_bimmer_spec_endpoint(sub_id: str, current: dict = Depends(require_admin)):
    """Fetch BMW / MINI / Rolls-Royce / ALPINA factory spec via the
    Bimmervin API for the submission's VIN.

    Admin-only, on-demand. The response is CACHED on the submission
    (``bimmer_spec`` field), so a second click on the same VIN is instant
    and doesn't spend credits (~€3 per real call). If the previous
    attempt errored, retrying is allowed and always hits Bimmervin
    fresh.

    Returns 400 for unsupported makes (non-BMW group), 404 if the
    submission has no VIN yet.
    """
    from services.bimmervin_client import (
        describe_option_code,
        fetch_bimmer_spec,
        is_bimmer_supported_make,
    )

    sub = await db.submissions.find_one({"id": sub_id}, {"_id": 0})
    if not sub:
        raise HTTPException(404, "Submission not found")

    vin = (sub.get("vin") or "").strip().upper()
    if len(vin) != 17:
        raise HTTPException(400, "Submission has no valid 17-character VIN yet.")

    make = sub.get("make_name") or sub.get("make") or ""
    if not is_bimmer_supported_make(make):
        raise HTTPException(
            400,
            "Bimmervin only supports BMW, MINI, Rolls-Royce and ALPINA vehicles.",
        )

    def _reapply_descriptions(spec: dict) -> dict:
        """Refresh every option's ``description`` from the local dictionary
        so any codes we've added to `bmw_sa_codes.json` since the snapshot
        was captured get their labels retroactively — no extra credit."""
        opts = spec.get("options") if isinstance(spec, dict) else None
        if not isinstance(opts, list):
            return spec
        unknown: list[str] = []
        described = 0
        for o in opts:
            if isinstance(o, dict) and o.get("code"):
                desc = describe_option_code(o["code"])
                o["description"] = desc
                if desc:
                    described += 1
                else:
                    unknown.append(o["code"])
        spec["unknown_codes"] = unknown
        counts = spec.get("option_counts") or {}
        counts["described"] = described
        counts["unknown"] = len(unknown)
        spec["option_counts"] = counts
        return spec

    async def _bill_once_if_needed(vin_: str, dealer_id_: Optional[str]) -> None:
        """Insert the R10 charge on `report_orders` at most once per
        submission. Called from BOTH the cached and fresh paths so a
        successful lookup always ends up billed exactly once — even if
        the spec was cached before this billing rule existed."""
        if not dealer_id_:
            return
        existing_bill = await db.report_orders.find_one(
            {"submission_id": sub_id, "type": "bmw_options"},
        )
        if existing_bill:
            return
        now_ts = now_utc()
        order = {
            "id": str(uuid.uuid4()),
            "submission_id": sub_id,
            "dealer_id": dealer_id_,
            "vin": vin_,
            "type": "bmw_options",
            "name": "BMW Factory Options",
            "cost_zar": 10.0,
            "status": "delivered",
            "ordered_at": now_ts,
            "ordered_by": current["id"],
            "delivered_at": now_ts,
            "note": "Factory-fitted options list fetched via Bimmervin for the supplied VIN.",
        }
        await db.report_orders.insert_one(order)
        logger.info("bimmervin: billed R10 to dealer %s for sub %s", dealer_id_, sub_id)

    # Cached OK snapshot for the same VIN? Return instantly. Cached error
    # snapshots still let the admin retry with a fresh Bimmervin call.
    existing = sub.get("bimmer_spec") or {}
    if isinstance(existing, dict) and existing.get("status") == "ok" and existing.get("vin") == vin:
        enriched = _reapply_descriptions(existing)
        # Persist the refreshed descriptions too so the mobile GET picks
        # them up on its next load (single Mongo write, no external call).
        await db.submissions.update_one({"id": sub_id}, {"$set": {"bimmer_spec": enriched}})
        # Bill R10 if we haven't yet for this submission (legacy caches
        # captured before the billing rule existed still get charged the
        # first time an admin views them, as agreed).
        await _bill_once_if_needed(vin, sub.get("dealer_id"))
        return {"bimmer_spec": enriched, "cached": True}

    logger.info("bimmervin: fetching spec for sub=%s vin=%s (admin=%s)", sub_id, vin, current.get("email"))
    spec = await fetch_bimmer_spec(vin)

    # Persist regardless of success / failure — a failure snapshot with an
    # ``error`` string lets the UI surface a specific message and the admin can
    # retry when appropriate (transient/network error, etc.). We only persist
    # if the result is a genuine spec or a proper error; for ``needs_full_vin``
    # we return it live so the admin can supply the correct VIN first.
    if spec.get("status") == "ok" or spec.get("status") == "error":
        await db.submissions.update_one(
            {"id": sub_id},
            {"$set": {"bimmer_spec": spec}},
        )

    # Bill R10 on the dealership when the fetch was successful. Handled
    # through the same helper so cached + fresh both flow through one code
    # path (and one idempotency check on `report_orders`).
    if spec.get("status") == "ok":
        await _bill_once_if_needed(vin, sub.get("dealer_id"))

    return {"bimmer_spec": spec, "cached": False}


@api_router.get("/admin/submissions")
async def admin_list_submissions(
    bucket: Optional[Literal["incoming", "priced", "archived", "all"]] = "all",
    current: dict = Depends(require_admin),
):
    """List all submissions with a `bucket` field and counts per bucket.

    Query param `bucket` (default 'all'): filter the returned list to a single
    silo. Counts always cover the full dataset so the UI can render badges.
    """
    subs = await db.submissions.find({}, {"_id": 0}).sort("created_at", -1).to_list(4000)
    counts = {"incoming": 0, "priced": 0, "archived": 0}
    for s in subs:
        b = compute_bucket(s)
        s["bucket"] = b
        s["billable"] = is_billable(s)
        photos = s.pop("photos", {}) or {}
        front = photos.get("front") or None
        s["front_photo"] = _valid_front_photo(front)
        counts[b] += 1
    if bucket and bucket != "all":
        subs = [s for s in subs if s["bucket"] == bucket]
    return {"submissions": subs, "counts": counts, "archive_after_days": ARCHIVE_AFTER_DAYS}


@api_router.post("/admin/submissions/{sub_id}/price")
async def admin_price(sub_id: str, offer: PriceOffer, current: dict = Depends(require_admin)):
    sub = await db.submissions.find_one({"id": sub_id})
    if not sub:
        raise HTTPException(404, "Submission not found")

    prev_price = sub.get("price")
    prev_notes = sub.get("price_notes")
    is_update = sub.get("status") == "priced" and prev_price is not None

    # For price UPDATES the admin must explain WHY the offer moved so
    # every price change is audit-logged with a rationale. Initial
    # offers still allow an optional comment (defaults to "Initial
    # offer" below).
    if is_update:
        change_comment = (offer.change_comment or "").strip()
        if not change_comment:
            raise HTTPException(
                400,
                "A comment is required when updating an existing price. "
                "Tell the dealer why the offer has changed.",
            )
        if len(change_comment) < 3:
            raise HTTPException(
                400,
                "Please add a more descriptive reason for the price change.",
            )

    # Build the price-history entry so dealers + admins can see how / when /
    # by whom the offer evolved over time.
    admin_info = current.get("dealer_info") or {}
    admin_label = " ".join(
        [admin_info.get("first_name") or "", admin_info.get("last_name") or ""]
    ).strip() or current.get("email") or "Admin"
    default_comment = "Price updated" if is_update else "Initial offer"
    history_entry = {
        "id": str(uuid.uuid4()),
        "action": "update" if is_update else "offer",
        "previous_price": prev_price if is_update else None,
        "new_price": offer.price,
        "previous_notes": prev_notes if is_update else None,
        "new_notes": offer.notes,
        "comment": (offer.change_comment or "").strip() or default_comment,
        "admin_id": current["id"],
        "admin_name": admin_label,
        "at": now_utc(),
    }
    update = {
        "status": "priced",
        "price": offer.price,
        "price_notes": offer.notes,
        "priced_at": now_utc(),
    }
    await db.submissions.update_one(
        {"id": sub_id},
        {"$set": update, "$push": {"price_history": history_entry}},
    )
    # Award 1 Fourbuy Rewards point to the submitter if this priced offer
    # lands within the SLA window (which is exactly the billing rule).
    fresh_sub = await db.submissions.find_one({"id": sub_id}, {"_id": 0})
    if fresh_sub:
        try:
            await award_reward_point_for_submission(fresh_sub)
        except Exception as e:
            logger.warning("Reward point award failed (non-blocking): %s", e)
    try:
        push_title = "Price Updated" if is_update else "Price Offer Received"
        await send_push(
            recipients=[sub["dealer_id"]],
            data={
                "title": push_title,
                "message": f"Your {sub['year']} {sub['make_name']} {sub['model_name']} has been priced at R{offer.price:,.0f}",
                "action_url": f"/vehicle/{sub_id}",
            },
        )
    except Exception as e:
        logger.warning(f"Push failed (non-blocking): {e}")
    return {"status": "priced", "price": offer.price, "history_entry": history_entry}


@api_router.post("/admin/submissions/{sub_id}/decline")
async def admin_decline(
    sub_id: str,
    payload: Optional[DeclineOffer] = None,
    current: dict = Depends(require_admin),
):
    """Mark a submission as DECLINED — Fourbuy will not make an offer.

    The dealer is NOT charged (submission is not counted as priced) and sees
    a standard message on the vehicle detail screen. The admin may attach
    an internal note (not shown to the dealer).
    """
    sub = await db.submissions.find_one({"id": sub_id})
    if not sub:
        raise HTTPException(404, "Submission not found")
    if sub.get("status") == "priced":
        raise HTTPException(
            400,
            "This submission has already been priced. Delete or edit the offer first if you need to decline it.",
        )
    update = {
        "status": "declined",
        "declined_at": now_utc(),
        "decline_note": (payload.admin_note if payload else None),
        # Wipe any stale price data to keep the record clean.
        "price": None,
        "price_notes": None,
        "priced_at": None,
    }
    await db.submissions.update_one({"id": sub_id}, {"$set": update})
    try:
        await send_push(
            recipients=[sub["dealer_id"]],
            data={
                "title": "Valuation Update",
                "message": f"We're unable to make an offer on your {sub.get('year')} {sub.get('make_name')} {sub.get('model_name')}. You will not be charged.",
                "action_url": f"/vehicle/{sub_id}",
            },
        )
    except Exception as e:
        logger.warning(f"Push failed (non-blocking): {e}")
    return {"status": "declined"}


@api_router.delete("/admin/submissions/{sub_id}")
async def admin_delete_submission(sub_id: str, current: dict = Depends(require_admin)):
    result = await db.submissions.delete_one({"id": sub_id})
    if result.deleted_count == 0:
        raise HTTPException(404, "Submission not found")
    # Cascade: remove report orders tied to this submission so billing stays consistent.
    await db.report_orders.delete_many({"submission_id": sub_id})
    return {"status": "deleted"}


# ============ Vehicle report orders (VIN-linked, chargeable) ============
@api_router.get("/reports/catalog")
async def report_catalog(
    submission_id: Optional[str] = None,
    _: dict = Depends(get_current_user),
):
    """Return the list of available VIN reports and their costs.

    When a ``submission_id`` is supplied we filter the catalog against
    ``supported_makes`` so that make-specific reports (currently BMW-only
    ``bmw_options``) never surface on submissions they can't service.
    """
    make: Optional[str] = None
    if submission_id:
        sub = await db.submissions.find_one({"id": submission_id}, {"_id": 0, "make_name": 1, "make": 1})
        if sub:
            make = (sub.get("make_name") or sub.get("make") or "").upper().strip()

    def _allowed(entry: dict) -> bool:
        supported = entry.get("supported_makes")
        if not supported:
            return True
        if not make:
            # Without submission context we can't filter — hide make-restricted
            # reports so callers don't accidentally offer them everywhere.
            return False
        return make in [s.upper() for s in supported]

    return {
        "reports": [
            {
                "type": k,
                "name": v["name"],
                "cost_zar": v["cost_zar"],
                "supported_makes": v.get("supported_makes"),
            }
            for k, v in REPORT_CATALOG.items()
            if _allowed(v)
        ]
    }


@api_router.get("/submissions/{sub_id}/reports")
async def list_submission_reports(sub_id: str, current: dict = Depends(get_current_user)):
    sub = await db.submissions.find_one({"id": sub_id}, {"_id": 0, "dealer_id": 1})
    if not sub:
        raise HTTPException(404, "Submission not found")
    if not await _can_access_submission(sub, current):
        raise HTTPException(403, "Not authorized")
    reports = await db.report_orders.find(
        {"submission_id": sub_id}, {"_id": 0}
    ).sort("ordered_at", -1).to_list(50)
    return {"reports": reports}


def _mock_report_data(report_type: str, sub: dict) -> dict:
    """Generate a realistic-looking mock payload for a given report type.

    This is a placeholder until real Lightstone / CarVertical APIs are wired
    up. Content is deterministic-ish based on the submission so the same
    vehicle always renders the same story in the UI. Structure is
    intentionally shaped as {summary, sections: {label: {k: v}}} so the
    generic frontend renderer (ReportResultBody) handles it without knowing
    each provider's schema.
    """
    vin = (sub.get("vin") or "").strip() or "—"
    make = sub.get("make_name") or "—"
    model = sub.get("model_name") or "—"
    year = sub.get("year") or sub.get("year_registered") or "—"
    mileage = int(sub.get("mileage") or 0)

    if report_type == "lightstone_verification":
        return {
            "summary": (
                f"Vehicle verification complete. VIN {vin} matches SAPS and eNaTIS records "
                f"for a {year} {make} {model}. No stolen/interest markers found."
            ),
            "sections": {
                "Identity Match": {
                    "VIN": vin,
                    "Registered Make/Model": f"{make} {model}",
                    "Registered Year": str(year),
                    "Registered Colour": sub.get("colour") or "—",
                    "License Number": (sub.get("license_disk_data") or "").split("|")[0][:12] or "CA 000 000",
                },
                "Registration Status": {
                    "Current Status": "Active",
                    "Licence Expiry": "2027-03-31",
                    "Registered Owner Type": "Private",
                    "Duplicate Keys Issued": "No",
                    "Ownership Changes (last 3y)": "1",
                },
                "SAPS / Interest Checks": {
                    "Stolen Marker": "None",
                    "Border Alert": "None",
                    "Finance Interest": "None",
                    "Insurance Write-off": "None",
                },
                "Compliance": {
                    "Roadworthy Certificate": "Valid — 2025-11-18",
                    "eNaTIS Last Sync": "2026-07-14",
                },
            },
        }

    if report_type == "lightstone_repair":
        approx_events = 3 if mileage > 80000 else 2
        return {
            "summary": (
                f"Repair history captured for VIN {vin}. {approx_events} insurance/workshop event(s) "
                "found across the last 6 years. No structural repairs recorded."
            ),
            "sections": {
                "Repair Summary": {
                    "Total Events": str(approx_events),
                    "Structural Repairs": "0",
                    "Cosmetic Repairs": str(approx_events - 1) if approx_events > 1 else "0",
                    "Mechanical Repairs": "1",
                    "Highest Claim Value": _fmt_zar(23400),
                },
                "Events Timeline": [
                    "2022-08 — Rear bumper respray (Cosmetic, claim R8,240)",
                    "2023-11 — Front left panel repair (Cosmetic, claim R14,180)",
                    "2025-04 — Alternator replacement (Mechanical, claim R23,400)",
                ][:approx_events],
                "Service Milestones": {
                    "Last Full Service": "2026-02 · 92,400 km",
                    "Cambelt / Chain": "OK — replaced 2024-06",
                    "Battery": "OK — replaced 2025-09",
                },
            },
        }

    if report_type == "car_vertical":
        return {
            "summary": (
                f"CarVertical dossier for VIN {vin}. Cross-referenced against 900+ international "
                "databases including EU imports, mileage records, and damage archives."
            ),
            "sections": {
                "Overview": {
                    "VIN": vin,
                    "Vehicle": f"{year} {make} {model}",
                    "First Registered": f"{max(int(year or 2020) - 1, 1990)}-04-12",
                    "Country of Origin": "South Africa",
                    "Imported": "No",
                },
                "Mileage Cross-check": {
                    "Records Found": "4",
                    "Latest Reading": f"{mileage:,} km",
                    "Rollback Detected": "No",
                    "Consistency": "PASS",
                },
                "Damage Records": {
                    "Photos Attached": "2",
                    "Severity": "Minor" if mileage < 100000 else "Moderate",
                    "Airbag Deployment": "No",
                    "Odometer Freeze": "No",
                },
                "International Checks": [
                    "EU Stolen Vehicle Database: No match",
                    "Auction History (US/EU): 0 auction listings",
                    "Recall Notices: None outstanding",
                ],
                "Estimated Market Value (ZAR)": {
                    "Trade": _fmt_zar((sub.get("price") or 0) * 0.94),
                    "Retail": _fmt_zar((sub.get("price") or 0) * 1.12),
                },
            },
        }

    return {"summary": "No mock data for this report type.", "sections": {}}


@api_router.post("/submissions/{sub_id}/reports")
async def order_submission_report(
    sub_id: str,
    payload: ReportOrderCreate,
    current: dict = Depends(get_current_user),
):
    """Dealer orders a chargeable VIN report against a priced submission.

    Guards:
      - ONLY the owning dealer may place the order. Admins can view but cannot
        purchase reports on behalf of a dealer.
      - Submission must have status 'priced' (offer received) so an offer exists.
      - VIN must be present (empty or 'TBC' is rejected).
      - Explicit charge acceptance (accepted_charge=True) is mandatory.
      - Same report type cannot be ordered twice for the same submission.
    """
    if current.get("role") == "admin":
        raise HTTPException(
            403,
            "Admins cannot order reports on behalf of a dealer. The dealer must place the order themselves.",
        )
    if not payload.accepted_charge:
        raise HTTPException(400, "Charge must be accepted before ordering the report")

    sub = await db.submissions.find_one({"id": sub_id}, {"_id": 0})
    if not sub:
        raise HTTPException(404, "Submission not found")
    if not await _can_access_submission(sub, current):
        raise HTTPException(403, "Not authorized")
    if sub.get("status") != "priced":
        raise HTTPException(400, "Reports can only be ordered after an offer has been received")

    vin = (sub.get("vin") or "").strip()
    if not vin or vin.upper() == "TBC":
        raise HTTPException(400, "VIN is required to order a report")

    catalog = REPORT_CATALOG.get(payload.type)
    if not catalog:
        raise HTTPException(400, "Unknown report type")

    # Make-restricted reports (currently bmw_options) refuse to run against
    # wrong-brand submissions. Front-end already filters these out, but the
    # backend gates defensively too.
    supported_makes = catalog.get("supported_makes")
    if supported_makes:
        make = (sub.get("make_name") or sub.get("make") or "").upper().strip()
        if make not in [s.upper() for s in supported_makes]:
            raise HTTPException(400, f"This report is only available for {', '.join(supported_makes)} vehicles.")

    existing = await db.report_orders.find_one(
        {"submission_id": sub_id, "type": payload.type}
    )
    if existing:
        raise HTTPException(409, "This report has already been ordered for this submission")

    now_ts = now_utc()

    # bmw_options is a LIVE Bimmervin lookup, not mock data. On failure we
    # do NOT bill the dealer or create the order — we return a 502 so the
    # dealer can retry when appropriate.
    if payload.type == "bmw_options":
        from services.bimmervin_client import fetch_bimmer_spec, describe_option_code

        spec = await fetch_bimmer_spec(vin)
        if spec.get("status") != "ok":
            raise HTTPException(
                502,
                spec.get("error") or "Could not fetch BMW factory options — please try again.",
            )

        # Re-apply descriptions defensively (already done inside the client,
        # but re-running keeps this endpoint safe if the client changes).
        for o in spec.get("options") or []:
            if o.get("code"):
                o["description"] = describe_option_code(o["code"])

        # Also mirror the spec onto the submission for the mobile "Factory
        # Fitted Vehicle Options" card and the valuation PDF.
        await db.submissions.update_one(
            {"id": sub_id},
            {"$set": {"bimmer_spec": spec}},
        )
        result_data = spec
        note = "Sourced live from Bimmervin (BMW factory order data)."
        mocked = False
    elif payload.type == "landrover_osh":
        # Live JLR Online Service History scrape. Same "on-failure don't
        # bill" contract as bmw_options — errors bubble up as 502 and
        # nothing is inserted / charged.
        from services.landrover_osh import fetch_landrover_osh

        spec = await fetch_landrover_osh(vin)
        if spec.get("status") != "ok":
            raise HTTPException(
                502,
                spec.get("error") or "Could not fetch JLR service history — please try again.",
            )
        # Mirror onto the submission so PDF / other future consumers can
        # find the payload without going through the report_orders row.
        await db.submissions.update_one(
            {"id": sub_id},
            {"$set": {"landrover_osh": spec}},
        )
        result_data = spec
        note = "Sourced live from osh.landrover.com (JLR Online Service History)."
        mocked = False
    else:
        # MOCKED: real Lightstone / CarVertical APIs will replace this generator.
        # For now the report is marked delivered immediately with a realistic payload
        # so the dealer can see the shape of the final output.
        result_data = _mock_report_data(payload.type, sub)
        note = "MOCK DATA — this report was generated locally while the real provider APIs are being integrated."
        mocked = True

    order = {
        "id": str(uuid.uuid4()),
        "submission_id": sub_id,
        "dealer_id": sub["dealer_id"],
        "vin": vin,
        "type": payload.type,
        "name": catalog["name"],
        "cost_zar": catalog["cost_zar"],
        "status": "delivered",
        "ordered_at": now_ts,
        "ordered_by": current["id"],
        "delivered_at": now_ts,
        "result_data": result_data,
        "note": note,
        "mocked": mocked,
    }
    await db.report_orders.insert_one(order)
    order.pop("_id", None)
    return {"order": order}


# ============ Valuation PDF ============
def _fmt_zar(v) -> str:
    try:
        return f"R{float(v):,.2f}"
    except Exception:
        return "—"


def _compute_service_gap(sub: dict) -> dict:
    """Compute how long / how many km have elapsed since the recorded last
    service. Returns {'months_ago': int|None, 'km_since': int|None, 'label_time':
    str, 'label_km': str} for direct rendering.
    """
    out = {"months_ago": None, "km_since": None, "label_time": "—", "label_km": "—"}
    lsd = (sub.get("last_service_date") or "").strip()
    if lsd and lsd.upper() != "TBC":
        try:
            year_s, month_s = lsd.split("-", 1)[0], lsd.split("-")[1][:2]
            year, month = int(year_s), int(month_s)
            now = datetime.now(timezone.utc)
            months = (now.year - year) * 12 + (now.month - month)
            months = max(0, months)
            out["months_ago"] = months
            if months == 0:
                out["label_time"] = "This month"
            elif months < 12:
                out["label_time"] = f"{months} month{'' if months == 1 else 's'} ago"
            else:
                y, rem = divmod(months, 12)
                out["label_time"] = (
                    f"{y} year{'' if y == 1 else 's'} ago" if rem == 0
                    else f"{y}y {rem}m ago"
                )
        except Exception:
            pass
    lsm = sub.get("last_service_mileage")
    cur = sub.get("mileage")
    if isinstance(lsm, (int, float)) and isinstance(cur, (int, float)) and lsm > 0:
        delta = max(0, int(cur) - int(lsm))
        out["km_since"] = delta
        out["label_km"] = f"{delta:,} km"
    return out


async def _build_valuation_pdf(sub: dict, reports: list, expired: bool = False) -> bytes:
    """Render the valuation as an app-like monochrome A4 PDF using reportlab.

    Photo layout mirrors the mobile valuation screen: black header band with
    brand + reference, big vehicle title, 2×2 photo grid (front / driver /
    passenger / rear) followed by the interior on its own row, then all
    detail tables in the same order as the app.
    """
    from io import BytesIO
    from reportlab.lib.pagesizes import A4
    from reportlab.lib.styles import getSampleStyleSheet, ParagraphStyle
    from reportlab.lib.units import mm
    from reportlab.lib import colors as rl_colors
    from reportlab.lib.enums import TA_CENTER, TA_RIGHT
    from reportlab.platypus import (
        SimpleDocTemplate, Paragraph, Spacer, Table, TableStyle, PageBreak,
        Image as RLImage, KeepTogether,
    )
    import base64 as _b64
    from PIL import Image as PILImage

    async def _fetch_image_bytes(uri: str) -> Optional[bytes]:
        """Return raw bytes for a Cloudinary URL or a base64 data-URL, or
        None if the URI is empty / unreachable."""
        if not uri or not isinstance(uri, str):
            return None
        try:
            if uri.startswith("data:"):
                _, _, b64part = uri.partition(",")
                return _b64.b64decode(b64part)
            if uri.startswith("http://") or uri.startswith("https://"):
                async with httpx.AsyncClient(timeout=15.0) as cli:
                    r = await cli.get(uri)
                    r.raise_for_status()
                    return r.content
        except Exception as e:
            logger.warning("PDF image fetch failed for %s: %s", uri[:80], e)
        return None

    def _as_rlimage(raw: bytes, max_w_mm: float, max_h_mm: float):
        """Down-scale + JPEG-encode to keep the PDF light, then wrap in an
        RLImage sized to fit inside (max_w_mm × max_h_mm) in millimetres."""
        if not raw:
            return None
        try:
            im = PILImage.open(BytesIO(raw))
            if im.mode not in ("RGB", "L"):
                im = im.convert("RGB")
            # Downscale so the biggest dimension is ~1200 px — plenty for A4
            # print but keeps the PDF under a few MB even with 5 photos.
            im.thumbnail((1200, 1200), PILImage.LANCZOS)
            buf = BytesIO()
            im.save(buf, format="JPEG", quality=82, optimize=True)
            buf.seek(0)
            iw, ih = im.size
            # Convert target from mm to points for reportlab.
            max_w_pt = float(max_w_mm) * mm
            max_h_pt = float(max_h_mm) * mm
            # Preserve aspect ratio.
            ratio = min(max_w_pt / iw, max_h_pt / ih)
            return RLImage(buf, width=iw * ratio, height=ih * ratio)
        except Exception as e:
            logger.warning("PDF image render failed: %s", e)
            return None

    buf = BytesIO()
    doc = SimpleDocTemplate(
        buf, pagesize=A4,
        leftMargin=12 * mm, rightMargin=12 * mm,
        topMargin=22 * mm, bottomMargin=16 * mm,
        title=f"Valuation {sub.get('reference') or sub.get('id')}",
        author="Fourbuy Car Buying Co.",
    )
    styles = getSampleStyleSheet()

    # ---- Style palette (monochrome, matches the mobile app) ----
    BLACK = rl_colors.HexColor("#0A0A0A")
    INK = rl_colors.HexColor("#111111")
    MUTED = rl_colors.HexColor("#6B6B6B")
    LINE = rl_colors.HexColor("#E5E5E5")
    PAPER = rl_colors.HexColor("#F7F7F7")
    OK = rl_colors.HexColor("#1F7A3A")
    WARN = rl_colors.HexColor("#B67900")
    DANGER = rl_colors.HexColor("#B3261E")

    # Content width for A4 minus the 12mm side margins.
    CONTENT_W_MM = 186.0

    def _row_style() -> TableStyle:
        return TableStyle([
            ("FONT", (0, 0), (-1, -1), "Helvetica", 8),
            ("FONT", (0, 0), (0, -1), "Helvetica-Bold", 8),
            ("TEXTCOLOR", (0, 0), (0, -1), MUTED),
            ("TEXTCOLOR", (1, 0), (1, -1), INK),
            ("LINEBELOW", (0, 0), (-1, -1), 0.35, LINE),
            ("TOPPADDING", (0, 0), (-1, -1), 3),
            ("BOTTOMPADDING", (0, 0), (-1, -1), 3),
            ("VALIGN", (0, 0), (-1, -1), "MIDDLE"),
            ("LEFTPADDING", (0, 0), (-1, -1), 6),
            ("RIGHTPADDING", (0, 0), (-1, -1), 6),
        ])

    section_title = ParagraphStyle(
        "sect", parent=styles["Normal"], fontName="Helvetica-Bold",
        fontSize=8, textColor=MUTED, leading=10, spaceBefore=6,
        spaceAfter=3, letterSpace=1.5,
    )
    body = ParagraphStyle(
        "body", parent=styles["Normal"], fontName="Helvetica",
        fontSize=9, leading=12, textColor=INK,
    )
    small = ParagraphStyle(
        "small", parent=styles["Normal"], fontName="Helvetica",
        fontSize=7, leading=10, textColor=MUTED,
    )
    price_big = ParagraphStyle(
        "priceBig", parent=styles["Normal"], fontName="Helvetica-Bold",
        fontSize=22, leading=26, textColor=INK, alignment=TA_CENTER,
    )
    price_lbl = ParagraphStyle(
        "priceLbl", parent=styles["Normal"], fontName="Helvetica-Bold",
        fontSize=7, leading=9, textColor=MUTED, alignment=TA_CENTER,
    )

    story: list = []

    # ============ HEADER BAND ============
    reference = sub.get("reference") or (sub.get("id") or "")[:8].upper()
    status = (sub.get("status") or "pending").upper()
    header_left = Paragraph(
        '<font name="Helvetica-Bold" size="12" color="#FFFFFF">FOURBUY CAR BUYING CO.</font><br/>'
        '<font name="Helvetica" size="7" color="#BFBFBF">Vehicle Valuation Statement</font>',
        ParagraphStyle("hdrL", parent=styles["Normal"], leading=13),
    )
    header_right = Paragraph(
        f'<para align="right">'
        f'<font name="Helvetica-Bold" size="10" color="#FFFFFF">{reference}</font><br/>'
        f'<font name="Helvetica" size="7" color="#BFBFBF">STATUS · {status}</font>'
        f'</para>',
        ParagraphStyle("hdrR", parent=styles["Normal"], leading=12),
    )
    hdr = Table([[header_left, header_right]], colWidths=[120 * mm, 66 * mm])
    hdr.setStyle(TableStyle([
        ("BACKGROUND", (0, 0), (-1, -1), BLACK),
        ("TEXTCOLOR", (0, 0), (-1, -1), rl_colors.white),
        ("LEFTPADDING", (0, 0), (-1, -1), 10),
        ("RIGHTPADDING", (0, 0), (-1, -1), 10),
        ("TOPPADDING", (0, 0), (-1, -1), 7),
        ("BOTTOMPADDING", (0, 0), (-1, -1), 7),
        ("VALIGN", (0, 0), (-1, -1), "MIDDLE"),
    ]))
    story.append(hdr)

    # ============ EXPIRED SNAPSHOT BANNER ============
    # When the caller requests a PDF for a submission that has moved to
    # the archived bucket, prepend a bold red banner making clear this
    # is a snapshot of historical data — the sub is no longer live.
    if expired:
        archived_iso = sub.get("archived_at") or sub.get("priced_at") or sub.get("submitted_at") or ""
        try:
            archived_display = (
                datetime.fromisoformat(str(archived_iso).replace("Z", "+00:00"))
                .strftime("%d %b %Y")
            ) if archived_iso else ""
        except Exception:
            archived_display = str(archived_iso or "")
        expired_tbl = Table(
            [[
                Paragraph(
                    "<b>SUBMISSION EXPIRED</b> — Snapshot of the record as it was at archival"
                    + (f" ({archived_display})" if archived_display else "")
                    + ". The live valuation is no longer accessible; re-submit the vehicle for a fresh offer.",
                    ParagraphStyle(
                        "ExpiredBanner",
                        fontName="Helvetica-Bold",
                        fontSize=9,
                        leading=11,
                        textColor=rl_colors.white,
                    ),
                )
            ]],
            colWidths=[CONTENT_W_MM * mm],
        )
        expired_tbl.setStyle(TableStyle([
            ("BACKGROUND", (0, 0), (-1, -1), rl_colors.HexColor("#B3261E")),
            ("LEFTPADDING", (0, 0), (-1, -1), 10),
            ("RIGHTPADDING", (0, 0), (-1, -1), 10),
            ("TOPPADDING", (0, 0), (-1, -1), 6),
            ("BOTTOMPADDING", (0, 0), (-1, -1), 6),
        ]))
        story.append(Spacer(1, 4))
        story.append(expired_tbl)
        story.append(Spacer(1, 4))
    year = sub.get("year_registered") or sub.get("year") or sub.get("year_of_production") or ""
    title_line = " ".join(str(x) for x in [year, sub.get("make_name"), sub.get("model_name")] if x)
    # Split the subtitle across two lines so a long derivative doesn't fight
    # for horizontal space with the spec bits. Derivative gets its own row,
    # and the compact spec strip (mileage · trans · fuel · colour) goes below.
    derivative = (sub.get("derivative_name") or "").strip()
    spec_bits = [
        f"{int(sub.get('mileage') or 0):,} km" if sub.get("mileage") else None,
        sub.get("transmission"),
        sub.get("fuel_type"),
        sub.get("colour"),
    ]
    spec_line = " · ".join(str(x) for x in spec_bits if x)
    submitted_line = ""
    if sub.get("submitted_by_name"):
        submitted_line = (
            f'<font name="Helvetica" size="8" color="#6B6B6B">'
            f'Submitted by <b>{sub.get("submitted_by_name")}</b>'
            + (f' · {sub.get("submitted_by_job_title")}' if sub.get("submitted_by_job_title") else "")
            + (f' · {(sub.get("submitted_at") or "")[:10]}' if sub.get("submitted_at") else "")
            + '</font>'
        )
    title_html = (
        f'<font name="Helvetica-Bold" size="16" color="#111111">{title_line}</font>'
        + (f'<br/><font name="Helvetica" size="9" color="#111111">{derivative}</font>' if derivative else "")
        + (f'<br/><font name="Helvetica" size="8" color="#6B6B6B">{spec_line}</font>' if spec_line else "")
        + (f'<br/>{submitted_line}' if submitted_line else "")
    )
    title_p = Paragraph(
        title_html,
        ParagraphStyle("title", parent=styles["Normal"], leading=15, wordWrap="CJK"),
    )
    gen_p = Paragraph(
        f'<para align="right">'
        f'<font name="Helvetica" size="7" color="#6B6B6B">Generated<br/>{now_utc()[:19].replace("T", " ")} UTC</font>'
        f'</para>',
        ParagraphStyle("gen", parent=styles["Normal"], leading=10),
    )
    # Narrow the right column and widen the left so the wrapped title has
    # enough room even when the derivative is very long.
    title_tbl = Table([[title_p, gen_p]], colWidths=[152 * mm, 34 * mm])
    title_tbl.setStyle(TableStyle([
        ("VALIGN", (0, 0), (-1, -1), "TOP"),
        ("LEFTPADDING", (0, 0), (-1, -1), 0),
        ("RIGHTPADDING", (0, 0), (-1, -1), 0),
        ("TOPPADDING", (0, 0), (-1, -1), 8),
        ("BOTTOMPADDING", (0, 0), (-1, -1), 4),
    ]))
    story.append(title_tbl)

    # ============ UNSEEN VALUATION BANNER ============
    # If the dealer flagged the submission as "vehicle unseen" (i.e. a
    # desktop valuation without physical inspection), we surface a loud,
    # red-outlined banner immediately below the title so nobody — dealer,
    # trader, admin — accidentally treats the Cover Price as an
    # inspection-backed number.
    if sub.get("unseen"):
        unseen_para = Paragraph(
            '<font name="Helvetica-Bold" size="10" color="#B3261E">'
            "VEHICLE UNSEEN — SUBJECT TO VIEW &amp; LESS TO SPEND"
            "</font><br/>"
            '<font name="Helvetica" size="8" color="#6B6B6B">'
            "This valuation is desktop-only. Fourbuy has NOT physically "
            "inspected the vehicle. The final trade cover will be adjusted "
            "at inspection to reflect actual condition."
            "</font>",
            ParagraphStyle("unseen_banner", parent=styles["Normal"], leading=13),
        )
        unseen_tbl = Table(
            [[unseen_para]],
            colWidths=[CONTENT_W_MM * mm],
        )
        unseen_tbl.setStyle(TableStyle([
            ("BOX", (0, 0), (-1, -1), 1.2, DANGER),
            ("BACKGROUND", (0, 0), (-1, -1), rl_colors.HexColor("#FDECEA")),
            ("LEFTPADDING", (0, 0), (-1, -1), 10),
            ("RIGHTPADDING", (0, 0), (-1, -1), 10),
            ("TOPPADDING", (0, 0), (-1, -1), 8),
            ("BOTTOMPADDING", (0, 0), (-1, -1), 8),
        ]))
        story.append(Spacer(1, 4))
        story.append(unseen_tbl)
        story.append(Spacer(1, 4))

    # ============ OFFER CARD (top when priced/declined) ============
    price = sub.get("price")
    if status == "PRICED" and price is not None:
        priced_at = (sub.get("priced_at") or "")[:10]
        notes = sub.get("price_notes") or ""
        # Two-column layout: label + big price on the left, meta on the right.
        left = Paragraph(
            f'<font name="Helvetica-Bold" size="7" color="#6B6B6B">OFFER</font><br/>'
            f'<font name="Helvetica-Bold" size="22" color="#111111">{_fmt_zar(price)}</font>',
            ParagraphStyle("offerL", parent=styles["Normal"], leading=26),
        )
        right_bits = [f'<font name="Helvetica" size="8" color="#6B6B6B">Offered on {priced_at}</font>']
        if notes:
            right_bits.append(f'<font name="Helvetica" size="8" color="#6B6B6B"><i>“{notes}”</i></font>')
        right = Paragraph(
            f'<para align="right">' + "<br/>".join(right_bits) + '</para>',
            ParagraphStyle("offerR", parent=styles["Normal"], leading=11),
        )
        offer_card = Table([[left, right]], colWidths=[90 * mm, 96 * mm])
        offer_card.setStyle(TableStyle([
            ("BACKGROUND", (0, 0), (-1, -1), PAPER),
            ("BOX", (0, 0), (-1, -1), 0.6, LINE),
            ("VALIGN", (0, 0), (-1, -1), "MIDDLE"),
            ("LEFTPADDING", (0, 0), (-1, -1), 12),
            ("RIGHTPADDING", (0, 0), (-1, -1), 12),
            ("TOPPADDING", (0, 0), (-1, -1), 8),
            ("BOTTOMPADDING", (0, 0), (-1, -1), 8),
        ]))
        story.append(offer_card)
    elif status == "DECLINED":
        decl = Paragraph(
            '<para align="center"><font name="Helvetica-Bold" size="10" color="#B3261E">'
            'CANNOT OFFER — WE UNFORTUNATELY ARE NOT ABLE TO MAKE AN OFFER ON THIS VEHICLE'
            '</font></para>',
            body,
        )
        decl_card = Table([[decl]], colWidths=[CONTENT_W_MM * mm])
        decl_card.setStyle(TableStyle([
            ("BACKGROUND", (0, 0), (-1, -1), rl_colors.HexColor("#FFF3F2")),
            ("BOX", (0, 0), (-1, -1), 0.6, DANGER),
            ("TOPPADDING", (0, 0), (-1, -1), 8),
            ("BOTTOMPADDING", (0, 0), (-1, -1), 8),
        ]))
        story.append(decl_card)

    # ============ PHOTOS (single row of 5, no labels) ============
    photos = sub.get("photos") or {}
    photo_keys = ["front", "driver_side", "passenger_side", "rear", "interior"]
    loaded_photos: list[bytes] = []
    for key in photo_keys:
        raw = await _fetch_image_bytes(photos.get(key))
        if raw:
            loaded_photos.append(raw)
    if loaded_photos:
        # Divide the content width evenly across up to 5 photos with a small
        # gap between each. 186mm content – (n-1)*2mm gaps = per-cell width.
        n = min(5, len(loaded_photos))
        gap_mm = 1.5
        cell_w_mm = (CONTENT_W_MM - (n - 1) * gap_mm) / n
        cell_h_mm = cell_w_mm * 0.75  # gentle landscape ratio
        row_cells: list = []
        for raw in loaded_photos[:5]:
            img = _as_rlimage(raw, cell_w_mm, cell_h_mm)
            if img:
                row_cells.append(img)
        if row_cells:
            col_widths = []
            for i in range(len(row_cells)):
                col_widths.append(cell_w_mm * mm)
                if i < len(row_cells) - 1:
                    col_widths.append(gap_mm * mm)
            # Interleave photos with empty spacer cells for the gaps.
            interleaved: list = []
            for i, cell in enumerate(row_cells):
                interleaved.append(cell)
                if i < len(row_cells) - 1:
                    interleaved.append("")
            photo_row = Table([interleaved], colWidths=col_widths)
            photo_row.setStyle(TableStyle([
                ("VALIGN", (0, 0), (-1, -1), "MIDDLE"),
                ("ALIGN", (0, 0), (-1, -1), "CENTER"),
                ("LEFTPADDING", (0, 0), (-1, -1), 0),
                ("RIGHTPADDING", (0, 0), (-1, -1), 0),
                ("TOPPADDING", (0, 0), (-1, -1), 0),
                ("BOTTOMPADDING", (0, 0), (-1, -1), 0),
            ]))
            story.append(Spacer(1, 6))
            story.append(photo_row)

    # ============ DETAILS + CONDITION (side-by-side 2 columns) ============
    # Compact "value" style — wraps automatically inside the cell so long
    # derivatives / VINs / notes never overflow. Every value column in this
    # PDF should feed through this so the layout stays clean.
    val_style = ParagraphStyle(
        "val", parent=styles["Normal"], fontName="Helvetica",
        fontSize=8, leading=10, textColor=INK, wordWrap="CJK",
    )
    val_mono_style = ParagraphStyle(
        "valMono", parent=styles["Normal"], fontName="Courier",
        fontSize=8, leading=10, textColor=INK, wordWrap="CJK",
    )
    def _P(text, mono: bool = False) -> Paragraph:
        return Paragraph(str(text) if text is not None else "—", val_mono_style if mono else val_style)

    # LEFT column: Vehicle details + identity (VIN / engine).
    vmr = sub.get("variant_manufacture_range") or {}
    vmr_txt = None
    if vmr.get("min") or vmr.get("max"):
        lo, hi = vmr.get("min"), vmr.get("max")
        vmr_txt = f"{lo}—{hi}" if lo and hi and lo != hi else f"{lo or hi}"
    v_rows = [
        ["Make", _P(sub.get("make_name") or "—")],
        ["Model", _P(sub.get("model_name") or "—")],
        ["Derivative", _P(sub.get("derivative_name") or "—")],
    ]
    if vmr_txt:
        # "Model Year Run" mirrors the on-screen block placed just above
        # Year Reg / Year Prod — helps buyers spot MY-variant carry-overs.
        v_rows.append(["Model Year Run", _P(vmr_txt)])
    v_rows.extend([
        ["Year Reg.", _P(str(sub.get("year_registered") or sub.get("year") or "—"))],
        ["Year Prod.", _P(str(sub.get("year_of_production") or sub.get("year") or "—"))],
        ["Mileage", _P(f"{int(sub.get('mileage') or 0):,} km")],
        ["Transmission", _P(sub.get("transmission") or "—")],
        ["Fuel Type", _P(sub.get("fuel_type") or "—")],
        ["Colour", _P(sub.get("colour") or "—")],
        ["VIN", _P(sub.get("vin") or "—", mono=True)],
        ["Engine No.", _P(sub.get("engine_number") or "—", mono=True)],
    ])
    # Rebalance columns so the value cell has more room to wrap.
    v_label_w = 26 * mm
    v_value_w = 66 * mm
    t_v = Table(v_rows, colWidths=[v_label_w, v_value_w])
    ts_v = _row_style()
    t_v.setStyle(ts_v)

    # RIGHT column: Condition assessment. Overall score inlined at the top.
    # ------------------------------------------------------------------
    # When the submission is flagged as "vehicle unseen", the dealer has
    # NOT physically inspected the car — none of the ratings, damage or
    # paint entries are meaningful. Drop the entire right column so the
    # PDF doesn't imply an inspection took place.
    unseen = bool(sub.get("unseen"))

    m = sub.get("mechanical_condition")
    c = sub.get("cosmetic_condition")
    i_ = sub.get("interior_condition")
    h_ = sub.get("history_condition")
    c_rows: list = []
    if not unseen:
        if m is not None:
            overall = round(
                (m or 0) * 0.30 + (c or 0) * 0.25 + (i_ or 0) * 0.25 + (h_ or 0) * 0.20, 1,
            )
            c_rows.append(["Overall Condition", _P(f"{overall} / 10")])
            c_rows.extend([
                ["Mechanical (30%)", _P(f"{m} / 10")],
                ["Cosmetic (25%)", _P(f"{c} / 10")],
                ["Interior (25%)", _P(f"{i_} / 10")],
                ["General (20%)", _P(f"{h_} / 10")],
            ])
        c_rows.append(["Accident Damage", _P("Yes" if sub.get("accident_damage") else "None")])
        if sub.get("accident_damage") and sub.get("accident_damage_types"):
            c_rows.append(["Damage Types", _P(", ".join(sub.get("accident_damage_types") or []))])
        c_rows.append(["Paint Evidence", _P("Yes" if sub.get("paint_evidence") else "None")])
        if sub.get("paint_evidence") and sub.get("paint_quality"):
            c_rows.append(["Paint Quality", _P(sub.get("paint_quality"))])
    c_label_w = 34 * mm
    c_value_w = 58 * mm
    if unseen or not c_rows:
        # Full-width Vehicle Details only — no Condition Assessment column.
        hdr_left = Paragraph("VEHICLE DETAILS", section_title)
        two_col = Table(
            [[hdr_left], [t_v]],
            colWidths=[CONTENT_W_MM * mm],
        )
        two_col.setStyle(TableStyle([
            ("VALIGN", (0, 0), (-1, -1), "TOP"),
            ("LEFTPADDING", (0, 0), (-1, -1), 0),
            ("RIGHTPADDING", (0, 0), (-1, -1), 0),
            ("TOPPADDING", (0, 0), (-1, -1), 0),
            ("BOTTOMPADDING", (0, 0), (-1, -1), 0),
        ]))
        story.append(Spacer(1, 4))
        story.append(two_col)
    else:
        t_c = Table(c_rows, colWidths=[c_label_w, c_value_w])
        ts_c = _row_style()
        # Emphasise the "Overall Condition" row when present.
        if m is not None:
            ts_c.add("FONT", (0, 0), (-1, 0), "Helvetica-Bold", 9)
            ts_c.add("TEXTCOLOR", (1, 0), (1, 0), INK)
            ts_c.add("BACKGROUND", (0, 0), (-1, 0), PAPER)
        t_c.setStyle(ts_c)
        # Titled headers above each column, then the two tables side-by-side.
        hdr_left = Paragraph("VEHICLE DETAILS", section_title)
        hdr_right = Paragraph("CONDITION ASSESSMENT", section_title)
        two_col = Table(
            [[hdr_left, hdr_right], [t_v, t_c]],
            colWidths=[92 * mm, 92 * mm],
        )
        two_col.setStyle(TableStyle([
            ("VALIGN", (0, 0), (-1, -1), "TOP"),
            ("LEFTPADDING", (0, 0), (-1, -1), 0),
            ("RIGHTPADDING", (0, 0), (0, -1), 4),
            ("LEFTPADDING", (1, 0), (1, -1), 4),
            ("TOPPADDING", (0, 0), (-1, -1), 0),
            ("BOTTOMPADDING", (0, 0), (-1, -1), 0),
        ]))
        story.append(Spacer(1, 4))
        story.append(two_col)

    # ============ REQUESTED BY ============
    # Full contact block for the dealer user who submitted the
    # valuation + the dealership they belong to. Rendered as two side-
    # by-side info cards under the vehicle details so the PDF is a
    # complete, self-contained audit record — the reader knows exactly
    # who they need to phone / email / invoice.
    #
    # Historical fields on the submission (`submitted_by_name`,
    # `submitted_by_job_title`) are used as a fallback so old
    # submissions still render nicely; live user record wins when
    # available.
    submitter_id = sub.get("submitted_by_user_id") or sub.get("dealer_id")
    submitter_user: dict = {}
    submitter_dinfo: dict = {}
    if submitter_id:
        try:
            u = await db.users.find_one(
                {"id": submitter_id},
                {"_id": 0, "email": 1, "dealer_info": 1, "profile_pic": 1, "role": 1},
            )
            if u:
                submitter_user = u
                submitter_dinfo = u.get("dealer_info") or {}
        except Exception:
            pass
    submitter_first = submitter_dinfo.get("first_name") or ""
    submitter_last = submitter_dinfo.get("last_name") or ""
    submitter_full_name = (
        (f"{submitter_first} {submitter_last}").strip()
        or sub.get("submitted_by_name")
        or "—"
    )
    submitter_title = (
        submitter_dinfo.get("job_title")
        or sub.get("submitted_by_job_title")
        or ""
    )
    submitter_email = submitter_user.get("email") or ""
    submitter_phone = submitter_dinfo.get("phone") or ""

    dship: dict = {}
    if sub.get("dealership_id"):
        try:
            dship = await db.dealerships.find_one(
                {"id": sub["dealership_id"]},
                {"_id": 0, "name": 1, "address": 1, "vat_no": 1, "company_reg_no": 1, "phone": 1, "email": 1},
            ) or {}
        except Exception:
            dship = {}
    dship_name = dship.get("name") or sub.get("company_name") or ""
    dship_addr = dship.get("address") or ""
    dship_vat = dship.get("vat_no") or ""
    dship_reg = dship.get("company_reg_no") or ""
    dship_phone = dship.get("phone") or ""
    dship_email = dship.get("email") or ""

    def _kv(label: str, value: str):
        if not value:
            return None
        return [
            Paragraph(
                f'<font name="Helvetica" size="8" color="#6B6B6B">{label.upper()}</font>',
                small,
            ),
            _P(value),
        ]

    dealer_rows = [row for row in [
        _kv("Requested by", submitter_full_name),
        _kv("Position", submitter_title),
        _kv("Email", submitter_email),
        _kv("Phone", submitter_phone),
        _kv("Requested on", (sub.get("created_at") or sub.get("submitted_at") or "")[:10]),
    ] if row]

    dship_rows = [row for row in [
        _kv("Dealership", dship_name),
        _kv("Address", dship_addr),
        _kv("Phone", dship_phone),
        _kv("Email", dship_email),
        _kv("VAT No.", dship_vat),
        _kv("Reg. No.", dship_reg),
    ] if row]

    if dealer_rows or dship_rows:
        story.append(Spacer(1, 6))
        hdr_left_req = Paragraph("REQUESTED BY", section_title)
        hdr_right_req = Paragraph("DEALERSHIP", section_title)

        # Left / right sub-tables. If one side is empty we still lay it
        # out as two columns for visual balance — the empty side just
        # doesn't have rows.
        left_body = Table(dealer_rows, colWidths=[26 * mm, 60 * mm]) if dealer_rows else Spacer(1, 0)
        right_body = Table(dship_rows, colWidths=[26 * mm, 60 * mm]) if dship_rows else Spacer(1, 0)
        if isinstance(left_body, Table):
            left_body.setStyle(_row_style())
        if isinstance(right_body, Table):
            right_body.setStyle(_row_style())

        req_wrap = Table(
            [[hdr_left_req, hdr_right_req], [left_body, right_body]],
            colWidths=[92 * mm, 92 * mm],
        )
        req_wrap.setStyle(TableStyle([
            ("VALIGN", (0, 0), (-1, -1), "TOP"),
            ("LEFTPADDING", (0, 0), (-1, -1), 0),
            ("RIGHTPADDING", (0, 0), (0, -1), 4),
            ("LEFTPADDING", (1, 0), (1, -1), 4),
            ("TOPPADDING", (0, 0), (-1, -1), 0),
            ("BOTTOMPADDING", (0, 0), (-1, -1), 0),
        ]))
        story.append(req_wrap)

    # ============ SERVICE + RECONDITIONING (side-by-side) ============
    # When flagged as "unseen", skip this entire block — there was no
    # physical inspection and any service/recon content is either
    # undefined or auto-defaulted, and misleading to include on the PDF.
    srv_block = None
    recon_block = None
    if not unseen:
        # Warranty & Maintenance Plan status (dealer-declared at valuation).
        fw = sub.get("factory_warranty_status")
        mp = sub.get("maintenance_plan_status")
        if fw or mp or sub.get("factory_warranty") is not None:
            def _lbl(v: Optional[str], legacy_b: Optional[bool] = None) -> tuple:
                if v == "active": return ("Active", OK)
                if v == "expired": return ("Expired", DANGER)
                if legacy_b is True: return ("Active", OK)
                if legacy_b is False: return ("Expired / None", DANGER)
                return ("Not answered", INK)
            fw_txt, fw_col = _lbl(fw, sub.get("factory_warranty"))
            mp_txt, mp_col = _lbl(mp, None)
            fw_style = ParagraphStyle("wfw", parent=val_style, textColor=fw_col, fontName="Helvetica-Bold")
            mp_style = ParagraphStyle("wmp", parent=val_style, textColor=mp_col, fontName="Helvetica-Bold")
            warr_rows = [
                ["Factory Warranty", Paragraph(fw_txt, fw_style)],
                ["Maintenance Plan", Paragraph(mp_txt, mp_style)],
            ]
            t_w = Table(warr_rows, colWidths=[42 * mm, 142 * mm])
            t_w.setStyle(_row_style())
            hdr_w = Paragraph("WARRANTY &amp; MAINTENANCE PLAN", section_title)
            warr_table = Table(
                [[hdr_w], [t_w]],
                colWidths=[184 * mm],
            )
            warr_table.setStyle(TableStyle([
                ("VALIGN", (0, 0), (-1, -1), "TOP"),
                ("LEFTPADDING", (0, 0), (-1, -1), 0),
                ("RIGHTPADDING", (0, 0), (-1, -1), 0),
                ("TOPPADDING", (0, 0), (-1, -1), 0),
                ("BOTTOMPADDING", (0, 0), (-1, -1), 0),
            ]))
            story.append(Spacer(1, 6))
            story.append(warr_table)

        if sub.get("service_history"):
            srv_rows = [
                ["History", _P(sub.get("service_history") or "—")],
                ["Last Service", _P(sub.get("last_service_date") if sub.get("last_service_date") and sub.get("last_service_date") != "TBC" else "TBC")],
                ["Service Mileage", _P(f"{int(sub.get('last_service_mileage')):,} km" if sub.get("last_service_mileage") else "TBC")],
            ]
            gap = _compute_service_gap(sub)
            months = gap["months_ago"]
            km_since = gap["km_since"]
            if months is not None or km_since is not None:
                time_colour = DANGER if (months is not None and months >= 24) else (WARN if (months is not None and months >= 12) else OK)
                km_colour = DANGER if (km_since is not None and km_since >= 30000) else (WARN if (km_since is not None and km_since >= 15000) else OK)
                time_style = ParagraphStyle("srvT", parent=val_style, textColor=time_colour, fontName="Helvetica-Bold")
                km_style = ParagraphStyle("srvK", parent=val_style, textColor=km_colour, fontName="Helvetica-Bold")
                srv_rows.append(["Time Since", Paragraph(str(gap["label_time"]), time_style)])
                srv_rows.append(["Mileage Since", Paragraph(str(gap["label_km"]), km_style)])
            t_s = Table(srv_rows, colWidths=[30 * mm, 62 * mm])
            t_s.setStyle(_row_style())
            srv_block = t_s

        recon_block = None
        recon_items = sub.get("reconditioning_items") or []
        if recon_items:
            # Recon items now render as one full-width block per line so we
            # can attach photos underneath each one. This is separate from
            # the two-column service-history / recon layout below because
            # photos need proper horizontal breathing room.
            recon_block = "RENDER_BELOW"  # sentinel — handled after two_col2

        if srv_block is not None:
            hdr_left = Paragraph("SERVICE HISTORY", section_title)
            two_col2 = Table(
                [[hdr_left], [srv_block]],
                colWidths=[184 * mm],
            )
            two_col2.setStyle(TableStyle([
                ("VALIGN", (0, 0), (-1, -1), "TOP"),
                ("LEFTPADDING", (0, 0), (-1, -1), 0),
                ("RIGHTPADDING", (0, 0), (-1, -1), 0),
                ("TOPPADDING", (0, 0), (-1, -1), 0),
                ("BOTTOMPADDING", (0, 0), (-1, -1), 0),
            ]))
            story.append(Spacer(1, 4))
            story.append(two_col2)

        # Recon lines with per-line photo strip (up to 5 thumbs, ~35 mm wide).
        if recon_items:
            story.append(Spacer(1, 6))
            story.append(Paragraph("RECONDITIONING", section_title))
            total = sub.get("reconditioning_total_zar") or sum((r.get("amount_zar") or 0) for r in recon_items)
            recon_head_style = ParagraphStyle(
                "reconHead", parent=body, fontName="Helvetica-Bold", fontSize=10,
                textColor=INK, leading=13,
            )
            for r in recon_items:
                heading = r.get("category") or r.get("label") or "Reconditioning"
                amount = _fmt_zar(r.get("amount_zar") or 0)
                # Grab all photos (new `photos` list first, legacy `photo` next).
                raw_photos = []
                if isinstance(r.get("photos"), list):
                    raw_photos.extend([p for p in r["photos"] if p])
                if r.get("photo") and r["photo"] not in raw_photos:
                    raw_photos.append(r["photo"])
                # Render photo row: 5 slots × 35 mm wide.
                photo_row_widget = None
                if raw_photos:
                    thumbs: list = []
                    for uri in raw_photos[:5]:
                        raw = await _fetch_image_bytes(uri)
                        img = _as_rlimage(raw, max_w_mm=34, max_h_mm=26) if raw else None
                        thumbs.append(img or Paragraph("", small))
                    # Pad to 5 cells so column widths stay consistent.
                    while len(thumbs) < 5:
                        thumbs.append(Paragraph("", small))
                    photo_row_widget = Table([thumbs], colWidths=[36 * mm] * 5)
                    photo_row_widget.setStyle(TableStyle([
                        ("VALIGN", (0, 0), (-1, -1), "MIDDLE"),
                        ("ALIGN", (0, 0), (-1, -1), "CENTER"),
                        ("LEFTPADDING", (0, 0), (-1, -1), 1),
                        ("RIGHTPADDING", (0, 0), (-1, -1), 1),
                        ("TOPPADDING", (0, 0), (-1, -1), 2),
                        ("BOTTOMPADDING", (0, 0), (-1, -1), 2),
                    ]))
                head_row = Table(
                    [[Paragraph(heading, recon_head_style), Paragraph(
                        f'<para align="right"><font name="Courier-Bold" size="10">{amount}</font></para>',
                        body,
                    )]],
                    colWidths=[140 * mm, 44 * mm],
                )
                head_row.setStyle(TableStyle([
                    ("VALIGN", (0, 0), (-1, -1), "MIDDLE"),
                    ("BACKGROUND", (0, 0), (-1, -1), PAPER),
                    ("LEFTPADDING", (0, 0), (-1, -1), 8),
                    ("RIGHTPADDING", (0, 0), (-1, -1), 8),
                    ("TOPPADDING", (0, 0), (-1, -1), 4),
                    ("BOTTOMPADDING", (0, 0), (-1, -1), 4),
                ]))
                grouping: list = [head_row]
                if photo_row_widget is not None:
                    grouping.append(photo_row_widget)
                grouping.append(Spacer(1, 4))
                story.append(KeepTogether(grouping))
            # Total row
            total_row = Table(
                [[Paragraph('<font color="#FFFFFF">TOTAL RECONDITIONING</font>', body),
                  Paragraph(f'<para align="right"><font name="Courier-Bold" size="11" color="#FFFFFF">{_fmt_zar(total)}</font></para>', body)]],
                colWidths=[140 * mm, 44 * mm],
            )
            total_row.setStyle(TableStyle([
                ("BACKGROUND", (0, 0), (-1, -1), BLACK),
                ("VALIGN", (0, 0), (-1, -1), "MIDDLE"),
                ("LEFTPADDING", (0, 0), (-1, -1), 8),
                ("RIGHTPADDING", (0, 0), (-1, -1), 8),
                ("TOPPADDING", (0, 0), (-1, -1), 5),
                ("BOTTOMPADDING", (0, 0), (-1, -1), 5),
            ]))
            story.append(total_row)

    # ============ KREDO MARKET VALUES ============
    # Snapshot of the Kredo Vehicle Values pulled at the time of valuation
    # (new list + M&M code from the flatfile, trade + retail from Kredo's
    # /value endpoint). These are locked once captured, so what appears
    # here matches the app's "Market Values" card exactly.
    mv = sub.get("market_values") or {}
    if isinstance(mv, dict) and mv.get("status") == "ok":
        story.append(Paragraph("KREDO MARKET VALUES", section_title))
        mv_mono = ParagraphStyle("mvMono", parent=val_style, fontName="Courier-Bold", fontSize=9)
        mv_rows = [
            ["New List Price", Paragraph(_fmt_zar(mv.get("new_list_price_zar")), mv_mono)],
            ["M&M Code", Paragraph(str(mv.get("mm_code") or "—"), mv_mono)],
            ["Trade Value", Paragraph(_fmt_zar(mv.get("trade_price_zar")), mv_mono)],
            ["Retail Value", Paragraph(_fmt_zar(mv.get("retail_price_zar")), mv_mono)],
        ]
        t_mv = Table(mv_rows, colWidths=[46 * mm, 140 * mm])
        t_mv.setStyle(_row_style())
        story.append(t_mv)
        # Footer note — provenance + captured-at timestamp so the reader
        # knows this is a locked historical snapshot, not a live reading.
        fetched_at = mv.get("fetched_at")
        try:
            if isinstance(fetched_at, datetime):
                ts_txt = fetched_at.strftime("%d %b %Y %H:%M UTC")
            elif isinstance(fetched_at, str):
                ts_txt = fetched_at.split(".")[0].replace("T", " ") + " UTC"
            else:
                ts_txt = "—"
        except Exception:
            ts_txt = "—"
        story.append(Spacer(1, 2))
        story.append(Paragraph(
            f"Source: Kredo Vehicle Values · captured {ts_txt} · locked at valuation",
            small,
        ))

    # ============ BMW FACTORY FITTED OPTIONS (Bimmervin) ============
    # Only rendered for BMW-group vehicles that have a cached Bimmervin
    # snapshot. Shows the raw factory-fitted option list (SA + E codes)
    # with plain-English descriptions from the local dictionary. No
    # chassis/colour/fabric meta — those are already in the vehicle
    # details table above.
    bs = sub.get("bimmer_spec") or {}
    if isinstance(bs, dict) and bs.get("status") == "ok":
        story.append(Paragraph("FACTORY FITTED VEHICLE OPTIONS", section_title))
        # Caption row — VIN reminder + a compact SA / E / HO count
        # summary so the dealer can gauge the scope at a glance without
        # counting rows.
        opt_counts = bs.get("option_counts") or {}
        sa_n = int(opt_counts.get("sa") or 0)
        e_n = int(opt_counts.get("e") or 0)
        ho_n = int(opt_counts.get("ho") or 0)
        described_n = int(opt_counts.get("described") or 0)
        total_n = sa_n + e_n + ho_n
        cap_bits = [f"VIN {bs.get('vin') or '—'}"]
        if total_n:
            cap_bits.append(f"{total_n} options")
        if sa_n:
            cap_bits.append(f"{sa_n} SA")
        if e_n:
            cap_bits.append(f"{e_n} E")
        if ho_n:
            cap_bits.append(f"{ho_n} HO")
        if described_n and total_n:
            cap_bits.append(f"{described_n}/{total_n} named")
        story.append(Paragraph(
            f'<font name="Helvetica" size="8" color="#6B6B6B">' +
            " · ".join(cap_bits) +
            "</font>",
            small,
        ))
        opts = bs.get("options") or []
        if opts:
            # Nicer typography and colour-blocked "Kind" column so SA /
            # E / HO groups read like proper section chips. Also uses
            # slightly larger row padding for a calmer, less cramped
            # feel on print.
            opt_rows: list[list[Any]] = [["Kind", "Code", "Description"]]
            order = {"SA": 0, "E": 1, "HO": 2}
            sorted_opts = sorted(
                opts,
                key=lambda x: (order.get(x.get("kind"), 9), x.get("code") or ""),
            )
            for o in sorted_opts:
                kind = o.get("kind") or ""
                code = o.get("code") or ""
                desc = o.get("description") or "—"
                opt_rows.append([
                    Paragraph(
                        f'<font name="Helvetica-Bold" size="8">{kind}</font>',
                        ParagraphStyle("opt_kind", parent=small, leading=10, alignment=1),
                    ),
                    Paragraph(
                        f'<font name="Courier-Bold" size="8">{code}</font>',
                        ParagraphStyle("opt_code", parent=small, leading=10),
                    ),
                    _P(desc),
                ])
            t_opts = Table(opt_rows, colWidths=[14 * mm, 22 * mm, 150 * mm], repeatRows=1)
            ts_opts = _row_style()
            ts_opts.add("FONT", (0, 0), (-1, 0), "Helvetica-Bold", 8)
            ts_opts.add("BACKGROUND", (0, 0), (-1, 0), PAPER)
            # Colour the Kind column a subtle tint so SA/E/HO groups are
            # visually separable without adding row-band shading which
            # can print poorly.
            ts_opts.add("BACKGROUND", (0, 1), (0, -1), rl_colors.HexColor("#F7F7F5"))
            ts_opts.add("ALIGN", (0, 0), (0, -1), "CENTER")
            ts_opts.add("TOPPADDING", (0, 1), (-1, -1), 3)
            ts_opts.add("BOTTOMPADDING", (0, 1), (-1, -1), 3)
            t_opts.setStyle(ts_opts)
            story.append(t_opts)
        else:
            story.append(Paragraph("No factory options returned for this VIN.", small))

    # ============ AI MARKET ANALYSIS ============
    # The analysis payload lives at `sub.market_analysis.analysis.*`
    # (the outer object also carries `generated_at` + `model`). Historic
    # code here read the wrong schema (`estimated_value.low_zar` etc.)
    # and produced an empty section. This renderer mirrors the on-screen
    # panel so admins / dealers see the same numbers + reasoning on the
    # printed PDF.
    ma_wrap = sub.get("market_analysis") or {}
    ma = ma_wrap.get("analysis") if isinstance(ma_wrap.get("analysis"), dict) else {}
    if ma:
        story.append(Paragraph("AI MARKET ANALYSIS", section_title))
        # Model / generated stamp — small caption on top.
        stamp_bits: list[str] = []
        if ma_wrap.get("generated_at"):
            stamp_bits.append(f"Generated {str(ma_wrap['generated_at'])[:19].replace('T', ' ')} UTC")
        if ma_wrap.get("model"):
            stamp_bits.append(f"Model: {ma_wrap['model']}")
        if ma.get("confidence"):
            stamp_bits.append(f"Confidence: {ma['confidence'].upper()}")
        if stamp_bits:
            story.append(Paragraph(" · ".join(stamp_bits), small))
            story.append(Spacer(1, 3))

        # Number rows — mirror on-screen "Estimated Market Range /
        # Trade / Retail" panel.
        rng = ma.get("estimated_market_range_zar") or {}
        ma_rows: list = []
        if rng.get("low") is not None or rng.get("high") is not None:
            ma_rows.append([
                "Estimated Market Range",
                _P(f"{_fmt_zar(rng.get('low'))} — {_fmt_zar(rng.get('high'))}"),
            ])
        if rng.get("typical") is not None:
            ma_rows.append(["Typical Market Value", _P(_fmt_zar(rng.get("typical")))])
        if ma.get("trade_price_estimate_zar") is not None:
            ma_rows.append(["Trade Estimate", _P(_fmt_zar(ma.get("trade_price_estimate_zar")))])
        if ma.get("retail_price_estimate_zar") is not None:
            ma_rows.append(["Retail Estimate", _P(_fmt_zar(ma.get("retail_price_estimate_zar")))])
        if ma.get("recon_impact_zar") is not None:
            ma_rows.append(["Recon Adjustment", _P(f"− {_fmt_zar(ma.get('recon_impact_zar'))}")])
        if ma_rows:
            t_ma = Table(ma_rows, colWidths=[52 * mm, 132 * mm])
            t_ma.setStyle(_row_style())
            story.append(t_ma)
            story.append(Spacer(1, 4))

        # Year positioning + Mileage positioning paragraphs — new
        # first-class narrative fields so the dealer can see exactly how
        # the year of production and the mileage moved the price against
        # comparable AutoTrader listings.
        if ma.get("year_positioning"):
            story.append(Paragraph("<b>Year positioning</b>", body))
            story.append(Paragraph(str(ma.get("year_positioning")), body))
            story.append(Spacer(1, 3))
        if ma.get("mileage_positioning"):
            story.append(Paragraph("<b>Mileage positioning</b>", body))
            story.append(Paragraph(str(ma.get("mileage_positioning")), body))
            story.append(Spacer(1, 3))

        # Listings summary paragraph.
        if ma.get("listings_summary"):
            story.append(Paragraph("<b>Listings summary</b>", body))
            story.append(Paragraph(str(ma.get("listings_summary")), body))
            story.append(Spacer(1, 3))

        # Key factors bullet list — one of the most useful takeaways for
        # a buyer at inspection.
        kf = ma.get("key_factors") or []
        if kf:
            story.append(Paragraph("<b>Key factors</b>", body))
            for f in kf:
                story.append(Paragraph(f"•  {f}", small))
            story.append(Spacer(1, 3))

        # Kredo alignment explanation.
        if ma.get("kredo_alignment"):
            story.append(Paragraph("<b>Kredo alignment</b>", body))
            story.append(Paragraph(str(ma.get("kredo_alignment")), body))
            story.append(Spacer(1, 3))

        # Disclaimer — tiny grey text so admins know how the estimate was
        # derived.
        if ma.get("disclaimer"):
            disc_style = ParagraphStyle(
                "disc", parent=small, textColor=MUTED, fontSize=6.5, leading=8,
            )
            story.append(Paragraph(str(ma.get("disclaimer")), disc_style))

    # ============ TYRE ESTIMATE ============
    tyre_wrap = sub.get("tyre_estimate") or {}
    tyre = tyre_wrap.get("estimate") if isinstance(tyre_wrap, dict) else None
    if tyre:
        story.append(Paragraph("TYRE REPLACEMENT ESTIMATE", section_title))
        tyre_rows = [
            ["Tyre Spec", _P(tyre.get("tyre_spec") or "—")],
            ["Set of 4 Replacement", _P(_fmt_zar(tyre.get("total_replacement_estimate_zar")))],
            ["Fitment & Balance", _P(_fmt_zar(tyre.get("fitment_and_balance_zar")))],
            ["Confidence", _P((tyre.get("confidence") or "—").upper())],
        ]
        t_t = Table(tyre_rows, colWidths=[46 * mm, 140 * mm])
        t_t.setStyle(_row_style())
        story.append(t_t)

    # ============ PRICE HISTORY ============
    ph = sub.get("price_history") or []
    if ph:
        story.append(Paragraph("PRICE HISTORY", section_title))
        ph_rows = [["Date", "Change", "Comment"]]
        for h in ph:
            prev = h.get("previous_price")
            new = h.get("new_price")
            arrow = f"{_fmt_zar(prev)} → {_fmt_zar(new)}" if prev is not None else f"Initial: {_fmt_zar(new)}"
            ph_rows.append([
                (h.get("at") or "")[:10],
                _P(arrow),
                _P(h.get("comment") or "—"),
            ])
        t_ph = Table(ph_rows, colWidths=[24 * mm, 62 * mm, 100 * mm])
        t_ph.setStyle(TableStyle([
            ("FONT", (0, 0), (-1, 0), "Helvetica-Bold", 7),
            ("TEXTCOLOR", (0, 0), (-1, 0), MUTED),
            ("BACKGROUND", (0, 0), (-1, 0), PAPER),
            ("FONT", (0, 1), (-1, -1), "Helvetica", 8),
            ("LINEBELOW", (0, 0), (-1, -1), 0.35, LINE),
            ("VALIGN", (0, 0), (-1, -1), "MIDDLE"),
            ("TOPPADDING", (0, 0), (-1, -1), 3),
            ("BOTTOMPADDING", (0, 0), (-1, -1), 3),
            ("LEFTPADDING", (0, 0), (-1, -1), 6),
            ("RIGHTPADDING", (0, 0), (-1, -1), 6),
        ]))
        story.append(t_ph)

    # ============ VIN REPORTS ============
    if reports:
        story.append(Paragraph("ORDERED VIN REPORTS", section_title))
        rep_rows = [["Report", "Cost", "Status", "Ordered"]]
        for r in reports:
            rep_rows.append([
                _P(r.get("name") or r.get("type")),
                _fmt_zar(r.get("cost_zar")),
                (r.get("status") or "pending").upper(),
                (r.get("ordered_at") or "")[:10],
            ])
        t_rep = Table(rep_rows, colWidths=[90 * mm, 30 * mm, 34 * mm, 32 * mm])
        t_rep.setStyle(TableStyle([
            ("FONT", (0, 0), (-1, 0), "Helvetica-Bold", 8),
            ("BACKGROUND", (0, 0), (-1, 0), BLACK),
            ("TEXTCOLOR", (0, 0), (-1, 0), rl_colors.white),
            ("FONT", (0, 1), (-1, -1), "Helvetica", 8),
            ("LINEBELOW", (0, 0), (-1, -1), 0.35, LINE),
            ("VALIGN", (0, 0), (-1, -1), "MIDDLE"),
            ("TOPPADDING", (0, 0), (-1, -1), 3),
            ("BOTTOMPADDING", (0, 0), (-1, -1), 3),
            ("LEFTPADDING", (0, 0), (-1, -1), 6),
            ("RIGHTPADDING", (0, 0), (-1, -1), 6),
        ]))
        story.append(t_rep)

        # Full delivered mock/real report bodies stay on their own page.
        for r in reports:
            data = r.get("result_data")
            if not data or (r.get("status") or "").lower() != "delivered":
                continue
            # Skip the `bmw_options` report body — its content is
            # already fully rendered above in "FACTORY FITTED VEHICLE
            # OPTIONS" (sourced from the submission's cached
            # `bimmer_spec`, which is the same payload). Rendering it a
            # second time added a blank page with just a header (there
            # was no branch for `bmw_options` in the per-report body
            # switch below), which read as a duplicated / half-broken
            # section. The report is still listed in the "ORDERED VIN
            # REPORTS" summary table above so the dealer can see it was
            # delivered — we just don't re-print the same 52 rows.
            if r.get("type") == "bmw_options":
                continue
            story.append(PageBreak())
            story.append(Paragraph(
                (r.get("name") or r.get("type") or "REPORT").upper(),
                ParagraphStyle(
                    "repHdr", parent=styles["Heading2"], fontSize=14,
                    textColor=INK, spaceAfter=6,
                ),
            ))
            if r.get("mocked"):
                story.append(Paragraph(
                    "MOCK DATA — will be replaced by the real provider response once integrated.",
                    small,
                ))
                story.append(Spacer(1, 4))

            # -------- JLR OSH — vehicle + services + alerts --------
            if r.get("type") == "landrover_osh" and isinstance(data, dict):
                v = data.get("vehicle") or {}
                vrows = []
                for lbl, k in [
                    ("VIN", "vin"), ("Model", "model_name"), ("Model Year", "model_year"),
                    ("Engine", "engine"), ("Colour", "colour"),
                    ("Warranty Start", "warranty_start_date"),
                    ("Registration Country", "registration_country"),
                ]:
                    if v.get(k):
                        vrows.append([lbl, _P(str(v[k]))])
                if vrows:
                    story.append(Paragraph("VEHICLE DETAILS", section_title))
                    t_v = Table(vrows, colWidths=[46 * mm, 140 * mm])
                    t_v.setStyle(_row_style())
                    story.append(t_v)

                # Latest service — dedicated panel that mirrors the on-
                # screen "Latest Service Detail" card, including the
                # Service Items bullet list which was previously never
                # rendered on the PDF.
                ls = data.get("last_service") or {}
                if isinstance(ls, dict) and any(ls.get(k) for k in
                        ("type", "distance", "date", "job_number",
                         "repairer_name", "repairer_location", "service_items")):
                    services_local = data.get("services") or []
                    ls_title = "LATEST SERVICE DETAIL" if services_local else "LAST SERVICE RECORDED"
                    story.append(Spacer(1, 4))
                    story.append(Paragraph(ls_title, section_title))
                    ls_rows: list = []
                    for lbl, key in [
                        ("Type", "type"), ("Distance", "distance"), ("Date", "date"),
                        ("Job Number", "job_number"),
                        ("Repairer", "repairer_name"),
                        ("Location", "repairer_location"),
                        ("Repairer Type", "repairer_type"),
                    ]:
                        val = ls.get(key)
                        if val:
                            ls_rows.append([lbl, _P(str(val))])
                    if ls_rows:
                        t_ls = Table(ls_rows, colWidths=[46 * mm, 140 * mm])
                        t_ls.setStyle(_row_style())
                        story.append(t_ls)
                    items = ls.get("service_items") or []
                    if isinstance(items, list) and items:
                        story.append(Spacer(1, 2))
                        story.append(Paragraph("<b>Service items</b>", body))
                        for item in items:
                            story.append(Paragraph(f"•  {item}", small))

                services = data.get("services") or []
                if services:
                    story.append(Paragraph(f"SERVICE HISTORY ({len(services)})", section_title))
                    srv_rows = [["Date", "Odometer", "Repairer", "Job No.", "Details"]]
                    for s in services:
                        odo = s.get("odometer")
                        odo_str = "—"
                        if odo:
                            odo_str = str(odo).strip()
                            # Some JLR pages return "84089 km" already suffixed;
                            # only append the unit when it's a bare number so we
                            # don't emit "84089 km km" in the PDF cell.
                            if not odo_str.lower().endswith("km"):
                                odo_str = f"{odo_str} km"
                        srv_rows.append([
                            _P(s.get("job_date") or "—"),
                            _P(odo_str),
                            _P(s.get("repairer") or "—"),
                            _P(s.get("job_number") or "—"),
                            _P(s.get("details") or "—"),
                        ])
                    t_s = Table(srv_rows, colWidths=[22 * mm, 24 * mm, 52 * mm, 24 * mm, 64 * mm], repeatRows=1)
                    ts = _row_style()
                    ts.add("FONT", (0, 0), (-1, 0), "Helvetica-Bold", 7)
                    ts.add("BACKGROUND", (0, 0), (-1, 0), PAPER)
                    t_s.setStyle(ts)
                    story.append(t_s)

                alerts = data.get("alerts") or []
                if alerts:
                    story.append(Paragraph(f"ALERTS ({len(alerts)})", section_title))
                    for a in alerts:
                        story.append(Paragraph(f"• {a}", body))

                # Provenance footer — captured timestamp + a clickable
                # deep link back to the JLR OSH page for auditability.
                prov_bits: list[str] = []
                if data.get("captured_at"):
                    prov_bits.append(
                        f"Captured {str(data['captured_at'])[:19].replace('T', ' ')} UTC"
                    )
                if data.get("source"):
                    prov_bits.append(f"Source: {data['source']}")
                url = data.get("service_history_url") or data.get("result_url")
                if url:
                    prov_bits.append(f'<a href="{url}"><u>View on JLR OSH</u></a>')
                if prov_bits:
                    prov_style = ParagraphStyle(
                        "prov", parent=small, textColor=MUTED, fontSize=6.5, leading=8,
                    )
                    story.append(Spacer(1, 3))
                    story.append(Paragraph(" · ".join(prov_bits), prov_style))
                continue  # skip the generic renderer for this report

            # -------- Kredo VIN history — accident/claim list --------
            if r.get("type") == "kredo_vin_history" and isinstance(data, dict):
                claims = data.get("claims") or data.get("accident_claims") or []
                summary_bits = []
                if data.get("claim_count") is not None:
                    summary_bits.append(f"Claim count: {data['claim_count']}")
                elif claims:
                    summary_bits.append(f"Claim count: {len(claims)}")
                if data.get("last_claim_date"):
                    summary_bits.append(f"Last claim: {data['last_claim_date']}")
                if summary_bits:
                    story.append(Paragraph(" · ".join(summary_bits), body))
                if claims:
                    rows = [["Date", "Vehicle", "Mileage", "Damage", "Ref"]]
                    for c in claims:
                        date_str = c.get("accident_date") or c.get("creation_date") or "—"
                        mfr = c.get("manufacturer") or ""
                        mdl = c.get("model") or ""
                        vehicle_line = (mfr + " " + mdl).strip() or "—"
                        mileage_raw = c.get("mileage_at_claim")
                        try:
                            mileage_num = int(mileage_raw) if mileage_raw not in (None, "") else None
                        except (TypeError, ValueError):
                            mileage_num = None
                        mileage_str = f"{mileage_num:,} km" if mileage_num is not None else "—"
                        locs = list(c.get("damage_locations") or [])
                        if c.get("glass_damage"):
                            locs.append("Windscreen")
                        damage_str = ", ".join(
                            l.replace("-", " ").title() for l in locs
                        ) or "—"
                        rows.append([
                            _P(str(date_str)),
                            _P(vehicle_line),
                            _P(mileage_str),
                            _P(damage_str),
                            _P(str(c.get("id") or "—")),
                        ])
                    t_c = Table(rows, colWidths=[22 * mm, 32 * mm, 22 * mm, 68 * mm, 42 * mm], repeatRows=1)
                    ts = _row_style()
                    ts.add("FONT", (0, 0), (-1, 0), "Helvetica-Bold", 7)
                    ts.add("BACKGROUND", (0, 0), (-1, 0), PAPER)
                    t_c.setStyle(ts)
                    story.append(t_c)
                else:
                    story.append(Paragraph("No claims recorded for this VIN.", body))
                continue

            # -------- Fallback: existing generic renderer --------
            if data.get("summary"):
                story.append(Paragraph(data["summary"], body))
                story.append(Spacer(1, 4))
            for section_name, section_val in (data.get("sections") or {}).items():
                story.append(Paragraph(f"<b>{section_name}</b>", body))
                if isinstance(section_val, list):
                    for item in section_val:
                        story.append(Paragraph(f"• {item}", small))
                elif isinstance(section_val, dict):
                    sec_rows = [[str(k), str(v)] for k, v in section_val.items()]
                    if sec_rows:
                        st = Table(sec_rows, colWidths=[55 * mm, 123 * mm])
                        st.setStyle(_row_style())
                        story.append(st)
                story.append(Spacer(1, 3))

    # -------- CarTrust callback data (lives on the submission, not report_orders) --------
    kct = (sub.get("reports") or {}).get("kredo_cartrust") or {}
    ct_payload = kct.get("callback_payload") or {}
    ct_json_raw = ct_payload.get("cartrust_json") if ct_payload else None
    ct_data = None
    if isinstance(ct_json_raw, str):
        try:
            import json as _pdf_json
            ct_data = _pdf_json.loads(ct_json_raw)
        except Exception:
            ct_data = None
    elif isinstance(ct_json_raw, dict):
        ct_data = ct_json_raw

    if ct_data:
        story.append(PageBreak())
        story.append(Paragraph(
            "CARTRUST VEHICLE REPORT",
            ParagraphStyle("ctHdr", parent=styles["Heading2"], fontSize=14, textColor=INK, spaceAfter=6),
        ))

        # Vehicle confirmation block. CarTrust returns this as
        # `{heading, columns, rows}` — reuse the generic table renderer.
        vconf = ct_data.get("vehicle_confirmation") or ct_data.get("vehicle") or {}
        if isinstance(vconf, dict) and vconf:
            if isinstance(vconf.get("rows"), list) and isinstance(vconf.get("columns"), list):
                # defer to the generic table renderer defined below.
                pass
            else:
                story.append(Paragraph("VEHICLE CONFIRMATION", section_title))
                vc_rows = [
                    [str(k).replace("_", " ").title(), _P(str(v))]
                    for k, v in vconf.items() if v not in (None, "", [])
                ]
                if vc_rows:
                    t_vc = Table(vc_rows, colWidths=[52 * mm, 132 * mm])
                    t_vc.setStyle(_row_style())
                    story.append(t_vc)

        # Accident/claims from CarTrust
        claims = (
            ct_data.get("accident_claims")
            or ct_data.get("claims")
            or (ct_data.get("accident_history") or {}).get("claims")
            or []
        )
        if isinstance(claims, list) and claims:
            story.append(Paragraph(f"ACCIDENT / CLAIM HISTORY ({len(claims)})", section_title))
            rows = [["Date", "Damage", "Mileage", "Insurer / Type"]]
            for c in claims:
                if not isinstance(c, dict):
                    continue
                rows.append([
                    _P(str(c.get("accident_date") or c.get("date") or "—")),
                    _P(str(c.get("damage") or c.get("area") or c.get("description") or "—")),
                    _P(f"{c.get('odometer')} km" if c.get("odometer") else "—"),
                    _P(str(c.get("insurer") or c.get("type") or "—")),
                ])
            t_c = Table(rows, colWidths=[24 * mm, 76 * mm, 24 * mm, 62 * mm], repeatRows=1)
            ts = _row_style()
            ts.add("FONT", (0, 0), (-1, 0), "Helvetica-Bold", 7)
            ts.add("BACKGROUND", (0, 0), (-1, 0), PAPER)
            t_c.setStyle(ts)
            story.append(t_c)

        # CarTrust returns a `pdf_sections` dict where each entry is a
        # `{heading, columns, rows}` table — CarTrust's own idea of how
        # the section should render. Use those as the primary content
        # and only fall back to per-key dumps for anything not covered.
        pdf_sections = ct_data.get("pdf_sections")
        rendered_headings: set[str] = set()
        if isinstance(pdf_sections, dict):
            for _name, section in pdf_sections.items():
                if not isinstance(section, dict):
                    continue
                heading = str(section.get("heading") or _name)
                cols = section.get("columns")
                rows = section.get("rows")
                if not (isinstance(cols, list) and isinstance(rows, list) and cols):
                    continue
                story.append(Paragraph(heading.upper(), section_title))
                header = [Paragraph(f"<b>{c}</b>", small) for c in cols]
                tbl_rows = [header]
                for r in rows:
                    if not isinstance(r, dict):
                        continue
                    row = []
                    for c in cols:
                        val = r.get(c)
                        if val is None:
                            for kc in (c.lower(), c.replace(" ", ""), c.replace(" ", "").lower()):
                                if kc in r:
                                    val = r[kc]
                                    break
                        row.append(_P(str(val) if val is not None else "—"))
                    tbl_rows.append(row)
                if len(tbl_rows) > 1:
                    col_w_mm = 184.0 / len(cols)
                    t_g = Table(tbl_rows, colWidths=[col_w_mm * mm] * len(cols), repeatRows=1)
                    ts = _row_style()
                    ts.add("BACKGROUND", (0, 0), (-1, 0), PAPER)
                    ts.add("FONT", (0, 0), (-1, 0), "Helvetica-Bold", 7)
                    t_g.setStyle(ts)
                    story.append(t_g)
                rendered_headings.add(heading.upper())
                story.append(Spacer(1, 2))

        # Skip flat sections whose data is already represented in a
        # pdf_sections table.
        skip = {"pdf_sections", "accident_claims_payload"}
        if "VEHICLE CONFIRMATION" in rendered_headings:
            skip.update({"vehicle_confirmation", "vehicle", "user_input"})
        if any("ACCIDENT" in h for h in rendered_headings):
            skip.update({"accident_claims", "claims", "accident_history", "accident", "all_accidents"})
        if "MICRODOT VERIFICATION" in rendered_headings:
            skip.add("microdot")
        if "FINANCIAL INTEREST" in rendered_headings:
            skip.add("financial_interest")
        if "POLICE INTEREST" in rendered_headings:
            skip.add("police_interest")

        for k, v in ct_data.items():
            if k in skip:
                continue
            if v in (None, "", [], {}):
                continue
            story.append(Paragraph(str(k).replace("_", " ").upper(), section_title))
            if isinstance(v, dict):
                rows = [[str(kk).replace("_", " ").title(), _P(str(vv))]
                        for kk, vv in v.items() if vv not in (None, "", [])]
                if rows:
                    t_g = Table(rows, colWidths=[52 * mm, 132 * mm])
                    t_g.setStyle(_row_style())
                    story.append(t_g)
            elif isinstance(v, list):
                for item in v[:20]:
                    story.append(Paragraph(f"• {item}", body))
            else:
                story.append(Paragraph(str(v), body))
            story.append(Spacer(1, 2))

    # ============ FOOTER ============
    story.append(Spacer(1, 6))
    story.append(Paragraph(
        "This document is generated for the dealer's internal record. Offer prices are indicative and "
        "subject to a physical inspection at Fourbuy premises. Fourbuy Car Buying Co. — Quality Used Cars at Wholesale Prices.",
        small,
    ))

    # ------------------------------------------------------------------
    # Page header + footer
    # ------------------------------------------------------------------
    # NumberedCanvas ensures every page ends up stamped with "Page N of M".
    # Total-page-count requires a two-pass approach — the canvas subclass
    # caches page states in showPage() and only draws the frame during
    # save() when the final total is known.
    from reportlab.pdfgen import canvas as _rl_canvas

    _logo_path = "/app/frontend/assets/images/logo-fourbuy.png"
    _has_logo = os.path.exists(_logo_path)
    _ref = str(sub.get("reference") or sub.get("id") or "")[:24]
    _make_model = " ".join(
        str(x) for x in [sub.get("make_name"), sub.get("model_name")] if x
    ).strip()[:64]

    class NumberedCanvas(_rl_canvas.Canvas):
        def __init__(self, *args, **kwargs):
            super().__init__(*args, **kwargs)
            self._saved_page_states: list = []

        def showPage(self):
            self._saved_page_states.append(dict(self.__dict__))
            self._startPage()

        def save(self):
            total = len(self._saved_page_states)
            for state in self._saved_page_states:
                self.__dict__.update(state)
                self._draw_page_frame(total)
                _rl_canvas.Canvas.showPage(self)
            _rl_canvas.Canvas.save(self)

        def _draw_page_frame(self, total_pages: int):
            page_w, page_h = A4
            # ---- Header band --------------------------------------
            band_top = page_h - 6 * mm
            band_bot = page_h - 18 * mm
            self.setFillColor(BLACK)
            self.rect(0, band_bot, page_w, band_top - band_bot, stroke=0, fill=1)

            if _has_logo:
                try:
                    from reportlab.lib.utils import ImageReader as _IR
                    img = _IR(_logo_path)
                    iw, ih = img.getSize()
                    tgt_h = 9 * mm
                    tgt_w = (iw / ih) * tgt_h
                    self.drawImage(
                        img,
                        12 * mm,
                        band_bot + (band_top - band_bot - tgt_h) / 2,
                        width=tgt_w, height=tgt_h,
                        preserveAspectRatio=True, mask="auto",
                    )
                except Exception:
                    self.setFillColor(rl_colors.white)
                    self.setFont("Helvetica-Bold", 10)
                    self.drawString(12 * mm, band_bot + 4 * mm, "FOURBUY")
            else:
                self.setFillColor(rl_colors.white)
                self.setFont("Helvetica-Bold", 10)
                self.drawString(12 * mm, band_bot + 4 * mm, "FOURBUY")

            self.setFillColor(rl_colors.white)
            self.setFont("Helvetica-Bold", 9)
            self.drawRightString(
                page_w - 12 * mm, band_top - 5 * mm,
                f"VEHICLE VALUATION  ·  {_ref}",
            )
            if _make_model:
                self.setFont("Helvetica", 7.5)
                self.setFillColor(rl_colors.HexColor("#BEBEBE"))
                self.drawRightString(
                    page_w - 12 * mm, band_top - 10 * mm,
                    _make_model,
                )

            # ---- Footer band --------------------------------------
            foot_y = 9 * mm
            self.setFillColor(LINE)
            self.rect(12 * mm, foot_y + 4 * mm, page_w - 24 * mm, 0.4, stroke=0, fill=1)
            self.setFillColor(MUTED)
            self.setFont("Helvetica", 7)
            self.drawString(
                12 * mm, foot_y,
                "Fourbuy Car Buying Co.  ·  Confidential  ·  Offer prices are indicative and subject to physical inspection.",
            )
            self.setFont("Helvetica-Bold", 7)
            self.setFillColor(INK)
            self.drawRightString(
                page_w - 12 * mm, foot_y,
                f"Page {self._pageNumber} of {total_pages}",
            )

    doc.build(story, canvasmaker=NumberedCanvas)
    return buf.getvalue()


async def _build_report_pdf(sub: dict, order: dict) -> bytes:
    """Render a single VIN report as a stand-alone PDF.

    Layout is deliberately provider-styled for the Car Vertical case (dark
    header, blue accent), otherwise a monochrome Lightstone-style layout.
    Content is pulled from `order['result_data']` which the mock generator
    (or a future real API) fills in.
    """
    from io import BytesIO
    from reportlab.lib.pagesizes import A4
    from reportlab.lib.styles import getSampleStyleSheet, ParagraphStyle
    from reportlab.lib.units import mm
    from reportlab.lib import colors as rl_colors
    from reportlab.platypus import (
        SimpleDocTemplate, Paragraph, Spacer, Table, TableStyle,
    )

    report_type = order.get("type") or "report"
    provider_map = {
        "lightstone_verification": ("Lightstone", rl_colors.HexColor("#111111"), rl_colors.HexColor("#8ec7ff")),
        "lightstone_repair":       ("Lightstone", rl_colors.HexColor("#111111"), rl_colors.HexColor("#f7c56e")),
        "car_vertical":            ("carVertical", rl_colors.HexColor("#0f2540"), rl_colors.HexColor("#00b3ff")),
    }
    provider_name, header_bg, accent = provider_map.get(
        report_type, ("Report", rl_colors.black, rl_colors.grey)
    )

    buf = BytesIO()
    doc = SimpleDocTemplate(
        buf, pagesize=A4,
        leftMargin=16*mm, rightMargin=16*mm,
        topMargin=10*mm, bottomMargin=14*mm,
        title=f"{order.get('name') or report_type} - {sub.get('reference') or ''}",
        author="Fourbuy Car Buying Co.",
    )
    styles = getSampleStyleSheet()
    body = ParagraphStyle("body", parent=styles["Normal"], fontSize=10, leading=14)
    small = ParagraphStyle("small", parent=styles["Normal"], fontSize=8, leading=11, textColor=rl_colors.grey)
    h_section = ParagraphStyle(
        "h_section", parent=styles["Heading2"],
        fontSize=11, leading=14, textColor=rl_colors.HexColor("#0f2540") if report_type == "car_vertical" else rl_colors.black,
        spaceBefore=12, spaceAfter=6, textTransform="uppercase",
    )
    story = []

    # Header banner
    header_rows = [[
        Paragraph(
            f"<font color='white' size='16'><b>{provider_name}</b></font>"
            f"<br/><font color='white' size='9'>{order.get('name') or report_type}</font>",
            body,
        ),
        Paragraph(
            f"<font color='white' size='8'>VIN</font><br/>"
            f"<font color='white' size='10'><b>{order.get('vin') or '—'}</b></font>",
            body,
        ),
    ]]
    header_table = Table(header_rows, colWidths=[125*mm, 55*mm])
    header_table.setStyle(TableStyle([
        ("BACKGROUND", (0, 0), (-1, -1), header_bg),
        ("VALIGN", (0, 0), (-1, -1), "MIDDLE"),
        ("LEFTPADDING", (0, 0), (-1, -1), 14),
        ("RIGHTPADDING", (0, 0), (-1, -1), 14),
        ("TOPPADDING", (0, 0), (-1, -1), 14),
        ("BOTTOMPADDING", (0, 0), (-1, -1), 14),
    ]))
    story.append(header_table)

    # Accent strip
    strip = Table([[""]], colWidths=[180*mm], rowHeights=[3])
    strip.setStyle(TableStyle([("BACKGROUND", (0, 0), (-1, -1), accent)]))
    story.append(strip)

    # Meta row
    meta_rows = [[
        Paragraph(f"<b>{sub.get('year') or ''} {sub.get('make_name') or ''} {sub.get('model_name') or ''}</b>", body),
        Paragraph(f"<b>Reference:</b> {sub.get('reference') or sub.get('id', '')[:8]}", small),
        Paragraph(
            f"<b>Report Date:</b> {(order.get('delivered_at') or order.get('ordered_at') or '')[:10]}",
            small,
        ),
    ]]
    meta_table = Table(meta_rows, colWidths=[70*mm, 55*mm, 55*mm])
    meta_table.setStyle(TableStyle([
        ("VALIGN", (0, 0), (-1, -1), "MIDDLE"),
        ("TOPPADDING", (0, 0), (-1, -1), 8),
        ("BOTTOMPADDING", (0, 0), (-1, -1), 8),
        ("LINEBELOW", (0, 0), (-1, -1), 0.5, rl_colors.lightgrey),
    ]))
    story.append(meta_table)

    # Mock disclaimer
    if order.get("mocked"):
        story.append(Spacer(1, 6))
        story.append(Paragraph(
            "<i>MOCK DATA — this dossier is generated locally while the real provider APIs are being integrated. Structure mirrors the live provider response.</i>",
            small,
        ))

    data = order.get("result_data") or {}

    # ------------------------------------------------------------------
    # Type-specific rich renderers (JLR OSH, Kredo VIN, BMW factory
    # options). These payloads don't use the generic `summary` +
    # `sections` schema, so without a dedicated branch the whole
    # dossier would render as just the header banner. Structure mirrors
    # the on-screen report cards.
    # ------------------------------------------------------------------
    def _sub_row_style() -> TableStyle:
        return TableStyle([
            ("FONT", (0, 0), (-1, -1), "Helvetica", 9.5),
            ("FONT", (0, 0), (0, -1), "Helvetica-Bold", 9.5),
            ("LINEBELOW", (0, 0), (-1, -1), 0.25, rl_colors.lightgrey),
            ("TOPPADDING", (0, 0), (-1, -1), 5),
            ("BOTTOMPADDING", (0, 0), (-1, -1), 5),
            ("VALIGN", (0, 0), (-1, -1), "TOP"),
        ])

    if report_type == "landrover_osh" and isinstance(data, dict):
        v = data.get("vehicle") or {}
        v_rows = []
        for lbl, k in [
            ("VIN", "vin"), ("Model", "model_name"), ("Model Year", "model_year"),
            ("Engine", "engine"), ("Colour", "colour"),
            ("Warranty Start", "warranty_start_date"),
            ("Registration Country", "registration_country"),
        ]:
            if v.get(k):
                v_rows.append([lbl, Paragraph(str(v[k]), body)])
        if v_rows:
            story.append(Paragraph("VEHICLE", h_section))
            tv = Table(v_rows, colWidths=[45*mm, 130*mm])
            tv.setStyle(_sub_row_style())
            story.append(tv)

        ls = data.get("last_service") or {}
        if isinstance(ls, dict) and any(ls.get(k) for k in
                ("type", "distance", "date", "job_number",
                 "repairer_name", "repairer_location", "service_items")):
            services_local = data.get("services") or []
            ls_title = "LATEST SERVICE DETAIL" if services_local else "LAST SERVICE RECORDED"
            story.append(Paragraph(ls_title, h_section))
            ls_rows = []
            for lbl, key in [
                ("Type", "type"), ("Distance", "distance"), ("Date", "date"),
                ("Job Number", "job_number"),
                ("Repairer", "repairer_name"),
                ("Location", "repairer_location"),
                ("Repairer Type", "repairer_type"),
            ]:
                val = ls.get(key)
                if val:
                    ls_rows.append([lbl, Paragraph(str(val), body)])
            if ls_rows:
                t_ls = Table(ls_rows, colWidths=[45*mm, 130*mm])
                t_ls.setStyle(_sub_row_style())
                story.append(t_ls)
            items = ls.get("service_items") or []
            if isinstance(items, list) and items:
                story.append(Spacer(1, 4))
                story.append(Paragraph("<b>Service items</b>", body))
                for item in items:
                    story.append(Paragraph(f"•&nbsp;&nbsp;{item}", body))

        services = data.get("services") or []
        if services:
            story.append(Paragraph(f"SERVICE HISTORY ({len(services)})", h_section))
            srv_rows = [["Date", "Odometer", "Repairer", "Job No.", "Details"]]
            for s in services:
                odo = s.get("odometer")
                odo_str = "—"
                if odo:
                    odo_str = str(odo).strip()
                    if not odo_str.lower().endswith("km"):
                        odo_str = f"{odo_str} km"
                srv_rows.append([
                    Paragraph(s.get("job_date") or "—", body),
                    Paragraph(odo_str, body),
                    Paragraph(s.get("repairer") or "—", body),
                    Paragraph(s.get("job_number") or "—", body),
                    Paragraph(s.get("details") or "—", body),
                ])
            t_s = Table(srv_rows, colWidths=[22*mm, 22*mm, 50*mm, 22*mm, 62*mm], repeatRows=1)
            ts = _sub_row_style()
            ts.add("FONT", (0, 0), (-1, 0), "Helvetica-Bold", 8.5)
            ts.add("BACKGROUND", (0, 0), (-1, 0), rl_colors.HexColor("#F5F5F5"))
            t_s.setStyle(ts)
            story.append(t_s)

        alerts = data.get("alerts") or []
        if alerts:
            story.append(Paragraph(f"ALERTS ({len(alerts)})", h_section))
            for a in alerts:
                story.append(Paragraph(f"•&nbsp;&nbsp;{a}", body))

        prov_bits = []
        if data.get("captured_at"):
            prov_bits.append(
                f"Captured {str(data['captured_at'])[:19].replace('T', ' ')} UTC"
            )
        if data.get("source"):
            prov_bits.append(f"Source: {data['source']}")
        url = data.get("service_history_url") or data.get("result_url")
        if url:
            prov_bits.append(f'<a href="{url}"><u>View on JLR OSH</u></a>')
        if prov_bits:
            story.append(Spacer(1, 6))
            story.append(Paragraph(" · ".join(prov_bits), small))

    elif report_type == "kredo_vin_history" and isinstance(data, dict):
        # Real Kredo VIN payload shape:
        #   { claim_count, claims: [{ id, creation_date, accident_date,
        #     country, manufacturer, model, mileage_at_claim,
        #     damage_locations: [str], glass_damage }] }
        claims = data.get("claims") or data.get("accident_claims") or []
        claim_count = data.get("claim_count")
        if claim_count is None:
            claim_count = len(claims)
        summary_bits = [f"Claim count: {claim_count}"]
        if data.get("last_claim_date"):
            summary_bits.append(f"Last claim: {data['last_claim_date']}")
        story.append(Paragraph("SUMMARY", h_section))
        story.append(Paragraph(" · ".join(summary_bits), body))

        story.append(Paragraph("ACCIDENT / CLAIM HISTORY", h_section))
        if claims:
            c_rows = [["Date", "Vehicle", "Mileage", "Damage", "Ref"]]
            for cl in claims:
                date_str = cl.get("accident_date") or cl.get("creation_date") or "—"
                mfr = cl.get("manufacturer") or ""
                mdl = cl.get("model") or ""
                vehicle_line = (mfr + " " + mdl).strip() or "—"
                mileage_raw = cl.get("mileage_at_claim")
                try:
                    mileage_num = int(mileage_raw) if mileage_raw not in (None, "") else None
                except (TypeError, ValueError):
                    mileage_num = None
                mileage_str = f"{mileage_num:,} km" if mileage_num is not None else "—"
                locs = list(cl.get("damage_locations") or [])
                if cl.get("glass_damage"):
                    locs.append("Windscreen")
                damage_str = ", ".join(l.replace("-", " ").title() for l in locs) or "—"
                c_rows.append([
                    Paragraph(str(date_str), body),
                    Paragraph(vehicle_line, body),
                    Paragraph(mileage_str, body),
                    Paragraph(damage_str, body),
                    Paragraph(str(cl.get("id") or "—"), body),
                ])
            t_c = Table(c_rows, colWidths=[24*mm, 34*mm, 22*mm, 62*mm, 36*mm], repeatRows=1)
            ts = _sub_row_style()
            ts.add("FONT", (0, 0), (-1, 0), "Helvetica-Bold", 8.5)
            ts.add("BACKGROUND", (0, 0), (-1, 0), rl_colors.HexColor("#F5F5F5"))
            t_c.setStyle(ts)
            story.append(t_c)
        else:
            story.append(Paragraph("No claims recorded for this VIN.", body))

    elif report_type == "bmw_options" and isinstance(data, dict):
        # BMW factory-option list.
        opts = data.get("options") or []
        if data.get("report_date"):
            story.append(Paragraph("SUMMARY", h_section))
            story.append(Paragraph(f"Report date: {data.get('report_date')}", body))
        if opts:
            story.append(Paragraph(f"FACTORY OPTIONS ({len(opts)})", h_section))
            for o in opts:
                code = o.get("code") or ""
                desc = o.get("description") or o.get("name") or ""
                story.append(Paragraph(f"•&nbsp;&nbsp;<b>{code}</b> — {desc}", body))
        elif not data.get("summary") and not data.get("sections"):
            story.append(Paragraph("No factory options returned for this VIN.", body))

    # Summary paragraph
    if data.get("summary"):
        story.append(Paragraph("SUMMARY", h_section))
        story.append(Paragraph(data["summary"], body))

    # Sections
    for section_name, section_val in (data.get("sections") or {}).items():
        story.append(Paragraph(section_name.upper(), h_section))
        if isinstance(section_val, list):
            for item in section_val:
                story.append(Paragraph(f"•&nbsp;&nbsp;{item}", body))
        elif isinstance(section_val, dict) and section_val:
            rows = [[str(k), str(v)] for k, v in section_val.items()]
            tbl = Table(rows, colWidths=[70*mm, 105*mm])
            tbl.setStyle(TableStyle([
                ("FONT", (0, 0), (-1, -1), "Helvetica", 9.5),
                ("FONT", (0, 0), (0, -1), "Helvetica-Bold", 9.5),
                ("LINEBELOW", (0, 0), (-1, -1), 0.25, rl_colors.lightgrey),
                ("TOPPADDING", (0, 0), (-1, -1), 5),
                ("BOTTOMPADDING", (0, 0), (-1, -1), 5),
                ("VALIGN", (0, 0), (-1, -1), "TOP"),
            ]))
            story.append(tbl)
        story.append(Spacer(1, 4))

    # Footer
    story.append(Spacer(1, 16))
    story.append(Paragraph(
        f"Delivered via Fourbuy Car Buying Co. · Report Cost: R{order.get('cost_zar', 0):.0f} · Order ID: {order.get('id')}",
        small,
    ))

    doc.build(story)
    return buf.getvalue()


# ============ Deal Tracking & Profit Analysis ============
# The submitting dealer records the outcome of the deal on the vehicle in
# TWO stages once they've received Fourbuy's Cover + any Pricing Agent
# covers:
#   Stage 1 (purchase)  — Did they do the deal? If yes, at what price?
#   Stage 2 (sale)      — Have they sold the car? If yes, recon spend +
#                          sale price. From these we compute a live P&L
#                          which can be downloaded as a PDF.
#
# Visibility rules:
#   • Dealer users in the SAME dealership as the submission can edit.
#   • Admin can read (for internal reporting) but never edits.
#   • Pricing agents in the Give Cover network MUST NEVER see any of
#     this data — enforced in `_sanitise_sub_for_pricing_agent`.

def _sanitise_deal_int(value, field: str) -> Optional[int]:
    """Coerce a client-supplied price / cost input into a non-negative int
    ZAR value. Accepts int, float or numeric strings; strips whitespace,
    commas, spaces and a leading `R`. Returns None when the value is
    None/empty. Raises HTTPException on invalid values so the client sees
    a proper 400."""
    if value is None:
        return None
    if isinstance(value, bool):
        raise HTTPException(400, f"{field} must be a number")
    if isinstance(value, str):
        s = value.strip().replace(",", "").replace(" ", "")
        if s.upper().startswith("R"):
            s = s[1:]
        if s == "":
            return None
        try:
            value = float(s)
        except ValueError:
            raise HTTPException(400, f"{field} must be a number")
    if isinstance(value, (int, float)):
        n = int(round(float(value)))
        if n < 0:
            raise HTTPException(400, f"{field} must be zero or greater")
        return n
    raise HTTPException(400, f"{field} must be a number")


def _compute_deal_profit(deal: dict) -> dict:
    """Given a `deal` doc, return the derived P&L block used by both the
    API response and the PDF renderer. Values are None if we don't have
    enough info yet to compute them."""
    dealer_offer = deal.get("dealer_offer_zar")
    purchase = deal.get("purchase_price_zar")
    recon = deal.get("recon_cost_zar")
    sale = deal.get("sale_price_zar")
    cost_basis = None
    if isinstance(purchase, (int, float)):
        cost_basis = int(purchase) + int(recon or 0)
    profit = None
    margin_pct = None
    if cost_basis is not None and isinstance(sale, (int, float)):
        profit = int(sale) - cost_basis
        if int(sale) > 0:
            margin_pct = round((profit / int(sale)) * 100, 1)
    return {
        # Dealer's OWN pre-purchase offer to the seller. Distinct from
        # `purchase_price_zar` which is what they eventually paid — the
        # two often differ because of negotiation, discovered issues at
        # inspection, etc.
        "dealer_offer_zar": dealer_offer,
        "purchase_price_zar": purchase,
        "recon_cost_zar": recon,
        "sale_price_zar": sale,
        "cost_basis_zar": cost_basis,
        "profit_zar": profit,
        "margin_pct": margin_pct,
    }


@api_router.patch("/submissions/{sub_id}/deal")
async def update_submission_deal(
    sub_id: str,
    payload: dict,
    current: dict = Depends(get_current_user),
):
    """Deal-tracking updates. Accepts (any subset of):
      { "dealer_offer_zar": int,       # dealer's own pre-purchase offer
        "done": bool|null,             # Stage 1 answer
        "purchase_price_zar": int,     # required when done=True
        "sold": bool|null,             # Stage 2 answer
        "recon_cost_zar": int,         # required when sold=True (can be 0)
        "sale_price_zar": int }        # required when sold=True

    Access rules:
      • Caller must be a `dealer` on the submission's dealership.
      • Caller must additionally have `is_pricing_agent = true` — this
        toggle is the managerial-access marker set by admins. Only
        those users can commit dealer offers and complete the deal
        tracking (buyer's-book style) for their dealership. Other
        dealers on the same dealership can still SEE the fields via
        the submission read endpoints.

    Timestamps `purchased_at` / `sold_at` / `dealer_offer_at` are
    stamped automatically the first time each stage is set. Fields
    remain fully editable so mistakes can be corrected.
    """
    if current.get("role") != "dealer":
        raise HTTPException(403, "Only the submitting dealership can update deal tracking.")
    if not current.get("is_pricing_agent"):
        raise HTTPException(
            403,
            "Only pricing agents (managerial access) on this dealership can update the deal tracking. Please ask your admin to enable your pricing access.",
        )

    sub = await db.submissions.find_one({"id": sub_id}, {"_id": 0})
    if not sub:
        raise HTTPException(404, "Submission not found")

    owner_dship = sub.get("dealership_id")
    my_dship = await _get_user_dealership_id(current)
    if not (owner_dship and owner_dship == my_dship) and sub.get("dealer_id") != current.get("id"):
        raise HTTPException(403, "Only dealers on the vehicle's dealership can update deal tracking.")

    prev = sub.get("deal") or {}
    now_iso = datetime.now(timezone.utc).isoformat()
    deal = dict(prev)

    # ------- Dealer's own offer (new Stage 0) -------
    # Dealers set this BEFORE the seller has accepted. Storing it lets
    # the P&L show three anchors: what we offered, what we actually
    # paid, and what we sold it for. Also unlocks the rest of the
    # deal-tracking flow (Stage 1/2) on the UI.
    #
    # We ALSO keep a running audit history in `deal.dealer_offer_history`
    # — one entry per genuine change — so the dealership can look back
    # at how the offer moved during negotiation. Each history row
    # captures the amount, the timestamp, and the user who saved it.
    if "dealer_offer_zar" in payload:
        val = _sanitise_deal_int(payload.get("dealer_offer_zar"), "dealer_offer_zar")
        old_val = prev.get("dealer_offer_zar")
        deal["dealer_offer_zar"] = val
        if val is not None and not prev.get("dealer_offer_at"):
            deal["dealer_offer_at"] = now_iso
        # Only append to history when the amount ACTUALLY changed —
        # a redundant save with the same value shouldn't spam the log.
        if val is not None and val != old_val:
            history = list(prev.get("dealer_offer_history") or [])
            actor_info = current.get("dealer_info") or {}
            actor_name = (
                (actor_info.get("first_name") or "") + " " + (actor_info.get("last_name") or "")
            ).strip() or current.get("email") or "—"
            history.append({
                "price_zar": val,
                "at": now_iso,
                "by_user_id": current.get("id"),
                "by_name": actor_name,
            })
            deal["dealer_offer_history"] = history
            # Always keep the top-level `dealer_offer_at` in sync with
            # the LAST update — dealers should see the most recent
            # change date on the summary line.
            deal["dealer_offer_at"] = now_iso

    if "done" in payload:
        done_val = payload.get("done")
        if done_val is not None and not isinstance(done_val, bool):
            raise HTTPException(400, "done must be true, false or null")
        deal["done"] = done_val
        if done_val is True and not prev.get("purchased_at"):
            deal["purchased_at"] = now_iso
        if done_val is False:
            deal["purchase_price_zar"] = None
            deal["sold"] = None
            deal["recon_cost_zar"] = None
            deal["sale_price_zar"] = None

    if "purchase_price_zar" in payload:
        deal["purchase_price_zar"] = _sanitise_deal_int(
            payload.get("purchase_price_zar"), "purchase_price_zar"
        )

    if "sold" in payload:
        sold_val = payload.get("sold")
        if sold_val is not None and not isinstance(sold_val, bool):
            raise HTTPException(400, "sold must be true, false or null")
        if sold_val is True and deal.get("done") is not True:
            raise HTTPException(400, "Mark the purchase as done before recording a sale.")
        deal["sold"] = sold_val
        if sold_val is True and not prev.get("sold_at"):
            deal["sold_at"] = now_iso
        if sold_val is False:
            deal["recon_cost_zar"] = None
            deal["sale_price_zar"] = None

    if "recon_cost_zar" in payload:
        deal["recon_cost_zar"] = _sanitise_deal_int(
            payload.get("recon_cost_zar"), "recon_cost_zar"
        )
    if "sale_price_zar" in payload:
        deal["sale_price_zar"] = _sanitise_deal_int(
            payload.get("sale_price_zar"), "sale_price_zar"
        )

    deal["updated_at"] = now_iso
    deal["updated_by_user_id"] = current.get("id")
    info = (current.get("dealer_info") or {})
    deal["updated_by_name"] = (
        f"{info.get('first_name','').strip()} {info.get('last_name','').strip()}".strip()
        or current.get("email")
    )

    await db.submissions.update_one({"id": sub_id}, {"$set": {"deal": deal}})
    profit = _compute_deal_profit(deal)
    return {"ok": True, "deal": deal, "profit": profit}


class AttachLicenseDiskPayload(BaseModel):
    """Payload for the non-billable `add license disk to existing sub` flow.

    Dealer scans / uploads a licence disc for a submission that was
    originally submitted with VIN=TBC. We extract VIN + engine number
    from the raw PDF-417 blob, upload the raw blob and (optional)
    physical photograph to Cloudinary, and stamp them on the sub —
    no new invoice, no re-pricing, no touching the offer.
    """
    license_disk_data: str
    license_disk_photo: Optional[str] = None


@api_router.patch("/submissions/{sub_id}/license-disk")
async def attach_license_disk(
    sub_id: str,
    payload: AttachLicenseDiskPayload,
    current: dict = Depends(get_current_user),
):
    """Attach a licence-disc scan to an existing submission without
    creating a new billable valuation.

    Guardrails:
      • dealer must be on the owning dealership (or the original
        submitter). Admins can also patch for correction workflows.
      • only proceeds if the existing submission has no VIN (or VIN=='TBC').
        If a real VIN is already recorded we refuse — the dealer should
        submit a fresh valuation for a different car.
      • VIN and engine number are re-derived from the barcode payload
        (never trusted from the client).
    """
    sub = await db.submissions.find_one({"id": sub_id}, {"_id": 0})
    if not sub:
        raise HTTPException(404, "Submission not found")

    # Access: admin OR dealer on the owning dealership OR original submitter.
    role = current.get("role")
    if role != "admin":
        owner_dship = sub.get("dealership_id")
        my_dship = await _get_user_dealership_id(current)
        if not (owner_dship and owner_dship == my_dship) and sub.get("dealer_id") != current.get("id"):
            raise HTTPException(403, "Only the submitting dealership can attach a licence disc.")

    existing_vin = (sub.get("vin") or "").strip().upper()
    if existing_vin and existing_vin != "TBC":
        raise HTTPException(400, "This submission already has a VIN captured; nothing to attach.")

    # Extract VIN + engine number from the scanned barcode string.
    parsed = _parse_license_disk_string(payload.license_disk_data or "")
    new_vin = (parsed.get("vin") or "").strip().upper() or "TBC"
    new_engine = (parsed.get("engine_number") or "").strip().upper() or (sub.get("engine_number") or "TBC")

    if new_vin == "TBC":
        raise HTTPException(
            400,
            "The scanned licence disc did not contain a VIN. Please retake the scan or upload a clearer photo.",
        )

    # Upload the raw disc payload + photo to Cloudinary (folder-scoped
    # to the submission so admin can reconcile later).
    disk_uploaded = upload_image_to_cloudinary(
        payload.license_disk_data,
        folder=f"fourbuy/submissions/{sub_id}",
        public_id="license_disk",
    )
    disk_photo_uploaded = upload_image_to_cloudinary(
        payload.license_disk_photo,
        folder=f"fourbuy/submissions/{sub_id}",
        public_id="license_disk_photo",
    )

    update = {
        "vin": new_vin,
        "engine_number": new_engine,
        "license_disk_data": disk_uploaded or payload.license_disk_data,
    }
    if disk_photo_uploaded:
        update["license_disk_photo"] = disk_photo_uploaded

    # Audit trail — record who attached the disc + when. Non-billable.
    now_iso = datetime.now(timezone.utc).isoformat()
    info = current.get("dealer_info") or {}
    who = (
        f"{info.get('first_name','').strip()} {info.get('last_name','').strip()}".strip()
        or current.get("email")
        or "unknown"
    )
    disk_history = list(sub.get("license_disk_history") or [])
    disk_history.append({
        "attached_at": now_iso,
        "attached_by_user_id": current.get("id"),
        "attached_by_name": who,
        "vin_before": existing_vin or None,
        "vin_after": new_vin,
    })
    update["license_disk_history"] = disk_history

    await db.submissions.update_one({"id": sub_id}, {"$set": update})
    fresh = await db.submissions.find_one({"id": sub_id}, {"_id": 0})
    return {"ok": True, "submission": fresh, "vin": new_vin}


async def _build_profit_pdf(sub: dict, deal: dict) -> bytes:
    """Render a 1-page A4 profit-analysis sheet for a completed deal.

    Vehicle header (year / make / model / VIN / reference / dealership) +
    a front-photo thumbnail (when available), the Fourbuy Cover offer,
    the purchase price, recon cost, cost basis, sale price, and a bold
    profit / loss callout with margin %.
    """
    from io import BytesIO
    from reportlab.lib.pagesizes import A4
    from reportlab.lib.styles import getSampleStyleSheet, ParagraphStyle
    from reportlab.lib.units import mm
    from reportlab.lib import colors as rl_colors
    from reportlab.lib.enums import TA_RIGHT
    from reportlab.platypus import (
        SimpleDocTemplate, Paragraph, Spacer, Table, TableStyle,
        Image as RLImage, KeepTogether,
    )
    import base64 as _b64
    from PIL import Image as PILImage

    async def _fetch_bytes(uri: Optional[str]) -> Optional[bytes]:
        if not uri or not isinstance(uri, str):
            return None
        try:
            if uri.startswith("data:"):
                _, _, b64part = uri.partition(",")
                return _b64.b64decode(b64part)
            if uri.startswith("http://") or uri.startswith("https://"):
                async with httpx.AsyncClient(timeout=15.0) as cli:
                    r = await cli.get(uri)
                    r.raise_for_status()
                    return r.content
        except Exception as e:
            logger.warning("Profit PDF image fetch failed: %s", e)
        return None

    def _thumb(raw: bytes, max_w_mm: float, max_h_mm: float):
        if not raw:
            return None
        try:
            im = PILImage.open(BytesIO(raw))
            if im.mode not in ("RGB", "L"):
                im = im.convert("RGB")
            im.thumbnail((900, 900), PILImage.LANCZOS)
            b = BytesIO()
            im.save(b, format="JPEG", quality=82, optimize=True)
            b.seek(0)
            iw, ih = im.size
            max_w_pt = float(max_w_mm) * mm
            max_h_pt = float(max_h_mm) * mm
            ratio = min(max_w_pt / iw, max_h_pt / ih)
            return RLImage(b, width=iw * ratio, height=ih * ratio)
        except Exception as e:
            logger.warning("Profit PDF thumb failed: %s", e)
            return None

    profit = _compute_deal_profit(deal)
    ref = sub.get("reference") or (sub.get("id") or "")[:8]

    buf = BytesIO()
    doc = SimpleDocTemplate(
        buf, pagesize=A4,
        leftMargin=14 * mm, rightMargin=14 * mm,
        topMargin=16 * mm, bottomMargin=14 * mm,
        title=f"Profit Analysis {ref}",
        author="Fourbuy Car Buying Co.",
    )
    styles = getSampleStyleSheet()
    BLACK = rl_colors.HexColor("#0A0A0A")
    INK = rl_colors.HexColor("#111111")
    MUTED = rl_colors.HexColor("#6B6B6B")
    LINE = rl_colors.HexColor("#E5E5E5")
    PAPER = rl_colors.HexColor("#F7F7F7")
    OK = rl_colors.HexColor("#1F7A3A")
    DANGER = rl_colors.HexColor("#B3261E")

    h1 = ParagraphStyle("h1", parent=styles["Heading1"], fontSize=20, leading=24,
                       textColor=BLACK, spaceAfter=2)
    h2 = ParagraphStyle("h2", parent=styles["Heading2"], fontSize=12, leading=15,
                       textColor=INK, spaceBefore=8, spaceAfter=4)
    body = ParagraphStyle("body", parent=styles["BodyText"], fontSize=10, leading=14,
                       textColor=INK)
    muted = ParagraphStyle("muted", parent=body, textColor=MUTED, fontSize=9)
    right = ParagraphStyle("right", parent=body, alignment=TA_RIGHT)

    story = []
    vehicle_title = " ".join([
        str(sub.get("year") or ""),
        str(sub.get("make_name") or ""),
        str(sub.get("model_name") or ""),
    ]).strip() or "Vehicle"
    derivative = str(sub.get("derivative_name") or "").strip()
    header_left = [
        Paragraph("<b>PROFIT ANALYSIS</b>", muted),
        Paragraph(vehicle_title, h1),
    ]
    if derivative:
        header_left.append(Paragraph(derivative, muted))
    header_left.append(Paragraph(
        f"Ref <b>{ref}</b>  ·  VIN <b>{sub.get('vin') or '&mdash;'}</b>", muted,
    ))
    dship = (sub.get("company_name") or sub.get("dealer_name") or "").strip()
    if dship:
        header_left.append(Paragraph(f"Dealership: <b>{dship}</b>", muted))

    front_uri = None
    photos = sub.get("photos") or {}
    if isinstance(photos, dict):
        front_uri = photos.get("front") or photos.get("front_photo") or sub.get("front_photo")
    front_bytes = await _fetch_bytes(front_uri) if front_uri else None
    front_img = _thumb(front_bytes, 58, 40) if front_bytes else None

    if front_img is not None:
        hdr_tbl = Table(
            [[header_left, front_img]],
            colWidths=[110 * mm, 62 * mm],
        )
    else:
        hdr_tbl = Table([[header_left, ""]], colWidths=[172 * mm, 0])
    hdr_tbl.setStyle(TableStyle([
        ("VALIGN", (0, 0), (-1, -1), "TOP"),
        ("ALIGN", (1, 0), (1, 0), "RIGHT"),
        ("LEFTPADDING", (0, 0), (-1, -1), 0),
        ("RIGHTPADDING", (0, 0), (-1, -1), 0),
        ("TOPPADDING", (0, 0), (-1, -1), 0),
        ("BOTTOMPADDING", (0, 0), (-1, -1), 0),
    ]))
    story.append(hdr_tbl)
    story.append(Spacer(1, 8))

    fourbuy_cover = sub.get("price")
    if fourbuy_cover is None:
        ap = sub.get("admin_pricing") or {}
        fourbuy_cover = ap.get("offer_to_dealer_zar")
    story.append(Paragraph("Fourbuy Cover", h2))
    story.append(Table(
        [[
            Paragraph("Cover offered", body),
            Paragraph(
                f"<b>R {int(fourbuy_cover or 0):,}</b>".replace(",", " "), right,
            ),
        ]],
        colWidths=[100 * mm, 72 * mm],
        style=TableStyle([
            ("BOX", (0, 0), (-1, -1), 0.5, LINE),
            ("BACKGROUND", (0, 0), (-1, -1), PAPER),
            ("LEFTPADDING", (0, 0), (-1, -1), 10),
            ("RIGHTPADDING", (0, 0), (-1, -1), 10),
            ("TOPPADDING", (0, 0), (-1, -1), 6),
            ("BOTTOMPADDING", (0, 0), (-1, -1), 6),
        ]),
    ))

    def _r(v):
        if v is None:
            return "—"
        try:
            return f"R {int(v):,}".replace(",", " ")
        except Exception:
            return "—"

    def _dt(iso):
        if not iso:
            return "—"
        try:
            dt = datetime.fromisoformat(iso.replace("Z", "+00:00"))
            return dt.strftime("%d %b %Y")
        except Exception:
            return "—"

    story.append(Paragraph("Deal Summary", h2))
    tbl_rows = [
        ["Dealer offer", _r(deal.get("dealer_offer_zar")), "Offered on", _dt(deal.get("dealer_offer_at"))],
        ["Purchase price", _r(deal.get("purchase_price_zar")), "Bought on", _dt(deal.get("purchased_at"))],
        ["Reconditioning", _r(deal.get("recon_cost_zar")), "", ""],
        ["Total cost basis", _r(profit.get("cost_basis_zar")), "", ""],
        ["Sale price", _r(deal.get("sale_price_zar")), "Sold on", _dt(deal.get("sold_at"))],
    ]
    story.append(Table(
        tbl_rows,
        colWidths=[46 * mm, 42 * mm, 30 * mm, 54 * mm],
        style=TableStyle([
            ("BOX", (0, 0), (-1, -1), 0.5, LINE),
            ("INNERGRID", (0, 0), (-1, -1), 0.4, LINE),
            ("FONTSIZE", (0, 0), (-1, -1), 10),
            ("TEXTCOLOR", (0, 0), (-1, -1), INK),
            ("ALIGN", (1, 0), (1, -1), "RIGHT"),
            ("VALIGN", (0, 0), (-1, -1), "MIDDLE"),
            ("LEFTPADDING", (0, 0), (-1, -1), 8),
            ("RIGHTPADDING", (0, 0), (-1, -1), 8),
            ("TOPPADDING", (0, 0), (-1, -1), 6),
            ("BOTTOMPADDING", (0, 0), (-1, -1), 6),
            ("BACKGROUND", (0, 2), (1, 2), PAPER),
        ]),
    ))
    story.append(Spacer(1, 8))

    p_val = profit.get("profit_zar")
    p_color = OK if (p_val is not None and p_val >= 0) else DANGER
    p_label = "Gross Profit" if (p_val is not None and p_val >= 0) else "Loss"
    p_str = _r(p_val) if p_val is not None else "—"
    m_str = f"{profit.get('margin_pct'):.1f}%" if profit.get("margin_pct") is not None else "—"
    profit_tbl = Table(
        [[
            Paragraph(f"<b>{p_label.upper()}</b>", ParagraphStyle(
                "pl", parent=body, textColor=rl_colors.white, fontSize=11,
            )),
            Paragraph(
                f"<font size=22><b>{p_str}</b></font>",
                ParagraphStyle("pv", parent=body, textColor=rl_colors.white,
                              alignment=TA_RIGHT),
            ),
        ], [
            Paragraph("Margin on sale price", ParagraphStyle(
                "ml", parent=body, textColor=rl_colors.HexColor("#DDDDDD"), fontSize=9,
            )),
            Paragraph(f"<b>{m_str}</b>", ParagraphStyle(
                "mv", parent=body, textColor=rl_colors.white, alignment=TA_RIGHT,
                fontSize=12,
            )),
        ]],
        colWidths=[86 * mm, 86 * mm],
        style=TableStyle([
            ("BACKGROUND", (0, 0), (-1, -1), p_color),
            ("BOX", (0, 0), (-1, -1), 0, p_color),
            ("LEFTPADDING", (0, 0), (-1, -1), 14),
            ("RIGHTPADDING", (0, 0), (-1, -1), 14),
            ("TOPPADDING", (0, 0), (-1, -1), 8),
            ("BOTTOMPADDING", (0, 0), (-1, -1), 8),
        ]),
    )
    story.append(KeepTogether(profit_tbl))
    story.append(Spacer(1, 10))

    now_str = datetime.now(timezone.utc).strftime("%d %b %Y %H:%M UTC")
    story.append(Paragraph(
        f"Generated {now_str} · Fourbuy Car Buying Co. · Confidential — for the "
        "submitting dealership and Fourbuy admin only.",
        muted,
    ))

    doc.build(story)
    return buf.getvalue()


@api_router.get("/submissions/{sub_id}/profit-analysis.pdf")
async def download_profit_analysis_pdf(
    sub_id: str,
    current: dict = Depends(get_user_flexible),
):
    """Downloadable profit-analysis PDF. Restricted to the owning
    dealership (dealer or their teammates) and admin. Pricing agents are
    blocked even if they have a query token that grants cover access."""
    sub = await db.submissions.find_one({"id": sub_id}, {"_id": 0})
    if not sub:
        raise HTTPException(404, "Submission not found")
    if current.get("role") != "admin":
        my_dship = await _get_user_dealership_id(current)
        same_dship = sub.get("dealership_id") and sub.get("dealership_id") == my_dship
        legacy_owner = sub.get("dealer_id") == current.get("id")
        if not (same_dship or legacy_owner):
            raise HTTPException(403, "Not authorized")
    deal = sub.get("deal") or {}
    profit = _compute_deal_profit(deal)
    if profit.get("profit_zar") is None:
        raise HTTPException(400, "Enter the purchase, recon and sale figures first.")
    try:
        pdf_bytes = await _build_profit_pdf(sub, deal)
    except Exception as e:
        logger.exception("Profit PDF generation failed")
        raise HTTPException(500, f"Failed to generate PDF: {e}")
    filename = f"profit_analysis_{sub.get('reference') or sub_id}.pdf".replace(" ", "_")
    return Response(
        content=pdf_bytes,
        media_type="application/pdf",
        headers={"Content-Disposition": f'inline; filename="{filename}"'},
    )




@api_router.get("/submissions/{sub_id}/valuation.pdf")
async def download_valuation_pdf(sub_id: str, current: dict = Depends(get_user_flexible)):
    # Note: keep the `photos` field — the new PDF renderer embeds all 5 main
    # photos in the document, matching the on-screen valuation.
    sub = await db.submissions.find_one({"id": sub_id}, {"_id": 0})
    if not sub:
        raise HTTPException(404, "Submission not found")
    if not await _can_access_submission(sub, current):
        raise HTTPException(403, "Not authorized")
    if sub.get("status") != "priced":
        raise HTTPException(400, "Valuation PDF is available only after an offer has been received")

    # If the submission has moved to the "archived" bucket, we STILL let
    # the owner download a snapshot PDF (they can't access the live
    # detail screen anymore, but the PDF is a permanent historical
    # record). The renderer stamps a red "SUBMISSION EXPIRED" banner
    # on page 1 so the dealer knows they're looking at a snapshot.
    expired = compute_bucket(sub) == "archived"

    reports = await db.report_orders.find(
        {"submission_id": sub_id}, {"_id": 0}
    ).sort("ordered_at", 1).to_list(50)

    try:
        pdf_bytes = await _build_valuation_pdf(sub, reports, expired=expired)
    except Exception as e:
        logger.exception("PDF generation failed")
        raise HTTPException(500, f"Failed to generate PDF: {e}")

    filename = f"valuation_{sub.get('reference') or sub_id}.pdf".replace(" ", "_")
    # `inline` so mobile in-app browsers preview the PDF instead of prompting to
    # download. On the web/desktop flow the frontend fetches as a blob and
    # triggers a download link itself, so `inline` is fine for both cases.
    return Response(
        content=pdf_bytes,
        media_type="application/pdf",
        headers={"Content-Disposition": f'inline; filename="{filename}"'},
    )


@api_router.get("/submissions/{sub_id}/reports/{report_type}.pdf")
async def download_report_pdf(
    sub_id: str,
    report_type: str,
    current: dict = Depends(get_user_flexible),
):
    """Render a single VIN report as its own PDF (Lightstone / CarVertical
    styled). Useful when the dealer wants to keep a copy of the individual
    report — especially the Car Vertical dossier which mimics the sample
    provider PDF layout.
    """
    if report_type not in REPORT_CATALOG:
        raise HTTPException(400, "Unknown report type")

    sub = await db.submissions.find_one({"id": sub_id}, {"_id": 0, "photos": 0})
    if not sub:
        raise HTTPException(404, "Submission not found")
    if not await _can_access_submission(sub, current):
        raise HTTPException(403, "Not authorized")

    order = await db.report_orders.find_one(
        {"submission_id": sub_id, "type": report_type}, {"_id": 0}
    )
    if not order:
        raise HTTPException(404, "Report has not been ordered for this submission")
    if (order.get("status") or "") != "delivered":
        raise HTTPException(400, "Report has not been delivered yet")

    try:
        pdf_bytes = await _build_report_pdf(sub, order)
    except Exception as e:
        logger.exception("Report PDF generation failed")
        raise HTTPException(500, f"Failed to generate report PDF: {e}")

    filename = f"{report_type}_{sub.get('reference') or sub_id}.pdf".replace(" ", "_")
    return Response(
        content=pdf_bytes,
        media_type="application/pdf",
        headers={"Content-Disposition": f'inline; filename="{filename}"'},
    )



# ============ Market analysis (AI) ============
def _warranty_label(status: Optional[str], legacy_bool: Optional[bool]) -> str:
    """Human-readable label for the market-analysis prompt covering both the
    new `factory_warranty_status` / `maintenance_plan_status` fields and
    legacy bool submissions."""
    if status == "active":
        return "Active"
    if status == "expired":
        return "Expired"
    if legacy_bool is True:
        return "Active"
    if legacy_bool is False:
        return "Expired / None"
    return "Not answered"


def _zar(n: Optional[float]) -> str:
    """Format a Rand value as `R123 456` or `—` when null."""
    if n is None:
        return "—"
    try:
        return f"R{int(round(float(n))):,}".replace(",", " ")
    except (TypeError, ValueError):
        return "—"


def _autotrader_search_url_for_sub(sub: dict) -> str | None:
    """Build the same AutoTrader.co.za deep-link the frontend "Compare Live
    Listings" card generates. We inject this URL into the AI market
    analysis prompt so GPT reasons against exactly the same set of
    listings the dealer can open in a browser — same make, derivative
    keywords, year range, fuel, transmission and dealerrating=3 filter.
    Returns `None` if there's not enough identifying data to build a
    meaningful URL.
    """
    import re as _re
    import urllib.parse as _up

    make = (sub.get("make_name") or "").strip()
    if not make:
        return None
    make_slug = _re.sub(r"[^a-z0-9]+", "-", make.lower()).strip("-")

    # Derivative keywords — split on non-alphanumerics, keep tokens ≥ 2
    # chars, upper-case for AutoTrader's search UI.
    derivative = (sub.get("derivative_name") or sub.get("model_name") or "").strip()
    tokens = [
        t.upper() for t in _re.split(r"[^A-Za-z0-9]+", derivative)
        if len(t) >= 2
    ]

    range_ = sub.get("variant_manufacture_range") or {}
    y_from = range_.get("min") or sub.get("year") or sub.get("year_registered")
    y_to = range_.get("max") or sub.get("year") or sub.get("year_registered")

    fuel = (sub.get("fuel_type") or "").strip().capitalize()
    trans = (sub.get("transmission") or "").strip().capitalize()

    qs: list[tuple[str, str]] = []
    for t in tokens:
        qs.append(("keyword", t))
    if y_from and y_to:
        qs.append(("year", f"{y_from}-to-{y_to}"))
    if fuel:
        qs.append(("fueltype", fuel))
    if trans:
        qs.append(("transmission", trans))
    qs.append(("dealerrating", "3"))

    return f"https://www.autotrader.co.za/cars-for-sale/{make_slug}?{_up.urlencode(qs)}"


def _market_analysis_context(sub: dict) -> str:
    """Build the enriched Vehicle-context block sent to GPT-5.2 for the
    market analysis. Combines everything the app already knows about the
    car — Kredo trade/retail values, VIN accident history, BMW/JLR
    factory data, service history, paint & recon — into a compact,
    prompt-friendly report so the model can ground its answer instead of
    guessing from make/model/year alone. Missing pieces are omitted
    silently so the prompt stays tight for cars with limited data.
    """
    lines: list[str] = ["Vehicle:"]

    # -- AutoTrader reference URL (drives the analysis) -------------------
    # This is the *only* market data source we ask GPT to consider —
    # exactly the same deep-link the dealer sees in the Compare Live
    # Listings card. Filters: same make, same derivative keywords, model-
    # year run, fuel type, transmission, dealerrating >= 3.
    at_url = _autotrader_search_url_for_sub(sub)
    if at_url:
        lines.append(f"- AutoTrader reference search: {at_url}")

    # -- Core identity & condition ---------------------------------------
    lines.append(f"- Make: {sub.get('make_name')}")
    lines.append(f"- Model: {sub.get('model_name')}")
    lines.append(f"- Derivative: {sub.get('derivative_name')}")
    lines.append(f"- Year of production: {sub.get('year')}")
    if sub.get("year_registered") and sub.get("year_registered") != sub.get("year"):
        lines.append(f"- Year registered: {sub.get('year_registered')}")
    try:
        km = int(sub.get("mileage") or 0)
        lines.append(f"- Mileage: {km:,} km")
        # Mileage per year vs SA average (~20,000 km/year is the common yardstick)
        yr = sub.get("year") or sub.get("year_registered")
        if yr:
            age = max(1, datetime.now(timezone.utc).year - int(yr))
            per_year = km / age
            avg_delta = per_year - 20000
            deviation = "typical"
            if avg_delta < -6000:
                deviation = f"below-average (~{int(per_year):,} km/yr)"
            elif avg_delta > 6000:
                deviation = f"above-average (~{int(per_year):,} km/yr)"
            else:
                deviation = f"average (~{int(per_year):,} km/yr)"
            lines.append(f"- Mileage vs SA average: {deviation}")
    except Exception:
        pass
    lines.append(f"- Colour: {sub.get('colour')}")

    # Ratings: prefer granular scores when present, otherwise legacy overall
    ratings = []
    for key, label in (
        ("mechanical_condition", "Mechanical"),
        ("cosmetic_condition", "Cosmetic"),
        ("interior_condition", "Interior"),
        ("history_condition", "History"),
    ):
        val = sub.get(key)
        if val is not None:
            ratings.append(f"{label} {val}/10")
    if ratings:
        lines.append(f"- Condition ratings: {', '.join(ratings)}")
    elif sub.get("condition") is not None:
        lines.append(f"- Condition: {sub.get('condition')}/10")

    # -- Warranty & Maintenance Plan -------------------------------------
    lines.append(
        f"- Factory warranty: {_warranty_label(sub.get('factory_warranty_status'), sub.get('factory_warranty'))}"
    )
    lines.append(
        f"- Maintenance plan: {_warranty_label(sub.get('maintenance_plan_status'), None)}"
    )

    # -- Service history (dealer-declared) --------------------------------
    if sub.get("service_history"):
        lines.append(f"- Service history (declared): {sub['service_history']}")
    if sub.get("last_service_date"):
        lines.append(f"- Last service date: {sub['last_service_date']}")
    if sub.get("last_service_mileage"):
        lines.append(f"- Last service mileage: {sub['last_service_mileage']} km")

    # -- Paint & accident (dealer-declared) -------------------------------
    if sub.get("paint_evidence"):
        lines.append(
            f"- Paint evidence: Yes ({sub.get('paint_quality') or 'quality unrated'})"
        )
    else:
        lines.append("- Paint evidence: None reported")
    if sub.get("accident_damage"):
        types = sub.get("accident_damage_types") or []
        lines.append(
            f"- Dealer-declared accident damage: Yes ({', '.join(types) if types else 'unspecified'})"
        )
    else:
        lines.append("- Dealer-declared accident damage: None reported")

    # -- Reconditioning (money needed to retail-ready) --------------------
    recon_items = sub.get("reconditioning_items") or []
    recon_total = sub.get("reconditioning_total_zar")
    if recon_items or recon_total:
        cat_lines = []
        for r in recon_items:
            amt = r.get("amount_zar") or 0
            lbl = r.get("category") or r.get("label") or "Other"
            if amt:
                cat_lines.append(f"{lbl} {_zar(amt)}")
        cat_str = ", ".join(cat_lines) if cat_lines else "no line items"
        lines.append(
            f"- Reconditioning required: total {_zar(recon_total)} ({cat_str})"
        )

    # -- Kredo TrueTrade values (SA industry benchmark) -------------------
    mv = sub.get("market_values") or {}
    if (mv.get("status") or "ok") == "ok" and (mv.get("retail_price_zar") or mv.get("adjusted_retail_zar")):
        lines.append("- Kredo TrueTrade values (SA benchmark for this M&M code):")
        if mv.get("mm_code"):
            lines.append(f"    · M&M code: {mv['mm_code']}")
        if mv.get("new_price_zar"):
            lines.append(f"    · Original list price: {_zar(mv['new_price_zar'])}")
        if mv.get("retail_price_zar"):
            lines.append(f"    · Book retail: {_zar(mv['retail_price_zar'])}")
        if mv.get("market_price_zar"):
            lines.append(f"    · Market: {_zar(mv['market_price_zar'])}")
        if mv.get("adjusted_retail_zar"):
            lines.append(f"    · Adjusted retail (this unit): {_zar(mv['adjusted_retail_zar'])}")
        if mv.get("adjusted_trade_zar"):
            lines.append(f"    · Adjusted trade (this unit): {_zar(mv['adjusted_trade_zar'])}")

    # -- Kredo CarTrust / VIN accident-claim history ----------------------
    kct = (sub.get("reports") or {}).get("kredo_cartrust") or {}
    ct_payload = kct.get("callback_payload") or {}
    ct_json_raw = ct_payload.get("cartrust_json") if ct_payload else None
    if isinstance(ct_json_raw, str):
        try:
            import json as _json_std
            ct_data = _json_std.loads(ct_json_raw)
        except Exception:
            ct_data = None
    elif isinstance(ct_json_raw, dict):
        ct_data = ct_json_raw
    else:
        ct_data = None
    if ct_data:
        cc = ct_data.get("claim_count") or ct_data.get("accident_count")
        if cc is not None:
            lines.append(f"- Kredo CarTrust: {cc} recorded insurance/accident claim(s)")

    # Also consider VIN-history report if ordered
    for r in (sub.get("report_orders_snapshot") or []):
        if r.get("type") == "kredo_vin_history":
            data = r.get("result_data") or {}
            cc = data.get("claim_count")
            if cc is not None:
                lines.append(f"- Kredo VIN accident/claim history: {cc} claim(s) on file")

    # -- BMW factory options (Bimmervin) ---------------------------------
    bs = sub.get("bimmer_spec") or {}
    if bs:
        counts = bs.get("option_counts") or {}
        opts = bs.get("options") or []
        premium_hits = []
        opt_str_all = " ".join(str(o).lower() for o in opts) if opts else ""
        for keyword, label in [
            ("m sport", "M Sport package"),
            ("m-sport", "M Sport package"),
            ("sunroof", "Sunroof"),
            ("panorama", "Panoramic roof"),
            ("harman", "Harman/Kardon audio"),
            ("head-up", "Head-Up display"),
            ("head up", "Head-Up display"),
            ("adaptive cruise", "Adaptive cruise"),
            ("laser", "Laser headlights"),
            ("individual", "BMW Individual finish"),
        ]:
            if keyword in opt_str_all and label not in premium_hits:
                premium_hits.append(label)
        total_opts = counts.get("total") or len(opts)
        if total_opts:
            hits_str = f" — notable: {', '.join(premium_hits[:5])}" if premium_hits else ""
            lines.append(
                f"- BMW factory options (Bimmervin): {total_opts} options fitted{hits_str}"
            )

    # -- JLR OSH service history (Land Rover / Range Rover / Jaguar) -----
    losh = sub.get("landrover_osh") or {}
    services = losh.get("services") or []
    if services or losh.get("alerts"):
        recent = services[0] if services else {}
        alerts = losh.get("alerts") or []
        parts = [f"{len(services)} JLR service records on file"]
        if recent.get("service_date"):
            parts.append(f"most recent {recent['service_date']}")
        if alerts:
            parts.append(f"{len(alerts)} active alert(s)")
        lines.append(f"- JLR Online Service History: {'; '.join(parts)}")

    return "\n".join(lines) + "\n\nProvide the JSON market analysis for the South African market."


@api_router.post("/submissions/{sub_id}/market-analysis")
async def market_analysis(sub_id: str, current: dict = Depends(get_current_user)):
    sub = await db.submissions.find_one({"id": sub_id}, {"_id": 0, "photos": 0})
    if not sub:
        raise HTTPException(404, "Submission not found")
    if not await _can_access_submission(sub, current):
        raise HTTPException(403, "Not authorized")
    if not EMERGENT_LLM_KEY:
        raise HTTPException(500, "LLM key not configured")

    # Look up delivered report orders so the prompt can factor in
    # Kredo VIN history / accident data if a report was ordered.
    try:
        report_orders_list = await db.report_orders.find(
            {"submission_id": sub_id, "status": "delivered"}, {"_id": 0}
        ).to_list(50)
        sub["report_orders_snapshot"] = report_orders_list
    except Exception:
        sub["report_orders_snapshot"] = []

    system_prompt = (
        "You are a South African used-car market analyst. Your ONLY reference market is autotrader.co.za "
        "(South Africa). Do not use cars.co.za, Kredo TrueTrade, dealer trade-guides, or any other source when "
        "deriving retail — those may be listed in the dossier for context only. You reason as if you have "
        "just opened the exact AutoTrader search URL provided in the dossier (same make, same derivative "
        "keywords, same model-year run, same fuel type, same transmission, dealerrating>=3) and scanned the "
        "full result set.\n\n"
        "PRICING METHOD — follow this exactly:\n"
        "1. Scan the ENTIRE AutoTrader result set for the search. This spans the full model-year run because "
        "   the same derivative was produced across several years — you'll see cars from several years, at "
        "   different mileages, all at once.\n"
        "2. YEAR is a first-class pricing driver. Group the listings by year of production and understand the "
        "   year-band price ladder before doing anything else — a same-derivative car one year newer is "
        "   typically 8-12 %% more expensive at the same mileage; one year older, 8-12 %% cheaper. Extremes "
        "   (5+ years apart) widen further. Use your knowledge of SA depreciation curves for this specific "
        "   segment and make.\n"
        "3. Find the sub-set of listings that share THIS vehicle's exact year of production — those are the "
        "   PRIMARY comparables. If there are few or none in that year, extend one year in either direction "
        "   and adjust upward/downward using the year ladder from step 2.\n"
        "4. Within the primary-year comparables, apply mileage adjustment: listings whose mileage is within "
        "   ±25 %% of this vehicle's mileage are the closest competitors. Higher-mileage listings sit lower "
        "   in the year's distribution, lower-mileage listings sit higher — a rough SA rule is R0.70–R1.20 "
        "   per additional km beyond a same-year median, scaled by segment.\n"
        "5. Set `retail_price_estimate_zar` = the market-appropriate retail for THIS car at THIS year and "
        "   THIS mileage on AutoTrader — i.e. what the average AutoTrader dealer would list this exact car at "
        "   today, positioned correctly in its year-and-mileage cell. Round to R1 000.\n"
        "6. Compute `trade_price_estimate_zar` = round(retail * 0.85 / 1000) * 1000 — a strict 15 %% margin "
        "   below your retail estimate. This is what a Fourbuy dealer should pay.\n"
        "7. Set `estimated_market_range_zar.low` and `.high` to the 10th and 90th percentile of the "
        "   FULL AutoTrader distribution across the model-year run (not just the primary year), so the "
        "   dealer sees the wider market context; `.typical` = your retail estimate for THIS year/mileage.\n"
        "8. `recon_impact_zar` should be the reconditioning total from the dossier if present, otherwise 0. "
        "   Deduct this from retail only if the dossier indicates the car is being sold as-is; otherwise the "
        "   dealer absorbs it separately and retail is unchanged.\n\n"
        "OUTPUT — return ONLY valid JSON (no markdown, no code fences) in this exact shape:\n"
        "{\n"
        '  "estimated_market_range_zar": {"low": <int>, "high": <int>, "typical": <int>},\n'
        '  "trade_price_estimate_zar": <int>,   // retail * 0.85, rounded to R1 000\n'
        '  "retail_price_estimate_zar": <int>,\n'
        '  "year_positioning": "<1-2 sentences on how this vehicle\'s year of production sits inside the model-year run\'s AutoTrader price ladder — e.g. \'2020 examples list around R780k, our 2018 is 2 years older and typically 18 %% lower which lands it near R640k before mileage\'>",\n'
        '  "mileage_positioning": "<1-2 sentences on how this vehicle\'s mileage compares to the median for its year on AutoTrader, and the rand adjustment applied>",\n'
        '  "listings_summary": "<2-3 sentences about how many similar vehicles are typically listed on autotrader.co.za for these filters and how price varies by year and mileage across the result set>",\n'
        '  "key_factors": ["<factor 1>", "<factor 2>", "<factor 3>", "<factor 4>"],\n'
        '  "margin_pct": 15,\n'
        '  "recon_impact_zar": <int>,\n'
        '  "confidence": "low|medium|high",\n'
        '  "disclaimer": "Retail benchmarked against the AutoTrader.co.za search results for the same derivative, positioned inside its year-of-production band and adjusted for mileage. Trade = retail − 15%%."\n'
        "}\n"
        "Do NOT include a `kredo_alignment` field or reference Kredo values in the answer. If the dossier "
        "contains Kredo trade/retail lines, treat them as advisory context only — they must not shift your "
        "estimate away from what AutoTrader listings support for this year and mileage."
    )
    prompt = _market_analysis_context(sub)

    try:
        chat = LlmChat(
            api_key=EMERGENT_LLM_KEY,
            session_id=f"market-{sub_id}",
            system_message=system_prompt,
        ).with_model("openai", "gpt-5.2")
        reply = await chat.send_message(UserMessage(text=prompt))
    except Exception as e:
        logger.exception("LLM market analysis failed")
        raise HTTPException(502, f"Market analysis unavailable: {e}")

    # Parse JSON reply (LLM may return with or without code fences)
    import json, re
    text = reply.strip()
    text = re.sub(r"^```(?:json)?\s*|\s*```$", "", text, flags=re.MULTILINE).strip()
    try:
        analysis = json.loads(text)
    except Exception:
        analysis = {"raw": text, "disclaimer": "Analysis returned in non-JSON format"}

    # ---- Server-side enforcement of the 15% margin ----------------------
    # GPT is instructed to compute trade = retail × 0.85, but occasionally
    # returns numbers that drift a couple of percent. Snap trade to the
    # exact 15%-below-retail rule so the number printed on the valuation
    # PDF is defensible against a hand-calculated audit by the dealer.
    try:
        retail = analysis.get("retail_price_estimate_zar")
        if isinstance(retail, (int, float)) and retail > 0:
            enforced_trade = int(round((float(retail) * 0.85) / 1000.0)) * 1000
            analysis["trade_price_estimate_zar"] = enforced_trade
            analysis["margin_pct"] = 15
    except Exception:
        # Non-fatal — keep whatever GPT returned.
        pass

    payload = {
        "analysis": analysis,
        "generated_at": now_utc(),
        "model": "gpt-5.2",
    }
    await db.submissions.update_one(
        {"id": sub_id},
        {"$set": {"market_analysis": payload, "market_analysis_at": payload["generated_at"]}},
    )
    return payload


@api_router.post("/submissions/{sub_id}/tyre-estimate")
async def tyre_estimate(sub_id: str, current: dict = Depends(get_current_user)):
    """GPT-5.2 estimates the cost of replacing all four tyres in South Africa
    for this specific vehicle + rim size combo. Admin-triggered from the
    detail view; result is cached on the submission doc."""
    sub = await db.submissions.find_one({"id": sub_id}, {"_id": 0, "photos": 0})
    if not sub:
        raise HTTPException(404, "Submission not found")
    # Only admins should be spending LLM budget on tyre estimates.
    if current["role"] != "admin":
        raise HTTPException(403, "Admin only")
    if not EMERGENT_LLM_KEY:
        raise HTTPException(500, "LLM key not configured")

    system_prompt = (
        "You are a South African automotive parts pricing expert who tracks retail "
        "tyre prices from Tiger Wheel & Tyre, Supa Quick, HiQ, Tyres & More and "
        "similar SA fitment centres. Given a vehicle's make/model/derivative/year "
        "and its wheel rim size (in inches), respond with ONLY a valid JSON object "
        "(no markdown, no explanation) in this exact shape:\n"
        "{\n"
        '  "tyre_spec": "<e.g. 225/45 R18 — the OEM tyre size for this rim>",\n'
        '  "per_tyre_range_zar": {"low": <int>, "high": <int>, "typical": <int>},\n'
        '  "set_of_four_zar": {"low": <int>, "high": <int>, "typical": <int>},\n'
        '  "fitment_and_balance_zar": <int, expected fitment+balance+alignment charge for 4 tyres at a SA workshop>,\n'
        '  "total_replacement_estimate_zar": <int, set_of_four_zar.typical + fitment_and_balance_zar>,\n'
        '  "recommended_brands": ["<brand 1>", "<brand 2>", "<brand 3>"],\n'
        '  "notes": "<1-2 sentences explaining any assumptions about wheel width, run-flat availability, or performance rating>",\n'
        '  "confidence": "low|medium|high",\n'
        '  "disclaimer": "Prices are ZAR estimates for the SA aftermarket based on general knowledge — verify at fitment centre."\n'
        "}\n"
        "Use current SA retail prices. If run-flats are OEM for this model (e.g. many BMWs), reflect that in the price. "
        "Round all Rand values to the nearest R50."
    )
    prompt = (
        "Vehicle:\n"
        f"- Make: {sub['make_name']}\n"
        f"- Model: {sub['model_name']}\n"
        f"- Derivative: {sub['derivative_name']}\n"
        f"- Year: {sub.get('year_of_production') or sub.get('year')}\n"
        # Rim size is no longer captured in the valuation form, so we ask the
        # model to fall back to the OEM factory rim size for this derivative.
        "- Rim size: unspecified — assume OEM factory size for this derivative\n"
        f"- Tyre condition rated by dealer: {sub.get('tyre_condition') or 'not rated'} / 10\n"
        "\nProvide the tyre-replacement estimate JSON for the South African market."
    )

    try:
        chat = LlmChat(
            api_key=EMERGENT_LLM_KEY,
            session_id=f"tyre-{sub_id}",
            system_message=system_prompt,
        ).with_model("openai", "gpt-5.2")
        reply = await chat.send_message(UserMessage(text=prompt))
    except Exception as e:
        logger.exception("LLM tyre estimate failed")
        raise HTTPException(502, f"Tyre estimate unavailable: {e}")

    import json, re
    text = reply.strip()
    text = re.sub(r"^```(?:json)?\s*|\s*```$", "", text, flags=re.MULTILINE).strip()
    try:
        estimate = json.loads(text)
    except Exception:
        estimate = {"raw": text, "disclaimer": "Estimate returned in non-JSON format"}

    payload = {
        "estimate": estimate,
        "rim_size": None,  # rim size no longer captured on the submission form
        "generated_at": now_utc(),
        "model": "gpt-5.2",
    }
    await db.submissions.update_one(
        {"id": sub_id},
        {"$set": {"tyre_estimate": payload, "tyre_estimate_at": payload["generated_at"]}},
    )
    return payload


# ============ Admin dealership management ============
@api_router.get("/admin/dealerships")
async def admin_list_dealerships(current: dict = Depends(require_admin)):
    """List every dealership with user + submission + billing stats."""
    dships = await db.dealerships.find({}, {"_id": 0}).sort("created_at", -1).to_list(500)
    for d in dships:
        d["user_count"] = await db.users.count_documents({"dealership_id": d["id"], "role": "dealer"})
        d["submission_count"] = await db.submissions.count_documents({"dealership_id": d["id"]})
        subs = await db.submissions.find(
            {"dealership_id": d["id"], "status": "priced"},
            {"_id": 0, "created_at": 1, "priced_at": 1, "status": 1},
        ).to_list(10000)
        billable = sum(1 for s in subs if is_billable(s))
        d["billable_count"] = billable
        d["billable_total_zar"] = round(billable * BILLING_FEE_ZAR, 2)
    return {"dealerships": dships, "fee_zar": BILLING_FEE_ZAR}


@api_router.post("/admin/dealerships")
async def admin_create_dealership(
    payload: DealershipCreate,
    current: dict = Depends(require_admin),
):
    """Create a brand-new empty dealership. The admin can then attach users
    to it via POST /api/admin/dealerships/{id}/users. Name must be unique
    (case-insensitive) to avoid accidental duplicates from the UI."""
    name = (payload.name or "").strip()
    if not name:
        raise HTTPException(400, "Dealership name is required.")
    # Case-insensitive duplicate check
    dup = await db.dealerships.find_one({"name": {"$regex": f"^{re.escape(name)}$", "$options": "i"}})
    if dup:
        raise HTTPException(409, f"A dealership named '{dup['name']}' already exists.")

    dealership_id = str(uuid.uuid4())
    doc = {
        "id": dealership_id,
        "name": name,
        "address": (payload.address or "").strip(),
        "company_reg_no": (payload.company_reg_no or None),
        "vat_no": (payload.vat_no or None),
        "active": bool(payload.active),
        "created_at": now_utc(),
        "created_by_admin_id": current["id"],
    }
    await db.dealerships.insert_one(doc)
    logger.info("Admin %s created dealership %s (%s)", current.get("email"), dealership_id, name)
    doc.pop("_id", None)
    # Return a payload consistent with the list endpoint so the client can
    # optimistically prepend the row without a re-fetch.
    doc["user_count"] = 0
    doc["submission_count"] = 0
    doc["billable_count"] = 0
    doc["billable_total_zar"] = 0.0
    return {"dealership": doc}


@api_router.get("/admin/dealerships/{dealership_id}")
async def admin_get_dealership(dealership_id: str, current: dict = Depends(require_admin)):
    d = await db.dealerships.find_one({"id": dealership_id}, {"_id": 0})
    if not d:
        raise HTTPException(404, "Dealership not found")
    users = await db.users.find(
        {"dealership_id": dealership_id},
        {"_id": 0, "password_hash": 0},
    ).sort("created_at", 1).to_list(200)
    for u in users:
        u["active"] = u.get("active", True)
    d["users"] = users
    d["submission_count"] = await db.submissions.count_documents({"dealership_id": dealership_id})
    return {"dealership": d}


@api_router.patch("/admin/dealerships/{dealership_id}")
async def admin_update_dealership(
    dealership_id: str,
    payload: DealershipUpdate,
    current: dict = Depends(require_admin),
):
    d = await db.dealerships.find_one({"id": dealership_id})
    if not d:
        raise HTTPException(404, "Dealership not found")
    updates = {k: v for k, v in payload.dict(exclude_none=True).items()}
    if not updates:
        raise HTTPException(400, "No fields to update")
    updates["updated_at"] = now_utc()
    await db.dealerships.update_one({"id": dealership_id}, {"$set": updates})
    # If the admin toggled `active`, cascade to every user in the dealership
    # so a single switch disables/enables the whole team's ability to log in.
    # We DON'T touch users that are archived — archive is a stricter, opt-in
    # state and shouldn't be reversed by a dealership toggle.
    if "active" in updates:
        await db.users.update_many(
            {"dealership_id": dealership_id, "archived_at": {"$in": [None, ""]}},
            {"$set": {"active": bool(updates["active"])}},
        )
    fresh = await db.dealerships.find_one({"id": dealership_id}, {"_id": 0})
    return {"dealership": fresh}


@api_router.post("/admin/dealerships/{dealership_id}/users")
async def admin_add_user_to_dealership(
    dealership_id: str,
    payload: AdminInviteUserRequest,
    current: dict = Depends(require_admin),
):
    """Admin adds a new user to an existing dealership."""
    d = await db.dealerships.find_one({"id": dealership_id})
    if not d:
        raise HTTPException(404, "Dealership not found")
    existing = await db.users.find_one({"email": payload.email.lower()})
    if existing:
        raise HTTPException(409, "Email already registered")

    # SA ID — 13 digits + valid date of birth + Luhn checksum.
    ok, msg = validate_sa_id(payload.sa_id_number)
    if not ok:
        raise HTTPException(400, msg)
    sa_id_clean = "".join(ch for ch in payload.sa_id_number if ch.isdigit())

    # Referred-by lookup — if the admin keyed a code from another dealer's
    # share link, look up the referrer so we can persist the link. We only
    # accept lifetime codes attached to an *active* dealer.
    referred_by_user_id: Optional[str] = None
    referred_by_code_clean: Optional[str] = None
    if payload.referred_by_code:
        code = payload.referred_by_code.strip().upper()
        if code:
            referrer = await db.users.find_one(
                {"referral_code": code, "role": "dealer"}, {"_id": 0, "id": 1}
            )
            if not referrer:
                raise HTTPException(400, f"Referral code '{code}' does not match any dealer.")
            referred_by_user_id = referrer["id"]
            referred_by_code_clean = code

    # Lifetime referral code for the new user.
    async def _code_exists(c: str) -> bool:
        return (await db.users.count_documents({"referral_code": c})) > 0

    referral_code = await allocate_unique_code(_code_exists)

    user_id = str(uuid.uuid4())
    user_doc = {
        "id": user_id,
        "email": payload.email.lower(),
        "password_hash": hash_password(payload.password),
        "role": "dealer",
        "active": payload.active,
        "archived_at": None,
        "agreement_accepted_at": None,
        "dealer_info": payload.dealer_info.dict(),
        "sa_id_number": sa_id_clean,
        "referral_code": referral_code,
        "referred_by_user_id": referred_by_user_id,
        "referred_by_code": referred_by_code_clean,
        "company_info": {
            "company_name": d.get("name") or "",
            "company_address": d.get("address") or "",
            "company_reg_no": d.get("company_reg_no"),
            "vat_no": d.get("vat_no"),
        },
        "dealership_id": dealership_id,
        "created_at": now_utc(),
        "created_by_admin_id": current["id"],
    }
    await db.users.insert_one(user_doc)
    user_doc.pop("password_hash", None)
    user_doc.pop("_id", None)
    return {"user": user_doc}


@api_router.get("/admin/dealers")
async def admin_list_dealers(
    include_archived: bool = False,
    current: dict = Depends(require_admin),
):
    query: dict = {"role": "dealer"}
    if not include_archived:
        # Hide archived dealers from the default list (they still exist in the DB).
        query["archived_at"] = None
    dealers = await db.users.find(
        query,
        {"_id": 0, "password_hash": 0},
    ).sort("created_at", -1).to_list(2000)
    for d in dealers:
        d["active"] = d.get("active", True)
        d["archived_at"] = d.get("archived_at")
        d["submission_count"] = await db.submissions.count_documents({"dealer_id": d["id"]})
        subs = await db.submissions.find(
            {"dealer_id": d["id"], "status": "priced"},
            {"_id": 0, "created_at": 1, "priced_at": 1, "status": 1},
        ).to_list(10000)
        billable = sum(1 for s in subs if is_billable(s))
        d["billable_count"] = billable
        d["billable_total_zar"] = round(billable * BILLING_FEE_ZAR, 2)
    # Enrich with the dealership doc (name + active) so the frontend can group
    # rows without needing a second call.
    ds_ids = list({d.get("dealership_id") for d in dealers if d.get("dealership_id")})
    ds_map: dict = {}
    if ds_ids:
        ds_docs = await db.dealerships.find({"id": {"$in": ds_ids}}, {"_id": 0}).to_list(len(ds_ids))
        ds_map = {ds["id"]: ds for ds in ds_docs}
    for d in dealers:
        ds = ds_map.get(d.get("dealership_id") or "")
        d["dealership"] = ds  # {id, name, active, ...} or None

    # Enrich with "referred_by" — a small subset of the referrer's user doc
    # (name + dealership) so the admin cockpit can display "Referred by …"
    # under each dealer card. Single bulk lookup keeps this O(dealers).
    rb_ids = list({d.get("referred_by_user_id") for d in dealers if d.get("referred_by_user_id")})
    rb_map: dict = {}
    if rb_ids:
        rb_docs = await db.users.find(
            {"id": {"$in": rb_ids}},
            {"_id": 0, "id": 1, "dealer_info": 1, "dealership_id": 1, "referral_code": 1},
        ).to_list(len(rb_ids))
        for u in rb_docs:
            info = u.get("dealer_info") or {}
            first = (info.get("first_name") or "").strip()
            last = (info.get("last_name") or "").strip()
            name = (first + " " + last).strip() or "a Fourbuy dealer"
            rb_dship_name = None
            if u.get("dealership_id") and u["dealership_id"] in ds_map:
                rb_dship_name = ds_map[u["dealership_id"]].get("name")
            elif u.get("dealership_id"):
                dsx = await db.dealerships.find_one({"id": u["dealership_id"]}, {"_id": 0, "name": 1})
                rb_dship_name = (dsx or {}).get("name")
            rb_map[u["id"]] = {
                "name": name,
                "dealership": rb_dship_name,
                "code": u.get("referral_code"),
            }
    for d in dealers:
        rb_id = d.get("referred_by_user_id")
        d["referred_by"] = rb_map.get(rb_id) if rb_id else None

    # Reward balances — single ledger scan so this stays O(ledger) not O(dealers·ledger).
    balances: dict[str, int] = {}
    lifetime_earned: dict[str, int] = {}
    async for e in db.reward_ledger.find(
        {}, {"_id": 0, "user_id": 1, "delta": 1, "type": 1}
    ):
        uid = e.get("user_id")
        if not uid:
            continue
        delta = int(e.get("delta") or 0)
        balances[uid] = balances.get(uid, 0) + delta
        # All-time earned counts positive earn/adjust events (bonus grants also
        # add to lifetime; admin debits do NOT reduce it — lifetime is history).
        if delta > 0 and e.get("type") in ("earn", "adjust"):
            lifetime_earned[uid] = lifetime_earned.get(uid, 0) + delta
    for d in dealers:
        d["reward_balance"] = max(0, balances.get(d["id"], 0))
        d["reward_lifetime_earned"] = lifetime_earned.get(d["id"], 0)

    return {"dealers": dealers, "fee_zar": BILLING_FEE_ZAR, "sla_hours": BILLING_SLA_HOURS}


@api_router.patch("/admin/dealers/{dealer_id}")
async def admin_edit_dealer(
    dealer_id: str,
    payload: DealerEditRequest,
    current: dict = Depends(require_admin),
):
    user = await db.users.find_one({"id": dealer_id})
    if not user or user.get("role") != "dealer":
        raise HTTPException(404, "Dealer not found")

    updates: dict = {}
    if payload.first_name is not None:
        updates["dealer_info.first_name"] = payload.first_name
    if payload.last_name is not None:
        updates["dealer_info.last_name"] = payload.last_name
    if payload.phone is not None:
        updates["dealer_info.phone"] = payload.phone
    if payload.job_title is not None:
        # Store the trimmed value, or `None` to clear the field entirely.
        updates["dealer_info.job_title"] = (payload.job_title or "").strip() or None
    if payload.email is not None:
        new_email = payload.email.lower()
        if new_email != user["email"]:
            existing = await db.users.find_one({"email": new_email, "id": {"$ne": dealer_id}})
            if existing:
                raise HTTPException(409, "Email is already registered to another user")
            updates["email"] = new_email
    if payload.company_name is not None:
        updates["company_info.company_name"] = payload.company_name
    if payload.company_address is not None:
        updates["company_info.company_address"] = payload.company_address

    if not updates:
        raise HTTPException(400, "No fields provided to update")

    await db.users.update_one({"id": dealer_id}, {"$set": updates})
    fresh = await db.users.find_one({"id": dealer_id}, {"_id": 0, "password_hash": 0})
    return {"dealer": fresh}


@api_router.post("/admin/dealers/{dealer_id}/password")
async def admin_reset_dealer_password(
    dealer_id: str,
    payload: DealerPasswordReset,
    current: dict = Depends(require_admin),
):
    user = await db.users.find_one({"id": dealer_id})
    if not user or user.get("role") != "dealer":
        raise HTTPException(404, "Dealer not found")
    await db.users.update_one(
        {"id": dealer_id},
        {"$set": {"password_hash": hash_password(payload.new_password)}},
    )
    return {"status": "password_reset"}


@api_router.post("/admin/dealers/{dealer_id}/active")
async def admin_toggle_dealer_active(
    dealer_id: str,
    payload: DealerActiveToggle,
    current: dict = Depends(require_admin),
):
    user = await db.users.find_one({"id": dealer_id})
    if not user or user.get("role") != "dealer":
        raise HTTPException(404, "Dealer not found")
    await db.users.update_one({"id": dealer_id}, {"$set": {"active": bool(payload.active)}})
    return {"active": bool(payload.active)}


@api_router.post("/admin/dealers/{dealer_id}/photos")
async def admin_upload_dealer_photos(
    dealer_id: str,
    payload: DealerPhotoUpload,
    current: dict = Depends(require_admin),
):
    """Admin uploads/updates a dealer's profile picture and/or cover photo.

    Photos are base64 data-URLs (data:image/jpeg;base64,...). Pass an empty
    string ("") to clear a photo. Omitted fields are left unchanged.
    """
    user = await db.users.find_one({"id": dealer_id})
    if not user or user.get("role") != "dealer":
        raise HTTPException(404, "Dealer not found")
    updates: dict = {}
    folder = f"fourbuy/dealers/{dealer_id}"
    if payload.profile_pic is not None:
        if not payload.profile_pic:
            updates["profile_pic"] = None
        else:
            updates["profile_pic"] = upload_image_to_cloudinary(
                payload.profile_pic, folder=folder, public_id="profile_pic",
            )
    if payload.cover_photo is not None:
        if not payload.cover_photo:
            updates["cover_photo"] = None
        else:
            updates["cover_photo"] = upload_image_to_cloudinary(
                payload.cover_photo, folder=folder, public_id="cover_photo",
            )
    if not updates:
        raise HTTPException(400, "Provide profile_pic and/or cover_photo")
    await db.users.update_one({"id": dealer_id}, {"$set": updates})
    fresh = await db.users.find_one({"id": dealer_id}, {"_id": 0, "password_hash": 0})
    return {"dealer": fresh}


@api_router.get("/admin/dealers/{dealer_id}")
async def admin_get_dealer(dealer_id: str, current: dict = Depends(require_admin)):
    user = await db.users.find_one({"id": dealer_id}, {"_id": 0, "password_hash": 0})
    if not user or user.get("role") != "dealer":
        raise HTTPException(404, "Dealer not found")
    return {"dealer": user}


@api_router.delete("/admin/dealers/{dealer_id}")
async def admin_delete_dealer(dealer_id: str, current: dict = Depends(require_admin)):
    """Hard-delete a dealer.

    Only permitted when the dealer has ZERO submissions. If any submissions
    exist, the API returns 409 and instructs the caller to use the archive
    endpoint instead — this protects historical billing records.
    """
    user = await db.users.find_one({"id": dealer_id})
    if not user:
        raise HTTPException(404, "Dealer not found")
    if user["role"] != "dealer":
        raise HTTPException(400, "Can only remove dealer accounts")
    sub_count = await db.submissions.count_documents({"dealer_id": dealer_id})
    if sub_count > 0:
        raise HTTPException(
            409,
            f"Dealer has {sub_count} submission(s). Archive them instead to preserve billing history.",
        )
    await db.users.delete_one({"id": dealer_id})
    return {"status": "deleted", "hard_delete": True}


@api_router.post("/admin/dealers/{dealer_id}/archive")
async def admin_archive_dealer(dealer_id: str, current: dict = Depends(require_admin)):
    """Soft-delete a dealer: hide from lists, block login, PRESERVE all data."""
    user = await db.users.find_one({"id": dealer_id})
    if not user or user.get("role") != "dealer":
        raise HTTPException(404, "Dealer not found")
    ts = now_utc()
    await db.users.update_one(
        {"id": dealer_id},
        {"$set": {"archived_at": ts, "active": False}},
    )
    sub_count = await db.submissions.count_documents({"dealer_id": dealer_id})
    return {"status": "archived", "archived_at": ts, "submissions_preserved": sub_count}


@api_router.post("/admin/dealers/{dealer_id}/restore")
async def admin_restore_dealer(dealer_id: str, current: dict = Depends(require_admin)):
    """Restore an archived dealer back to the active list."""
    user = await db.users.find_one({"id": dealer_id})
    if not user or user.get("role") != "dealer":
        raise HTTPException(404, "Dealer not found")
    if not user.get("archived_at"):
        raise HTTPException(400, "Dealer is not archived")
    await db.users.update_one(
        {"id": dealer_id},
        {"$set": {"archived_at": None, "active": True}},
    )
    return {"status": "restored"}


# ============ Admin billing report ============
@api_router.get("/billing/my")
async def my_billing(
    month: Optional[str] = None,
    current: dict = Depends(get_current_user),
):
    """Dealer-facing billing summary for the current dealer for a given month.

    Attribution rules (same as admin billing):
      - Submissions are billed in the month they were PRICED (priced_at).
      - VIN reports are billed in the month they were ORDERED (ordered_at).
      Cross-month scenarios: a car submitted in July but priced in August
      appears on the August invoice; a report ordered in September for a car
      priced in August appears on the September invoice.
    """
    if current.get("role") == "admin":
        # Admins should use /api/admin/billing which aggregates all dealers.
        raise HTTPException(400, "Admins should query /api/admin/billing")

    if month:
        try:
            year, mo = [int(x) for x in month.split("-", 1)]
            start = datetime(year, mo, 1, tzinfo=timezone.utc)
        except Exception:
            raise HTTPException(400, "month must be YYYY-MM")
    else:
        today = datetime.now(timezone.utc)
        start = datetime(today.year, today.month, 1, tzinfo=timezone.utc)

    if start.month == 12:
        end = datetime(start.year + 1, 1, 1, tzinfo=timezone.utc)
    else:
        end = datetime(start.year, start.month + 1, 1, tzinfo=timezone.utc)

    # Billing rolls up to the DEALERSHIP so every user of a dealership shares
    # a single monthly bill. Fall-back to the legacy per-user dealer_id for
    # the tiny handful of docs that pre-date the multi-user migration.
    dealership_id = await _get_user_dealership_id(current)
    if dealership_id:
        sub_query: dict = {"$or": [
            {"dealership_id": dealership_id, "status": "priced"},
            {"dealer_id": current["id"], "dealership_id": {"$in": [None, ""]}, "status": "priced"},
        ]}
    else:
        sub_query = {"dealer_id": current["id"], "status": "priced"}

    # Priced submissions for this dealership whose priced_at falls inside the window.
    subs = await db.submissions.find(
        sub_query,
        {"_id": 0, "id": 1, "reference": 1, "make_name": 1, "model_name": 1,
         "year": 1, "created_at": 1, "priced_at": 1, "price": 1, "status": 1,
         "submitted_by_name": 1, "submitted_by_job_title": 1},
    ).to_list(20000)

    items = []
    priced_count = 0
    billable_count = 0
    for s in subs:
        pa = parse_iso(s.get("priced_at"))
        if not pa or not (start <= pa < end):
            continue
        priced_count += 1
        billable = is_billable(s)
        if billable:
            billable_count += 1
        items.append({
            "id": s.get("id"),
            "reference": s.get("reference"),
            "vehicle": f"{s.get('year')} {s.get('make_name')} {s.get('model_name')}",
            "price": s.get("price"),
            "priced_at": s.get("priced_at"),
            "created_at": s.get("created_at"),
            "billable": billable,
        })

    # Report orders for this dealership whose ordered_at falls inside the window.
    # `report_orders` stores `dealer_id` = the ordering user's id, so we
    # look up every user in the dealership and match on that set.
    if dealership_id:
        member_ids = [u["id"] async for u in db.users.find({"dealership_id": dealership_id}, {"_id": 0, "id": 1})]
        if not member_ids:
            member_ids = [current["id"]]
        order_query: dict = {"dealer_id": {"$in": member_ids}}
    else:
        order_query = {"dealer_id": current["id"]}
    orders = await db.report_orders.find(order_query, {"_id": 0}).to_list(20000)

    report_items = []
    for r in orders:
        oa = parse_iso(r.get("ordered_at"))
        if not oa or not (start <= oa < end):
            continue
        report_items.append({
            "type": r.get("type"),
            "name": r.get("name"),
            "cost_zar": r.get("cost_zar"),
            "status": r.get("status"),
            "ordered_at": r.get("ordered_at"),
            "submission_id": r.get("submission_id"),
            "vin": r.get("vin"),
        })

    submission_amount = round(billable_count * BILLING_FEE_ZAR, 2)
    report_amount = round(sum(float(r.get("cost_zar") or 0) for r in report_items), 2)

    return {
        "month": f"{start.year:04d}-{start.month:02d}",
        "fee_zar": BILLING_FEE_ZAR,
        "sla_hours": BILLING_SLA_HOURS,
        "priced_count": priced_count,
        "billable_count": billable_count,
        "submission_amount_zar": submission_amount,
        "report_count": len(report_items),
        "report_amount_zar": report_amount,
        "amount_zar": round(submission_amount + report_amount, 2),
        "items": items,
        "report_items": report_items,
    }


@api_router.get("/admin/billing")
async def admin_billing(
    month: Optional[str] = None,   # YYYY-MM, defaults to current month
    current: dict = Depends(require_admin),
):
    """Per-DEALERSHIP billing tally for a calendar month.

    Every user of a dealership shares one bill. A submission counts as
    billable when it was PRICED within 24 hours of being submitted (SLA).
    Fee is R50 incl. VAT per billable submission. VIN report orders are
    billed separately at their catalog price.
    """
    if month:
        try:
            year, mo = [int(x) for x in month.split("-", 1)]
            start = datetime(year, mo, 1, tzinfo=timezone.utc)
        except Exception:
            raise HTTPException(400, "month must be YYYY-MM")
    else:
        today = datetime.now(timezone.utc)
        start = datetime(today.year, today.month, 1, tzinfo=timezone.utc)
    # Compute month-end boundary.
    if start.month == 12:
        end = datetime(start.year + 1, 1, 1, tzinfo=timezone.utc)
    else:
        end = datetime(start.year, start.month + 1, 1, tzinfo=timezone.utc)

    # Pre-fetch users so we can map any submission/order back to its
    # dealership if the doc itself lacks `dealership_id` (legacy fallback).
    all_users = await db.users.find(
        {"role": "dealer"},
        {"_id": 0, "id": 1, "email": 1, "dealer_info": 1, "company_info": 1,
         "active": 1, "archived_at": 1, "dealership_id": 1},
    ).to_list(20000)
    users_by_id = {u["id"]: u for u in all_users}

    def _dealership_of(sub_or_order: dict) -> Optional[str]:
        """Return the dealership_id for a submission/order, falling back to
        the submitting user's dealership_id if the doc doesn't carry one."""
        did = sub_or_order.get("dealership_id")
        if did:
            return did
        u = users_by_id.get(sub_or_order.get("dealer_id"))
        return u.get("dealership_id") if u else None

    # 1) Priced submissions in the window
    all_subs = await db.submissions.find(
        {"status": "priced"},
        {"_id": 0, "id": 1, "dealer_id": 1, "dealership_id": 1, "reference": 1,
         "make_name": 1, "model_name": 1, "year": 1, "created_at": 1,
         "priced_at": 1, "price": 1, "status": 1,
         "submitted_by_name": 1, "submitted_by_job_title": 1,
         "submitted_by_user_id": 1},
    ).to_list(20000)
    by_group: dict = {}
    for s in all_subs:
        priced_at = parse_iso(s.get("priced_at"))
        if not priced_at or not (start <= priced_at < end):
            continue
        gid = _dealership_of(s) or f"user:{s.get('dealer_id')}"
        billable = is_billable(s)
        row = by_group.setdefault(gid, {
            "dealership_id": gid if not gid.startswith("user:") else None,
            "priced_count": 0, "billable_count": 0, "items": [],
            "reports": {"count": 0, "amount": 0.0, "items": []},
        })
        row["priced_count"] += 1
        if billable:
            row["billable_count"] += 1
        row["items"].append({
            "id": s.get("id"),
            "reference": s.get("reference"),
            "vehicle": f"{s.get('year')} {s.get('make_name')} {s.get('model_name')}",
            "price": s.get("price"),
            "priced_at": s.get("priced_at"),
            "created_at": s.get("created_at"),
            "billable": billable,
            "submitted_by_name": s.get("submitted_by_name"),
            "submitted_by_job_title": s.get("submitted_by_job_title"),
        })

    # 2) VIN report orders in the window
    all_orders = await db.report_orders.find({}, {"_id": 0}).to_list(20000)
    for r in all_orders:
        ordered_at = parse_iso(r.get("ordered_at"))
        if not ordered_at or not (start <= ordered_at < end):
            continue
        gid = _dealership_of(r) or f"user:{r.get('dealer_id')}"
        row = by_group.setdefault(gid, {
            "dealership_id": gid if not gid.startswith("user:") else None,
            "priced_count": 0, "billable_count": 0, "items": [],
            "reports": {"count": 0, "amount": 0.0, "items": []},
        })
        u = users_by_id.get(r.get("dealer_id")) or {}
        u_info = u.get("dealer_info") or {}
        row["reports"]["count"] += 1
        row["reports"]["amount"] += float(r.get("cost_zar") or 0)
        row["reports"]["items"].append({
            "type": r.get("type"),
            "name": r.get("name"),
            "cost_zar": r.get("cost_zar"),
            "status": r.get("status"),
            "ordered_at": r.get("ordered_at"),
            "submission_id": r.get("submission_id"),
            "vin": r.get("vin"),
            "ordered_by_name": (u_info.get("first_name", "") + " " + u_info.get("last_name", "")).strip() or None,
            "ordered_by_job_title": u_info.get("job_title") or None,
        })

    # 3) Look up dealership docs for naming + member counts
    real_ds_ids = [gid for gid in by_group.keys() if not gid.startswith("user:")]
    ds_docs = await db.dealerships.find(
        {"id": {"$in": real_ds_ids}}, {"_id": 0}
    ).to_list(len(real_ds_ids)) if real_ds_ids else []
    ds_by_id = {d["id"]: d for d in ds_docs}

    rows = []
    for gid, row in by_group.items():
        submission_amount = row["billable_count"] * BILLING_FEE_ZAR
        report_amount = row["reports"]["amount"]
        # Resolve display info
        if gid.startswith("user:"):
            uid = gid.split(":", 1)[1]
            u = users_by_id.get(uid) or {}
            info = u.get("dealer_info") or {}
            company = u.get("company_info") or {}
            display_name = company.get("company_name") or (
                f"{info.get('first_name','')} {info.get('last_name','')}".strip()
            ) or "(deleted dealer)"
            member_users = [{
                "id": uid, "email": u.get("email"),
                "name": f"{info.get('first_name','')} {info.get('last_name','')}".strip() or None,
                "job_title": info.get("job_title"),
                "active": u.get("active", True),
                "archived": bool(u.get("archived_at")),
            }] if u else []
            active = u.get("active", True) if u else True
            archived = bool(u.get("archived_at")) if u else False
            legacy = True
        else:
            ds = ds_by_id.get(gid, {})
            display_name = ds.get("name") or "(deleted dealership)"
            members = [u for u in all_users if u.get("dealership_id") == gid]
            member_users = [{
                "id": m["id"], "email": m.get("email"),
                "name": ((m.get("dealer_info") or {}).get("first_name", "") + " " + (m.get("dealer_info") or {}).get("last_name", "")).strip() or None,
                "job_title": (m.get("dealer_info") or {}).get("job_title"),
                "active": m.get("active", True),
                "archived": bool(m.get("archived_at")),
            } for m in members]
            active = ds.get("active", True)
            archived = False
            legacy = False
        rows.append({
            "dealership_id": row["dealership_id"],
            "dealership_name": display_name,
            "company_name": display_name,          # backwards-compat alias for the UI
            "user_count": len(member_users),
            "users": member_users,
            "priced_count": row["priced_count"],
            "billable_count": row["billable_count"],
            "items": row["items"],
            "submission_amount_zar": round(submission_amount, 2),
            "report_count": row["reports"]["count"],
            "report_amount_zar": round(report_amount, 2),
            "report_items": row["reports"]["items"],
            "amount_zar": round(submission_amount + report_amount, 2),
            "active": active,
            "archived": archived,
            "legacy": legacy,
        })

    rows.sort(key=lambda r: r["amount_zar"], reverse=True)

    total_billable = sum(r["billable_count"] for r in rows)
    total_priced = sum(r["priced_count"] for r in rows)
    total_report_count = sum(r.get("report_count", 0) for r in rows)
    total_report_amount = sum(r.get("report_amount_zar", 0.0) for r in rows)
    total_submission_amount = total_billable * BILLING_FEE_ZAR
    total_zar = round(total_submission_amount + total_report_amount, 2)

    return {
        "month": f"{start.year:04d}-{start.month:02d}",
        "fee_zar": BILLING_FEE_ZAR,
        "sla_hours": BILLING_SLA_HOURS,
        "report_catalog": [
            {"type": k, "name": v["name"], "cost_zar": v["cost_zar"]}
            for k, v in REPORT_CATALOG.items()
        ],
        "rows": rows,
        "totals": {
            "priced_count": total_priced,
            "billable_count": total_billable,
            "submission_amount_zar": round(total_submission_amount, 2),
            "report_count": total_report_count,
            "report_amount_zar": round(total_report_amount, 2),
            "amount_zar": total_zar,
        },
    }


@api_router.get("/admin/stats/home-mtd")
async def admin_home_mtd_stats(current: dict = Depends(require_admin)):
    """Month-to-date roll-up for the Admin Cockpit Home screen.

    Covers the window from the 1st of the current UTC month through *now*
    and returns:
      - Evaluations priced this month (with the billable-count subset).
      - Reports ordered (count + amount, plus a per-type breakdown).
      - Cars covered by pricing agents (count + total cover value).
      - Full billing breakdown:
            * submissions  (R50 × billable submissions)
            * VIN reports  (sum of report_orders that are third-party lookups)
            * cover fees   (R10 × initial cover placements)
            * advertising  (R1 000 × active advertising placements)
    """
    now = datetime.now(timezone.utc)
    start = datetime(now.year, now.month, 1, tzinfo=timezone.utc)
    start_iso = start.isoformat()
    now_iso = now.isoformat()

    # --- 1) Evaluations (priced submissions) in the window ------------
    subs_cursor = db.submissions.find(
        {"status": "priced", "priced_at": {"$gte": start_iso}},
        {"_id": 0, "priced_at": 1, "created_at": 1, "status": 1},
    )
    priced_count = 0
    billable_count = 0
    async for s in subs_cursor:
        priced_at = parse_iso(s.get("priced_at"))
        if not priced_at or priced_at < start:
            continue
        priced_count += 1
        if is_billable(s):
            billable_count += 1
    submission_amount = billable_count * BILLING_FEE_ZAR

    # --- 2) report_orders in the window (VIN reports + cover + ads) ---
    reports_cursor = db.report_orders.find(
        {"ordered_at": {"$gte": start_iso}},
        {"_id": 0, "type": 1, "name": 1, "cost_zar": 1, "ordered_at": 1},
    )
    report_count = 0
    report_amount = 0.0
    cover_fee_count = 0
    cover_fee_amount = 0.0
    ad_count = 0
    ad_amount = 0.0
    by_type_counts: dict = {}
    by_type_amount: dict = {}
    by_type_name: dict = {}
    async for r in reports_cursor:
        t = r.get("type") or "unknown"
        amt = float(r.get("cost_zar") or 0)
        if t == "cover_offer":
            cover_fee_count += 1
            cover_fee_amount += amt
        elif t == "advertising":
            ad_count += 1
            ad_amount += amt
        else:
            report_count += 1
            report_amount += amt
            by_type_counts[t] = by_type_counts.get(t, 0) + 1
            by_type_amount[t] = by_type_amount.get(t, 0.0) + amt
            # Prefer catalog name → order-level name → raw type key
            by_type_name[t] = (
                (REPORT_CATALOG.get(t) or {}).get("name")
                or r.get("name")
                or t.replace("_", " ").title()
            )

    reports_by_type = [
        {
            "type": t,
            "name": by_type_name.get(t, t),
            "count": by_type_counts[t],
            "amount_zar": round(by_type_amount[t], 2),
        }
        for t in sorted(by_type_counts.keys(), key=lambda k: by_type_amount[k], reverse=True)
    ]

    # --- 3) Cars covered (cover_offers created in the window) ---------
    covers_cursor = db.cover_offers.find(
        {"created_at": {"$gte": start_iso}},
        {"_id": 0, "price_zar": 1, "created_at": 1},
    )
    covers_count = 0
    covers_total_zar = 0
    async for c in covers_cursor:
        covers_count += 1
        try:
            covers_total_zar += int(c.get("price_zar") or 0)
        except (TypeError, ValueError):
            continue

    # --- 4) Roll everything up ---------------------------------------
    total_billed = round(
        submission_amount + report_amount + cover_fee_amount + ad_amount, 2
    )

    return {
        "period": {
            "start": start_iso,
            "end": now_iso,
            "month": f"{start.year:04d}-{start.month:02d}",
        },
        "evaluations": {
            "priced_count": priced_count,
            "billable_count": billable_count,
        },
        "reports": {
            "count": report_count,
            "amount_zar": round(report_amount, 2),
            "by_type": reports_by_type,
        },
        "covers": {
            "count": covers_count,
            "total_zar": covers_total_zar,
        },
        "billing": {
            "submission_amount_zar": round(submission_amount, 2),
            "report_amount_zar": round(report_amount, 2),
            "cover_fee_amount_zar": round(cover_fee_amount, 2),
            "cover_fee_count": cover_fee_count,
            "advertising_amount_zar": round(ad_amount, 2),
            "advertising_count": ad_count,
            "total_zar": total_billed,
            "submission_fee_zar": BILLING_FEE_ZAR,
        },
    }



# ============ Home advertising slots ============
# Routes extracted 2026-08-09 → /app/backend/routes/ads.py.
# The router is included into `api_router` at the bottom of this
# file (search for `include_router(ads_router)`).


# ============ Fourbuy Rewards ============
class RedeemRequest(BaseModel):
    # Where the user wants the voucher emailed to. Defaults to their login email.
    desired_email: Optional[EmailStr] = None


class RedemptionActionRequest(BaseModel):
    voucher_code: Optional[str] = None
    admin_note: Optional[str] = None


class RewardGrantRequest(BaseModel):
    """Admin adjustment to a user's reward balance. Positive `points` credits
    the account, negative debits. `reason` is required and stored in the
    ledger note so bonus/goodwill adjustments remain fully auditable."""
    user_id: str
    points: int
    reason: str


@api_router.get("/rewards/me")
async def rewards_me(current: dict = Depends(get_current_user)):
    """Dealer's own rewards summary: balance, next threshold, ledger and
    redemption history."""
    if current.get("role") != "dealer":
        raise HTTPException(400, "Only dealer users have a rewards balance")
    balance = await get_user_reward_balance(current["id"])
    # Ledger — newest first, capped so we don't ship huge payloads.
    ledger = await db.reward_ledger.find(
        {"user_id": current["id"]},
        {"_id": 0},
    ).sort("at", -1).to_list(200)
    redemptions = await db.reward_redemptions.find(
        {"user_id": current["id"]},
        {"_id": 0},
    ).sort("requested_at", -1).to_list(200)
    total_earned = sum(int(e.get("delta") or 0) for e in ledger if e.get("type") in ("earn", "referral_earn"))
    total_spent = sum(abs(int(e.get("delta") or 0)) for e in ledger if e.get("type") == "spend")
    total_refunded = sum(int(e.get("delta") or 0) for e in ledger if e.get("type") == "refund")
    total_referred = sum(int(e.get("delta") or 0) for e in ledger if e.get("type") == "referral_earn")

    # Referred dealers list — every dealer who signed up via *this* user's
    # referral code. Never exposes email / phone / SA-ID; only safe display
    # fields so the referrer can see their "network" in the Rewards tab.
    referred_users_cursor = db.users.find(
        {"referred_by_user_id": current["id"], "role": "dealer"},
        {
            "_id": 0,
            "id": 1,
            "dealer_info": 1,
            "dealership_id": 1,
            "active": 1,
            "archived_at": 1,
            "created_at": 1,
        },
    ).sort("created_at", -1)
    referred_users = await referred_users_cursor.to_list(500)
    referred_dealers: list[dict] = []
    # Pre-compute per-referee points earned by the current user, in one pass.
    points_by_referee: dict[str, int] = {}
    for row in ledger:
        if row.get("type") == "referral_earn":
            rid = row.get("referral_of_user_id")
            if rid:
                points_by_referee[rid] = points_by_referee.get(rid, 0) + int(row.get("delta") or 0)
    # Batch-fetch dealership names for the referees.
    dship_ids = {u.get("dealership_id") for u in referred_users if u.get("dealership_id")}
    dship_map: dict[str, str] = {}
    if dship_ids:
        async for dship in db.dealerships.find(
            {"id": {"$in": list(dship_ids)}},
            {"_id": 0, "id": 1, "name": 1},
        ):
            dship_map[dship["id"]] = dship.get("name") or ""

    for u in referred_users:
        info = u.get("dealer_info") or {}
        first = (info.get("first_name") or "").strip()
        last = (info.get("last_name") or "").strip()
        name = (first + " " + last).strip() or "Fourbuy dealer"
        if u.get("archived_at"):
            status = "archived"
        elif u.get("active") is False:
            status = "suspended"
        else:
            status = "active"
        referred_dealers.append({
            "id": u["id"],
            "name": name,
            "dealership": dship_map.get(u.get("dealership_id") or "", None),
            "joined_at": u.get("created_at"),
            "status": status,
            "points_earned_from": int(points_by_referee.get(u["id"], 0)),
        })

    return {
        "label": REWARD_POINT_LABEL,
        "balance": balance,
        "points_per_voucher": REWARD_POINTS_PER_VOUCHER,
        "voucher_value_zar": REWARD_VOUCHER_VALUE_ZAR,
        "voucher_provider": REWARD_VOUCHER_PROVIDER,
        "can_redeem": balance >= REWARD_POINTS_PER_VOUCHER,
        "points_to_next_voucher": max(0, REWARD_POINTS_PER_VOUCHER - balance),
        "totals": {
            "earned": total_earned,
            "spent": total_spent,
            "refunded": total_refunded,
            "referred": total_referred,
        },
        "ledger": ledger,
        "redemptions": redemptions,
        "referral_code": current.get("referral_code"),
        "referred_dealers": referred_dealers,
    }


@api_router.post("/rewards/redeem")
async def rewards_redeem(payload: RedeemRequest, current: dict = Depends(get_current_user)):
    """Dealer submits a voucher redemption. Points are debited immediately
    (prevents double-redemption) — refunded if the admin later rejects."""
    if current.get("role") != "dealer":
        raise HTTPException(400, "Only dealer users can redeem")
    balance = await get_user_reward_balance(current["id"])
    if balance < REWARD_POINTS_PER_VOUCHER:
        raise HTTPException(400, f"Not enough points — you have {balance} of {REWARD_POINTS_PER_VOUCHER} required")
    desired_email = (payload.desired_email or current.get("email") or "").strip().lower()
    if not desired_email:
        raise HTTPException(400, "A delivery email is required")
    redemption_id = str(uuid.uuid4())
    info = current.get("dealer_info") or {}
    doc = {
        "id": redemption_id,
        "user_id": current["id"],
        "user_name": (f"{info.get('first_name','')} {info.get('last_name','')}".strip()) or None,
        "user_email": current.get("email"),
        "user_job_title": info.get("job_title"),
        "dealership_id": current.get("dealership_id"),
        "requested_email": desired_email,
        "points_cost": REWARD_POINTS_PER_VOUCHER,
        "voucher_value_zar": REWARD_VOUCHER_VALUE_ZAR,
        "voucher_provider": REWARD_VOUCHER_PROVIDER,
        "status": "pending",
        "voucher_code": None,
        "admin_note": None,
        "actioned_by_admin_id": None,
        "actioned_at": None,
        "requested_at": now_utc(),
    }
    await db.reward_redemptions.insert_one(doc)
    await spend_points(
        current["id"], REWARD_POINTS_PER_VOUCHER, redemption_id,
        f"Voucher redemption request → {desired_email}",
    )
    # Notify all admins so they can action promptly.
    try:
        admin_ids = [a["id"] async for a in db.users.find({"role": "admin"}, {"_id": 0, "id": 1})]
        if admin_ids:
            await send_push(
                recipients=admin_ids,
                data={
                    "title": "New Voucher Request",
                    "message": f"{doc['user_name'] or current.get('email')} redeemed for a R{REWARD_VOUCHER_VALUE_ZAR} {REWARD_VOUCHER_PROVIDER} voucher.",
                    "action_url": "/admin/rewards",
                },
            )
    except Exception as e:
        logger.warning("Reward redemption push failed (non-blocking): %s", e)
    doc.pop("_id", None)
    fresh_balance = await get_user_reward_balance(current["id"])
    return {"redemption": doc, "balance": fresh_balance}


@api_router.get("/admin/reward-redemptions")
async def admin_list_redemptions(
    status: Optional[str] = None,
    current: dict = Depends(require_admin),
):
    """Admin inbox — every voucher request across all dealerships. Filter
    by status (pending | fulfilled | rejected) or omit for all."""
    query: dict = {}
    if status:
        query["status"] = status
    docs = await db.reward_redemptions.find(query, {"_id": 0}).sort("requested_at", -1).to_list(500)
    # Enrich with the user's WhatsApp / phone number so the admin can
    # ping the fulfilled voucher straight through WhatsApp.
    uids = list({d.get("user_id") for d in docs if d.get("user_id")})
    if uids:
        users_cursor = db.users.find(
            {"id": {"$in": uids}},
            {"_id": 0, "id": 1, "dealer_info": 1},
        )
        phones: dict = {}
        async for u in users_cursor:
            info = u.get("dealer_info") or {}
            phone = (info.get("phone") or info.get("whatsapp") or "").strip()
            if phone:
                phones[u["id"]] = phone
        for d in docs:
            uid = d.get("user_id")
            if uid and uid in phones:
                d["user_phone"] = phones[uid]
    pending = sum(1 for d in docs if d.get("status") == "pending")
    return {
        "redemptions": docs,
        "pending_count": pending,
        "voucher_value_zar": REWARD_VOUCHER_VALUE_ZAR,
        "voucher_provider": REWARD_VOUCHER_PROVIDER,
    }


@api_router.post("/admin/reward-redemptions/{redemption_id}/fulfill")
async def admin_fulfill_redemption(
    redemption_id: str,
    payload: RedemptionActionRequest,
    current: dict = Depends(require_admin),
):
    r = await db.reward_redemptions.find_one({"id": redemption_id})
    if not r:
        raise HTTPException(404, "Redemption not found")
    if r.get("status") != "pending":
        raise HTTPException(400, f"Cannot fulfil a {r.get('status')} redemption")
    code = (payload.voucher_code or "").strip()
    if not code:
        raise HTTPException(400, "voucher_code is required")
    await db.reward_redemptions.update_one(
        {"id": redemption_id},
        {"$set": {
            "status": "fulfilled",
            "voucher_code": code,
            "admin_note": (payload.admin_note or "").strip() or None,
            "actioned_by_admin_id": current["id"],
            "actioned_at": now_utc(),
        }},
    )
    # Also log to the ledger for full auditability (no delta — informational).
    await db.reward_ledger.insert_one({
        "id": str(uuid.uuid4()),
        "user_id": r["user_id"],
        "type": "fulfill",
        "delta": 0,
        "redemption_id": redemption_id,
        "note": f"Voucher issued · code {code[:4]}…",
        "at": now_utc(),
    })
    try:
        await send_push(
            recipients=[r["user_id"]],
            data={
                "title": "Voucher Ready",
                "message": f"Your R{r.get('voucher_value_zar')} {r.get('voucher_provider')} voucher code is on the way.",
                "action_url": "/rewards",
            },
        )
    except Exception as e:
        logger.warning("Fulfill push failed (non-blocking): %s", e)
    fresh = await db.reward_redemptions.find_one({"id": redemption_id}, {"_id": 0})
    return {"redemption": fresh}


@api_router.post("/admin/reward-redemptions/{redemption_id}/reject")
async def admin_reject_redemption(
    redemption_id: str,
    payload: RedemptionActionRequest,
    current: dict = Depends(require_admin),
):
    r = await db.reward_redemptions.find_one({"id": redemption_id})
    if not r:
        raise HTTPException(404, "Redemption not found")
    if r.get("status") != "pending":
        raise HTTPException(400, f"Cannot reject a {r.get('status')} redemption")
    reason = (payload.admin_note or "").strip() or "Rejected by admin"
    await db.reward_redemptions.update_one(
        {"id": redemption_id},
        {"$set": {
            "status": "rejected",
            "admin_note": reason,
            "actioned_by_admin_id": current["id"],
            "actioned_at": now_utc(),
        }},
    )
    await refund_points(
        r["user_id"], r.get("points_cost") or REWARD_POINTS_PER_VOUCHER, redemption_id,
        f"Refund · {reason}",
    )
    try:
        await send_push(
            recipients=[r["user_id"]],
            data={
                "title": "Voucher Request Rejected",
                "message": f"Your points have been refunded. Reason: {reason}",
                "action_url": "/rewards",
            },
        )
    except Exception as e:
        logger.warning("Reject push failed (non-blocking): %s", e)
    fresh = await db.reward_redemptions.find_one({"id": redemption_id}, {"_id": 0})
    return {"redemption": fresh}


@api_router.get("/admin/rewards/leaderboard")
async def admin_rewards_leaderboard(
    limit: int = 20,
    current: dict = Depends(require_admin),
):
    """Rewards leaderboard.

    Returns two sorted lists:
      * `current` — current balance (net available points per user), descending.
      * `all_time` — lifetime points ever earned (excludes admin debits so
        prior earnings are preserved as history), descending.

    Only users who have ever been in the ledger are returned so we don't
    ship a huge zero-row payload.
    """
    limit = max(1, min(int(limit or 20), 100))

    balances: dict[str, int] = {}
    lifetime: dict[str, int] = {}
    async for e in db.reward_ledger.find(
        {}, {"_id": 0, "user_id": 1, "delta": 1, "type": 1}
    ):
        uid = e.get("user_id")
        if not uid:
            continue
        delta = int(e.get("delta") or 0)
        balances[uid] = balances.get(uid, 0) + delta
        if delta > 0 and e.get("type") in ("earn", "adjust"):
            lifetime[uid] = lifetime.get(uid, 0) + delta

    uids = list({*balances.keys(), *lifetime.keys()})
    if not uids:
        return {"current": [], "all_time": [], "points_per_voucher": REWARD_POINTS_PER_VOUCHER}

    users = await db.users.find(
        {"id": {"$in": uids}, "role": "dealer"},
        {"_id": 0, "password_hash": 0},
    ).to_list(len(uids))
    dealership_ids = list({u.get("dealership_id") for u in users if u.get("dealership_id")})
    dealership_docs = await db.dealerships.find(
        {"id": {"$in": dealership_ids}}, {"_id": 0, "id": 1, "name": 1}
    ).to_list(len(dealership_ids)) if dealership_ids else []
    d_by_id = {d["id"]: d for d in dealership_docs}

    def _shape(u: dict) -> dict:
        info = u.get("dealer_info") or {}
        first = info.get("first_name") or ""
        last = info.get("last_name") or ""
        name = f"{first} {last}".strip() or (u.get("email") or "")
        d = d_by_id.get(u.get("dealership_id") or "")
        return {
            "id": u["id"],
            "email": u.get("email"),
            "name": name,
            "job_title": info.get("job_title"),
            "dealership_id": u.get("dealership_id"),
            "dealership_name": (d or {}).get("name"),
            "balance": max(0, balances.get(u["id"], 0)),
            "lifetime_earned": lifetime.get(u["id"], 0),
        }

    shaped = [_shape(u) for u in users]

    current_sorted = sorted(shaped, key=lambda x: x["balance"], reverse=True)[:limit]
    all_time_sorted = sorted(shaped, key=lambda x: x["lifetime_earned"], reverse=True)[:limit]

    # Rank + trim zeroes off the tail so the board doesn't fill with empty rows.
    def _rank(rows: list[dict], key: str) -> list[dict]:
        out = []
        rank = 0
        prev_val: Optional[int] = None
        for i, r in enumerate(rows, start=1):
            val = r[key]
            if val <= 0:
                continue
            if val != prev_val:
                rank = i
                prev_val = val
            out.append({**r, "rank": rank})
        return out

    return {
        "current": _rank(current_sorted, "balance"),
        "all_time": _rank(all_time_sorted, "lifetime_earned"),
        "points_per_voucher": REWARD_POINTS_PER_VOUCHER,
    }


@api_router.get("/admin/rewards/users")
async def admin_list_reward_users(current: dict = Depends(require_admin)):
    """List all dealer users with their current reward balance. Powers the
    admin "grant bonus points" picker."""
    users = await db.users.find(
        {"role": "dealer"},
        {"_id": 0, "password_hash": 0},
    ).to_list(1000)
    # Bulk-sum ledger deltas so we don't do N round-trips.
    balances: dict[str, int] = {}
    async for e in db.reward_ledger.find({}, {"_id": 0, "user_id": 1, "delta": 1}):
        uid = e.get("user_id")
        if not uid:
            continue
        balances[uid] = balances.get(uid, 0) + int(e.get("delta") or 0)
    dealership_ids = list({u.get("dealership_id") for u in users if u.get("dealership_id")})
    dealership_docs = await db.dealerships.find(
        {"id": {"$in": dealership_ids}}, {"_id": 0, "id": 1, "name": 1}
    ).to_list(1000) if dealership_ids else []
    d_by_id = {d["id"]: d for d in dealership_docs}
    out = []
    for u in users:
        info = u.get("dealer_info") or {}
        first = info.get("first_name") or ""
        last = info.get("last_name") or ""
        name = f"{first} {last}".strip() or (u.get("email") or "")
        d = d_by_id.get(u.get("dealership_id") or "")
        out.append({
            "id": u["id"],
            "email": u.get("email"),
            "name": name,
            "job_title": info.get("job_title"),
            "active": u.get("active", True),
            "dealership_id": u.get("dealership_id"),
            "dealership_name": (d or {}).get("name"),
            "balance": max(0, balances.get(u["id"], 0)),
        })
    out.sort(key=lambda x: (x["dealership_name"] or "", x["name"]))
    return {"users": out, "points_per_voucher": REWARD_POINTS_PER_VOUCHER}


@api_router.post("/admin/rewards/grant")
async def admin_grant_reward_points(
    payload: RewardGrantRequest,
    current: dict = Depends(require_admin),
):
    """Admin credit / debit of a dealer's reward balance. Positive `points`
    adds a bonus, negative removes. Everything is written to the ledger with
    the admin's identity and reason so this stays fully auditable."""
    reason = (payload.reason or "").strip()
    if not reason:
        raise HTTPException(400, "reason is required")
    if payload.points == 0:
        raise HTTPException(400, "points must be non-zero")
    target = await db.users.find_one(
        {"id": payload.user_id}, {"_id": 0, "password_hash": 0}
    )
    if not target:
        raise HTTPException(404, "User not found")
    if target.get("role") != "dealer":
        raise HTTPException(400, "Bonus points can only be granted to dealer users")

    # If it's a debit, guard against sending the balance below zero.
    delta = int(payload.points)
    if delta < 0:
        current_balance = await get_user_reward_balance(payload.user_id)
        if current_balance + delta < 0:
            raise HTTPException(
                400,
                f"Cannot debit {abs(delta)} pts — user only has {current_balance} pt(s)",
            )

    doc = {
        "id": str(uuid.uuid4()),
        "user_id": payload.user_id,
        "dealership_id": target.get("dealership_id"),
        "type": "adjust",
        "delta": delta,
        "note": f"Admin adjustment · {reason}",
        "granted_by_admin_id": current["id"],
        "granted_by_admin_email": current.get("email"),
        "at": now_utc(),
    }
    await db.reward_ledger.insert_one(doc)
    fresh_balance = await get_user_reward_balance(payload.user_id)
    return {
        "user_id": payload.user_id,
        "delta": delta,
        "balance": fresh_balance,
        "reason": reason,
    }


# ============ Health ============
# ============ Kredo (Vehicle Values) ============
# Server-side proxy to Kredo. All secrets stay in backend/.env — the client
# only calls our own /api/kredo/* endpoints. See services/kredo_client.py.
from services.kredo_client import get_kredo_client, KredoAPIError  # noqa: E402
from services.sa_id import validate_sa_id  # noqa: E402
from services.referral import allocate_unique_code  # noqa: E402


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


@api_router.get("/kredo/makes")
async def kredo_makes(current: dict = Depends(get_current_user)):
    """Return the list of vehicle makes Kredo supports."""
    _ = current
    try:
        raw = await get_kredo_client().makes()
    except KredoAPIError as e:
        raise _kredo_502(e) from e
    return {"makes": raw.get("data") or [], "source": "kredo"}


@api_router.get("/kredo/models")
async def kredo_models(make: str, current: dict = Depends(get_current_user)):
    if not make:
        raise HTTPException(400, "make is required")
    try:
        raw = await get_kredo_client().models(make)
    except KredoAPIError as e:
        raise _kredo_502(e) from e
    return {"models": raw.get("data") or [], "make": make, "source": "kredo"}


@api_router.get("/kredo/years")
async def kredo_years(make: str, model: str, current: dict = Depends(get_current_user)):
    if not (make and model):
        raise HTTPException(400, "make and model are required")
    try:
        raw = await get_kredo_client().years(make, model)
    except KredoAPIError as e:
        raise _kredo_502(e) from e
    return {"years": raw.get("data") or [], "make": make, "model": model, "source": "kredo"}


@api_router.get("/kredo/derivatives")
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


@api_router.post("/kredo/value")
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


@api_router.post("/kredo/vin-history")
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


@api_router.post("/kredo/cartrust/order")
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


@api_router.get("/kredo/cartrust/status/{submission_id}")
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


@api_router.post("/kredo/cartrust/callback")
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


@api_router.get("/kredo/cartrust/pdf/{submission_id}")
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


# ============ Cover Offers (Pricing Agents) ============
# A pricing-agent is a special dealer who can price other dealers'
# submissions. Their offers ("covers") are binding-subject-to-inspection,
# billed R10 per cover placed. The Fourbuy admin Offer / admin_pricing
# are stripped from what they see so they price without anchoring.

COVER_OFFER_COST_ZAR = 10.0


def _sanitise_sub_for_pricing_agent(sub: dict) -> dict:
    """Return a copy of the submission dict with fields hidden that a
    pricing agent must NOT see: the Fourbuy admin Offer, admin_pricing,
    and any other Fourbuy-side price signals. Everything else (photos,
    condition, recon, warranty, VIN reports, AI market analysis,
    AutoTrader deep link, service history etc.) stays visible.
    """
    hidden = {"admin_pricing", "offer_to_dealer_zar", "fourbuy_offer_zar",
              "admin_notes", "admin_price_zar",
              # Dealer's private deal-tracking info — cost, sale, profit —
              # must never be visible to pricing agents.
              "deal"}
    return {k: v for k, v in sub.items() if k not in hidden}


@api_router.patch("/admin/users/{user_id}/pricing-agent")
async def admin_toggle_pricing_agent(
    user_id: str,
    payload: dict,
    current: dict = Depends(require_admin),
):
    """Admin-only toggle for a user's `is_pricing_agent` flag."""
    enabled = bool(payload.get("enabled"))
    result = await db.users.update_one(
        {"id": user_id, "role": "dealer"},
        {"$set": {"is_pricing_agent": enabled}},
    )
    if result.matched_count == 0:
        raise HTTPException(404, "Dealer user not found")
    return {"ok": True, "user_id": user_id, "is_pricing_agent": enabled}


async def require_pricing_agent(current: dict = Depends(get_current_user)) -> dict:
    if not current.get("is_pricing_agent"):
        raise HTTPException(403, "This action is available to pricing agents only.")
    return current


@api_router.get("/cover/declined-submissions")
async def list_declined_cover_submissions(
    current: dict = Depends(require_pricing_agent),
):
    """Pricing-agent-only. Returns the full vehicle payload for every
    submission this agent has previously swiped-to-decline. Used to
    power the "Declined" silo on the Give Cover screen so an agent can
    retrieve a declined lead later and place a cover on it after all.

    Rows are:
      - Sorted newest-declined first
      - Filtered to only include submissions that are still live
        (status in {pending, priced}) — a decline on an archived sub is
        auto-hidden here because it can never be actioned again
      - Excluded when the agent has since covered them (shouldn't happen
        because the list endpoint auto-clears the decline, but we belt-
        and-braces filter here too)
    """
    my_dealership = current.get("dealership_id")
    declines = await db.cover_declines.find(
        {"agent_user_id": current["id"]},
        {"_id": 0, "submission_id": 1, "declined_at": 1},
    ).sort("declined_at", -1).to_list(2000)
    if not declines:
        return {"submissions": []}

    sub_ids = [d["submission_id"] for d in declines if d.get("submission_id")]
    declined_at_by_id = {d["submission_id"]: d.get("declined_at") for d in declines}

    subs = await db.submissions.find(
        {
            "id": {"$in": sub_ids},
            "status": {"$in": ["pending", "priced"]},
            "dealership_id": {"$ne": my_dealership},
        },
        {
            "_id": 0, "id": 1, "reference": 1, "make_name": 1, "model_name": 1,
            "derivative_name": 1, "year_of_production": 1, "year_registered": 1,
            "mileage": 1, "status": 1, "photos": 1, "vin": 1, "colour": 1,
            "fuel_type": 1, "transmission": 1, "created_at": 1,
        },
    ).to_list(2000)

    # Exclude subs the agent has now covered (edge case — the auto-clear
    # in list_cover_submissions would normally have already removed the
    # decline record).
    my_covers = await db.cover_offers.find(
        {"agent_user_id": current["id"], "submission_id": {"$in": [s["id"] for s in subs]}},
        {"_id": 0, "submission_id": 1},
    ).to_list(2000)
    covered_ids = {c["submission_id"] for c in my_covers}

    # Attach thumbnails + decline timestamps, and preserve the
    # newest-declined-first ordering.
    ordered: dict[str, dict] = {}
    for s in subs:
        if s["id"] in covered_ids:
            continue
        photos = s.get("photos")
        thumb = None
        if isinstance(photos, dict):
            for k in ("front", "driver_side", "passenger_side", "rear", "interior"):
                if photos.get(k):
                    thumb = photos[k]
                    break
            if not thumb:
                thumb = next((v for v in photos.values() if v), None)
        elif isinstance(photos, list):
            thumb = photos[0] if photos else None
        s["thumbnail"] = thumb
        s["declined_at"] = declined_at_by_id.get(s["id"])
        ordered[s["id"]] = s

    out = [ordered[sid] for sid in sub_ids if sid in ordered]
    return {"submissions": out}


@api_router.get("/cover/submissions")
async def list_cover_submissions(current: dict = Depends(require_pricing_agent)):
    """List submissions available for a pricing agent to price.

    Rules: status in {pending, priced}, not a draft, and NOT owned by
    this agent's dealership (they can't cover their own stock). Any
    submissions this agent has explicitly declined (via swipe-to-decline)
    are also hidden — unless they've placed a cover on it since (in
    which case the decline is auto-cleared server-side).
    """
    my_dealership = current.get("dealership_id")
    # Load the set of submission ids this agent has declined. We keep
    # this in a dedicated collection so undecline / audit is trivial.
    declined_docs = await db.cover_declines.find(
        {"agent_user_id": current["id"]},
        {"_id": 0, "submission_id": 1},
    ).to_list(5000)
    declined_ids = {d["submission_id"] for d in declined_docs if d.get("submission_id")}
    cursor = db.submissions.find(
        {
            "status": {"$in": ["pending", "priced"]},
            "dealership_id": {"$ne": my_dealership},
        },
        {
            "_id": 0, "id": 1, "reference": 1, "make_name": 1, "model_name": 1,
            "derivative_name": 1, "year_of_production": 1, "year_registered": 1,
            "mileage": 1, "status": 1, "photos": 1, "vin": 1, "colour": 1,
            "fuel_type": 1, "transmission": 1, "created_at": 1,
        },
    ).sort("created_at", -1)
    subs = await cursor.to_list(500)
    # Attach my own cover for each (if any) — so the UI can flip the
    # button to "Cover placed · R<amount>".
    my_covers = await db.cover_offers.find(
        {"agent_user_id": current["id"]},
        {"_id": 0, "submission_id": 1, "price_zar": 1, "created_at": 1},
    ).to_list(1000)
    covers_by_sub = {c["submission_id"]: c for c in my_covers}
    filtered: list = []
    for s in subs:
        sid = s["id"]
        c = covers_by_sub.get(sid)
        s["my_cover"] = c if c else None
        # If the agent has already declined this sub, hide it — UNLESS
        # they have subsequently placed a cover (edge case: they
        # declined, then reopened the deep-link and gave cover). In
        # that case honour the cover and clear the decline.
        if sid in declined_ids and not c:
            continue
        if sid in declined_ids and c:
            # Best-effort auto-cleanup; ignore failure.
            try:
                await db.cover_declines.delete_one({"agent_user_id": current["id"], "submission_id": sid})
            except Exception:
                pass
        # Derive a single "thumbnail" URL from whichever photo role is
        # present first — the frontend list card renders this. `photos`
        # in Fourbuy submissions is a dict keyed by role
        # (front / driver_side / passenger_side / rear / interior) so
        # we can't just do `photos[0]`.
        photos = s.get("photos")
        thumb = None
        if isinstance(photos, dict):
            for k in ("front", "driver_side", "passenger_side", "rear", "interior"):
                if photos.get(k):
                    thumb = photos[k]
                    break
            if not thumb:
                # Fallback: first non-empty value.
                thumb = next((v for v in photos.values() if v), None)
        elif isinstance(photos, list):
            thumb = photos[0] if photos else None
        s["thumbnail"] = thumb
        filtered.append(s)
    return {"submissions": filtered}


@api_router.post("/cover/submissions/{sub_id}/decline")
async def decline_cover_submission(
    sub_id: str, current: dict = Depends(require_pricing_agent)
):
    """Pricing agent swipes-to-decline a submission → it no longer
    appears in their `available to cover` list. This is a personal
    filter — the submission remains fully available to every other
    pricing agent. Placing a cover later automatically clears the
    decline (see list_cover_submissions above)."""
    sub = await db.submissions.find_one({"id": sub_id}, {"_id": 0, "id": 1, "dealership_id": 1, "status": 1})
    if not sub:
        raise HTTPException(404, "Submission not found")
    if sub.get("dealership_id") == current.get("dealership_id"):
        raise HTTPException(403, "You cannot decline your own stock.")
    await db.cover_declines.update_one(
        {"agent_user_id": current["id"], "submission_id": sub_id},
        {"$set": {
            "agent_user_id": current["id"],
            "submission_id": sub_id,
            "declined_at": datetime.now(timezone.utc).isoformat(),
        }},
        upsert=True,
    )
    return {"status": "declined"}


@api_router.delete("/cover/submissions/{sub_id}/decline")
async def undo_decline_cover_submission(
    sub_id: str, current: dict = Depends(require_pricing_agent)
):
    """Undo a decline (used by the client-side "Undo" toast after a
    swipe). Safe no-op if the decline was never persisted."""
    await db.cover_declines.delete_one(
        {"agent_user_id": current["id"], "submission_id": sub_id}
    )
    return {"status": "restored"}


@api_router.get("/cover/submissions/{sub_id}")
async def get_cover_submission(sub_id: str, current: dict = Depends(require_pricing_agent)):
    sub = await db.submissions.find_one({"id": sub_id}, {"_id": 0})
    if not sub:
        raise HTTPException(404, "Submission not found")
    if sub.get("dealership_id") == current.get("dealership_id"):
        raise HTTPException(403, "You cannot cover your own stock.")
    if sub.get("status") == "draft":
        raise HTTPException(404, "Draft submissions cannot be covered.")
    # Load its report_orders — pricing agents see the reports the owning
    # dealer ordered (JLR OSH, BMW options, Kredo accident, CarTrust).
    reports = await db.report_orders.find(
        {"submission_id": sub_id}, {"_id": 0}
    ).to_list(50)
    my_cover = await db.cover_offers.find_one(
        {"submission_id": sub_id, "agent_user_id": current["id"]},
        {"_id": 0},
    )
    return {
        "submission": _sanitise_sub_for_pricing_agent(sub),
        "report_orders": reports,
        "my_cover": my_cover,
        "cover_cost_zar": COVER_OFFER_COST_ZAR,
    }


@api_router.post("/submissions/{sub_id}/covers")
async def place_cover_offer(
    sub_id: str,
    payload: dict,
    current: dict = Depends(require_pricing_agent),
):
    """Place OR update a binding cover offer.

    Each call bills R10 to the agent's dealership on their next invoice —
    including updates to an existing cover (the update is treated as a
    fresh binding cover attempt with its own R10 charge). Previous prices
    are pushed onto the offer's `history[]` for full auditability.
    """
    try:
        price = int(payload.get("price_zar") or 0)
    except (TypeError, ValueError):
        raise HTTPException(400, "Invalid price_zar")
    if price <= 0:
        raise HTTPException(400, "price_zar must be a positive integer")
    sub = await db.submissions.find_one({"id": sub_id}, {"_id": 0})
    if not sub:
        raise HTTPException(404, "Submission not found")
    if sub.get("dealership_id") == current.get("dealership_id"):
        raise HTTPException(403, "You cannot cover your own stock.")
    if sub.get("status") == "draft":
        raise HTTPException(400, "This submission is a draft.")
    now = datetime.now(timezone.utc)
    now_iso = now.isoformat()
    note = (payload.get("note") or "").strip() or None
    existing = await db.cover_offers.find_one(
        {"submission_id": sub_id, "agent_user_id": current["id"]}
    )
    if existing:
        # UPDATE path — push previous price to history, replace price/note.
        # Updates are NOT billed — only the initial cover placement is
        # billed. Cover remains binding subject to inspection.
        prev_history = existing.get("history") or []
        prev_history.append({
            "price_zar": existing.get("price_zar"),
            "note": existing.get("note"),
            "at": existing.get("updated_at") or existing.get("created_at"),
        })
        await db.cover_offers.update_one(
            {"id": existing["id"]},
            {"$set": {
                "price_zar": price,
                "note": note,
                "updated_at": now_iso,
                "history": prev_history,
            }},
        )
        cover_id = existing["id"]
        # No R10 bill for updates — return early with the fresh cover doc.
        fresh = await db.cover_offers.find_one({"id": cover_id}, {"_id": 0})
        return {"ok": True, "cover": fresh, "billed_zar": 0}
    else:
        # First-time cover.
        cover_id = str(uuid.uuid4())
        offer = {
            "id": cover_id,
            "submission_id": sub_id,
            "agent_user_id": current["id"],
            "agent_dealership_id": current.get("dealership_id"),
            "price_zar": price,
            "note": note,
            "status": "active",
            "created_at": now_iso,
            "updated_at": now_iso,
            "history": [],
            "binding_caveat": (
                "Cover is binding subject to physical inspection of the vehicle "
                "and confirmation that all details in the submission (mileage, "
                "condition, service history, accident/claim status, warranty and "
                "reconditioning) are accurate."
            ),
        }
        await db.cover_offers.insert_one(offer)
        billing_note = f"Cover of R{price:,} placed on submission {sub.get('reference')}."
    # Bill R10 to the pricing-agent — ONLY on the first-time cover
    # placement (updates skip this via the early return above).
    await db.report_orders.insert_one({
        "id": str(uuid.uuid4()),
        "submission_id": sub_id,
        "dealer_id": current.get("id"),  # matches billing member_ids lookup
        "type": "cover_offer",
        "name": f"Cover Offer · {sub.get('reference') or sub_id[:8]}",
        "cost_zar": COVER_OFFER_COST_ZAR,
        "status": "delivered",
        "ordered_at": now_iso,
        "ordered_by": current["id"],
        "delivered_at": now_iso,
        "note": billing_note,
        "cover_offer_id": cover_id,
    })
    # Return the fresh cover doc so the UI can refresh without re-fetching.
    fresh = await db.cover_offers.find_one({"id": cover_id}, {"_id": 0})
    return {"ok": True, "cover": fresh, "billed_zar": COVER_OFFER_COST_ZAR}


@api_router.get("/submissions/{sub_id}/covers")
async def list_covers_for_submission(sub_id: str, current: dict = Depends(get_current_user)):
    """List covers on a submission. Visible to (a) the submission owner's
    dealership, (b) admins, (c) the pricing agent who placed each cover.
    Not visible to other pricing agents to prevent price scanning.
    """
    sub = await db.submissions.find_one({"id": sub_id}, {"_id": 0, "dealership_id": 1})
    if not sub:
        raise HTTPException(404, "Submission not found")
    is_admin = current.get("role") == "admin"
    is_owner = sub.get("dealership_id") and sub["dealership_id"] == current.get("dealership_id")
    if not (is_admin or is_owner):
        # Pricing agent: only their own cover on this sub.
        if current.get("is_pricing_agent"):
            own = await db.cover_offers.find_one(
                {"submission_id": sub_id, "agent_user_id": current["id"]},
                {"_id": 0},
            )
            return {"covers": [own] if own else []}
        raise HTTPException(403, "Not authorised.")
    covers = await db.cover_offers.find(
        {"submission_id": sub_id}, {"_id": 0},
    ).sort("price_zar", -1).to_list(100)
    # Enrich with agent name + WhatsApp phone from the user record.
    agent_ids = list({c["agent_user_id"] for c in covers})
    agents = {}
    if agent_ids:
        async for u in db.users.find(
            {"id": {"$in": agent_ids}},
            {
                "_id": 0,
                "id": 1,
                "dealer_info": 1,
                "dealership_id": 1,
                # `profile_pic` lives at the top-level of the user
                # document (Cloudinary URL, populated via the profile
                # editor). Older code looked for `dealer_info.
                # profile_photo` which was never populated — that's why
                # cover rows rendered the fallback initial disc even
                # when the agent had uploaded a proper avatar.
                "profile_pic": 1,
            },
        ):
            info = u.get("dealer_info") or {}
            agents[u["id"]] = {
                "name": (
                    (info.get("first_name") or "") + " " + (info.get("last_name") or "")
                ).strip() or "Pricing agent",
                "phone": info.get("phone") or "",
                "dealership_id": u.get("dealership_id"),
                # Round profile pic rendered next to the agent's name in
                # the covers row so the receiving dealer instantly
                # recognises who placed the bind. Fall back to the
                # legacy `dealer_info.profile_photo` key just in case
                # older records still use it.
                "profile_pic": u.get("profile_pic") or info.get("profile_photo") or None,
            }
    # Attach dealership names in one batch.
    dship_ids = list({a["dealership_id"] for a in agents.values() if a.get("dealership_id")})
    dship_map: dict[str, str] = {}
    if dship_ids:
        async for d in db.dealerships.find(
            {"id": {"$in": dship_ids}}, {"_id": 0, "id": 1, "name": 1},
        ):
            dship_map[d["id"]] = d.get("name") or ""
    for c in covers:
        a = agents.get(c["agent_user_id"], {})
        c["agent_name"] = a.get("name")
        c["agent_phone"] = a.get("phone")
        c["agent_dealership_name"] = dship_map.get(a.get("dealership_id") or "")
        c["agent_profile_pic"] = a.get("profile_pic")
    return {"covers": covers}


# ============ Health (real) ============
@api_router.get("/")
async def root():
    return {"message": "Fourbuy Car Buying Co. API", "status": "ok"}


# ============ Extracted route modules ============
# Late-imported so `server.py` has finished defining `db`, auth deps,
# `parse_iso` and other shared runtime state before each route module
# reaches for them. See `/app/backend/routes/` for the split modules.
from routes.ads import router as ads_router
api_router.include_router(ads_router)


app.include_router(api_router)

app.add_middleware(
    CORSMiddleware,
    allow_credentials=True,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)


# ============ Startup seed ============
@app.on_event("startup")
async def seed_data():
    # Ensure Playwright chromium browser is installed for the JLR OSH scraper.
    # This runs as a background task so it never blocks startup — if the
    # browser is already present the check is instant, otherwise the
    # download completes before the first dealer orders a Land Rover report.
    try:
        from services.playwright_bootstrap import ensure_playwright_chromium
        asyncio.create_task(ensure_playwright_chromium())
    except Exception:
        logger.exception("Could not schedule Playwright chromium bootstrap")

    # Seed admin
    existing_admin = await db.users.find_one({"email": ADMIN_EMAIL.lower()})
    if not existing_admin:
        admin_doc = {
            "id": str(uuid.uuid4()),
            "email": ADMIN_EMAIL.lower(),
            "password_hash": hash_password(ADMIN_PASSWORD),
            "role": "admin",
            "dealer_info": {"first_name": "Fourbuy", "last_name": "Admin", "phone": ""},
            "company_info": {"company_name": "Fourbuy Car Buying Co.", "company_address": ""},
            "created_at": now_utc(),
        }
        await db.users.insert_one(admin_doc)
        logger.info(f"Seeded admin: {ADMIN_EMAIL}")

    # -------- One-off Dealership migration (2026-07) --------
    # Every legacy dealer user gets its own single-user Dealership. New signups
    # already create their own on register. This is safe to run every startup
    # because it only touches users/subs that don't yet have `dealership_id`.
    # -------- Reward ledger indexes (2026-07) --------
    # Partial unique index guards against concurrent duplicate awards for the
    # same submission (belt-and-braces on top of the app-level idempotency
    # check inside `award_reward_point_for_submission`).
    try:
        await db.reward_ledger.create_index(
            [("sub_id", 1)],
            unique=True,
            partialFilterExpression={"type": "earn", "sub_id": {"$type": "string"}},
            name="uniq_earn_sub_id",
        )
    except Exception as e:
        logger.warning("reward_ledger index create failed (non-blocking): %s", e)
    # Referral-earn idempotency — one bonus point per submission per referrer.
    try:
        await db.reward_ledger.create_index(
            [("sub_id", 1)],
            unique=True,
            partialFilterExpression={"type": "referral_earn", "sub_id": {"$type": "string"}},
            name="uniq_referral_earn_sub_id",
        )
    except Exception as e:
        logger.warning("reward_ledger referral index create failed (non-blocking): %s", e)
    # Lifetime referral codes must be unique per dealer. Sparse so
    # admins / legacy users without a code don't fight the index.
    try:
        await db.users.create_index(
            [("referral_code", 1)],
            unique=True,
            sparse=True,
            name="uniq_referral_code",
        )
    except Exception as e:
        logger.warning("users referral_code index create failed (non-blocking): %s", e)
    async for u in db.users.find({"role": "dealer", "dealership_id": {"$in": [None, ""]}}, {"_id": 0}):
        await _ensure_dealership_for_user(u)
    # Back-fill submissions that pre-date the dealership_id field.
    unmigrated = await db.submissions.count_documents({"dealership_id": {"$in": [None, ""]}})
    if unmigrated:
        logger.info("Migrating %d submissions to dealership_id …", unmigrated)
        async for s in db.submissions.find({"dealership_id": {"$in": [None, ""]}}, {"_id": 0, "id": 1, "dealer_id": 1}):
            dealer = await db.users.find_one({"id": s.get("dealer_id")}, {"_id": 0, "dealership_id": 1, "dealer_info": 1})
            if not dealer:
                # Orphaned submission — skip, admin can clean up manually
                continue
            fn = (dealer.get("dealer_info") or {}).get("first_name") or ""
            ln = (dealer.get("dealer_info") or {}).get("last_name") or ""
            jt = (dealer.get("dealer_info") or {}).get("job_title") or ""
            await db.submissions.update_one(
                {"id": s["id"]},
                {"$set": {
                    "dealership_id": dealer.get("dealership_id"),
                    "submitted_by_user_id": s.get("dealer_id"),
                    "submitted_by_name": (fn + " " + ln).strip() or None,
                    "submitted_by_job_title": jt or None,
                }},
            )

    # Seed vehicle DB if empty
    if await db.makes.count_documents({}) == 0:
        VEHICLE_DB = [
            ("Toyota", ["Hilux", "Corolla", "Fortuner", "RAV4"]),
            ("Volkswagen", ["Polo", "Golf", "Amarok", "Tiguan"]),
            ("Ford", ["Ranger", "Fiesta", "EcoSport", "Everest"]),
            ("BMW", ["3 Series", "5 Series", "X3", "X5"]),
            ("Mercedes-Benz", ["C-Class", "E-Class", "GLC", "GLE"]),
            ("Audi", ["A3", "A4", "Q3", "Q5"]),
            ("Hyundai", ["i20", "Tucson", "Creta", "Elantra"]),
            ("Kia", ["Picanto", "Rio", "Sportage", "Sorento"]),
            ("Nissan", ["Navara", "Qashqai", "X-Trail", "Almera"]),
            ("Suzuki", ["Swift", "Baleno", "Vitara", "Jimny"]),
            ("Mazda", ["CX-3", "CX-5", "Mazda3", "BT-50"]),
            ("Honda", ["Civic", "Ballade", "CR-V", "Jazz"]),
        ]
        DERIVATIVES = {
            "Hilux": ["2.4 GD-6 SR", "2.8 GD-6 Raider 4x4", "2.8 GD-6 Legend"],
            "Corolla": ["1.8 Hybrid XR", "2.0 XR", "1.2T XS"],
            "Fortuner": ["2.4 GD-6 RB", "2.8 GD-6 4x4", "2.8 GD-6 VX"],
            "RAV4": ["2.0 GX CVT", "2.5 VX AWD", "2.5 Hybrid GX-R"],
            "Polo": ["1.0 TSI Life", "1.0 TSI R-Line", "GTI"],
            "Golf": ["1.4 TSI R-Line", "GTI", "R"],
            "Amarok": ["2.0 TDI Life 4Mot", "3.0 TDI Style", "3.0 TDI PanAmericana"],
            "Tiguan": ["1.4 TSI Life", "2.0 TSI R-Line 4Mot", "R"],
            "Ranger": ["2.0 SiT XL", "2.0 BiT Wildtrak 4x4", "3.0 V6 Raptor"],
            "Fiesta": ["1.0 EcoBoost Trend", "1.5 TDCi Ambiente", "ST"],
            "EcoSport": ["1.5 TiVCT Ambiente", "1.0 EcoBoost Trend", "1.0 EcoBoost Titanium"],
            "Everest": ["2.0 SiT XLT", "2.0 BiT Sport 4WD", "3.0 V6 Platinum"],
            "3 Series": ["318i", "320i M Sport", "M3 Competition"],
            "5 Series": ["520d M Sport", "530i M Sport", "M5"],
            "X3": ["xDrive20d", "xDrive30i M Sport", "M40i"],
            "X5": ["xDrive30d", "xDrive40i M Sport", "M50i"],
            "C-Class": ["C200 Avantgarde", "C300 AMG Line", "C63 S"],
            "E-Class": ["E220d", "E300 AMG Line", "E63 S"],
            "GLC": ["GLC 220d", "GLC 300 AMG Line", "GLC 63 S"],
            "GLE": ["GLE 300d", "GLE 400d AMG Line", "GLE 63 S"],
            "A3": ["30 TFSI", "35 TFSI S line", "S3"],
            "A4": ["35 TFSI", "40 TFSI S line", "S4"],
            "Q3": ["35 TFSI", "40 TFSI S line", "RS Q3"],
            "Q5": ["40 TDI", "45 TFSI S line", "SQ5"],
            "i20": ["1.2 Motion", "1.0T Fluid", "N Line"],
            "Tucson": ["2.0 Premium", "1.6 TGDi Executive", "N Line"],
            "Creta": ["1.5 Premium", "1.5 Executive", "1.5 Diesel Executive"],
            "Elantra": ["1.6 Executive", "2.0 Elite", "N Line"],
            "Picanto": ["1.0 Start", "1.2 Style", "1.0 X-Line"],
            "Rio": ["1.2 LS", "1.4 LX", "1.0T GT-Line"],
            "Sportage": ["1.6 Ignite", "2.0 EX", "1.6T GT-Line"],
            "Sorento": ["2.2D EX", "2.2D SX AWD", "2.5T GT-Line"],
            "Navara": ["2.5 DDTi SE", "2.5 DDTi PRO-4X", "2.5 DDTi Warrior"],
            "Qashqai": ["1.2T Visia", "1.3T Acenta Plus", "1.3T Tekna"],
            "X-Trail": ["2.5 Visia", "2.5 Acenta", "2.5 Tekna 4WD"],
            "Almera": ["1.5 Acenta", "1.5 Acenta Plus"],
            "Swift": ["1.2 GA", "1.2 GL", "1.4 Sport"],
            "Baleno": ["1.4 GL", "1.4 GLX"],
            "Vitara": ["1.4T GL+", "1.4T GLX AllGrip"],
            "Jimny": ["1.5 GA", "1.5 GLX", "1.5 GLX AllGrip"],
            "CX-3": ["2.0 Active", "2.0 Dynamic", "2.0 Individual"],
            "CX-5": ["2.0 Active", "2.5 Dynamic AWD", "2.5 Individual"],
            "Mazda3": ["1.5 Active", "2.0 Dynamic", "2.0 Individual"],
            "BT-50": ["2.2 SLX", "3.0 SLE 4x4", "3.0 GT 4x4"],
            "Civic": ["1.8 Comfort", "1.5T Sport", "Type R"],
            "Ballade": ["1.5 Trend", "1.5 Elegance", "1.5 RS"],
            "CR-V": ["2.0 Comfort", "1.5T Executive", "1.5T Exclusive AWD"],
            "Jazz": ["1.5 Trend", "1.5 Elegance", "1.5 Executive"],
        }

        for make_name, models in VEHICLE_DB:
            make_id = str(uuid.uuid4())
            await db.makes.insert_one({"id": make_id, "name": make_name})
            for model_name in models:
                model_id = str(uuid.uuid4())
                await db.models.insert_one({"id": model_id, "make_id": make_id, "name": model_name})
                for deriv in DERIVATIVES.get(model_name, ["Standard"]):
                    await db.derivatives.insert_one({
                        "id": str(uuid.uuid4()),
                        "model_id": model_id,
                        "name": deriv,
                    })
        logger.info("Seeded vehicle database")

    # Seed the flat vehicle_specs collection. Prefer the Kredo flatfile
    # (`vehicle_specs_kredo.json`) when present — it's the real vehicle
    # dictionary. Fall back to the small mock seed otherwise.
    #
    # We tag every inserted row with `spec_source` so we can safely
    # replace the mock seed with the Kredo dataset at startup without
    # touching production dealer submissions.
    from pathlib import Path

    kredo_specs_path = Path(__file__).with_name("vehicle_specs_kredo.json")

    async def _reseed_from_kredo() -> None:
        import json as _json
        with open(kredo_specs_path) as f:
            rows = _json.load(f)
        # Wipe any previous seed (mock or old Kredo) so we don't leave
        # duplicate variants around when the flatfile is refreshed.
        await db.vehicle_specs.delete_many({})
        for r in rows:
            r["id"] = str(uuid.uuid4())
            r["spec_source"] = "kredo"
        # Batched insert — 22k rows in one call is fine, but chunk to keep
        # the wire payload sensible.
        BATCH = 2000
        for i in range(0, len(rows), BATCH):
            await db.vehicle_specs.insert_many(rows[i:i + BATCH])
        logger.info(f"Seeded {len(rows)} vehicle_specs rows from Kredo flatfile")

    try:
        if kredo_specs_path.exists():
            # Re-seed when:
            #  a) collection is empty, OR
            #  b) it has non-Kredo (mock) rows, OR
            #  c) it has Kredo rows but they were imported before we started
            #     preserving `mm_code` on each variant, OR
            #  d) the flatfile on disk has a materially different row count
            #     from what's in Mongo — i.e. someone re-imported the Excel
            #     with additional makes / years. We compare the row counts
            #     with a small tolerance to avoid churn on trivial diffs.
            existing_kredo = await db.vehicle_specs.count_documents({"spec_source": "kredo"})
            total = await db.vehicle_specs.count_documents({})
            needs_mm = False
            if existing_kredo:
                probe = await db.vehicle_specs.find_one(
                    {"spec_source": "kredo"}, {"mm_code": 1, "_id": 0}
                )
                if not probe or "mm_code" not in probe:
                    needs_mm = True

            # Check flatfile row-count vs seeded row-count.
            import json as _json_probe
            with open(kredo_specs_path) as _fh:
                file_row_count = len(_json_probe.load(_fh))
            row_count_stale = abs(existing_kredo - file_row_count) > max(50, int(file_row_count * 0.01))

            if total == 0 or existing_kredo == 0 or needs_mm or row_count_stale:
                if row_count_stale and not (total == 0 or existing_kredo == 0 or needs_mm):
                    logger.info(
                        "Kredo flatfile row count changed (%s → %s) — reseeding vehicle_specs.",
                        existing_kredo, file_row_count,
                    )
                await _reseed_from_kredo()
        elif await db.vehicle_specs.count_documents({}) == 0:
            from vehicle_specs_seed import expand_specs
            rows = expand_specs()
            if rows:
                for r in rows:
                    r["id"] = str(uuid.uuid4())
                    r["spec_source"] = "mock"
                await db.vehicle_specs.insert_many(rows)
                logger.info(f"Seeded {len(rows)} mock vehicle spec rows")
    except Exception as e:
        logger.warning(f"vehicle_specs seed failed: {e}")


@app.on_event("shutdown")
async def shutdown_db_client():
    await _push_client.aclose()
    client.close()
