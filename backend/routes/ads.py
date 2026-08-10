"""Home advertising slot routes.

Extracted from `backend/server.py` on 2026-08-09 as the first
proof-of-concept for splitting the monolithic route file into
per-domain modules.

Ten fixed slots (1..10). Admin uploads an image per slot, assigns a
dealership and a duration in months. Billing is `R AD_MONTHLY_FEE_ZAR`
per placeholder per month, charged to the assigned dealership through
the standard billing ledger (a `report_orders` doc with
`type='advertising'`).

The module owns its own `APIRouter` (no prefix — matches the previous
`@api_router.get("/admin/ads")` style routes). It's included in the
parent `api_router` at the bottom of `server.py`.
"""

from __future__ import annotations

import base64
import uuid
from datetime import datetime, timedelta, timezone

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field

# Late-import from `server` — safe because by the time this module is
# imported, `server.py` has already executed everything above its
# `include_router(...)` call, so `db`, `require_admin`, etc. all exist
# on the partially-initialised `server` module.
from server import db, require_admin, get_current_user, parse_iso


router = APIRouter()


# ---- Constants --------------------------------------------------------
AD_SLOT_COUNT = 10
AD_MONTHLY_FEE_ZAR = 1000.0
AD_MAX_IMAGE_BYTES = 3 * 1024 * 1024
AD_RECOMMENDED_WIDTH = 1600
AD_RECOMMENDED_HEIGHT = 1000
AD_ASPECT_LABEL = "16:10 landscape"


# ---- Request models ---------------------------------------------------
class AdvertisingSlotUpsert(BaseModel):
    dealership_id: str
    image_base64: str
    duration_months: int = Field(..., ge=1, le=60)


# ---- Serializers ------------------------------------------------------
def _ad_public(slot: dict) -> dict:
    """Serialize an advertising slot for API list output (no image bytes)."""
    now = datetime.now(timezone.utc)
    ends_at = parse_iso(slot.get("ends_at"))
    active = bool(slot.get("dealership_id")) and (ends_at is not None) and (ends_at > now)
    return {
        "slot_number": slot.get("slot_number"),
        "dealership_id": slot.get("dealership_id"),
        "dealership_name": slot.get("dealership_name"),
        "duration_months": slot.get("duration_months"),
        "starts_at": slot.get("starts_at"),
        "ends_at": slot.get("ends_at"),
        "cost_zar": slot.get("cost_zar"),
        "active": active,
        "has_image": bool(slot.get("image_base64")),
        "image_content_type": slot.get("image_content_type"),
        "created_at": slot.get("created_at"),
        "updated_at": slot.get("updated_at"),
    }


def _ad_public_full(slot: dict) -> dict:
    out = _ad_public(slot)
    out["image_base64"] = slot.get("image_base64")
    return out


# ---- Routes -----------------------------------------------------------
@router.get("/admin/ads")
async def admin_list_ads(current: dict = Depends(require_admin)):
    """List all 10 advertising slots (fills in empty placeholders).

    We include the full `image_base64` for each populated slot so the
    admin cockpit's grid view can render the actual thumbnails without
    a second round-trip per card. Payload is still small in practice
    because there are only ever 10 slots and each image is capped at
    the configured `AD_MAX_IMAGE_BYTES` (3 MB) by the upload path.
    """
    docs = {
        d["slot_number"]: d
        async for d in db.advertising_slots.find({}, {"_id": 0})
    }
    out = []
    for n in range(1, AD_SLOT_COUNT + 1):
        raw = docs.get(n)
        out.append(_ad_public_full(raw) if raw else _ad_public({"slot_number": n}))
    return {
        "slots": out,
        "total_slots": AD_SLOT_COUNT,
        "monthly_fee_zar": AD_MONTHLY_FEE_ZAR,
        "spec": {
            "aspect_ratio": AD_ASPECT_LABEL,
            "recommended_width": AD_RECOMMENDED_WIDTH,
            "recommended_height": AD_RECOMMENDED_HEIGHT,
            "max_bytes": AD_MAX_IMAGE_BYTES,
            "formats": ["JPG", "PNG", "WebP"],
        },
    }


@router.get("/admin/ads/{slot_number}")
async def admin_get_ad(slot_number: int, current: dict = Depends(require_admin)):
    if slot_number < 1 or slot_number > AD_SLOT_COUNT:
        raise HTTPException(400, f"slot_number must be 1..{AD_SLOT_COUNT}")
    d = await db.advertising_slots.find_one({"slot_number": slot_number}, {"_id": 0})
    return {"slot": _ad_public_full(d) if d else _ad_public({"slot_number": slot_number})}


