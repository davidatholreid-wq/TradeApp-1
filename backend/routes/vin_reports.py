"""VIN Reports — standalone (non-submission) vendor report ordering.

The dealer picks a make + enters a VIN, then chooses one of the
available reports for that make and orders it. Each order is billed
per its own price and stored on the dealer's profile in the new
`vin_report_orders` collection so it can be retrieved / reviewed
later without having to redo the vendor call.

Currently supported reports (Phase 1 — Nov 2026):

    * ``vin_history`` — Kredo VIN Accident / Claim History (R100)
    * ``bimmervin``   — Bimmervin BMW factory options (free — BMW only)
    * ``mbtools``     — MBTools Mercedes-Benz datacard (free — Mercedes only)
    * ``outvin``      — Outvin multi-make OEM spec decode (R20 — supported makes only)

CarTrust is intentionally deferred to Phase 2 — that vendor needs
full make/model/derivative context which we don't collect in this
lightweight flow.
"""

from __future__ import annotations

import uuid
from typing import Any, Optional

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field

# Vendor clients — reused verbatim from the full-valuation flow.
from services.kredo_client import get_kredo_client, KredoAPIError
from services.bimmervin_client import fetch_bimmer_spec, is_bimmer_supported_make
from services.mbtools_client import fetch_mb_datacard, is_mb_supported_make
from services.outvin_client import (
    fetch_outvin_spec,
    is_outvin_supported_make,
    OUTVIN_SUPPORTED_MAKES,
)

# Late-import from `server` — safe because this file is only imported
# at the bottom of `server.py` once all these names are defined.
from server import db, get_current_user, now_utc, logger

# Reuse the same normalisation helper the /kredo/vin-history route uses
# so the shape stored on the order matches what the app already knows
# how to render.
from routes.kredo import _normalise_vin_history

router = APIRouter()


# ---------------------------------------------------------------------------
# Report catalogue
# ---------------------------------------------------------------------------
# Each report is described by:
#   * `id`        — machine name stored on the order row
#   * `label`     — human-readable title shown in the app
#   * `cost_zar`  — flat R fee billed on successful delivery. 0 for free.
#   * `blurb`     — short description surfaced in the picker UI
#   * `supports`  — callable that returns True when the report is
#                   available for the given make. Bimmervin only covers
#                   BMW, MBTools only Mercedes-Benz, Outvin its own
#                   supported-marque list. `vin_history` works on any
#                   make so its guard is always-True.
REPORT_CATALOG: list[dict[str, Any]] = [
    {
        "id": "vin_history",
        "label": "Accident & Claim History",
        "cost_zar": 100,
        "blurb": "Kredo VIN-based accident and insurance claim history.",
        "supports": lambda make: True,
    },
    {
        "id": "bimmervin",
        "label": "BMW Factory Options",
        "cost_zar": 0,
        "blurb": "Bimmervin OEM datacard — factory-fitted options for a specific BMW VIN.",
        "supports": is_bimmer_supported_make,
    },
    {
        "id": "mbtools",
        "label": "Mercedes-Benz Datacard",
        "cost_zar": 0,
        "blurb": "MBTools Mercedes-Benz Datacard — factory options + build data.",
        "supports": is_mb_supported_make,
    },
    {
        "id": "outvin",
        "label": "OEM Spec Decode",
        "cost_zar": 20,
        "blurb": "Outvin multi-make OEM datacard — supports 30+ marques.",
        "supports": is_outvin_supported_make,
    },
]


def _catalog_entry(report_id: str) -> Optional[dict[str, Any]]:
    for r in REPORT_CATALOG:
        if r["id"] == report_id:
            return r
    return None


def _available_for_make(make: str) -> list[dict[str, Any]]:
    """Filter the catalog to reports whose vendor supports `make`.
    Each returned dict is the sanitised (JSON-safe) view — the `supports`
    callable is stripped."""
    out: list[dict[str, Any]] = []
    for r in REPORT_CATALOG:
        try:
            supported = bool(r["supports"](make))
        except Exception:
            supported = False
        if supported:
            out.append({
                "id": r["id"],
                "label": r["label"],
                "cost_zar": r["cost_zar"],
                "blurb": r["blurb"],
            })
    return out


# ---------------------------------------------------------------------------
# GET /api/vin-reports/available?make=X
# ---------------------------------------------------------------------------
@router.get("/vin-reports/makes")
async def list_supported_makes(_: dict = Depends(get_current_user)):
    """Return a de-duplicated list of makes any vendor supports.
    Currently just Outvin's list is authoritative (broadest) — BMW /
    Mercedes-Benz are already in it — plus `vin_history` which is
    always-True. Frontend shows this as a dropdown.
    """
    # Outvin's list is title-case; we return it verbatim so the UI can
    # display "Mercedes-Benz" exactly as the vendor sees it.
    return {"makes": OUTVIN_SUPPORTED_MAKES}


@router.get("/vin-reports/available")
async def available_reports(
    make: str,
    _: dict = Depends(get_current_user),
):
    if not (make or "").strip():
        raise HTTPException(400, "make is required")
    reports = _available_for_make(make.strip())
    return {"make": make, "reports": reports}


# ---------------------------------------------------------------------------
# POST /api/vin-reports/order
# ---------------------------------------------------------------------------
class VinReportOrderRequest(BaseModel):
    make: str = Field(..., min_length=1)
    vin: str = Field(..., min_length=1)
    report_type: str = Field(..., min_length=1)
    # Extra metadata that helps some vendors — optional. Bimmervin
    # can accept a model hint, Outvin doesn't; we forward whatever's
    # supplied.
    model_hint: Optional[str] = None


