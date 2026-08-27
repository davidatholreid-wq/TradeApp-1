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
from io import BytesIO
from typing import Any, Optional

from fastapi import APIRouter, Depends, HTTPException, Query
from fastapi.responses import Response
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
from services.porsche_vin import decode_porsche_vin, is_porsche_supported_make
from services.ferrari_vin import decode_ferrari_vin, is_ferrari_supported_make

# Late-import from `server` — safe because this file is only imported
# at the bottom of `server.py` once all these names are defined.
from server import db, get_current_user, get_user_flexible, now_utc, logger

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
    {
        "id": "kredo_cartrust",
        "label": "CarTrust NaTIS History",
        "cost_zar": 100,
        "blurb": "NaTIS-linked ownership history, colour, engine/chassis alignment and mileage timeline.",
        # CarTrust works for any registered SA vehicle regardless of make.
        "supports": lambda make: True,
    },
    {
        "id": "porsche_vin",
        "label": "Porsche VIN Decode",
        "cost_zar": 20,
        "blurb": "Rule-based Porsche VIN decode — model, generation, model year, factory and production sequence.",
        "supports": is_porsche_supported_make,
    },
    {
        "id": "ferrari_vin",
        "label": "Ferrari VIN Decode",
        "cost_zar": 20,
        "blurb": "Rule-based Ferrari VIN decode — model family, era, model year, plant and production sequence.",
        "supports": is_ferrari_supported_make,
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
    """Return a de-duplicated list of makes the platform knows about.

    Union of THREE sources so no dealer ever gets stuck without a make:
      1. ``db.makes`` — the canonical catalog seeded from admin. This
         matches what dealers see when submitting a valuation and is
         the source of truth for "makes the platform supports today".
      2. Outvin's supported-marque list — even if a make isn't in the
         admin catalog yet, if Outvin covers it we should still let
         users pull an OEM decode.
      3. ``Porsche`` and ``Ferrari`` — served by our own rule-based
         VIN decoders (no vendor dependency).

    All three are merged case-insensitively, then sorted alphabetically.
    """
    # Start with the admin-managed catalog — this is the same list the
    # /submit picker uses so dealers see a coherent set of makes.
    catalog = await db.makes.find({}, {"_id": 0, "name": 1}).to_list(1000)
    names: list[str] = [m.get("name") for m in catalog if m.get("name")]

    # Merge in vendor-supported makes we might not have in the catalog
    # yet — Outvin covers ~30+ marques (very broad), plus Porsche and
    # Ferrari for our rule-based decoders.
    for extra in list(OUTVIN_SUPPORTED_MAKES) + ["Porsche", "Ferrari"]:
        if not any(str(m).strip().upper() == extra.strip().upper() for m in names):
            names.append(extra)

    names.sort(key=lambda s: str(s).upper())
    return {"makes": names}


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
    # Required only for kredo_cartrust — the NaTIS registry key on
    # this VIN + the current odometer. The frontend prompts for these
    # inline when CarTrust is selected.
    registration_number: Optional[str] = None
    mileage: Optional[int] = None
    vehicle_condition: Optional[str] = None


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
    # Suspension guard — dealerships with a depleted wallet balance
    # cannot pull new VIN reports. Applied at the top so we don't burn
    # a Kredo/Bimmervin API call before failing.
    from routes.billing import assert_dealership_active as _assert_active_billing
    if current.get("role") == "dealer" and current.get("dealership_id"):
        await _assert_active_billing(current["dealership_id"], feature="VIN reports")
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
    is_async_pending = False   # Set true for cartrust — bill on callback
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
        elif entry["id"] == "kredo_cartrust":
            # CarTrust is an async webhook-based report. The dealer
            # must supply a license plate + mileage — VIN alone isn't
            # enough for Kredo's NaTIS lookup. We store the order as
            # `pending`, kick off Kredo, and let the existing
            # /api/kredo/cartrust/callback fill in the PDF once ready.
            reg = (payload.registration_number or "").strip().upper().replace(" ", "")
            if len(reg) < 4:
                raise HTTPException(400, "Registration number is required to order a CarTrust report.")
            mileage_val = int(payload.mileage or 0)
            if mileage_val <= 0:
                raise HTTPException(400, "A valid mileage (km) is required to order a CarTrust report.")
            condition = (payload.vehicle_condition or "Used").strip() or "Used"

            # Build a friendly requester profile from whatever the caller
            # has attached to their user row.
            dealer_info = current.get("dealer_info") or {}
            ack = await get_kredo_client().order_cartrust_pdf(
                requester_name=(dealer_info.get("first_name") or current.get("name") or current.get("email") or "Dealer"),
                requester_surname=(dealer_info.get("last_name") or "User"),
                requester_email=current.get("email") or "noreply@tradeapp.co.za",
                requester_phone=(dealer_info.get("phone") or "0000000000"),
                vin=vin,
                registration_number=reg,
                mileage=mileage_val,
                vehicle_condition=condition,
                manufacturer=make,
            )
            # We DON'T bill / complete here — Kredo will POST to
            # /api/kredo/cartrust/callback with the presigned PDF URL
            # (usually inside 60 seconds). The callback updates the
            # same order row.
            await db.vin_report_orders.update_one(
                {"id": order_id},
                {"$set": {
                    "status": "pending",
                    "kredo_ack": ack,
                    "kredo_client_guid": (ack or {}).get("client_guid"),
                    "registration_number": reg,
                    "mileage": mileage_val,
                    "vehicle_condition": condition,
                }},
            )
            is_async_pending = True
            result = None   # not ready yet
        elif entry["id"] == "porsche_vin":
            # Pure rule-based decode — no external call, no failure
            # mode beyond "malformed VIN" which we surface as a 400
            # via the catalog dispatch machinery below.
            decoded = decode_porsche_vin(vin)
            if decoded.get("status") != "ok":
                raise HTTPException(400, decoded.get("error") or "Could not decode VIN.")
            result = decoded
        elif entry["id"] == "ferrari_vin":
            decoded = decode_ferrari_vin(vin)
            if decoded.get("status") != "ok":
                raise HTTPException(400, decoded.get("error") or "Could not decode VIN.")
            result = decoded
        else:
            raise RuntimeError(f"Report dispatcher missing for {entry['id']}")
    except KredoAPIError as e:
        error = f"Kredo error: {e}"
    except HTTPException as e:
        # 4xx from client-side validation (missing plate, bad mileage,
        # decoder rejecting VIN etc) must propagate unchanged — those
        # tell the caller EXACTLY what to fix and are not vendor
        # failures. Only 5xx-shape HTTPExceptions get collapsed into
        # the generic 502 "report failed" envelope below.
        if getattr(e, "status_code", 500) < 500:
            # Mark the order as failed so it doesn't linger in `pending`
            # forever, then re-raise the original 4xx verbatim.
            await db.vin_report_orders.update_one(
                {"id": order_id},
                {"$set": {
                    "status": "failed",
                    "error": str(getattr(e, "detail", e)),
                    "completed_at": now_utc(),
                }},
            )
            raise
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

    # Async report — return the pending row immediately. Kredo's callback
    # will flip it to `completed` (billing + PDF stamped there).
    if is_async_pending:
        row = await db.vin_report_orders.find_one({"id": order_id}, {"_id": 0})
        return {"order": row, "async_pending": True}

    # Some vendors return empty payloads for VINs they don't have —
    # treat those as failed so we don't bill for nothing. Bimmervin /
    # MBTools / Outvin also return `{"status": "error", "error": "..."}`
    # dicts (truthy but semantically failed) — recognise those too.
    if not result or (isinstance(result, dict) and str(result.get("status") or "").lower() == "error"):
        err_msg = "The vendor has no data for this VIN."
        if isinstance(result, dict):
            vendor_err = result.get("error") or result.get("message")
            if vendor_err:
                err_msg = str(vendor_err)
        await db.vin_report_orders.update_one(
            {"id": order_id},
            {"$set": {
                "status": "failed",
                "error": err_msg,
                "completed_at": now_utc(),
            }},
        )
        # 404 so the client can present a clear "no data — not billed"
        # message. Bill status is unchanged from the initial insert
        # (billed=false, cost_zar=0), so the caller is never charged.
        raise HTTPException(404, err_msg)

    # Success — bill the caller and persist the payload.
    billed = int(entry["cost_zar"] or 0) > 0
    completed_at = now_utc()
    # Stamp `billing_charge_cents` so the billing wallet debits this
    # amount when it recomputes. Aug 2026 wallet-based billing.
    billing_charge_cents = int(round(float(entry["cost_zar"] or 0) * 100))
    await db.vin_report_orders.update_one(
        {"id": order_id},
        {"$set": {
            "status": "completed",
            "cost_zar": entry["cost_zar"],
            "billing_charge_cents": billing_charge_cents,
            "billed": billed,
            "result_data": result,
            "completed_at": completed_at,
        }},
    )
    if dealer_id and billing_charge_cents:
        try:
            from routes.billing import _recompute_wallet as _bill_recompute
            await _bill_recompute(dealer_id)
        except Exception as e:
            logger.warning("VIN report wallet debit stamp failed (non-blocking): %s", e)

    # Mirror the completed order into `db.report_orders` — the canonical
    # billing collection queried by BOTH the dealer's `/api/billing/my`
    # and admin's `/api/admin/billing` endpoints. Without this mirror
    # row the charge would silently disappear from every invoice /
    # monthly tally. `submission_id` is deliberately null (this is a
    # standalone VIN order, not tied to a valuation) — the billing
    # renderer already handles that case cleanly. Idempotent on the
    # vin_report_orders `id` so a retry never double-bills.
    if dealer_id:
        await db.report_orders.update_one(
            {"vin_report_order_id": order_id},
            {"$setOnInsert": {
                "id": order_id,
                "vin_report_order_id": order_id,   # link back for audit
                "submission_id": None,
                "dealer_id": current["id"],
                "dealership_id": dealer_id,
                "vin": vin,
                "make": make,
                "type": f"vin_reports.{entry['id']}",
                "name": entry["label"],
                "cost_zar": entry["cost_zar"],
                "status": "delivered",
                "ordered_at": completed_at,
                "ordered_by": current["id"],
                "ordered_by_name": current.get("name") or current.get("email"),
                "delivered_at": completed_at,
                "note": "Standalone VIN Report — no submission attached.",
                "billed": billed,
            }},
            upsert=True,
        )

    logger.info(
        "vin_reports: order %s completed — %s / %s / %s (R%s, billed=%s)",
        order_id, entry["id"], make, vin, entry["cost_zar"], billed,
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



# ---------------------------------------------------------------------------
# GET /api/vin-reports/{order_id}/pdf — downloadable / previewable PDF
# ---------------------------------------------------------------------------
def _build_vin_report_pdf(order: dict) -> bytes:
    """Render a completed VIN report order as a single-file PDF.

    The layout is deliberately simple + consistent across all four
    vendors so dealers get a predictable printable document:
        1. Dark brand header with report title + VIN
        2. Meta grid — Make, Report Type, Ordered By, Ordered At, Cost
        3. Body — vendor-specific structured tables (claims list for
           Kredo; factory-option tables for Bimmervin/MBTools/Outvin)
    """
    from reportlab.lib.pagesizes import A4
    from reportlab.lib.styles import getSampleStyleSheet, ParagraphStyle
    from reportlab.lib.units import mm
    from reportlab.lib import colors as rl_colors
    from reportlab.platypus import (
        SimpleDocTemplate, Paragraph, Spacer, Table, TableStyle,
        KeepTogether, PageBreak,
    )

    styles = getSampleStyleSheet()
    body = ParagraphStyle("body", parent=styles["Normal"], fontSize=10, leading=13)
    small = ParagraphStyle("small", parent=styles["Normal"], fontSize=8, leading=11, textColor=rl_colors.grey)
    h_section = ParagraphStyle(
        "h_section", parent=styles["Heading2"],
        fontSize=11, leading=14, textColor=rl_colors.HexColor("#0F172A"),
        spaceBefore=10, spaceAfter=6, textTransform="uppercase",
    )

    buf = BytesIO()
    doc = SimpleDocTemplate(
        buf, pagesize=A4,
        leftMargin=15 * mm, rightMargin=15 * mm,
        topMargin=12 * mm, bottomMargin=15 * mm,
        title=f"{order.get('report_label') or 'VIN Report'} · {order.get('vin') or ''}",
        author="TradeAPP",
    )
    story: list = []

    # ---- Brand header ----
    header_rows = [[
        Paragraph(
            "<font color='white' size='16'><b>TRADEAPP VIN REPORT</b></font><br/>"
            f"<font color='white' size='10'>{order.get('report_label') or order.get('report_type') or ''}</font>",
            body,
        ),
        Paragraph(
            "<font color='white' size='8'>VIN</font><br/>"
            f"<font color='white' size='11'><b>{order.get('vin') or '—'}</b></font>",
            body,
        ),
    ]]
    header_tbl = Table(header_rows, colWidths=[120 * mm, 60 * mm])
    header_tbl.setStyle(TableStyle([
        ("BACKGROUND", (0, 0), (-1, -1), rl_colors.HexColor("#0F172A")),
        ("LEFTPADDING", (0, 0), (-1, -1), 12),
        ("RIGHTPADDING", (0, 0), (-1, -1), 12),
        ("TOPPADDING", (0, 0), (-1, -1), 12),
        ("BOTTOMPADDING", (0, 0), (-1, -1), 12),
        ("VALIGN", (0, 0), (-1, -1), "MIDDLE"),
    ]))
    story.append(header_tbl)

    # Accent strip
    strip = Table([[""]], colWidths=[180 * mm], rowHeights=[3])
    strip.setStyle(TableStyle([("BACKGROUND", (0, 0), (-1, -1), rl_colors.HexColor("#22C55E"))]))
    story.append(strip)
    story.append(Spacer(1, 4 * mm))

    # ---- Meta grid ----
    ordered_at = (order.get("ordered_at") or "")
    if hasattr(ordered_at, "isoformat"):
        ordered_at = ordered_at.isoformat()
    ordered_at_display = str(ordered_at)[:19].replace("T", " ")
    cost = int(order.get("cost_zar") or 0)
    cost_display = f"R{cost}" if cost > 0 else "Free"
    meta = [
        [Paragraph("<b>MAKE</b>", small), Paragraph((order.get("make") or "—"), body)],
        [Paragraph("<b>REPORT TYPE</b>", small), Paragraph(order.get("report_label") or order.get("report_type") or "—", body)],
        [Paragraph("<b>ORDERED BY</b>", small), Paragraph(order.get("ordered_by_name") or "—", body)],
        [Paragraph("<b>ORDERED AT</b>", small), Paragraph(ordered_at_display, body)],
        [Paragraph("<b>COST</b>", small), Paragraph(cost_display, body)],
    ]
    meta_tbl = Table(meta, colWidths=[45 * mm, 135 * mm])
    meta_tbl.setStyle(TableStyle([
        ("VALIGN", (0, 0), (-1, -1), "TOP"),
        ("LEFTPADDING", (0, 0), (-1, -1), 6),
        ("RIGHTPADDING", (0, 0), (-1, -1), 6),
        ("TOPPADDING", (0, 0), (-1, -1), 5),
        ("BOTTOMPADDING", (0, 0), (-1, -1), 5),
        ("BACKGROUND", (0, 0), (0, -1), rl_colors.HexColor("#F1F5F9")),
        ("LINEBELOW", (0, 0), (-1, -1), 0.25, rl_colors.HexColor("#E2E8F0")),
    ]))
    story.append(meta_tbl)
    story.append(Spacer(1, 6 * mm))

    # ---- Body — per report type ----
    rd = order.get("result_data") or {}
    rtype = order.get("report_type") or ""

    def _kv_table(pairs: list[tuple[str, Any]]) -> Table:
        rows = [[Paragraph(f"<b>{k}</b>", small), Paragraph(str(v) if v is not None else "—", body)] for k, v in pairs]
        t = Table(rows, colWidths=[55 * mm, 125 * mm])
        t.setStyle(TableStyle([
            ("LEFTPADDING", (0, 0), (-1, -1), 6),
            ("RIGHTPADDING", (0, 0), (-1, -1), 6),
            ("TOPPADDING", (0, 0), (-1, -1), 4),
            ("BOTTOMPADDING", (0, 0), (-1, -1), 4),
            ("VALIGN", (0, 0), (-1, -1), "TOP"),
            ("LINEBELOW", (0, 0), (-1, -1), 0.25, rl_colors.HexColor("#E2E8F0")),
        ]))
        return t

    if rtype == "vin_history":
        claims = rd.get("claims") or []
        story.append(Paragraph(f"Claims on file: {len(claims)}", h_section))
        if not claims:
            story.append(Paragraph(
                "No accident or insurance claim history recorded for this VIN.",
                body,
            ))
        else:
            hdr = [
                Paragraph("<b>Date</b>", small),
                Paragraph("<b>Vehicle</b>", small),
                Paragraph("<b>Mileage</b>", small),
                Paragraph("<b>Damage</b>", small),
            ]
            rows = [hdr]
            for c in claims:
                veh = f"{c.get('manufacturer') or ''} {c.get('model') or ''}".strip() or "—"
                mileage = c.get("mileage_at_claim")
                mileage_txt = f"{int(mileage):,} km" if mileage not in (None, "") else "—"
                dmg = ", ".join(c.get("damage_locations") or []) or ("Glass" if c.get("glass_damage") else "—")
                rows.append([
                    Paragraph(str(c.get("accident_date") or c.get("creation_date") or "—")[:10], body),
                    Paragraph(veh, body),
                    Paragraph(mileage_txt, body),
                    Paragraph(dmg, body),
                ])
            t = Table(rows, colWidths=[28 * mm, 68 * mm, 30 * mm, 54 * mm], repeatRows=1)
            t.setStyle(TableStyle([
                ("BACKGROUND", (0, 0), (-1, 0), rl_colors.HexColor("#F1F5F9")),
                ("LEFTPADDING", (0, 0), (-1, -1), 5),
                ("RIGHTPADDING", (0, 0), (-1, -1), 5),
                ("TOPPADDING", (0, 0), (-1, -1), 4),
                ("BOTTOMPADDING", (0, 0), (-1, -1), 4),
                ("LINEBELOW", (0, 0), (-1, -1), 0.25, rl_colors.HexColor("#E2E8F0")),
                ("VALIGN", (0, 0), (-1, -1), "TOP"),
            ]))
            story.append(t)
    elif rtype == "porsche_vin":
        # Porsche VIN Decode — no options / equipment list (that would
        # require the option label from the actual car). We render the
        # decoded identity fields plus a position-by-position VIN
        # breakdown so the dealer can see exactly what each digit means.
        pairs: list[tuple[str, Any]] = [
            ("Model", rd.get("model")),
            ("Generation", rd.get("generation") or "—"),
            ("Model Year", rd.get("model_year") or "—"),
            ("Type Code", rd.get("model_code") or "—"),
            ("Vehicle Class", rd.get("vehicle_class") or "—"),
            ("Market", rd.get("market") or "—"),
            ("Manufacturer Country", rd.get("country") or "—"),
            ("Factory", rd.get("factory") or "—"),
            ("Production Serial", rd.get("serial") or "—"),
        ]
        if rd.get("check_digit_valid") is not None:
            pairs.append((
                "NA Check Digit",
                "Valid" if rd.get("check_digit_valid") else f"Invalid (computed {rd.get('check_digit_computed')} vs printed {rd.get('check_digit')})",
            ))
        story.append(Paragraph("Decoded identity", h_section))
        story.append(_kv_table(pairs))
        story.append(Spacer(1, 4 * mm))

        # VIN-position breakdown
        story.append(Paragraph("VIN position-by-position", h_section))
        pos = rd.get("positions") or {}
        pos_rows = [[
            Paragraph("<b>Position</b>", small),
            Paragraph("<b>Character(s)</b>", small),
            Paragraph("<b>Meaning</b>", small),
        ]]
        pos_meta = [
            ("1", "Country of origin (WMI)"),
            ("2", "Manufacturer (P = Porsche)"),
            ("3", "Vehicle class (0 = sports car, 1 = SUV)"),
            ("4-6", "ROW filler or NA body / engine / restraint"),
            ("7", "Model code high (ROW) / era identifier (NA)"),
            ("8", "Model code middle"),
            ("9", "ROW filler / NA check digit"),
            ("10", "Model year code"),
            ("11", "Factory / assembly plant"),
            ("12", "Model code low"),
            ("13-17", "Production serial sequence"),
        ]
        for key, meaning in pos_meta:
            if key == "4-6":
                val = f"{pos.get('4', '')}{pos.get('5', '')}{pos.get('6', '')}"
            elif key == "13-17":
                val = pos.get("13-17") or ""
            else:
                val = pos.get(key) or ""
            pos_rows.append([
                Paragraph(key, body),
                Paragraph(str(val), body),
                Paragraph(meaning, body),
            ])
        t = Table(pos_rows, colWidths=[22 * mm, 30 * mm, 128 * mm], repeatRows=1)
        t.setStyle(TableStyle([
            ("BACKGROUND", (0, 0), (-1, 0), rl_colors.HexColor("#F1F5F9")),
            ("LEFTPADDING", (0, 0), (-1, -1), 5),
            ("RIGHTPADDING", (0, 0), (-1, -1), 5),
            ("TOPPADDING", (0, 0), (-1, -1), 4),
            ("BOTTOMPADDING", (0, 0), (-1, -1), 4),
            ("LINEBELOW", (0, 0), (-1, -1), 0.25, rl_colors.HexColor("#E2E8F0")),
            ("VALIGN", (0, 0), (-1, -1), "TOP"),
        ]))
        story.append(t)

        if rd.get("warnings"):
            story.append(Spacer(1, 4 * mm))
            story.append(Paragraph("Notes", h_section))
            for w in rd["warnings"]:
                story.append(Paragraph(f"• {w}", body))

        story.append(Spacer(1, 4 * mm))
        story.append(Paragraph(
            f"<font color='#64748B'>{rd.get('disclaimer') or ''}</font>",
            small,
        ))
    elif rtype == "ferrari_vin":
        # Ferrari VIN Decode — same shape as porsche_vin but with the
        # extra engine / safety / market codes surfaced separately
        # because Ferrari's VDS carries three distinct sub-fields.
        pairs: list[tuple[str, Any]] = [
            ("Model", rd.get("model")),
            ("Era", rd.get("era") or "—"),
            ("Model Year", rd.get("model_year") or "—"),
            ("Type Code", rd.get("model_code") or "—"),
            ("Engine Code", rd.get("engine_code") or "—"),
            ("Safety System Code", rd.get("safety_code") or "—"),
            ("Market", rd.get("market") or "—"),
            ("Manufacturer Country", rd.get("country") or "—"),
            ("WMI", rd.get("wmi") or "—"),
            ("Plant", rd.get("plant") or "—"),
            ("VIN Layout", rd.get("layout") or "—"),
            ("Production Serial", rd.get("serial") or "—"),
        ]
        if rd.get("check_digit_valid") is not None:
            pairs.append((
                "NA Check Digit",
                "Valid" if rd.get("check_digit_valid") else f"Invalid (computed {rd.get('check_digit_computed')} vs printed {rd.get('check_digit')})",
            ))
        story.append(Paragraph("Decoded identity", h_section))
        story.append(_kv_table(pairs))
        story.append(Spacer(1, 4 * mm))

        story.append(Paragraph("VIN position-by-position", h_section))
        pos = rd.get("positions") or {}
        pos_rows = [[
            Paragraph("<b>Position</b>", small),
            Paragraph("<b>Character(s)</b>", small),
            Paragraph("<b>Meaning</b>", small),
        ]]
        pos_meta = [
            ("1-3", "WMI (world manufacturer identifier)"),
            ("4", "Model or engine (era-dependent)"),
            ("5", "Model or safety system (era-dependent)"),
            ("6", "Engine or model (era-dependent)"),
            ("7", "Safety system or model (era-dependent)"),
            ("8", "Market"),
            ("9", "Check digit (NA cars) / filler"),
            ("10", "Model year code"),
            ("11", "Assembly plant"),
            ("12-17", "Production serial sequence"),
        ]
        for key, meaning in pos_meta:
            if key == "1-3":
                val = f"{pos.get('1', '')}{pos.get('2', '')}{pos.get('3', '')}"
            elif key == "12-17":
                val = pos.get("12-17") or ""
            else:
                val = pos.get(key) or ""
            pos_rows.append([
                Paragraph(key, body),
                Paragraph(str(val), body),
                Paragraph(meaning, body),
            ])
        t = Table(pos_rows, colWidths=[22 * mm, 30 * mm, 128 * mm], repeatRows=1)
        t.setStyle(TableStyle([
            ("BACKGROUND", (0, 0), (-1, 0), rl_colors.HexColor("#F1F5F9")),
            ("LEFTPADDING", (0, 0), (-1, -1), 5),
            ("RIGHTPADDING", (0, 0), (-1, -1), 5),
            ("TOPPADDING", (0, 0), (-1, -1), 4),
            ("BOTTOMPADDING", (0, 0), (-1, -1), 4),
            ("LINEBELOW", (0, 0), (-1, -1), 0.25, rl_colors.HexColor("#E2E8F0")),
            ("VALIGN", (0, 0), (-1, -1), "TOP"),
        ]))
        story.append(t)

        if rd.get("warnings"):
            story.append(Spacer(1, 4 * mm))
            story.append(Paragraph("Notes", h_section))
            for w in rd["warnings"]:
                story.append(Paragraph(f"• {w}", body))

        story.append(Spacer(1, 4 * mm))
        story.append(Paragraph(
            f"<font color='#64748B'>{rd.get('disclaimer') or ''}</font>",
            small,
        ))
    else:
        # OEM datacard style — build meta first, then options table.
        summary = rd.get("summary") or rd.get("header") or rd.get("vehicle") or {}
        model_line = " ".join(str(x) for x in [rd.get("model"), rd.get("series"), rd.get("type_key")] if x)
        build = rd.get("build_date") or rd.get("first_registration")
        story.append(Paragraph("Vehicle build data", h_section))
        pairs: list[tuple[str, Any]] = []
        if model_line:
            pairs.append(("Model", model_line))
        if build:
            pairs.append(("Build / First Reg", str(build)[:10]))
        # Common Outvin/MBTools fields
        for k in ("colour_code", "fabric_code", "engine_number", "engine_type", "transmission", "fa_version"):
            v = rd.get(k) or (summary.get(k) if isinstance(summary, dict) else None)
            if v:
                pairs.append((k.replace("_", " ").title(), v))
        # Anything from summary block
        if isinstance(summary, dict):
            for k, v in list(summary.items())[:8]:
                if v not in (None, "", []) and (k, v) not in pairs:
                    pairs.append((str(k).replace("_", " ").title(), v))
        if pairs:
            story.append(_kv_table(pairs))
            story.append(Spacer(1, 4 * mm))

        # Options / equipment table
        options = rd.get("options") or rd.get("factory_options") or rd.get("equipment") or []
        if isinstance(options, list) and options:
            story.append(Paragraph(f"Factory options ({len(options)})", h_section))
            rows = [[
                Paragraph("<b>Code</b>", small),
                Paragraph("<b>Description</b>", small),
            ]]
            for opt in options[:400]:
                if isinstance(opt, dict):
                    code = opt.get("code") or opt.get("option_code") or opt.get("id") or "—"
                    desc = opt.get("description") or opt.get("name") or opt.get("label") or ""
                    rows.append([
                        Paragraph(str(code), body),
                        Paragraph(str(desc), body),
                    ])
                else:
                    rows.append([Paragraph("—", body), Paragraph(str(opt), body)])
            t = Table(rows, colWidths=[30 * mm, 150 * mm], repeatRows=1)
            t.setStyle(TableStyle([
                ("BACKGROUND", (0, 0), (-1, 0), rl_colors.HexColor("#F1F5F9")),
                ("LEFTPADDING", (0, 0), (-1, -1), 5),
                ("RIGHTPADDING", (0, 0), (-1, -1), 5),
                ("TOPPADDING", (0, 0), (-1, -1), 4),
                ("BOTTOMPADDING", (0, 0), (-1, -1), 4),
                ("LINEBELOW", (0, 0), (-1, -1), 0.25, rl_colors.HexColor("#E2E8F0")),
                ("VALIGN", (0, 0), (-1, -1), "TOP"),
            ]))
            story.append(t)
        elif not pairs:
            story.append(Paragraph("No structured data returned by the vendor.", body))

    # Footer note
    story.append(Spacer(1, 6 * mm))
    story.append(Paragraph(
        "<font color='#64748B'>Generated by TradeAPP · Data provided by third-party vendors.</font>",
        small,
    ))

    doc.build(story)
    buf.seek(0)
    return buf.read()


@router.get("/vin-reports/{order_id}/pdf")
async def get_order_pdf(
    order_id: str,
    access_token: Optional[str] = Query(None, description="JWT via URL for direct WebBrowser opens."),
    current: dict = Depends(get_user_flexible),
):
    row = await db.vin_report_orders.find_one({"id": order_id}, {"_id": 0})
    if not row:
        raise HTTPException(404, "Order not found")
    if current.get("role") != "admin" and row.get("user_id") != current["id"]:
        raise HTTPException(403, "You cannot access this order")
    if (row.get("status") or "") != "completed":
        raise HTTPException(400, "Report is not ready yet.")

    # CarTrust is a vendor-hosted PDF — Kredo delivers a fully-formatted
    # NaTIS report we cannot recreate. Serve those bytes directly rather
    # than the local ReportLab builder.
    if row.get("report_type") == "kredo_cartrust":
        rd = row.get("result_data") or {}
        pdf_b64 = rd.get("pdf_b64")
        if pdf_b64:
            import base64 as _b64
            try:
                pdf_bytes = _b64.b64decode(pdf_b64)
            except Exception as e:
                raise HTTPException(500, f"Failed to decode CarTrust PDF: {e}")
            fn = f"cartrust_{row.get('vin') or order_id[:8]}.pdf"
            return Response(
                content=pdf_bytes,
                media_type="application/pdf",
                headers={"Content-Disposition": f'inline; filename="{fn}"'},
            )
        raise HTTPException(500, "CarTrust PDF is not available on this order.")

    try:
        pdf_bytes = _build_vin_report_pdf(row)
    except Exception as e:  # pragma: no cover
        logger.exception("vin_reports: PDF build failed")
        raise HTTPException(500, f"Failed to build PDF: {e}")
    fn_report = (row.get("report_type") or "report").replace("_", "-")
    fn = f"vin-report_{fn_report}_{row.get('vin') or order_id[:8]}.pdf"
    return Response(
        content=pdf_bytes,
        media_type="application/pdf",
        headers={"Content-Disposition": f'inline; filename="{fn}"'},
    )
