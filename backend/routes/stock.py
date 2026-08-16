"""Dealer stock routes — backed by a dedicated ``stock_items`` collection.

## Architecture (Aug 2026 rework)

Prior to this rework the stock list was a derived view over the
``submissions`` collection (any submission with ``deal.done = true`` and
``deal.sold != true``).  Product feedback: the stock list needs to be
its OWN silo, decoupled from the valuation submission, so that:

  * The submission stays untouched in the valuations silo — it can be
    re-priced or corrected without disturbing the stock record.
  * Only a curated slice of the vehicle info is copied over (the info
    the dealer actually cares about on the lot: Year, Make, Derivative,
    M&M Code, Mileage, VIN, Colour, Condition Score, My Offer price).
    Photos and marketing metadata stay in the submission.
  * The dealer supplies TWO additional fields at transfer time that
    don't exist on submissions: ``stock_number`` and
    ``target_sell_price_zar``.
  * The transfer is reversible: un-transferring a stock item deletes
    the stock row, clears the badge on the submission, and unlocks the
    "My Offer" price on the submission for a fresh cycle.  Sold items
    cannot be un-transferred.

## Collection: ``stock_items``

Document shape::

    {
      "id":                    "<uuid>",
      "dealership_id":         "<owning dealership>",
      "dealer_id":             "<user id of the person who transferred>",
      "submission_id":         "<source submission id>",

      # Dealer-only fields (entered at transfer, editable afterwards)
      "stock_number":          "STK-1234",         # unique per dealership
      "target_sell_price_zar": 350000,

      # Snapshot of vehicle info at transfer time (all editable in stock)
      "year": 2019,
      "make_name": "BMW",
      "model_name": "X4",
      "derivative_name": "xDrive20d M Sport",
      "mm_code": "BM11223",
      "mileage": 45000,
      "vin": "WBA22CA0609U91380",
      "colour": "Alpine White",
      "condition_score": 7.6,
      "my_offer_price_zar": 320000,

      # Sale info (populated when Mark Sold is used)
      "sold":               false,
      "sold_at":            null,
      "sale_price_zar":     null,
      "recon_cost_zar":     null,
      "buyer_name":         null,
      "buyer_notes":        null,
      "days_to_sell":       null,

      # Timestamps
      "created_at": "2026-08-12T…",
      "updated_at": "2026-08-12T…"
    }

## Endpoints

  * ``POST /submissions/{sid}/transfer-to-stock`` — create a stock item.
  * ``POST /submissions/{sid}/untransfer-from-stock`` — reverse it.
  * ``GET  /stock`` — list stock items (with summary metrics).
  * ``PATCH /stock/{id}`` — edit any editable field (target price,
    stock number, mileage, VIN, colour, condition, my_offer, etc.).
  * ``POST  /stock/{id}/mark-sold`` — record a sale.
  * ``GET  /stock/export.csv`` — CSV export.
"""

from __future__ import annotations

import csv
import io
import logging
import uuid
from datetime import datetime, timezone
from typing import List, Optional

from fastapi import APIRouter, Depends, HTTPException, Response
from pydantic import BaseModel, Field

from server import (
    db,
    get_current_user,
    now_utc,
    _get_user_dealership_id,
    _sanitise_deal_int,
)


router = APIRouter()

# Editable vehicle-detail fields on a stock item.  Kept in one place so
# the PATCH endpoint and the transfer helpers stay in sync — extending
# this list is the only thing you need to do to expose a new editable
# field to the stock UI.
_EDITABLE_VEHICLE_FIELDS: List[str] = [
    "stock_number",
    "target_sell_price_zar",
    "my_offer_price_zar",
    "year",
    "make_name",
    "model_name",
    "derivative_name",
    "mm_code",
    "mileage",
    "vin",
    "colour",
    "condition_score",
    # Nov 2026 — extra fields for the detailed web stock table.
    # `target_sell_price_zar` now represents the RETAIL price shown to
    # consumers. Kept the field name unchanged (backwards-compatible with
    # existing DB rows / mobile app) but the web UI relabels it.
    "floorplan_amount_zar",
    "expected_recon_cost_zar",
    "advertised",
    "fully_reconditioned",
]


# ==================== Models ====================