@router.post("/vin-reports/order")
async def order_vin_report(
    payload: VinReportOrderRequest,
    current: dict = Depends(get_current_user),
):
    """Order a VIN-linked report and (on successful vendor response)
    bill the caller their tier's flat fee.

    Auto-debit — the caller is charged immediately on success. Failed
    vendor calls are stored as `status=failed` and NOT billed.
    """
    make = payload.make.strip()
    vin = (payload.vin or "").strip().upper()
    if len(vin) < 6:
        raise HTTPException(400, "Please enter a valid VIN.")
    entry = _catalog_entry(payload.report_type)
    if not entry:
        raise HTTPException(400, f"Unknown report_type '{payload.report_type}'.")
    try:
        if not entry["supports"](make):
            raise HTTPException(
                400,
                f"{entry['label']} is not available for {make}.",
            )
    except HTTPException:
        raise
    except Exception as e:
        logger.warning("vin_reports: supports() raised for make=%s: %s", make, e)
        raise HTTPException(400, f"{entry['label']} is not available for {make}.")

    order_id = str(uuid.uuid4())
    now = now_utc()
    dealer_id = current.get("dealership_id")

    # Create the order row immediately in `pending` so we can always
    # look it up later even if the vendor call blows up mid-way.
    base_row = {
        "id": order_id,
        "user_id": current["id"],
        "dealership_id": dealer_id,
        "make": make,
        "vin": vin,
        "report_type": entry["id"],
        "report_label": entry["label"],
        "status": "pending",
        "cost_zar": 0,          # only set to the tier price on success
        "billed": False,
        "ordered_at": now,
        "ordered_by_name": current.get("name") or current.get("email"),
        "result_data": None,
        "error": None,
        "completed_at": None,
    }
    await db.vin_report_orders.insert_one(base_row)

    # Dispatch to the appropriate vendor.
    result: Optional[dict[str, Any]] = None
    error: Optional[str] = None
    try:
        if entry["id"] == "vin_history":
            raw = await get_kredo_client().vin_history(vin)
            result = _normalise_vin_history(raw)
        elif entry["id"] == "bimmervin":
            result = await fetch_bimmer_spec(vin)
        elif entry["id"] == "mbtools":
            result = await fetch_mb_datacard(vin)
        elif entry["id"] == "outvin":
            result = await fetch_outvin_spec(vin)
        else:
            raise RuntimeError(f"Report dispatcher missing for {entry['id']}")
    except KredoAPIError as e:
        error = f"Kredo error: {e}"
    except HTTPException as e:
        # Vendor client-side validation — surface the detail.
        error = str(getattr(e, "detail", e))
    except Exception as e:  # pragma: no cover — vendor edge cases
        logger.exception("vin_reports: vendor call failed for %s / %s", entry["id"], vin)
        error = f"{type(e).__name__}: {e}"

    if error is not None:
        await db.vin_report_orders.update_one(
            {"id": order_id},
            {"$set": {
                "status": "failed",
                "error": error,
                "completed_at": now_utc(),
            }},
        )
        # 502 so the client can distinguish "we couldn't deliver" from
        # "you're not allowed" (403) or "bad request" (400).
        raise HTTPException(502, f"Report failed: {error}")

    # Some vendors return empty payloads for VINs they don't have —
    # treat those as failed so we don't bill for nothing.
    if not result:
        await db.vin_report_orders.update_one(
            {"id": order_id},
            {"$set": {
                "status": "failed",
                "error": "Vendor returned no data for this VIN.",
                "completed_at": now_utc(),
            }},
        )
        raise HTTPException(404, "The vendor has no data for this VIN.")

    # Success — bill the caller and persist the payload.
    billed = int(entry["cost_zar"] or 0) > 0
    await db.vin_report_orders.update_one(
        {"id": order_id},
        {"$set": {
            "status": "completed",
            "cost_zar": entry["cost_zar"],
            "billed": billed,
            "result_data": result,
            "completed_at": now_utc(),
        }},
    )
    logger.info(
        "vin_reports: order %s completed — %s / %s / %s (R%s)",
        order_id, entry["id"], make, vin, entry["cost_zar"],
    )

    row = await db.vin_report_orders.find_one({"id": order_id}, {"_id": 0})
    return {"order": row}


# ---------------------------------------------------------------------------
# GET /api/vin-reports/mine — list caller's orders
# ---------------------------------------------------------------------------
@router.get("/vin-reports/mine")
async def my_orders(
    current: dict = Depends(get_current_user),
    limit: int = 100,
):
    """List the caller's own VIN report orders (newest first).

    Admins see every order (they can audit). Regular users see only
    their own.
    """
    q: dict[str, Any] = {}
    if current.get("role") != "admin":
        q["user_id"] = current["id"]
    cursor = db.vin_report_orders.find(q, {"_id": 0}).sort("ordered_at", -1).limit(limit)
    rows = [r async for r in cursor]
    return {"orders": rows}


# ---------------------------------------------------------------------------
# GET /api/vin-reports/{order_id} — fetch a single order (with payload)
# ---------------------------------------------------------------------------
@router.get("/vin-reports/{order_id}")
async def get_order(
    order_id: str,
    current: dict = Depends(get_current_user),
):
    row = await db.vin_report_orders.find_one({"id": order_id}, {"_id": 0})
    if not row:
        raise HTTPException(404, "Order not found")
    if current.get("role") != "admin" and row.get("user_id") != current["id"]:
        raise HTTPException(403, "You cannot access this order")
    return {"order": row}
