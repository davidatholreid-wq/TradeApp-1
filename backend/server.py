from fastapi import FastAPI, APIRouter, HTTPException, Depends, Header
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


def compute_bucket(sub: dict) -> str:
    """Return 'incoming', 'priced' or 'archived' based on status + priced_at age.

    - status == 'pending'  → 'incoming'
    - status == 'priced' and priced_at within ARCHIVE_AFTER_DAYS → 'priced'
    - status == 'priced' and priced_at older than ARCHIVE_AFTER_DAYS → 'archived'
    """
    status = sub.get("status") or "pending"
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


class CompanyInfo(BaseModel):
    company_name: str
    company_address: str
    company_reg_no: Optional[str] = None
    vat_no: Optional[str] = None


class RegisterRequest(BaseModel):
    email: EmailStr
    password: str
    dealer_info: DealerInfo
    company_info: CompanyInfo


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

    # Condition ratings (1-10)
    exterior_condition: int = Field(ge=1, le=10)
    interior_condition: int = Field(ge=1, le=10)
    tyre_condition: int = Field(ge=1, le=10)
    # Windscreen — discrete options
    windscreen_condition: Literal["Perfect", "Chip", "Crack", "Needs Replacement"]

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
    accident_damage: bool

    # Reconditioning costs: list of {label: str, amount_zar: float}
    reconditioning_items: list[dict] = []

    # Compliance
    billing_accepted: bool = False


class PriceOffer(BaseModel):
    price: float
    notes: Optional[str] = None


class DealerEditRequest(BaseModel):
    first_name: Optional[str] = None
    last_name: Optional[str] = None
    phone: Optional[str] = None
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


# ============ Auth routes ============
@api_router.post("/auth/register")
async def register(payload: RegisterRequest):
    existing = await db.users.find_one({"email": payload.email.lower()})
    if existing:
        raise HTTPException(409, "Email already registered")
    user_id = str(uuid.uuid4())
    user_doc = {
        "id": user_id,
        "email": payload.email.lower(),
        "password_hash": hash_password(payload.password),
        "role": "dealer",
        "active": True,
        "archived_at": None,
        "agreement_accepted_at": None,
        "dealer_info": payload.dealer_info.dict(),
        "company_info": payload.company_info.dict(),
        "created_at": now_utc(),
    }
    await db.users.insert_one(user_doc)
    token = sign_token(user_id, payload.email.lower(), "dealer")
    return {
        "token": token,
        "user": {
            "id": user_id,
            "email": payload.email.lower(),
            "role": "dealer",
            "dealer_info": payload.dealer_info.dict(),
            "company_info": payload.company_info.dict(),
        },
    }


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
        },
    }


@api_router.get("/auth/me")
async def me(current: dict = Depends(get_current_user)):
    # Include billing-related fields that the client uses to gate flows.
    current["active"] = current.get("active", True)
    return {"user": current}


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
    for rating, name in [
        (payload.exterior_condition, "exterior"),
        (payload.interior_condition, "interior"),
        (payload.tyre_condition, "tyre"),
    ]:
        if not (1 <= rating <= 10):
            raise HTTPException(400, f"{name.title()} condition must be 1-10")
    total_recon = sum((r.get("amount_zar", 0) or 0) for r in payload.reconditioning_items)
    sub_id = str(uuid.uuid4())
    reference = await next_reference_number()
    doc = {
        "id": sub_id,
        "reference": reference,
        "dealer_id": current["id"],
        "dealer_email": current["email"],
        "dealer_name": f"{current['dealer_info']['first_name']} {current['dealer_info']['last_name']}",
        "dealer_first_name": current["dealer_info"].get("first_name", ""),
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
        "license_disk_data": payload.license_disk_data,
        # Condition
        "exterior_condition": payload.exterior_condition,
        "interior_condition": payload.interior_condition,
        "tyre_condition": payload.tyre_condition,
        "windscreen_condition": payload.windscreen_condition,
        "condition": payload.exterior_condition,  # legacy alias for existing analytics
        # Service history
        "service_history": payload.service_history,
        "last_service_date": payload.last_service_date or "TBC",
        "last_service_mileage": payload.last_service_mileage,  # None → treated as TBC
        # Damage
        "paint_evidence": payload.paint_evidence,
        "accident_damage": payload.accident_damage,
        # Reconditioning
        "reconditioning_items": payload.reconditioning_items,
        "reconditioning_total_zar": round(float(total_recon), 2),
        # Legacy fields kept for backward compat with older views
        "factory_warranty": False,
        # Photos & mileage
        "mileage": payload.mileage,
        "photos": payload.photos,
        "status": "pending",
        "price": None,
        "price_notes": None,
        "priced_at": None,
        "market_analysis": None,
        "market_analysis_at": None,
        "billing_accepted_at": now_utc(),
        "created_at": now_utc(),
    }
    await db.submissions.insert_one(doc)
    doc.pop("_id", None)
    return {"submission": {k: v for k, v in doc.items() if k != "photos"}, "id": sub_id}