class TransferIn(BaseModel):
    """Body for ``POST /submissions/{sid}/transfer-to-stock``.

    Both fields are required at transfer time — everything else is
    snapshotted from the source submission automatically.
    """

    stock_number: str = Field(..., min_length=1, max_length=32)
    target_sell_price_zar: int = Field(..., ge=0, le=100_000_000)


class StockPatchIn(BaseModel):
    """Body for ``PATCH /stock/{id}``.

    Every field is optional so the front-end can send a partial update
    (e.g. only ``target_sell_price_zar`` from the inline row editor).
    Numeric fields accept ``null`` to clear.
    """

    stock_number: Optional[str] = Field(default=None, max_length=32)
    target_sell_price_zar: Optional[int] = Field(default=None, ge=0, le=100_000_000)
    my_offer_price_zar: Optional[int] = Field(default=None, ge=0, le=100_000_000)
    year: Optional[int] = Field(default=None, ge=1900, le=2100)
    make_name: Optional[str] = Field(default=None, max_length=80)
    model_name: Optional[str] = Field(default=None, max_length=120)
    derivative_name: Optional[str] = Field(default=None, max_length=160)
    mm_code: Optional[str] = Field(default=None, max_length=32)
    mileage: Optional[int] = Field(default=None, ge=0, le=9_999_999)
    vin: Optional[str] = Field(default=None, max_length=32)
    colour: Optional[str] = Field(default=None, max_length=40)
    condition_score: Optional[float] = Field(default=None, ge=0, le=10)
    # Additional editable fields (Nov 2026 — detailed web stock table).
    floorplan_amount_zar: Optional[int] = Field(default=None, ge=0, le=100_000_000)
    expected_recon_cost_zar: Optional[int] = Field(default=None, ge=0, le=10_000_000)
    advertised: Optional[bool] = None
    fully_reconditioned: Optional[bool] = None


class MarkSoldIn(BaseModel):
    sale_price_zar: int = Field(..., ge=0, le=100_000_000)
    recon_cost_zar: Optional[int] = Field(default=0, ge=0, le=100_000_000)
    buyer_name: Optional[str] = Field(default=None, max_length=160)
    buyer_notes: Optional[str] = Field(default=None, max_length=2000)
    sold_at: Optional[str] = Field(default=None, max_length=40)


# ==================== Helpers ====================


