"""Dealer stock list routes.

A submission enters the dealer's "stock" the moment they mark the
deal as done (via the existing Deal Tracking flow → `deal.done = true`
which stamps `deal.purchased_at`), and exits the stock list the moment
they mark it sold (`deal.sold = true` which stamps `deal.sold_at`).

The stock endpoints are pure derived views over the `submissions`
collection — no new collection is introduced.  Two additional fields
are written directly onto `submission.deal` when the dealer interacts
with the stock module:

  * ``target_sell_price_zar``  — editable only from the stock screen
  * ``buyer_name`` / ``buyer_notes`` — captured on the stock "Mark Sold"
    form (in addition to the existing sale_price / recon_cost / sold_at)

Access rules:
  * Dealer callers only see stock owned by their dealership.
  * Admin callers see stock across every dealership (rolled up).

Endpoints:
  * GET   /stock                      — list stock rows + summary metrics
  * PATCH /stock/{sid}/target-price   — set / clear the target sell price
  * POST  /stock/{sid}/mark-sold      — record the sale (stock-management form)
  * GET   /stock/export.csv           — CSV export of the current stock list
"""

from __future__ import annotations

import csv
import io
import logging
from datetime import datetime, timezone
from typing import List, Optional

from fastapi import APIRouter, Depends, HTTPException, Response
from pydantic import BaseModel, Field

from server import (
    db,
    get_current_user,
    now_utc,
    _get_user_dealership_id,
    _valid_front_photo,
    _sanitise_deal_int,
)


router = APIRouter()


# ==================== Models ====================


class TargetPriceIn(BaseModel):
    # Pass null / omit to clear the target sell price.
    target_sell_price_zar: Optional[int] = Field(default=None, ge=0, le=100_000_000)


class MarkSoldIn(BaseModel):
    """Payload for the stock-module "Mark Sold" form.

    All amounts are ZAR integers.  ``sale_price_zar`` is required;
    everything else is optional but strongly encouraged so we can
    surface a proper profit calculation on the Deal Outcomes report.
    """

    sale_price_zar: int = Field(..., ge=0, le=100_000_000)
    recon_cost_zar: Optional[int] = Field(default=0, ge=0, le=100_000_000)
    buyer_name: Optional[str] = Field(default=None, max_length=160)
    buyer_notes: Optional[str] = Field(default=None, max_length=2000)
    # Sold date — dealer can back-date if they're catching up. Stored as
    # ISO-8601. If omitted we stamp `now`.
    sold_at: Optional[str] = Field(default=None, max_length=40)


# ==================== Helpers ====================


def _days_since(iso_ts: Optional[str]) -> Optional[int]:
    """Whole days elapsed between an ISO-8601 timestamp and now (UTC).

    Returns ``None`` if the input is missing or unparseable — the
    stock row will simply hide the aging pill rather than raise.
    """
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


async def _stock_query(current: dict) -> dict:
    """Base query for the stock list — dealership-scoped for dealers,
    unrestricted for admins.  A stock item is a submission with:

        deal.done == True   AND   deal.sold != True
    """
    query: dict = {
        "deal.done": True,
        # `sold` may be missing entirely on older submissions; only
        # exclude explicit True.
        "$or": [
            {"deal.sold": {"$exists": False}},
            {"deal.sold": None},
            {"deal.sold": False},
        ],
    }
    if current.get("role") != "admin":
        my_dship = await _get_user_dealership_id(current)
        if my_dship:
            # Scope to this dealership OR the caller's own submissions
            # (edge case: submissions created before the dealer joined
            # a dealership still have the caller as dealer_id).
            query["$and"] = [
                {
                    "$or": [
                        {"dealership_id": my_dship},
                        {"dealer_id": current.get("id")},
                    ]
                }
            ]
        else:
            query["dealer_id"] = current.get("id")
    return query


def _row_from_sub(sub: dict) -> dict:
    """Shape a submission document into a stock-row for the API."""
    deal = sub.get("deal") or {}
    photos = sub.get("photos") or {}
    purchased_at = deal.get("purchased_at")
    days_in_stock = _days_since(purchased_at)
    my_offer = (
        sub.get("dealer_offer_zar")
        or deal.get("dealer_offer_zar")
    )
    return {
        "id": sub.get("id"),
        "reference": sub.get("reference"),
        "make_name": sub.get("make_name"),
        "model_name": sub.get("model_name"),
        "derivative_name": sub.get("derivative_name"),
        "year": sub.get("year"),
        "mileage": sub.get("mileage"),
        "colour": sub.get("colour"),
        "vin": sub.get("vin"),
        "front_photo": _valid_front_photo(photos.get("front") or photos.get("side")),
        # Prices ---------------------------------------------------------
        "my_offer_price_zar": my_offer,
        "purchase_price_zar": deal.get("purchase_price_zar"),
        "target_sell_price_zar": deal.get("target_sell_price_zar"),
        # Timing ---------------------------------------------------------
        "purchased_at": purchased_at,
        "days_in_stock": days_in_stock,
        # Dealership info — surfaced for admin roll-up view.
        "dealership_id": sub.get("dealership_id"),
        "dealership_name": sub.get("dealership_name"),
    }


