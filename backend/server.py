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
def now_utc() -> str:
    return datetime.now(timezone.utc).isoformat()


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
    make_id: str
    make_name: str
    model_id: str
    model_name: str
    derivative_id: str
    derivative_name: str
    mileage: int
    year: int
    factory_warranty: bool
    condition: int  # 1-10
    accident_damage: bool
    colour: str
    license_disk_data: Optional[str] = None
    photos: dict  # {front, side_right, rear, side_left, interior} -> base64 strings


class PriceOffer(BaseModel):
    price: float
    notes: Optional[str] = None


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
    token = sign_token(user["id"], user["email"], user["role"])
    return {
        "token": token,
        "user": {
            "id": user["id"],
            "email": user["email"],
            "role": user["role"],
            "dealer_info": user.get("dealer_info"),
            "company_info": user.get("company_info"),
        },
    }


@api_router.get("/auth/me")
async def me(current: dict = Depends(get_current_user)):
    return {"user": current}


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


# ============ Submissions ============
@api_router.post("/submissions")
async def create_submission(payload: VehicleSubmission, current: dict = Depends(get_current_user)):
    if current["role"] != "dealer":
        raise HTTPException(403, "Only dealers can submit vehicles")
    if not (1 <= payload.condition <= 10):
        raise HTTPException(400, "Condition must be 1-10")
    sub_id = str(uuid.uuid4())
    reference = await next_reference_number()
    doc = {
        "id": sub_id,
        "reference": reference,
        "dealer_id": current["id"],
        "dealer_email": current["email"],
        "dealer_name": f"{current['dealer_info']['first_name']} {current['dealer_info']['last_name']}",
        "company_name": current["company_info"]["company_name"],
        "make_id": payload.make_id,
        "make_name": payload.make_name,
        "model_id": payload.model_id,
        "model_name": payload.model_name,
        "derivative_id": payload.derivative_id,
        "derivative_name": payload.derivative_name,
        "mileage": payload.mileage,
        "year": payload.year,
        "factory_warranty": payload.factory_warranty,
        "condition": payload.condition,
        "accident_damage": payload.accident_damage,
        "colour": payload.colour,
        "license_disk_data": payload.license_disk_data,
        "photos": payload.photos,
        "status": "pending",
        "price": None,
        "price_notes": None,
        "priced_at": None,
        "market_analysis": None,
        "market_analysis_at": None,
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
    return {"submissions": subs}


@api_router.get("/submissions/{sub_id}")
async def get_submission(sub_id: str, current: dict = Depends(get_current_user)):
    sub = await db.submissions.find_one({"id": sub_id}, {"_id": 0})
    if not sub:
        raise HTTPException(404, "Submission not found")
    if current["role"] != "admin" and sub["dealer_id"] != current["id"]:
        raise HTTPException(403, "Not authorized")
    return {"submission": sub}


@api_router.get("/admin/submissions")
async def admin_list_submissions(current: dict = Depends(require_admin)):
    subs = await db.submissions.find({}, {"_id": 0, "photos": 0}).sort("created_at", -1).to_list(2000)
    return {"submissions": subs}


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
async def admin_list_dealers(current: dict = Depends(require_admin)):
    dealers = await db.users.find(
        {"role": "dealer"},
        {"_id": 0, "password_hash": 0},
    ).sort("created_at", -1).to_list(2000)
    # Add submission count
    for d in dealers:
        d["submission_count"] = await db.submissions.count_documents({"dealer_id": d["id"]})
    return {"dealers": dealers}


@api_router.delete("/admin/dealers/{dealer_id}")
async def admin_delete_dealer(dealer_id: str, current: dict = Depends(require_admin)):
    user = await db.users.find_one({"id": dealer_id})
    if not user:
        raise HTTPException(404, "Dealer not found")
    if user["role"] != "dealer":
        raise HTTPException(400, "Can only remove dealer accounts")
    await db.users.delete_one({"id": dealer_id})
    # Optionally remove their submissions
    await db.submissions.delete_many({"dealer_id": dealer_id})
    return {"status": "deleted"}


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


@app.on_event("shutdown")
async def shutdown_db_client():
    await _push_client.aclose()
    client.close()