def _days_since(iso_ts: Optional[str]) -> Optional[int]:
    if not iso_ts:
        return None
    try:
        dt = datetime.fromisoformat(iso_ts.replace("Z", "+00:00"))
        if dt.tzinfo is None:
            dt = dt.replace(tzinfo=timezone.utc)
        delta = datetime.now(timezone.utc) - dt
        return max(0, int(delta.total_seconds() // 86400))
    except Exception:
        return None


async def _scope_query(current: dict) -> dict:
    """Base query fragment for scoping stock reads/writes.

    Admins see everything; dealers are locked to their own dealership.
    Note: sold items REMAIN in the collection but are excluded by the
    "current stock" list — the caller controls that via ``sold`` in
    the outer query.
    """
    if current.get("role") == "admin":
        return {}
    my_dship = await _get_user_dealership_id(current)
    if my_dship:
        return {
            "$or": [
                {"dealership_id": my_dship},
                {"dealer_id": current.get("id")},
            ]
        }
    return {"dealer_id": current.get("id")}


def _norm_stock_number(raw: str) -> str:
    return (raw or "").strip().upper()


async def _stock_number_taken(dealership_id: Optional[str], stock_number: str, exclude_id: Optional[str] = None) -> bool:
    """Uniqueness check for stock numbers within a dealership."""
    if not stock_number:
        return False
    q: dict = {
        "stock_number": stock_number,
        "sold": {"$ne": True},
    }
    if dealership_id:
        q["dealership_id"] = dealership_id
    if exclude_id:
        q["id"] = {"$ne": exclude_id}
    doc = await db.stock_items.find_one(q, {"_id": 0, "id": 1})
    return doc is not None


def _row_for_api(doc: dict) -> dict:
    """Shape a stock_item document for the frontend."""
    purchased_at = doc.get("created_at")
    days = _days_since(purchased_at)
    return {
        "id": doc.get("id"),
        "submission_id": doc.get("submission_id"),
        "stock_number": doc.get("stock_number"),
        "target_sell_price_zar": doc.get("target_sell_price_zar"),
        "my_offer_price_zar": doc.get("my_offer_price_zar"),
        "year": doc.get("year"),
        "make_name": doc.get("make_name"),
        "model_name": doc.get("model_name"),
        "derivative_name": doc.get("derivative_name"),
        "mm_code": doc.get("mm_code"),
        "mileage": doc.get("mileage"),
        "vin": doc.get("vin"),
        "colour": doc.get("colour"),
        "condition_score": doc.get("condition_score"),
        # Nov 2026 detailed web stock fields (default sensibly so existing
        # docs without these keys don't turn into an empty table cell).
        "floorplan_amount_zar": doc.get("floorplan_amount_zar"),
        "expected_recon_cost_zar": doc.get("expected_recon_cost_zar"),
        "advertised": bool(doc.get("advertised", False)),
        "fully_reconditioned": bool(doc.get("fully_reconditioned", False)),
        "purchased_at": purchased_at,
        "days_in_stock": days,
        "dealership_id": doc.get("dealership_id"),
        "dealership_name": doc.get("dealership_name"),
    }


def _bucket_days(days: Optional[int]) -> str:
    if days is None:
        return "unknown"
    if days <= 30:
        return "0-30"
    if days <= 60:
        return "31-60"
    if days <= 90:
        return "61-90"
    return "90+"


async def _can_write_stock(current: dict, item: dict) -> bool:
    """Managerial (is_pricing_agent) users on the owning dealership,
    or admins.  Regular dealers on the dealership can view but not edit.
    """
    if current.get("role") == "admin":
        return True
    if not current.get("is_pricing_agent"):
        return False
    my_dship = await _get_user_dealership_id(current)
    return (item.get("dealership_id") and item.get("dealership_id") == my_dship) or \
        item.get("dealer_id") == current.get("id")


# ==================== Transfer / Un-transfer ====================


@router.post("/submissions/{sid}/transfer-to-stock")
async def transfer_to_stock(
    sid: str,
    body: TransferIn,
    current: dict = Depends(get_current_user),
):
    """Create a new stock item from a fully-valued submission.

    Business rules enforced:
      1. Submission must be **fully valued** (``priced_at`` set).
      2. Caller must be managerial (``is_pricing_agent``) on the
         owning dealership — or an admin.
      3. The submission must not already be transferred (has
         ``stock_item_id``).
      4. Stock number must be unique within the caller's dealership
         (case-insensitive, stored upper-case).
    """
    sub = await db.submissions.find_one({"id": sid}, {"_id": 0})
    if not sub:
        raise HTTPException(404, "Submission not found")

    # Caller must be managerial on this dealership (or admin).
    if current.get("role") != "admin":
        if not current.get("is_pricing_agent"):
            raise HTTPException(403, "Only managerial users can transfer vehicles to stock.")
        my_dship = await _get_user_dealership_id(current)
        owner = sub.get("dealership_id")
        if not (owner and owner == my_dship) and sub.get("dealer_id") != current.get("id"):
            raise HTTPException(403, "You can only transfer submissions from your dealership.")

    # Rule 1 — must be a fully-valued submission (not subject-to-view).
    if not sub.get("priced_at"):
        raise HTTPException(
            400,
            "This submission has not been fully valued yet. Subject-to-view "
            "vehicles cannot be transferred to stock — please complete the "
            "valuation first.",
        )

    # Rule 3 — already transferred?
    if sub.get("stock_item_id"):
        raise HTTPException(400, "This submission is already in the stock list.")

    # Rule 4 — stock-number uniqueness.
    stock_number = _norm_stock_number(body.stock_number)
    if not stock_number:
        raise HTTPException(400, "Stock number is required.")
    dealership_id = sub.get("dealership_id")
    if await _stock_number_taken(dealership_id, stock_number):
        raise HTTPException(409, f"Stock number '{stock_number}' is already in use at this dealership.")

    # Snapshot the vehicle info (per product spec — only these fields).
    deal = sub.get("deal") or {}
    my_offer = sub.get("dealer_offer_zar") or deal.get("dealer_offer_zar") or 0
    now_iso = now_utc()
    new_id = str(uuid.uuid4())
    doc = {
        "id": new_id,
        "dealership_id": dealership_id,
        "dealership_name": sub.get("dealership_name"),
        "dealer_id": current.get("id"),
        "submission_id": sid,
        # Dealer-supplied at transfer:
        "stock_number": stock_number,
        "target_sell_price_zar": _sanitise_deal_int(
            body.target_sell_price_zar, "target_sell_price_zar"
        ),
        # Vehicle snapshot (editable within stock):
        "year": sub.get("year"),
        "make_name": sub.get("make_name"),
        "model_name": sub.get("model_name"),
        "derivative_name": sub.get("derivative_name"),
        "mm_code": (sub.get("market_values") or {}).get("mm_code"),
        "mileage": sub.get("mileage"),
        "vin": sub.get("vin"),
        "colour": sub.get("colour"),
        "condition_score": sub.get("condition_score"),
        "my_offer_price_zar": _sanitise_deal_int(my_offer, "my_offer_price_zar") if my_offer else 0,
        # Sale info — empty until Mark Sold.
        "sold": False,
        "sold_at": None,
        "sale_price_zar": None,
        "recon_cost_zar": None,
        "buyer_name": None,
        "buyer_notes": None,
        "days_to_sell": None,
        # Timestamps:
        "created_at": now_iso,
        "updated_at": now_iso,
    }
    await db.stock_items.insert_one(doc)

    # Flag the submission so the vehicle-detail screen shows the badge
    # and locks the My Offer price.
    await db.submissions.update_one(
        {"id": sid},
        {
            "$set": {
                "stock_item_id": new_id,
                "stock_number": stock_number,
                "transferred_to_stock_at": now_iso,
                "transferred_to_stock_by": current.get("id"),
            }
        },
    )
    logging.info("stock.transfer: submission %s → stock %s (%s)", sid, new_id, stock_number)
    return {
        "id": new_id,
        "submission_id": sid,
        "stock_number": stock_number,
        "target_sell_price_zar": doc["target_sell_price_zar"],
    }


@router.post("/submissions/{sid}/untransfer-from-stock")
async def untransfer_from_stock(
    sid: str,
    current: dict = Depends(get_current_user),
):
    """Reverse a transfer — deletes the stock item and unlocks the
    submission's My Offer price.  Sold items cannot be un-transferred.
    """
    sub = await db.submissions.find_one({"id": sid}, {"_id": 0})
    if not sub:
        raise HTTPException(404, "Submission not found")

    stock_id = sub.get("stock_item_id")
    if not stock_id:
        raise HTTPException(400, "This submission is not currently in the stock list.")

    stock = await db.stock_items.find_one({"id": stock_id}, {"_id": 0})

    # Managerial-only.
    if current.get("role") != "admin":
        if not current.get("is_pricing_agent"):
            raise HTTPException(403, "Only managerial users can un-transfer stock.")
        my_dship = await _get_user_dealership_id(current)
        owner = sub.get("dealership_id")
        if not (owner and owner == my_dship) and sub.get("dealer_id") != current.get("id"):
            raise HTTPException(403, "You can only un-transfer stock from your dealership.")

    if stock and stock.get("sold") is True:
        raise HTTPException(
            400,
            "This vehicle has been marked as sold and cannot be un-transferred.",
        )

    if stock:
        await db.stock_items.delete_one({"id": stock_id})
    await db.submissions.update_one(
        {"id": sid},
        {
            "$unset": {
                "stock_item_id": "",
                "stock_number": "",
                "transferred_to_stock_at": "",
                "transferred_to_stock_by": "",
            }
        },
    )
    logging.info("stock.untransfer: submission %s ← stock %s", sid, stock_id)
    return {"submission_id": sid, "removed_stock_id": stock_id}


# ==================== Stock list / edit / sold / export ====================


@router.get("/stock")
async def list_stock(current: dict = Depends(get_current_user)):
    """Return every stock item owned by the caller (or all, for admin)."""
    scope = await _scope_query(current)
    query = dict(scope)
    query["sold"] = {"$ne": True}
    items: List[dict] = []
    total_capital = 0
    total_floorplan = 0
    total_gp = 0
    total_gp_items = 0  # only rows that carry enough data to compute a GP
    ages: List[int] = []
    buckets = {"0-30": 0, "31-60": 0, "61-90": 0, "90+": 0, "unknown": 0}
    # Per-bucket cost + expected-GP roll-ups so the aging silos can
    # show the same "tied-up capital vs profit-on-the-line" split as
    # the top-line totals. Only rows with a target sell price
    # contribute to the bucket GP (same rule as the fleet total).
    bucket_cost: dict[str, int] = {k: 0 for k in buckets}
    bucket_gp: dict[str, int] = {k: 0 for k in buckets}
    over_60 = 0
    async for s in db.stock_items.find(query, {"_id": 0}):
        row = _row_for_api(s)
        items.append(row)
        cap = row.get("my_offer_price_zar") or 0
        try:
            cap_int = int(cap or 0)
            total_capital += cap_int
        except Exception:
            cap_int = 0
        # Floorplan running total — nullable, treat missing as 0 for
        # the total but only bump when we actually have a value so the
        # summary card can distinguish "no floorplan captured" from
        # "R0 floorplan".
        fp = row.get("floorplan_amount_zar")
        if isinstance(fp, (int, float)):
            total_floorplan += int(fp)
        # Estimated Gross Profit = Sell Price - (Cost + Expected Recon).
        # We only include rows where BOTH the sell price and the cost
        # are set (recon is treated as 0 when missing since a lot of
        # dealers only capture it once they've actually spent the money).
        sell = row.get("target_sell_price_zar")
        cost = row.get("my_offer_price_zar")
        row_gp: Optional[int] = None
        if isinstance(sell, (int, float)) and isinstance(cost, (int, float)):
            recon = row.get("expected_recon_cost_zar") or 0
            try:
                row_gp = int(sell) - (int(cost) + int(recon))
                total_gp += row_gp
                total_gp_items += 1
            except Exception:
                row_gp = None
        d = row.get("days_in_stock")
        if isinstance(d, int):
            ages.append(d)
            if d > 60:
                over_60 += 1
        bkt = _bucket_days(d)
        buckets[bkt] += 1
        bucket_cost[bkt] += cap_int
        if row_gp is not None:
            bucket_gp[bkt] += row_gp
    items.sort(key=lambda r: r.get("purchased_at") or "", reverse=True)
    avg_age = int(sum(ages) / len(ages)) if ages else None
    return {
        "summary": {
            "total_units": len(items),
            "total_capital_zar": total_capital,
            "total_floorplan_zar": total_floorplan,
            "total_expected_gp_zar": total_gp,
            # Also surface how many rows contributed to the GP total
            # so the UI can add a "on N of M priced units" footnote
            # if the difference is meaningful.
            "gp_priced_units": total_gp_items,
            "avg_age_days": avg_age,
            "over_60_days": over_60,
            "buckets": buckets,
            # Cost + expected GP per aging bucket so the silos on the
            # front-end can show the profit-on-the-line beside the
            # unit count. Same keys as ``buckets``.
            "bucket_cost_zar": bucket_cost,
            "bucket_gp_zar": bucket_gp,
        },
        "items": items,
    }


@router.patch("/stock/{sid}")
async def patch_stock(
    sid: str,
    body: StockPatchIn,
    current: dict = Depends(get_current_user),
):
    """Generic partial update — used by the inline target-price editor
    and the "edit details" modal.  Only managerial users on the owning
    dealership (and admins) can edit.
    """
    item = await db.stock_items.find_one({"id": sid}, {"_id": 0})
    if not item:
        raise HTTPException(404, "Stock item not found")
    if item.get("sold") is True:
        raise HTTPException(400, "Sold vehicles cannot be edited from the stock list.")
    if not await _can_write_stock(current, item):
        raise HTTPException(403, "You can only edit your own dealership's stock.")

    payload = body.model_dump(exclude_none=True)
    if not payload:
        return _row_for_api(item)

    # Stock-number uniqueness (case-insensitive).
    if "stock_number" in payload:
        sn = _norm_stock_number(payload["stock_number"])
        if not sn:
            raise HTTPException(400, "Stock number cannot be empty.")
        if sn != item.get("stock_number"):
            if await _stock_number_taken(item.get("dealership_id"), sn, exclude_id=sid):
                raise HTTPException(409, f"Stock number '{sn}' is already in use.")
        payload["stock_number"] = sn

    payload["updated_at"] = now_utc()
    await db.stock_items.update_one({"id": sid}, {"$set": payload})
    # Denormalised stock_number on the submission for the badge.
    if "stock_number" in payload and item.get("submission_id"):
        await db.submissions.update_one(
            {"id": item["submission_id"]},
            {"$set": {"stock_number": payload["stock_number"]}},
        )
    updated = await db.stock_items.find_one({"id": sid}, {"_id": 0})
    return _row_for_api(updated or item)


@router.post("/stock/{sid}/mark-sold")
async def mark_sold(
    sid: str,
    body: MarkSoldIn,
    current: dict = Depends(get_current_user),
):
    """Record a sale and drop the vehicle from the stock list."""
    item = await db.stock_items.find_one({"id": sid}, {"_id": 0})
    if not item:
        raise HTTPException(404, "Stock item not found")
    if item.get("sold") is True:
        raise HTTPException(400, "This vehicle has already been sold.")
    if not await _can_write_stock(current, item):
        raise HTTPException(403, "You can only sell your own dealership's stock.")

    now_iso = now_utc()
    sold_at_val = body.sold_at or now_iso
    if len(sold_at_val) == 10 and sold_at_val.count("-") == 2:
        sold_at_val = f"{sold_at_val}T00:00:00+00:00"

    days_to_sell = _days_since(item.get("created_at"))
    update = {
        "sold": True,
        "sold_at": sold_at_val,
        "sale_price_zar": _sanitise_deal_int(body.sale_price_zar, "sale_price_zar"),
        "recon_cost_zar": _sanitise_deal_int(body.recon_cost_zar, "recon_cost_zar") if body.recon_cost_zar is not None else 0,
        "buyer_name": (body.buyer_name or "").strip() or None,
        "buyer_notes": (body.buyer_notes or "").strip() or None,
        "days_to_sell": days_to_sell,
        "updated_at": now_iso,
    }
    await db.stock_items.update_one({"id": sid}, {"$set": update})
    logging.info("stock.mark_sold: %s sold for R%s", sid, body.sale_price_zar)
    return {"id": sid, **update}


@router.get("/stock/export.csv")
async def export_stock_csv(current: dict = Depends(get_current_user)):
    scope = await _scope_query(current)
    query = dict(scope)
    query["sold"] = {"$ne": True}
    is_admin = current.get("role") == "admin"
    buf = io.StringIO()
    writer = csv.writer(buf)
    header = [
        "Stock #", "Reference (Submission)", "Year", "Make", "Model", "Derivative",
        "M&M Code", "VIN", "Mileage", "Colour", "Condition Score",
        "My Offer (ZAR)", "Target Sell (ZAR)",
        "Transferred At", "Days in Stock",
    ]
    if is_admin:
        header.append("Dealership")
    writer.writerow(header)
    async for s in db.stock_items.find(query, {"_id": 0}):
        row = _row_for_api(s)
        line = [
            row.get("stock_number") or "",
            row.get("submission_id") or "",
            row.get("year") or "",
            row.get("make_name") or "",
            row.get("model_name") or "",
            row.get("derivative_name") or "",
            row.get("mm_code") or "",
            row.get("vin") or "",
            row.get("mileage") or "",
            row.get("colour") or "",
            row.get("condition_score") if row.get("condition_score") is not None else "",
            row.get("my_offer_price_zar") or "",
            row.get("target_sell_price_zar") or "",
            row.get("purchased_at") or "",
            row.get("days_in_stock") if row.get("days_in_stock") is not None else "",
        ]
        if is_admin:
            line.append(row.get("dealership_name") or "")
        writer.writerow(line)
    csv_bytes = buf.getvalue().encode("utf-8")
    filename = f"stock-{datetime.now(timezone.utc).strftime('%Y%m%d')}.csv"
    return Response(
        content=csv_bytes,
        media_type="text/csv",
        headers={"Content-Disposition": f'attachment; filename="{filename}"'},
    )
