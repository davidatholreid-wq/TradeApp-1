from fastapi import FastAPI, APIRouter, HTTPException, Depends, Header, Query
from fastapi.responses import Response
from dotenv import load_dotenv
from starlette.middleware.cors import CORSMiddleware
from motor.motor_asyncio import AsyncIOMotorClient
import os
import logging
import uuid
import bcrypt
import jwt as pyjwt
import httpx
from pathlib import Path
from pydantic import BaseModel, Field, EmailStr
from typing import List, Optional, Literal
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
    `sub_id` unique index on the ledger prevents duplicate awards."""
    if not is_billable(sub):
        return
    user_id = sub.get("submitted_by_user_id") or sub.get("dealer_id")
    if not user_id:
        return
    sub_id = sub.get("id")
    # Idempotency guard — check if an "earn" event already exists for this sub.
    existing = await db.reward_ledger.find_one({"type": "earn", "sub_id": sub_id})
    if existing:
        return
    doc = {
        "id": str(uuid.uuid4()),
        "user_id": user_id,
        "dealership_id": sub.get("dealership_id"),
        "type": "earn",
        "delta": 1,
        "sub_id": sub_id,
        "note": f"Billable valuation · {sub.get('reference') or sub_id[:8]}",
        "at": now_utc(),
    }
    try:
        await db.reward_ledger.insert_one(doc)
    except Exception as e:
        # Partial unique index (type=earn, sub_id) blocks concurrent duplicates.
        # Anything else we log and swallow — rewards must never break pricing.
        if "duplicate" not in str(e).lower():
            logger.warning("Reward award insert failed (non-blocking): %s", e)


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
class DealerInfo(BaseModel):
    first_name: str
    last_name: str
    phone: str
    id_number: Optional[str] = None
    # Job Title (e.g. "Sales Manager", "F&I", "Buyer"). Free text.
    # Optional for backwards compatibility with pre-multi-user users.
    job_title: Optional[str] = None


class CompanyInfo(BaseModel):
    company_name: str
    company_address: str
    company_reg_no: Optional[str] = None
    vat_no: Optional[str] = None


class RegisterRequest(BaseModel):
    """Public register — always creates a brand new Dealership plus the
    first user (who becomes a regular dealer user, not an owner because
    all users of a dealership are equal per product spec)."""
    email: EmailStr
    password: str
    dealer_info: DealerInfo
    company_info: CompanyInfo


class AdminInviteUserRequest(BaseModel):
    """Admin creates a new user inside an existing dealership."""
    email: EmailStr
    password: str
    dealer_info: DealerInfo
    active: bool = True


class DealershipUpdate(BaseModel):
    name: Optional[str] = None
    address: Optional[str] = None
    company_reg_no: Optional[str] = None
    vat_no: Optional[str] = None
    active: Optional[bool] = None


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
    share visibility). Falls back to the legacy `dealer_id == user.id`
    check for pre-migration submissions that don't yet carry a
    `dealership_id`."""
    if user.get("role") == "admin":
        return True
    if sub.get("dealership_id"):
        return sub["dealership_id"] == await _get_user_dealership_id(user)
    return sub.get("dealer_id") == user.get("id")


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

    # Auto-filled from the license disc scan (may be "TBC")
    colour: str
    vin: Optional[str] = "TBC"
    engine_number: Optional[str] = "TBC"
    license_disk_data: Optional[str] = None

    # Four condition pillars (1-10). We took over the old exterior/tyre
    # fields with the new mechanical/cosmetic/history pillars — interior
    # stays as-is. exterior_condition / tyre_condition are kept as optional
    # for backwards compatibility with legacy submissions.
    mechanical_condition: int = Field(ge=1, le=10)
    cosmetic_condition: int = Field(ge=1, le=10)
    interior_condition: int = Field(ge=1, le=10)
    history_condition: int = Field(ge=1, le=10)
    # Legacy (deprecated) — accepted but not required by the new mobile form.
    exterior_condition: Optional[int] = Field(default=None, ge=1, le=10)
    tyre_condition: Optional[int] = Field(default=None, ge=1, le=10)
    # Windscreen — three simple options after the flow rewrite. "Chip" and
    # "Crack" from the legacy schema are still accepted for historical
    # submissions but new submissions must use one of the new options.
    windscreen_condition: Literal[
        "Perfect", "Chip Repairs", "Needs Replacement",
        "Chip", "Crack",  # legacy
    ]

    # Service history
    service_history: Literal[
        "Full Service History with Agents",
        "Full Service History with Agents & Non-Agents",
        "Partial Service History",
        "No Service History",
    ]
    last_service_date: Optional[str] = None   # ISO date or None → "TBC"
    last_service_mileage: Optional[int] = None

    # Photos: {front, driver_side, passenger_side, rear, interior}
    photos: dict
    mileage: int

    # Damage / paint
    paint_evidence: bool
    # Optional detail selected when paint_evidence == True
    paint_quality: Optional[Literal["Excellent", "Fair", "Poor"]] = None
    accident_damage: bool
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
    type: Literal["lightstone_verification", "lightstone_repair", "car_vertical"]
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
    if user["role"] == "dealer":
        dealership_id = await _get_user_dealership_id(user)
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
        },
    }