@api_router.get("/submissions/my")
async def get_my_submissions(current: dict = Depends(get_current_user)):
    subs = await db.submissions.find(
        {"dealer_id": current["id"]},
        {"_id": 0, "photos": 0},
    ).sort("created_at", -1).to_list(1000)
    # Hide archived submissions from the dealer mobile app (they still exist in
    # the DB and remain visible in the desktop admin archive).
    visible = []
    for s in subs:
        bucket = compute_bucket(s)
        s["bucket"] = bucket
        if bucket != "archived":
            visible.append(s)
    return {"submissions": visible}


@api_router.get("/submissions/{sub_id}")
async def get_submission(sub_id: str, current: dict = Depends(get_current_user)):
    sub = await db.submissions.find_one({"id": sub_id}, {"_id": 0})
    if not sub:
        raise HTTPException(404, "Submission not found")
    if current["role"] != "admin" and sub["dealer_id"] != current["id"]:
        raise HTTPException(403, "Not authorized")
    # Prevent dealers from opening an archived submission from a stale link.
    if current["role"] != "admin" and compute_bucket(sub) == "archived":
        raise HTTPException(404, "Submission not found")
    sub["bucket"] = compute_bucket(sub)
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
    subs = await db.submissions.find({}, {"_id": 0, "photos": 0}).sort("created_at", -1).to_list(4000)
    counts = {"incoming": 0, "priced": 0, "archived": 0}
    for s in subs:
        b = compute_bucket(s)
        s["bucket"] = b
        s["billable"] = is_billable(s)
        counts[b] += 1
    if bucket and bucket != "all":
        subs = [s for s in subs if s["bucket"] == bucket]
    return {"submissions": subs, "counts": counts, "archive_after_days": ARCHIVE_AFTER_DAYS}


@api_router.post("/admin/submissions/{sub_id}/price")
async def admin_price(sub_id: str, offer: PriceOffer, current: dict = Depends(require_admin)):
    sub = await db.submissions.find_one({"id": sub_id})
    if not sub:
        raise HTTPException(404, "Submission not found")
    update = {
        "status": "priced",
        "price": offer.price,
        "price_notes": offer.notes,
        "priced_at": now_utc(),
    }
    await db.submissions.update_one({"id": sub_id}, {"$set": update})
    try:
        await send_push(
            recipients=[sub["dealer_id"]],
            data={
                "title": "Price Offer Received",
                "message": f"Your {sub['year']} {sub['make_name']} {sub['model_name']} has been priced at R{offer.price:,.0f}",
                "action_url": f"/vehicle/{sub_id}",
            },
        )
    except Exception as e:
        logger.warning(f"Push failed (non-blocking): {e}")
    return {"status": "priced", "price": offer.price}