def _bucket_days(days: Optional[int]) -> str:
    """Return the age bucket for a stock row."""
    if days is None:
        return "unknown"
    if days <= 30:
        return "0-30"
    if days <= 60:
        return "31-60"
    if days <= 90:
        return "61-90"
    return "90+"


# ==================== Endpoints ====================


@router.get("/stock")
async def list_stock(current: dict = Depends(get_current_user)):
    """List every vehicle currently in the caller's stock.

    Response shape::

        {
          "summary": {
             "total_units":    int,
             "total_capital_zar": int,   # sum of purchase prices (fallback to my_offer)
             "avg_age_days":   int|None,
             "over_60_days":   int,       # count of aging stock
             "buckets": {"0-30": n, "31-60": n, "61-90": n, "90+": n, "unknown": n}
          },
          "items": [ { ...row } ]
        }
    """
    query = await _stock_query(current)
    projection = {
        "_id": 0,
        "id": 1, "reference": 1,
        "make_name": 1, "model_name": 1, "derivative_name": 1,
        "year": 1, "mileage": 1, "colour": 1, "vin": 1,
        "photos": 1, "deal": 1, "dealer_offer_zar": 1,
        "dealership_id": 1, "dealership_name": 1,
    }
    items: List[dict] = []
    total_capital = 0
    ages: List[int] = []
    buckets = {"0-30": 0, "31-60": 0, "61-90": 0, "90+": 0, "unknown": 0}
    over_60 = 0
    async for s in db.submissions.find(query, projection):
        row = _row_from_sub(s)
        items.append(row)
        # Capital tied up = purchase price if recorded, else the dealer's
        # own offer (the amount they've committed to on this car). We
        # deliberately never fall back to the Fourbuy cover price per
        # product spec.
        cap = row.get("purchase_price_zar") or row.get("my_offer_price_zar") or 0
        try:
            total_capital += int(cap or 0)
        except Exception:
            pass
        d = row.get("days_in_stock")
        if isinstance(d, int):
            ages.append(d)
            if d > 60:
                over_60 += 1
        buckets[_bucket_days(d)] += 1

    # Newest deal-done first by default — keeps the freshest inventory
    # at the top and the aging stock further down. Front-end can still
    # sort client-side.
    items.sort(key=lambda r: r.get("purchased_at") or "", reverse=True)

    avg_age = int(sum(ages) / len(ages)) if ages else None
    return {
        "summary": {
            "total_units": len(items),
            "total_capital_zar": total_capital,
            "avg_age_days": avg_age,
            "over_60_days": over_60,
            "buckets": buckets,
        },
        "items": items,
    }


@router.patch("/stock/{sid}/target-price")
async def set_target_price(
    sid: str,
    body: TargetPriceIn,
    current: dict = Depends(get_current_user),
):
    """Set / clear the target sell price for a stock item.

    Editable only from the stock module (per product spec). Guarded by
    the same dealership-scope rules as the stock listing.
    """
    sub = await db.submissions.find_one({"id": sid}, {"_id": 0})
    if not sub:
        raise HTTPException(404, "Submission not found")

    # Reuse the stock scope for the access check so we never leak edit
    # rights across dealerships.
    if current.get("role") != "admin":
        my_dship = await _get_user_dealership_id(current)
        owner = sub.get("dealership_id")
        if not (owner and owner == my_dship) and sub.get("dealer_id") != current.get("id"):
            raise HTTPException(403, "You can only edit your own dealership's stock.")

    deal = dict(sub.get("deal") or {})
    if deal.get("done") is not True:
        raise HTTPException(400, "Only vehicles marked 'Deal Done' are on the stock list.")
    if deal.get("sold") is True:
        raise HTTPException(400, "This vehicle has already been sold.")

    val = body.target_sell_price_zar
    deal["target_sell_price_zar"] = val
    deal["target_sell_price_updated_at"] = now_utc()
    deal["target_sell_price_updated_by"] = current.get("id")

    await db.submissions.update_one({"id": sid}, {"$set": {"deal": deal}})
    return {"id": sid, "target_sell_price_zar": val}