@api_router.get("/auth/me")
async def me(current: dict = Depends(get_current_user)):
    # Include billing-related fields that the client uses to gate flows.
    current["active"] = current.get("active", True)
    # Enrich with dealership info so the client can render "Submitted by
    # …" chips and a "Team" screen without a second round-trip.
    if current.get("role") == "dealer":
        dealership_id = await _get_user_dealership_id(current)
        if dealership_id:
            current["dealership_id"] = dealership_id
            dship = await db.dealerships.find_one({"id": dealership_id}, {"_id": 0})
            if dship:
                current["dealership"] = dship
    return {"user": current}


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
):
    """Progressive filter over the seeded Disk Drive-shaped vehicle spec DB.

    Given any subset of filters, returns the DISTINCT remaining values for
    every other field. The mobile submit form uses this to eliminate options
    as the dealer moves through the wheel-picker sequence:
    Make → Fuel Type → Year → Transmission → Model → Derivative.
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

    rows = await db.vehicle_specs.find(query, {"_id": 0}).to_list(20000)

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
    # Guardrail — every 1-10 rating we actually care about.
    for rating, name in [
        (payload.mechanical_condition, "mechanical"),
        (payload.cosmetic_condition, "cosmetic"),
        (payload.interior_condition, "interior"),
        (payload.history_condition, "history"),
    ]:
        if not (1 <= rating <= 10):
            raise HTTPException(400, f"{name.title()} condition must be 1-10")
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
    # Reconditioning items may carry an optional per-line photo (base64 data
    # URL from the mobile picker). Upload each to Cloudinary and store the
    # secure URL alongside the label & amount.
    recon_folder = f"fourbuy/submissions/{sub_id}/recon"
    recon_items_uploaded: list[dict] = []
    for idx, item in enumerate(payload.reconditioning_items or []):
        clean = dict(item)
        photo_val = clean.get("photo")
        if _looks_like_base64_image(photo_val):
            clean["photo"] = upload_image_to_cloudinary(
                photo_val, folder=recon_folder, public_id=f"item_{idx}",
            )
        elif not photo_val:
            clean["photo"] = None
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
        # Identity
        "vin": payload.vin or "TBC",
        "engine_number": payload.engine_number or "TBC",
        "colour": payload.colour,
        "license_disk_data": license_disk_uploaded,
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
        # Legacy fields kept for backward compat with older views
        "factory_warranty": False,
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
    if current["role"] != "admin" and compute_bucket(sub) == "archived":
        raise HTTPException(404, "Submission not found")
    sub["bucket"] = compute_bucket(sub)
    # Attach report orders (dealer-visible list of ordered VIN reports).
    reports = await db.report_orders.find(
        {"submission_id": sub_id}, {"_id": 0}
    ).sort("ordered_at", -1).to_list(50)
    sub["report_orders"] = reports
    return {"submission": sub}


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
async def report_catalog(_: dict = Depends(get_current_user)):
    """Return the list of available VIN reports and their costs."""
    return {
        "reports": [
            {"type": k, "name": v["name"], "cost_zar": v["cost_zar"]}
            for k, v in REPORT_CATALOG.items()
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

    existing = await db.report_orders.find_one(
        {"submission_id": sub_id, "type": payload.type}
    )
    if existing:
        raise HTTPException(409, "This report has already been ordered for this submission")

    # MOCKED: real Lightstone / CarVertical APIs will replace this generator.
    # For now the report is marked delivered immediately with a realistic payload
    # so the dealer can see the shape of the final output.
    result_data = _mock_report_data(payload.type, sub)
    now_ts = now_utc()

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
        "note": "MOCK DATA — this report was generated locally while the real provider APIs are being integrated.",
        "mocked": True,
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


async def _build_valuation_pdf(sub: dict, reports: list) -> bytes:
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
        topMargin=10 * mm, bottomMargin=10 * mm,
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

    # ============ VEHICLE TITLE ============
    year = sub.get("year_registered") or sub.get("year") or sub.get("year_of_production") or ""
    title_line = " ".join(str(x) for x in [year, sub.get("make_name"), sub.get("model_name")] if x)
    subtitle_bits = [
        sub.get("derivative_name"),
        f"{int(sub.get('mileage') or 0):,} km" if sub.get("mileage") else None,
        sub.get("transmission"),
        sub.get("fuel_type"),
        sub.get("colour"),
    ]
    subtitle = " · ".join(str(x) for x in subtitle_bits if x)
    title_p = Paragraph(
        f'<font name="Helvetica-Bold" size="16" color="#111111">{title_line}</font><br/>'
        f'<font name="Helvetica" size="8" color="#6B6B6B">{subtitle}</font>' +
        (f'<br/><font name="Helvetica" size="8" color="#6B6B6B">Submitted by <b>{sub.get("submitted_by_name") or "—"}</b>'
         + (f' · {sub.get("submitted_by_job_title")}' if sub.get("submitted_by_job_title") else "")
         + (f' · {(sub.get("submitted_at") or "")[:10]}' if sub.get("submitted_at") else "")
         + '</font>' if sub.get("submitted_by_name") else ''),
        ParagraphStyle("title", parent=styles["Normal"], leading=19),
    )
    gen_p = Paragraph(
        f'<para align="right">'
        f'<font name="Helvetica" size="7" color="#6B6B6B">Generated<br/>{now_utc()[:19].replace("T", " ")} UTC</font>'
        f'</para>',
        ParagraphStyle("gen", parent=styles["Normal"], leading=10),
    )
    title_tbl = Table([[title_p, gen_p]], colWidths=[140 * mm, 46 * mm])
    title_tbl.setStyle(TableStyle([
        ("VALIGN", (0, 0), (-1, -1), "TOP"),
        ("LEFTPADDING", (0, 0), (-1, -1), 0),
        ("RIGHTPADDING", (0, 0), (-1, -1), 0),
        ("TOPPADDING", (0, 0), (-1, -1), 8),
        ("BOTTOMPADDING", (0, 0), (-1, -1), 4),
    ]))
    story.append(title_tbl)

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
    # LEFT column: Vehicle details + identity (VIN / engine).
    v_rows = [
        ["Make", sub.get("make_name") or "—"],
        ["Model", sub.get("model_name") or "—"],
        ["Derivative", sub.get("derivative_name") or "—"],
        ["Year Reg.", str(sub.get("year_registered") or sub.get("year") or "—")],
        ["Year Prod.", str(sub.get("year_of_production") or sub.get("year") or "—")],
        ["Mileage", f"{int(sub.get('mileage') or 0):,} km"],
        ["Transmission", sub.get("transmission") or "—"],
        ["Fuel Type", sub.get("fuel_type") or "—"],
        ["Colour", sub.get("colour") or "—"],
        ["VIN", sub.get("vin") or "—"],
        ["Engine No.", sub.get("engine_number") or "—"],
    ]
    col_w = 46 * mm  # per row: label col
    val_w = 46 * mm  # per row: value col
    t_v = Table(v_rows, colWidths=[col_w, val_w])
    ts_v = _row_style()
    # Mono for VIN + Engine (last two rows).
    ts_v.add("FONT", (1, -2), (1, -1), "Courier", 8)
    t_v.setStyle(ts_v)

    # RIGHT column: Condition assessment. Overall score inlined at the top.
    m = sub.get("mechanical_condition")
    c = sub.get("cosmetic_condition")
    i_ = sub.get("interior_condition")
    h_ = sub.get("history_condition")
    c_rows = []
    if m is not None:
        overall = round(
            (m or 0) * 0.30 + (c or 0) * 0.25 + (i_ or 0) * 0.25 + (h_ or 0) * 0.20, 1,
        )
        c_rows.append(["Overall Condition", f"{overall} / 10"])
        c_rows.extend([
            ["Mechanical (30%)", f"{m} / 10"],
            ["Cosmetic (25%)", f"{c} / 10"],
            ["Interior (25%)", f"{i_} / 10"],
            ["General (20%)", f"{h_} / 10"],
        ])
    c_rows.append(["Windscreen", sub.get("windscreen_condition") or "—"])
    c_rows.append(["Accident Damage", "Yes" if sub.get("accident_damage") else "None"])
    if sub.get("accident_damage") and sub.get("accident_damage_types"):
        c_rows.append(["Damage Types", ", ".join(sub.get("accident_damage_types") or [])])
    c_rows.append(["Paint Evidence", "Yes" if sub.get("paint_evidence") else "None"])
    if sub.get("paint_evidence") and sub.get("paint_quality"):
        c_rows.append(["Paint Quality", sub.get("paint_quality")])
    t_c = Table(c_rows, colWidths=[col_w, val_w])
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

    # ============ SERVICE + RECONDITIONING (side-by-side) ============
    srv_block = None
    if sub.get("service_history"):
        srv_rows = [
            ["History", sub.get("service_history") or "—"],
            ["Last Service", sub.get("last_service_date") if sub.get("last_service_date") and sub.get("last_service_date") != "TBC" else "TBC"],
            ["Service Mileage", f"{int(sub.get('last_service_mileage')):,} km" if sub.get("last_service_mileage") else "TBC"],
        ]
        gap = _compute_service_gap(sub)
        months = gap["months_ago"]
        km_since = gap["km_since"]
        if months is not None or km_since is not None:
            time_colour = DANGER if (months is not None and months >= 24) else (WARN if (months is not None and months >= 12) else OK)
            km_colour = DANGER if (km_since is not None and km_since >= 30000) else (WARN if (km_since is not None and km_since >= 15000) else OK)
            srv_rows.append(["Time Since", gap["label_time"]])
            srv_rows.append(["Mileage Since", gap["label_km"]])
        t_s = Table(srv_rows, colWidths=[30 * mm, 62 * mm])
        ts_s = _row_style()
        if months is not None or km_since is not None:
            time_idx = len(srv_rows) - 2
            km_idx = len(srv_rows) - 1
            ts_s.add("TEXTCOLOR", (1, time_idx), (1, time_idx), time_colour)
            ts_s.add("FONT", (1, time_idx), (1, time_idx), "Helvetica-Bold", 8)
            ts_s.add("TEXTCOLOR", (1, km_idx), (1, km_idx), km_colour)
            ts_s.add("FONT", (1, km_idx), (1, km_idx), "Helvetica-Bold", 8)
        t_s.setStyle(ts_s)
        srv_block = t_s

    recon_block = None
    recon_items = sub.get("reconditioning_items") or []
    if recon_items:
        rec_rows = [["Item", "Amount"]]
        for r in recon_items:
            rec_rows.append([r.get("label") or "—", _fmt_zar(r.get("amount_zar") or 0)])
        total = sub.get("reconditioning_total_zar") or sum((r.get("amount_zar") or 0) for r in recon_items)
        rec_rows.append(["TOTAL", _fmt_zar(total)])
        t_r = Table(rec_rows, colWidths=[62 * mm, 30 * mm])
        t_r.setStyle(TableStyle([
            ("FONT", (0, 0), (-1, 0), "Helvetica-Bold", 7),
            ("TEXTCOLOR", (0, 0), (-1, 0), MUTED),
            ("BACKGROUND", (0, 0), (-1, 0), PAPER),
            ("FONT", (0, 1), (-1, -2), "Helvetica", 8),
            ("FONT", (1, 1), (1, -1), "Courier-Bold", 8),
            ("FONT", (0, -1), (0, -1), "Helvetica-Bold", 8),
            ("FONT", (1, -1), (1, -1), "Courier-Bold", 9),
            ("TEXTCOLOR", (0, -1), (-1, -1), rl_colors.white),
            ("BACKGROUND", (0, -1), (-1, -1), BLACK),
            ("ALIGN", (1, 0), (1, -1), "RIGHT"),
            ("LINEBELOW", (0, 0), (-1, -2), 0.35, LINE),
            ("TOPPADDING", (0, 0), (-1, -1), 3),
            ("BOTTOMPADDING", (0, 0), (-1, -1), 3),
            ("LEFTPADDING", (0, 0), (-1, -1), 6),
            ("RIGHTPADDING", (0, 0), (-1, -1), 6),
            ("VALIGN", (0, 0), (-1, -1), "MIDDLE"),
        ]))
        recon_block = t_r

    if srv_block is not None or recon_block is not None:
        hdr_left = Paragraph("SERVICE HISTORY" if srv_block is not None else "", section_title)
        hdr_right = Paragraph("RECONDITIONING" if recon_block is not None else "", section_title)
        two_col2 = Table(
            [[hdr_left, hdr_right], [srv_block or Paragraph("", body), recon_block or Paragraph("", body)]],
            colWidths=[92 * mm, 92 * mm],
        )
        two_col2.setStyle(TableStyle([
            ("VALIGN", (0, 0), (-1, -1), "TOP"),
            ("LEFTPADDING", (0, 0), (-1, -1), 0),
            ("RIGHTPADDING", (0, 0), (0, -1), 4),
            ("LEFTPADDING", (1, 0), (1, -1), 4),
            ("TOPPADDING", (0, 0), (-1, -1), 0),
            ("BOTTOMPADDING", (0, 0), (-1, -1), 0),
        ]))
        story.append(Spacer(1, 4))
        story.append(two_col2)

    # ============ AI MARKET ANALYSIS ============
    ma = sub.get("market_analysis") or {}
    if ma:
        story.append(Paragraph("AI MARKET ANALYSIS", section_title))
        ma_rows = []
        est = ma.get("estimated_value") or {}
        low, high, mid = est.get("low_zar"), est.get("high_zar"), est.get("mid_zar")
        if low or high:
            ma_rows.append(["Estimated Retail Range", f"{_fmt_zar(low)} — {_fmt_zar(high)}"])
        if mid:
            ma_rows.append(["Recommended Trade Price", _fmt_zar(mid)])
        if ma.get("confidence"):
            ma_rows.append(["Confidence", (ma.get("confidence") or "—").upper()])
        if ma.get("summary"):
            ma_rows.append(["Summary", ma.get("summary")])
        if ma_rows:
            t_ma = Table(
                [[k, Paragraph(str(v), body)] for k, v in ma_rows],
                colWidths=[46 * mm, 140 * mm],
            )
            t_ma.setStyle(_row_style())
            story.append(t_ma)

    # ============ TYRE ESTIMATE ============
    tyre_wrap = sub.get("tyre_estimate") or {}
    tyre = tyre_wrap.get("estimate") if isinstance(tyre_wrap, dict) else None
    if tyre:
        story.append(Paragraph("TYRE REPLACEMENT ESTIMATE", section_title))
        tyre_rows = [
            ["Tyre Spec", tyre.get("tyre_spec") or "—"],
            ["Set of 4 Replacement", _fmt_zar(tyre.get("total_replacement_estimate_zar"))],
            ["Fitment & Balance", _fmt_zar(tyre.get("fitment_and_balance_zar"))],
            ["Confidence", (tyre.get("confidence") or "—").upper()],
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
                arrow,
                h.get("comment") or "—",
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
                r.get("name") or r.get("type"),
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

    # ============ FOOTER ============
    story.append(Spacer(1, 6))
    story.append(Paragraph(
        "This document is generated for the dealer's internal record. Offer prices are indicative and "
        "subject to a physical inspection at Fourbuy premises. Fourbuy Car Buying Co. — Quality Used Cars at Wholesale Prices.",
        small,
    ))

    doc.build(story)
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

    reports = await db.report_orders.find(
        {"submission_id": sub_id}, {"_id": 0}
    ).sort("ordered_at", 1).to_list(50)

    try:
        pdf_bytes = await _build_valuation_pdf(sub, reports)
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
@api_router.post("/submissions/{sub_id}/market-analysis")
async def market_analysis(sub_id: str, current: dict = Depends(get_current_user)):
    sub = await db.submissions.find_one({"id": sub_id}, {"_id": 0, "photos": 0})
    if not sub:
        raise HTTPException(404, "Submission not found")
    if not await _can_access_submission(sub, current):
        raise HTTPException(403, "Not authorized")
    if not EMERGENT_LLM_KEY:
        raise HTTPException(500, "LLM key not configured")

    system_prompt = (
        "You are a South African used-car market analyst with deep knowledge of pricing on autotrader.co.za "
        "and cars.co.za for the local ZAR (Rand) market. Given a specific vehicle's specs, provide a concise "
        "market overview in this exact JSON format (no markdown, only valid JSON):\n"
        "{\n"
        '  "estimated_market_range_zar": {"low": <int>, "high": <int>, "typical": <int>},\n'
        '  "trade_price_estimate_zar": <int>,\n'
        '  "retail_price_estimate_zar": <int>,\n'
        '  "listings_summary": "<2-3 sentences about how many similar vehicles are typically listed on autotrader.co.za and cars.co.za and their price patterns>",\n'
        '  "key_factors": ["<factor 1>", "<factor 2>", "<factor 3>"],\n'
        '  "confidence": "low|medium|high",\n'
        '  "disclaimer": "Prices based on general market knowledge (no live scraping)."\n'
        "}\n"
        "Consider mileage, year, condition, warranty status, and accident damage. Trade should be 15-20% below retail."
    )
    prompt = (
        f"Vehicle:\n"
        f"- Make: {sub['make_name']}\n"
        f"- Model: {sub['model_name']}\n"
        f"- Derivative: {sub['derivative_name']}\n"
        f"- Year: {sub['year']}\n"
        f"- Mileage: {sub['mileage']:,} km\n"
        f"- Colour: {sub['colour']}\n"
        f"- Condition: {sub['condition']}/10\n"
        f"- Factory warranty: {'Yes' if sub['factory_warranty'] else 'No'}\n"
        f"- Accident damage: {'Yes' if sub['accident_damage'] else 'None reported'}\n"
        f"\nProvide the JSON market analysis for the South African market."
    )

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
    user_id = str(uuid.uuid4())
    # Denormalise the dealership's company info onto the user so any legacy
    # code paths still work — the dealership doc is the source of truth
    # going forward.
    user_doc = {
        "id": user_id,
        "email": payload.email.lower(),
        "password_hash": hash_password(payload.password),
        "role": "dealer",
        "active": payload.active,
        "archived_at": None,
        "agreement_accepted_at": None,
        "dealer_info": payload.dealer_info.dict(),
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
    total_earned = sum(int(e.get("delta") or 0) for e in ledger if e.get("type") == "earn")
    total_spent = sum(abs(int(e.get("delta") or 0)) for e in ledger if e.get("type") == "spend")
    total_refunded = sum(int(e.get("delta") or 0) for e in ledger if e.get("type") == "refund")
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
        },
        "ledger": ledger,
        "redemptions": redemptions,
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
@api_router.get("/")
async def root():
    return {"message": "Fourbuy Car Buying Co. API", "status": "ok"}


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

    # Seed the flat vehicle_specs collection (Disk Drive-shaped) if empty.
    if await db.vehicle_specs.count_documents({}) == 0:
        try:
            from vehicle_specs_seed import expand_specs
            rows = expand_specs()
            if rows:
                for r in rows:
                    r["id"] = str(uuid.uuid4())
                await db.vehicle_specs.insert_many(rows)
                logger.info(f"Seeded {len(rows)} vehicle spec rows")
        except Exception as e:
            logger.warning(f"vehicle_specs seed failed: {e}")


@app.on_event("shutdown")
async def shutdown_db_client():
    await _push_client.aclose()
    client.close()