@api_router.delete("/admin/submissions/{sub_id}")
async def admin_delete_submission(sub_id: str, current: dict = Depends(require_admin)):
    result = await db.submissions.delete_one({"id": sub_id})
    if result.deleted_count == 0:
        raise HTTPException(404, "Submission not found")
    return {"status": "deleted"}


# ============ Market analysis (AI) ============
@api_router.post("/submissions/{sub_id}/market-analysis")
async def market_analysis(sub_id: str, current: dict = Depends(get_current_user)):
    sub = await db.submissions.find_one({"id": sub_id}, {"_id": 0, "photos": 0})
    if not sub:
        raise HTTPException(404, "Submission not found")
    if current["role"] != "admin" and sub["dealer_id"] != current["id"]:
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


# ============ Admin dealer management ============
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
    if payload.profile_pic is not None:
        updates["profile_pic"] = payload.profile_pic or None
    if payload.cover_photo is not None:
        updates["cover_photo"] = payload.cover_photo or None
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
@api_router.get("/admin/billing")
async def admin_billing(
    month: Optional[str] = None,   # YYYY-MM, defaults to current month
    current: dict = Depends(require_admin),
):
    """Per-dealer billing tally for a calendar month.

    A submission counts as billable when it was PRICED within 24 hours of
    being submitted (SLA). Fee is R50 incl. VAT per billable submission.
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

    # Aggregate: fetch every priced submission in the window, filter by billable,
    # then group by dealer.
    all_subs = await db.submissions.find(
        {"status": "priced"},
        {"_id": 0, "id": 1, "dealer_id": 1, "reference": 1, "make_name": 1,
         "model_name": 1, "year": 1, "created_at": 1, "priced_at": 1, "price": 1,
         "status": 1},
    ).to_list(20000)

    by_dealer: dict = {}
    for s in all_subs:
        priced_at = parse_iso(s.get("priced_at"))
        if not priced_at or not (start <= priced_at < end):
            continue
        billable = is_billable(s)
        did = s.get("dealer_id")
        row = by_dealer.setdefault(did, {"dealer_id": did, "priced_count": 0,
                                         "billable_count": 0, "items": []})
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
        })

    # Attach dealer profile info.
    dealer_ids = list(by_dealer.keys())
    dealers = await db.users.find(
        {"id": {"$in": dealer_ids}},
        {"_id": 0, "id": 1, "email": 1, "dealer_info": 1, "company_info": 1, "active": 1, "archived_at": 1},
    ).to_list(2000) if dealer_ids else []
    dealers_by_id = {d["id"]: d for d in dealers}

    rows = []
    for did, row in by_dealer.items():
        d = dealers_by_id.get(did, {})
        info = d.get("dealer_info") or {}
        company = d.get("company_info") or {}
        rows.append({
            **row,
            "dealer_name": f"{info.get('first_name', '')} {info.get('last_name', '')}".strip() or "(deleted dealer)",
            "dealer_email": d.get("email", ""),
            "company_name": company.get("company_name", ""),
            "active": d.get("active", True),
            "archived": bool(d.get("archived_at")),
            "archived_at": d.get("archived_at"),
            "amount_zar": round(row["billable_count"] * BILLING_FEE_ZAR, 2),
        })
    rows.sort(key=lambda r: r["billable_count"], reverse=True)

    total_billable = sum(r["billable_count"] for r in rows)
    total_priced = sum(r["priced_count"] for r in rows)
    total_zar = round(total_billable * BILLING_FEE_ZAR, 2)

    return {
        "month": f"{start.year:04d}-{start.month:02d}",
        "fee_zar": BILLING_FEE_ZAR,
        "sla_hours": BILLING_SLA_HOURS,
        "rows": rows,
        "totals": {
            "priced_count": total_priced,
            "billable_count": total_billable,
            "amount_zar": total_zar,
        },
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