@router.post("/stock/{sid}/mark-sold")
async def mark_sold(
    sid: str,
    body: MarkSoldIn,
    current: dict = Depends(get_current_user),
):
    """Move a stock item out of the stock list.

    Writes the standard deal-tracking sold fields **and** the
    stock-module extras (buyer_name, buyer_notes) so the record can
    be reported back on later.  The vehicle immediately falls off the
    stock listing on the next `GET /stock`.
    """
    sub = await db.submissions.find_one({"id": sid}, {"_id": 0})
    if not sub:
        raise HTTPException(404, "Submission not found")

    # Same scope as `target-price` — dealership managerial + admin.
    if current.get("role") != "admin":
        if not current.get("is_pricing_agent"):
            raise HTTPException(
                403,
                "Only managerial users on this dealership can record a sale.",
            )
        my_dship = await _get_user_dealership_id(current)
        owner = sub.get("dealership_id")
        if not (owner and owner == my_dship) and sub.get("dealer_id") != current.get("id"):
            raise HTTPException(403, "You can only sell your own dealership's stock.")

    deal = dict(sub.get("deal") or {})
    if deal.get("done") is not True:
        raise HTTPException(400, "Mark the purchase as done before recording a sale.")
    if deal.get("sold") is True:
        raise HTTPException(400, "This vehicle has already been sold.")

    now_iso = now_utc()
    sold_at_val = body.sold_at or now_iso
    # Normalise: if the caller supplied a plain YYYY-MM-DD, expand it.
    if len(sold_at_val) == 10 and sold_at_val.count("-") == 2:
        sold_at_val = f"{sold_at_val}T00:00:00+00:00"

    deal["sold"] = True
    deal["sold_at"] = sold_at_val
    deal["sale_price_zar"] = _sanitise_deal_int(body.sale_price_zar, "sale_price_zar")
    if body.recon_cost_zar is not None:
        deal["recon_cost_zar"] = _sanitise_deal_int(body.recon_cost_zar, "recon_cost_zar")
    if body.buyer_name is not None:
        deal["buyer_name"] = (body.buyer_name or "").strip() or None
    if body.buyer_notes is not None:
        deal["buyer_notes"] = (body.buyer_notes or "").strip() or None
    deal["updated_at"] = now_iso
    deal["updated_by_user_id"] = current.get("id")
    info = current.get("dealer_info") or {}
    actor = (
        f"{info.get('first_name','').strip()} {info.get('last_name','').strip()}".strip()
        or current.get("email")
        or "—"
    )
    deal["updated_by_name"] = actor
    # Days-to-sell (helpful stat for reports later).
    deal["days_to_sell"] = _days_since(deal.get("purchased_at"))

    await db.submissions.update_one({"id": sid}, {"$set": {"deal": deal}})
    logging.info("stock.mark_sold: submission %s sold for R%s by %s", sid, body.sale_price_zar, actor)
    return {
        "id": sid,
        "sold": True,
        "sold_at": deal["sold_at"],
        "sale_price_zar": deal["sale_price_zar"],
        "days_to_sell": deal.get("days_to_sell"),
    }


@router.get("/stock/export.csv")
async def export_stock_csv(current: dict = Depends(get_current_user)):
    """Return the current stock list as a CSV attachment.

    Columns are chosen to be self-explanatory for a manager scanning
    the file offline (dealer + branch shown only for the admin
    roll-up).
    """
    query = await _stock_query(current)
    projection = {
        "_id": 0,
        "id": 1, "reference": 1,
        "make_name": 1, "model_name": 1, "derivative_name": 1,
        "year": 1, "mileage": 1, "colour": 1, "vin": 1,
        "deal": 1, "dealer_offer_zar": 1,
        "dealership_id": 1, "dealership_name": 1,
    }
    is_admin = current.get("role") == "admin"
    buf = io.StringIO()
    writer = csv.writer(buf)
    header = [
        "Reference", "Year", "Make", "Model", "Derivative", "VIN",
        "Mileage", "Colour",
        "My Offer (ZAR)", "Purchase Price (ZAR)", "Target Sell (ZAR)",
        "Purchased At", "Days in Stock",
    ]
    if is_admin:
        header.append("Dealership")
    writer.writerow(header)
    async for s in db.submissions.find(query, projection):
        row = _row_from_sub(s)
        line = [
            row.get("reference") or "",
            row.get("year") or "",
            row.get("make_name") or "",
            row.get("model_name") or "",
            row.get("derivative_name") or "",
            row.get("vin") or "",
            row.get("mileage") or "",
            row.get("colour") or "",
            row.get("my_offer_price_zar") or "",
            row.get("purchase_price_zar") or "",
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