@router.put("/admin/ads/{slot_number}")
async def admin_upsert_ad(
    slot_number: int,
    payload: AdvertisingSlotUpsert,
    current: dict = Depends(require_admin),
):
    """Assign an advertiser to a slot for a given number of months.

    Bills `months × R1000` to the dealership via the existing billing
    ledger (a `report_orders` doc with `type='advertising'`). Editing an
    existing ACTIVE slot for the SAME dealership extends the run and
    bills only the additional months.
    """
    if slot_number < 1 or slot_number > AD_SLOT_COUNT:
        raise HTTPException(400, f"slot_number must be 1..{AD_SLOT_COUNT}")

    raw = (payload.image_base64 or "").strip()
    ctype = "image/jpeg"
    if raw.startswith("data:"):
        try:
            head, b64 = raw.split(",", 1)
            ctype = (head.split(";")[0] or "data:image/jpeg").split(":", 1)[1] or "image/jpeg"
        except Exception:
            raise HTTPException(400, "Malformed image data URL")
    else:
        b64 = raw
    try:
        img_bytes = base64.b64decode(b64, validate=False)
    except Exception:
        raise HTTPException(400, "Image is not valid base64")
    if not img_bytes:
        raise HTTPException(400, "Image is required")
    if len(img_bytes) > AD_MAX_IMAGE_BYTES:
        raise HTTPException(
            413,
            f"Image is {len(img_bytes) // 1024} KB; max is {AD_MAX_IMAGE_BYTES // (1024 * 1024)} MB.",
        )
    if ctype.lower() not in ("image/jpeg", "image/png", "image/webp", "image/jpg"):
        raise HTTPException(400, f"Unsupported image type: {ctype}. Use JPG, PNG or WebP.")

    image_data_url = f"data:{ctype};base64,{b64}"

    dship = await db.dealerships.find_one({"id": payload.dealership_id}, {"_id": 0})
    if not dship:
        raise HTTPException(404, "Dealership not found")

    now = datetime.now(timezone.utc)
    existing = await db.advertising_slots.find_one({"slot_number": slot_number}, {"_id": 0})

    prior_ends_at = parse_iso((existing or {}).get("ends_at"))
    same_active_dealer = bool(
        existing
        and existing.get("dealership_id") == payload.dealership_id
        and prior_ends_at
        and prior_ends_at > now
    )
    if same_active_dealer:
        starts_at = parse_iso(existing["starts_at"]) or now
        prior_months = int(existing.get("duration_months") or 0)
        new_total_months = prior_months + payload.duration_months
        delta_months = payload.duration_months
    else:
        starts_at = now
        new_total_months = payload.duration_months
        delta_months = payload.duration_months

    ends_at = starts_at + timedelta(days=30 * new_total_months)
    total_cost = round(new_total_months * AD_MONTHLY_FEE_ZAR, 2)
    delta_cost = round(delta_months * AD_MONTHLY_FEE_ZAR, 2)

    doc = {
        "slot_number": slot_number,
        "dealership_id": payload.dealership_id,
        "dealership_name": dship.get("name"),
        "image_base64": image_data_url,
        "image_content_type": ctype,
        "image_bytes": len(img_bytes),
        "duration_months": new_total_months,
        "starts_at": starts_at.isoformat(),
        "ends_at": ends_at.isoformat(),
        "cost_zar": total_cost,
        "created_at": (existing or {}).get("created_at") or now.isoformat(),
        "updated_at": now.isoformat(),
        "updated_by": current["id"],
    }
    await db.advertising_slots.update_one(
        {"slot_number": slot_number},
        {"$set": doc},
        upsert=True,
    )

    # Bill the delta via the standard billing ledger.
    order_user = await db.users.find_one(
        {"dealership_id": payload.dealership_id, "role": "dealer", "active": {"$ne": False}},
        {"_id": 0, "id": 1},
    )
    order = {
        "id": str(uuid.uuid4()),
        "submission_id": None,
        "dealership_id": payload.dealership_id,
        "dealer_id": (order_user or {}).get("id"),
        "vin": None,
        "type": "advertising",
        "name": f"Home Advertising — Slot {slot_number} ({delta_months} month{'s' if delta_months != 1 else ''})",
        "cost_zar": delta_cost,
        "status": "delivered",
        "ordered_at": now.isoformat(),
        "ordered_by": current["id"],
        "delivered_at": now.isoformat(),
        "result_data": {
            "slot_number": slot_number,
            "months": delta_months,
            "starts_at": starts_at.isoformat(),
            "ends_at": ends_at.isoformat(),
            "extended_from_active": same_active_dealer,
        },
    }
    await db.report_orders.insert_one(order)

    return {
        "slot": _ad_public_full(doc),
        "billed_zar": delta_cost,
        "billed_months": delta_months,
        "extended_from_active": bool(same_active_dealer),
    }


@router.delete("/admin/ads/{slot_number}")
async def admin_clear_ad(slot_number: int, current: dict = Depends(require_admin)):
    """Clear a slot. Does NOT refund the dealer — advertising is a
    pre-paid placement; the slot simply drops out of the home rotation."""
    if slot_number < 1 or slot_number > AD_SLOT_COUNT:
        raise HTTPException(400, f"slot_number must be 1..{AD_SLOT_COUNT}")
    await db.advertising_slots.delete_one({"slot_number": slot_number})
    return {"ok": True, "slot_number": slot_number}


@router.get("/ads/active")
async def list_active_ads(current: dict = Depends(get_current_user)):
    """Currently-active ads for the Home advertising tile. Any logged-in
    user can call this."""
    now = datetime.now(timezone.utc)
    docs = await db.advertising_slots.find({}, {"_id": 0}).sort("slot_number", 1).to_list(50)
    out = []
    for d in docs:
        ends_at = parse_iso(d.get("ends_at"))
        if not d.get("image_base64") or not ends_at or ends_at <= now:
            continue
        out.append({
            "slot_number": d.get("slot_number"),
            "image_base64": d.get("image_base64"),
            "dealership_name": d.get("dealership_name"),
            "ends_at": d.get("ends_at"),
        })
    return {"ads": out}


__all__ = ["router"]
