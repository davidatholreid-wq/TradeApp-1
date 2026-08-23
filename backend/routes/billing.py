"""Billing, deposits, invoices and payments (Aug 2026).

Model overview — "prepaid wallet + monthly invoice for record-keeping":

- Every dealership carries a running **wallet balance** (ZAR, stored in
  cents to avoid float drift). All incoming money (paid deposits,
  paid-invoice-allocations) credits the wallet; all outgoing usage
  (submission R50 fee, VIN report fees, etc.) debits the wallet.
- When the wallet balance hits R0 the dealership is **soft-suspended**
  — dealers can still view existing data but the guard
  `assert_dealership_active` blocks *new* submissions, VIN reports and
  Get-Cover placements until the admin loads more deposit.
- Monthly invoicing is a document-generation step, not a wallet event.
  Running `POST /admin/dealerships/{id}/invoices/generate` sums up
  every billable event in the requested calendar month and produces a
  PDF for the accounts contact — the wallet has already been debited
  as the usage happened.
- Deposit requests are separate objects (with their own `DEP-NNNNNN`
  reference) so the admin can email an "invoice-shaped" deposit
  request document out to the dealership before any money moves.
- Refunds are recorded as an explicit `deposit_refunds` line item;
  they debit the wallet in the same way a usage event would.

Every mutation runs through `_recompute_wallet` after commit so the
wallet balance stays consistent even if a code path forgets to update
the cached number directly.
"""
from __future__ import annotations

import io
import logging
import os
import re
import uuid
from datetime import datetime, timezone, timedelta, date
from typing import Any, Optional

from fastapi import APIRouter, Depends, HTTPException, Query, Response
from pydantic import BaseModel, EmailStr

from motor.motor_asyncio import AsyncIOMotorDatabase
from reportlab.lib import colors as _rlcolors
from reportlab.lib.pagesizes import A4
from reportlab.lib.styles import getSampleStyleSheet, ParagraphStyle
from reportlab.lib.units import mm
from reportlab.pdfgen import canvas as _rlcanvas
from reportlab.platypus import (
    SimpleDocTemplate, Paragraph, Spacer, Table, TableStyle, Image, PageBreak,
)

logger = logging.getLogger("fourbuy.billing")

# ---------------------------------------------------------------------------
# Wiring — server.py imports this module and injects the mongo client + auth
# dependencies via `init_billing_module(db, deps)`. This keeps the router
# free of any global-state coupling to the FastAPI app in `server.py`.
# ---------------------------------------------------------------------------
_db: Optional[AsyncIOMotorDatabase] = None
_require_admin = None
_get_current_user = None
_upload_pdf_to_cloudinary = None
_send_email = None
_now_utc = None


def init_billing_module(
    *,
    db,
    require_admin,
    get_current_user,
    upload_pdf_to_cloudinary,
    send_email,
    now_utc,
):
    """Called from server.py at import time to wire dependencies."""
    global _db, _require_admin, _get_current_user
    global _upload_pdf_to_cloudinary, _send_email, _now_utc
    _db = db
    _require_admin = require_admin
    _get_current_user = get_current_user
    _upload_pdf_to_cloudinary = upload_pdf_to_cloudinary
    _send_email = send_email
    _now_utc = now_utc


# NOTE: FastAPI's `Depends()` requires a real (possibly-async) callable — a
# `lambda` that *returns* a coroutine won't get awaited and the endpoint will
# then try to `.get()` on a coroutine object.  These thin async shims call
# through to the server-side dependency callables stored by
# `init_billing_module`, while still letting FastAPI resolve Header/Query
# args via the shim's own signature.
from fastapi import Header  # noqa: E402


async def _dep_current_user(authorization: Optional[str] = Header(None)) -> dict:
    return await _get_current_user(authorization=authorization)


async def _dep_require_admin(authorization: Optional[str] = Header(None)) -> dict:
    user = await _get_current_user(authorization=authorization)
    return await _require_admin(current=user)


router = APIRouter(prefix="/api", tags=["billing"])


# ---------------------------------------------------------------------------
# Amount helpers — always store as integer cents. All external APIs accept
# and return rand as decimal (float) so the frontend can render as-is.
# ---------------------------------------------------------------------------
def zar_to_cents(v: Any) -> int:
    try:
        f = float(v)
    except (TypeError, ValueError):
        raise HTTPException(400, "Invalid amount")
    return int(round(f * 100))


def cents_to_zar(c: Any) -> float:
    try:
        return round(int(c or 0) / 100.0, 2)
    except (TypeError, ValueError):
        return 0.0


# ---------------------------------------------------------------------------
# Reference number sequences (DEP-000001, INV-000001, REF-000001)
# ---------------------------------------------------------------------------
async def _next_ref(counter_key: str, prefix: str) -> str:
    result = await _db.counters.find_one_and_update(
        {"_id": counter_key},
        {"$inc": {"seq": 1}},
        upsert=True,
        return_document=True,
    )
    seq = (result or {}).get("seq") or 1
    return f"{prefix}-{seq:06d}"


# ---------------------------------------------------------------------------
# Wallet computation — the source of truth is the ledger of documents, not
# the cached number on the dealership. `_recompute_wallet` re-derives the
# balance from scratch every time and pushes it back onto the dealership
# for cheap reads.
# ---------------------------------------------------------------------------
async def _recompute_wallet(dealership_id: str) -> dict:
    """Recompute wallet balance for a dealership from primary ledgers.

    Returns a dict with:
      total_credits_cents  — sum of paid deposits + invoice-payment allocations
      total_debits_cents   — sum of usage (submission fees + VIN report fees)
                             + refunds
      balance_cents        — credits - debits
    """
    # Credits: deposit payments + invoice payments (any recorded incoming money)
    payments_cursor = _db.dealer_payments.find({"dealership_id": dealership_id}, {"_id": 0, "amount_cents": 1})
    total_payments = 0
    async for p in payments_cursor:
        total_payments += int(p.get("amount_cents") or 0)

    # Debits (usage): every billable submission + every paid VIN report order
    total_usage = 0
    subs_cursor = _db.submissions.find(
        {"dealership_id": dealership_id, "retracted": {"$ne": True}, "billing_charge_cents": {"$exists": True}},
        {"_id": 0, "billing_charge_cents": 1},
    )
    async for s in subs_cursor:
        total_usage += int(s.get("billing_charge_cents") or 0)
    vin_cursor = _db.vin_report_orders.find(
        {"dealership_id": dealership_id, "billing_charge_cents": {"$exists": True}},
        {"_id": 0, "billing_charge_cents": 1},
    )
    async for v in vin_cursor:
        total_usage += int(v.get("billing_charge_cents") or 0)

    # Debits (refunds): deposit refunds are money leaving the wallet
    refunds_cursor = _db.deposit_refunds.find({"dealership_id": dealership_id}, {"_id": 0, "amount_cents": 1})
    total_refunds = 0
    async for r in refunds_cursor:
        total_refunds += int(r.get("amount_cents") or 0)

    total_debits = total_usage + total_refunds
    balance_cents = total_payments - total_debits

    await _db.dealerships.update_one(
        {"id": dealership_id},
        {"$set": {
            "wallet_credits_cents": total_payments,
            "wallet_usage_cents": total_usage,
            "wallet_refunds_cents": total_refunds,
            "wallet_balance_cents": balance_cents,
            "wallet_updated_at": _now_utc(),
        }},
    )
    return {
        "total_credits_cents": total_payments,
        "total_debits_cents": total_debits,
        "usage_cents": total_usage,
        "refunds_cents": total_refunds,
        "balance_cents": balance_cents,
    }


async def assert_dealership_active(dealership_id: str, feature: str = "this feature") -> None:
    """Raise HTTP 402 if a dealership's wallet is <= 0.

    Called from the write-side endpoints (create submission, VIN report,
    Get Cover). Read endpoints are unaffected so dealers can still view
    everything.

    Dealerships flagged `pay_in_arrears=True` are exempt — they operate
    on credit terms and are billed in arrears via the monthly invoice.
    """
    if not dealership_id:
        return
    d = await _db.dealerships.find_one(
        {"id": dealership_id},
        {"_id": 0, "wallet_balance_cents": 1, "pay_in_arrears": 1},
    )
    if not d:
        return
    # Credit-terms dealerships bypass the wallet-depleted guard.
    if bool(d.get("pay_in_arrears")):
        return
    balance_cents = int(d.get("wallet_balance_cents") or 0)
    # Recompute lazily if we've never computed the wallet yet.
    if "wallet_balance_cents" not in d:
        w = await _recompute_wallet(dealership_id)
        balance_cents = w["balance_cents"]
    if balance_cents <= 0:
        raise HTTPException(
            402,
            f"Your dealership's deposit balance has been depleted. Please contact Fourbuy accounts to top up before using {feature}.",
        )


# ---------------------------------------------------------------------------
# Company settings — the "who's issuing the invoice" block. Singleton row
# with _id = "default" in company_settings collection.
# ---------------------------------------------------------------------------
COMPANY_SETTINGS_ID = "default"


async def _get_company_settings() -> dict:
    doc = await _db.company_settings.find_one({"_id": COMPANY_SETTINGS_ID}) or {}
    doc.pop("_id", None)
    # Sensible defaults if the admin hasn't populated the record yet.
    return {
        "trading_name": doc.get("trading_name") or "TRADE AI powered by FOURBUY",
        "legal_name": doc.get("legal_name") or "Fourbuy Car Buying Co (Pty) Ltd",
        "registration_number": doc.get("registration_number") or "",
        "vat_number": doc.get("vat_number") or "",
        "address_line1": doc.get("address_line1") or "",
        "address_line2": doc.get("address_line2") or "",
        "city": doc.get("city") or "",
        "postal_code": doc.get("postal_code") or "",
        "country": doc.get("country") or "South Africa",
        "email": doc.get("email") or "",
        "phone": doc.get("phone") or "",
        "website": doc.get("website") or "",
        "bank_name": doc.get("bank_name") or "",
        "bank_account_name": doc.get("bank_account_name") or "",
        "bank_account_number": doc.get("bank_account_number") or "",
        "bank_branch_code": doc.get("bank_branch_code") or "",
        "bank_swift": doc.get("bank_swift") or "",
        "vat_rate_percent": float(doc.get("vat_rate_percent") or 15.0),
    }


class CompanySettingsUpdate(BaseModel):
    trading_name: Optional[str] = None
    legal_name: Optional[str] = None
    registration_number: Optional[str] = None
    vat_number: Optional[str] = None
    address_line1: Optional[str] = None
    address_line2: Optional[str] = None
    city: Optional[str] = None
    postal_code: Optional[str] = None
    country: Optional[str] = None
    email: Optional[str] = None
    phone: Optional[str] = None
    website: Optional[str] = None
    bank_name: Optional[str] = None
    bank_account_name: Optional[str] = None
    bank_account_number: Optional[str] = None
    bank_branch_code: Optional[str] = None
    bank_swift: Optional[str] = None
    vat_rate_percent: Optional[float] = None


@router.get("/admin/company-settings")
async def admin_get_company_settings(current: dict = Depends(_dep_require_admin)):
    return {"settings": await _get_company_settings()}


@router.put("/admin/company-settings")
async def admin_update_company_settings(
    payload: CompanySettingsUpdate,
    current: dict = Depends(_dep_require_admin),
):
    updates = {k: v for k, v in payload.dict(exclude_none=True).items()}
    if not updates:
        raise HTTPException(400, "No fields to update")
    updates["updated_at"] = _now_utc()
    await _db.company_settings.update_one(
        {"_id": COMPANY_SETTINGS_ID},
        {"$set": updates},
        upsert=True,
    )
    logger.info("Admin %s updated company settings: keys=%s", current.get("email"), list(updates.keys()))
    return {"settings": await _get_company_settings()}


# ---------------------------------------------------------------------------
# PDF helpers — small ReportLab utilities shared by every billing PDF.
# ---------------------------------------------------------------------------
def _rand(cents: int) -> str:
    """Format an integer cents value as 'R 1 234.56'."""
    v = cents_to_zar(cents)
    # thin-space grouping, avoiding locale headaches
    sign = "-" if v < 0 else ""
    n = abs(v)
    whole, frac = divmod(round(n * 100), 100)
    whole_s = f"{whole:,}".replace(",", " ")
    return f"{sign}R {whole_s}.{frac:02d}"


def _pdf_header(styles: dict, doc_title: str, company: dict, dealership: dict) -> list:
    """Build the top block that appears on every billing PDF: company
    details on the left, dealership (bill-to) on the right, and a title bar."""
    title_style = ParagraphStyle(
        "titleBar", parent=styles["Heading1"],
        fontSize=18, spaceAfter=6, textColor=_rlcolors.HexColor("#0F172A"),
    )
    small = ParagraphStyle("small", parent=styles["Normal"], fontSize=8.5, leading=11)
    heading = ParagraphStyle("head", parent=styles["Normal"], fontSize=9, leading=11, textColor=_rlcolors.HexColor("#0F172A"))

    def _company_para():
        lines = [
            f"<b>{company.get('trading_name', '')}</b>",
            company.get("legal_name", "") or "",
            company.get("address_line1", "") or "",
            company.get("address_line2", "") or "",
            ", ".join([x for x in [company.get("city", ""), company.get("postal_code", "")] if x]) or "",
            f"VAT No: {company.get('vat_number', '')}" if company.get("vat_number") else "",
            f"Reg No: {company.get('registration_number', '')}" if company.get("registration_number") else "",
            f"Email: {company.get('email', '')}" if company.get("email") else "",
            f"Tel: {company.get('phone', '')}" if company.get("phone") else "",
        ]
        return Paragraph("<br/>".join([l for l in lines if l]), small)

    def _dealership_para():
        addr_bits = []
        if dealership.get("address"):
            addr_bits.append(dealership["address"])
        lines = [
            "<b>BILL TO</b>",
            f"<b>{dealership.get('name', '')}</b>",
            "<br/>".join(addr_bits) if addr_bits else "",
            f"VAT No: {dealership.get('vat_no', '')}" if dealership.get("vat_no") else "",
            f"Reg No: {dealership.get('company_reg_no', '')}" if dealership.get("company_reg_no") else "",
        ]
        contact = dealership.get("accounts_contact") or {}
        if any(contact.get(k) for k in ("name", "phone", "email")):
            lines.append("<b>Accounts contact:</b>")
            if contact.get("name"):
                lines.append(contact["name"])
            if contact.get("email"):
                lines.append(contact["email"])
            if contact.get("phone"):
                lines.append(contact["phone"])
        return Paragraph("<br/>".join([l for l in lines if l]), small)

    header_table = Table(
        [[_company_para(), _dealership_para()]],
        colWidths=[95 * mm, 95 * mm],
    )
    header_table.setStyle(TableStyle([
        ("VALIGN", (0, 0), (-1, -1), "TOP"),
        ("BOTTOMPADDING", (0, 0), (-1, -1), 6),
    ]))
    title_bar = Table([[Paragraph(doc_title, title_style)]], colWidths=[190 * mm])
    title_bar.setStyle(TableStyle([
        ("BACKGROUND", (0, 0), (-1, -1), _rlcolors.HexColor("#F1F5F9")),
        ("LEFTPADDING", (0, 0), (-1, -1), 8),
        ("TOPPADDING", (0, 0), (-1, -1), 6),
        ("BOTTOMPADDING", (0, 0), (-1, -1), 6),
    ]))
    return [header_table, Spacer(1, 6), title_bar, Spacer(1, 10)]


def _pdf_footer(story: list, company: dict) -> None:
    small = ParagraphStyle("footer", fontSize=8, leading=10, textColor=_rlcolors.HexColor("#64748B"))
    bank_lines = [
        "<b>BANKING DETAILS</b>",
        f"Bank: {company.get('bank_name', '')}" if company.get("bank_name") else "",
        f"Account name: {company.get('bank_account_name', '')}" if company.get("bank_account_name") else "",
        f"Account no: {company.get('bank_account_number', '')}" if company.get("bank_account_number") else "",
        f"Branch code: {company.get('bank_branch_code', '')}" if company.get("bank_branch_code") else "",
        f"SWIFT: {company.get('bank_swift', '')}" if company.get("bank_swift") else "",
    ]
    story.append(Spacer(1, 14))
    story.append(Paragraph("<br/>".join([l for l in bank_lines if l]), small))


def _totals_table(subtotal_cents: int, vat_percent: float) -> tuple[Table, int, int, int]:
    subtotal = subtotal_cents
    vat = int(round(subtotal * (vat_percent / 100.0)))
    total = subtotal + vat
    rows = [
        ["Subtotal", _rand(subtotal)],
        [f"VAT ({vat_percent:.0f}%)", _rand(vat)],
        ["TOTAL DUE", _rand(total)],
    ]
    t = Table(rows, colWidths=[60 * mm, 40 * mm], hAlign="RIGHT")
    t.setStyle(TableStyle([
        ("ALIGN", (0, 0), (-1, -1), "RIGHT"),
        ("FONTNAME", (0, -1), (-1, -1), "Helvetica-Bold"),
        ("BACKGROUND", (0, -1), (-1, -1), _rlcolors.HexColor("#0F172A")),
        ("TEXTCOLOR", (0, -1), (-1, -1), _rlcolors.HexColor("#FFFFFF")),
        ("BOTTOMPADDING", (0, 0), (-1, -1), 4),
        ("TOPPADDING", (0, 0), (-1, -1), 4),
        ("LINEBELOW", (0, 0), (-1, -2), 0.4, _rlcolors.HexColor("#E5E7EB")),
    ]))
    return t, subtotal, vat, total


def _render_pdf(doc_title: str, story_body: list, company: dict, dealership: dict) -> bytes:
    """Assemble a full PDF from the header + provided body flowables."""
    buf = io.BytesIO()
    doc = SimpleDocTemplate(
        buf, pagesize=A4,
        leftMargin=15 * mm, rightMargin=15 * mm,
        topMargin=15 * mm, bottomMargin=15 * mm,
        title=doc_title,
    )
    styles = getSampleStyleSheet()
    story: list = _pdf_header(styles, doc_title, company, dealership)
    story.extend(story_body)
    _pdf_footer(story, company)
    doc.build(story)
    return buf.getvalue()


# ---------------------------------------------------------------------------
# Strict payment allocation — admin records that money hit the bank.
#
# Aug 2026 refactor: every payment MUST be tied to either an existing
# invoice (`invoice_id`) OR flagged as a top-up deposit
# (`is_deposit=True`). There is no legacy "deposit request" flow any
# more — invoices are generated automatically on the 1st of each
# month, so the only reason a dealer would send money before an
# invoice exists is to pre-load the wallet, which is exactly what a
# deposit top-up captures.
# ---------------------------------------------------------------------------
class DealerPaymentCreate(BaseModel):
    amount_zar: float
    payment_date: str  # YYYY-MM-DD
    bank_reference: str
    notes: Optional[str] = ""
    # Exactly one of these must be set:
    #   • invoice_id      — closes/partly-closes an invoice
    #   • is_deposit=True — pure top-up (no invoice link)
    invoice_id: Optional[str] = None
    is_deposit: bool = False


@router.post("/admin/dealerships/{dealership_id}/payments")
async def admin_record_payment(
    dealership_id: str,
    payload: DealerPaymentCreate,
    current: dict = Depends(_dep_require_admin),
):
    """Record that money has been received. Strict allocation is
    required — the admin must pick either an invoice this payment
    settles, or explicitly flag the payment as a deposit top-up. If
    the payment is against an invoice AND the invoice is only
    partially settled the invoice is automatically re-emailed to the
    accounts contact with the updated `balance_due`."""
    d = await _db.dealerships.find_one({"id": dealership_id})
    if not d:
        raise HTTPException(404, "Dealership not found")
    if not payload.invoice_id and not payload.is_deposit:
        raise HTTPException(
            400,
            "A payment must be allocated to an invoice OR marked as a deposit top-up — unallocated payments are not accepted.",
        )
    if payload.invoice_id and payload.is_deposit:
        raise HTTPException(
            400,
            "A payment can be either against an invoice OR a deposit top-up — not both.",
        )
    amount_cents = zar_to_cents(payload.amount_zar)
    if amount_cents <= 0:
        raise HTTPException(400, "Amount must be > 0")

    # If the payment is allocated to an invoice, load & validate it
    # up front so we can bail out cleanly on a bad id.
    invoice_doc: Optional[dict] = None
    if payload.invoice_id:
        invoice_doc = await _db.dealer_invoices.find_one(
            {"id": payload.invoice_id, "dealership_id": dealership_id},
            {"_id": 0},
        )
        if not invoice_doc:
            raise HTTPException(404, "Invoice not found for this dealership.")

    doc = {
        "id": str(uuid.uuid4()),
        "dealership_id": dealership_id,
        "amount_cents": amount_cents,
        "amount_zar": cents_to_zar(amount_cents),
        "payment_date": payload.payment_date,
        "bank_reference": (payload.bank_reference or "").strip(),
        "notes": (payload.notes or "").strip(),
        "invoice_id": payload.invoice_id,
        "is_deposit": bool(payload.is_deposit),
        "recorded_at": _now_utc(),
        "recorded_by": current["id"],
    }
    await _db.dealer_payments.insert_one(doc)

    # Update the invoice's status/paid total if allocated to an invoice.
    invoice_after: Optional[dict] = None
    if invoice_doc:
        new_paid = int(invoice_doc.get("total_paid_cents") or 0) + amount_cents
        status = "paid" if new_paid >= int(invoice_doc.get("total_cents") or 0) else "partial"
        set_fields: dict = {
            "total_paid_cents": new_paid,
            "status": status,
            "paid_at": _now_utc() if status == "paid" else None,
        }
        await _db.dealer_invoices.update_one(
            {"id": payload.invoice_id},
            {"$set": set_fields},
        )
        invoice_after = {**invoice_doc, **set_fields}

    await _recompute_wallet(dealership_id)

    # Auto re-email invoice on payment (per business rule Aug 2026):
    # every payment against an invoice — whether it fully settles it
    # or only partially settles it — triggers an updated invoice
    # email so the dealer sees the running balance.
    if invoice_after and _send_email:
        to_addr = (d.get("accounts_contact") or {}).get("email")
        if to_addr:
            try:
                company = await _get_company_settings()
                subject = (
                    f"Payment received — Invoice {invoice_after['reference']} "
                    f"({'settled' if invoice_after['status'] == 'paid' else 'balance updated'}) — {company['trading_name']}"
                )
                await _send_email(
                    to=to_addr,
                    subject=subject,
                    html=_invoice_email_html(invoice_after, d, company, invoice_after.get("pdf_url")),
                )
                await _db.dealer_invoices.update_one(
                    {"id": invoice_after["id"]},
                    {"$set": {"emailed_to": to_addr, "emailed_at": _now_utc()}},
                )
            except Exception as e:
                logger.warning("Auto re-email invoice on payment failed: %s", e)

    doc.pop("_id", None)
    return {"payment": doc}


# ---------------------------------------------------------------------------
# Deposit refund — money leaving the wallet
# ---------------------------------------------------------------------------
class DepositRefundCreate(BaseModel):
    amount_zar: float
    refund_date: str
    bank_reference: str
    notes: Optional[str] = ""


@router.post("/admin/dealerships/{dealership_id}/deposit-refund")
async def admin_record_deposit_refund(
    dealership_id: str,
    payload: DepositRefundCreate,
    current: dict = Depends(_dep_require_admin),
):
    d = await _db.dealerships.find_one({"id": dealership_id})
    if not d:
        raise HTTPException(404, "Dealership not found")
    amount_cents = zar_to_cents(payload.amount_zar)
    if amount_cents <= 0:
        raise HTTPException(400, "Amount must be > 0")
    doc = {
        "id": str(uuid.uuid4()),
        "reference": await _next_ref("ref_seq", "REF"),
        "dealership_id": dealership_id,
        "amount_cents": amount_cents,
        "amount_zar": cents_to_zar(amount_cents),
        "refund_date": payload.refund_date,
        "bank_reference": (payload.bank_reference or "").strip(),
        "notes": (payload.notes or "").strip(),
        "recorded_at": _now_utc(),
        "recorded_by": current["id"],
    }
    await _db.deposit_refunds.insert_one(doc)
    await _recompute_wallet(dealership_id)
    doc.pop("_id", None)
    return {"refund": doc}


# ---------------------------------------------------------------------------
# Monthly invoice generation.
# ---------------------------------------------------------------------------
class InvoiceGenerateBody(BaseModel):
    year: int
    month: int   # 1-12
    email_to: Optional[EmailStr] = None


@router.post("/admin/dealerships/{dealership_id}/invoices/generate")
async def admin_generate_monthly_invoice(
    dealership_id: str,
    payload: InvoiceGenerateBody,
    current: dict = Depends(_dep_require_admin),
):
    d = await _db.dealerships.find_one({"id": dealership_id})
    if not d:
        raise HTTPException(404, "Dealership not found")
    if payload.month < 1 or payload.month > 12:
        raise HTTPException(400, "Invalid month")
    start = datetime(payload.year, payload.month, 1, tzinfo=timezone.utc)
    if payload.month == 12:
        end = datetime(payload.year + 1, 1, 1, tzinfo=timezone.utc)
    else:
        end = datetime(payload.year, payload.month + 1, 1, tzinfo=timezone.utc)

    # Collect billable line items in the calendar month.
    line_items: list[dict] = []
    subtotal_cents = 0

    # Submissions billed in that month (priced_at inside window)
    subs_cursor = _db.submissions.find(
        {
            "dealership_id": dealership_id,
            "retracted": {"$ne": True},
            "billing_charge_cents": {"$gt": 0},
            "priced_at": {"$gte": start.isoformat(), "$lt": end.isoformat()},
        },
        {"_id": 0, "reference": 1, "billing_charge_cents": 1, "make_name": 1, "model_name": 1, "year": 1, "priced_at": 1},
    ).sort("priced_at", 1)
    async for s in subs_cursor:
        desc = f"{s.get('reference', '')} · {s.get('year', '')} {s.get('make_name', '')} {s.get('model_name', '')}"
        line_items.append({
            "type": "submission",
            "reference": s.get("reference"),
            "date": (s.get("priced_at") or "").split("T")[0],
            "description": desc.strip(),
            "amount_cents": int(s.get("billing_charge_cents") or 0),
        })
        subtotal_cents += int(s.get("billing_charge_cents") or 0)

    # VIN report orders
    vin_cursor = _db.vin_report_orders.find(
        {
            "dealership_id": dealership_id,
            "billing_charge_cents": {"$gt": 0},
            "created_at": {"$gte": start.isoformat(), "$lt": end.isoformat()},
        },
        {"_id": 0, "reference": 1, "report_type": 1, "vin": 1, "billing_charge_cents": 1, "created_at": 1},
    ).sort("created_at", 1)
    async for v in vin_cursor:
        desc = f"VIN report ({v.get('report_type', '')}) · {v.get('vin', '')}"
        line_items.append({
            "type": "vin_report",
            "reference": v.get("reference"),
            "date": (v.get("created_at") or "").split("T")[0],
            "description": desc.strip(),
            "amount_cents": int(v.get("billing_charge_cents") or 0),
        })
        subtotal_cents += int(v.get("billing_charge_cents") or 0)

    if subtotal_cents <= 0:
        raise HTTPException(409, f"No billable activity in {start.strftime('%B %Y')}.")

    company = await _get_company_settings()
    vat_percent = float(company.get("vat_rate_percent") or 15.0)
    vat_cents = int(round(subtotal_cents * (vat_percent / 100.0)))
    total_cents = subtotal_cents + vat_cents

    reference = await _next_ref("inv_seq", "INV")
    doc = {
        "id": str(uuid.uuid4()),
        "reference": reference,
        "dealership_id": dealership_id,
        "period_start": start.date().isoformat(),
        "period_end": (end - timedelta(days=1)).date().isoformat(),
        "period_label": start.strftime("%B %Y"),
        "line_items": line_items,
        "subtotal_cents": subtotal_cents,
        "vat_cents": vat_cents,
        "vat_rate_percent": vat_percent,
        "total_cents": total_cents,
        "total_paid_cents": 0,
        "status": "outstanding",
        "generated_at": _now_utc(),
        "generated_by": current["id"],
    }
    pdf_bytes = _build_invoice_pdf(doc, d, company)
    # Cloudinary blocks raw PDFs by default (401 deny), so we skip
    # the upload and rely on the streaming endpoint
    # `/api/admin/dealerships/{id}/invoices/{id}.pdf` for in-app
    # viewing. The PDF bytes are regenerated on demand from the
    # persisted line items — cheap and always in sync with the
    # current company branding.
    await _db.dealer_invoices.insert_one(doc)

    to_addr = payload.email_to or ((d.get("accounts_contact") or {}).get("email"))
    if to_addr and _send_email:
        try:
            await _send_email(
                to=to_addr,
                subject=f"Invoice {reference} — {doc['period_label']} — {company['trading_name']}",
                html=_invoice_email_html(doc, d, company, None),
            )
            await _db.dealer_invoices.update_one(
                {"id": doc["id"]},
                {"$set": {"emailed_to": to_addr, "emailed_at": _now_utc()}},
            )
            doc["emailed_to"] = to_addr
        except Exception as e:
            logger.warning("Invoice email failed: %s", e)
    doc.pop("_id", None)
    return {"invoice": doc}


@router.post("/admin/dealerships/{dealership_id}/invoices/{invoice_id}/resend-email")
async def admin_resend_invoice_email(
    dealership_id: str,
    invoice_id: str,
    current: dict = Depends(_dep_require_admin),
):
    """Re-send an already-generated invoice by email to the accounts
    contact currently on file for the dealership. Useful if the contact
    changed, if the original delivery failed, or if the dealer just
    lost the email. Does NOT regenerate the PDF — the same Cloudinary
    URL from the original generation is re-linked."""
    d = await _db.dealerships.find_one({"id": dealership_id})
    if not d:
        raise HTTPException(404, "Dealership not found")
    inv = await _db.dealer_invoices.find_one({"id": invoice_id, "dealership_id": dealership_id}, {"_id": 0})
    if not inv:
        raise HTTPException(404, "Invoice not found")
    to_addr = (d.get("accounts_contact") or {}).get("email")
    if not to_addr:
        raise HTTPException(400, "No accounts contact email on file for this dealership.")
    if not _send_email:
        raise HTTPException(500, "Email transport is not configured.")
    company = await _get_company_settings()
    try:
        await _send_email(
            to=to_addr,
            subject=f"Invoice {inv['reference']} — {inv['period_label']} — {company['trading_name']}",
            html=_invoice_email_html(inv, d, company, inv.get("pdf_url")),
        )
    except Exception as e:
        raise HTTPException(502, f"Email send failed: {e}")
    await _db.dealer_invoices.update_one(
        {"id": invoice_id},
        {"$set": {"emailed_to": to_addr, "emailed_at": _now_utc()}},
    )
    logger.info("Admin %s re-sent invoice %s to %s", current.get("email"), inv["reference"], to_addr)
    return {"emailed_to": to_addr, "emailed_at": _now_utc()}


# ---------------------------------------------------------------------------
# Invoice PDF stream endpoints (Aug 2026).
#
# Cloudinary's default policy blocks raw PDFs (401 "deny or ACL
# failure"), so we can't rely on the stored `pdf_url` for in-app
# viewing. Instead these endpoints re-render the PDF from the
# invoice's stored line items on demand and stream it back to the
# authenticated caller. The regeneration is cheap (<100 ms) and
# guarantees the document always reflects the current company
# settings/branding.
# ---------------------------------------------------------------------------
async def _stream_invoice_pdf_response(invoice_id: str, dealership_id: str) -> Response:
    d = await _db.dealerships.find_one({"id": dealership_id})
    if not d:
        raise HTTPException(404, "Dealership not found")
    inv = await _db.dealer_invoices.find_one({"id": invoice_id, "dealership_id": dealership_id}, {"_id": 0})
    if not inv:
        raise HTTPException(404, "Invoice not found")
    company = await _get_company_settings()
    pdf = _build_invoice_pdf(inv, d, company)
    filename = f"invoice_{inv['reference']}_{inv['period_label'].replace(' ', '_')}.pdf"
    return Response(
        content=pdf,
        media_type="application/pdf",
        headers={"Content-Disposition": f"inline; filename={filename}"},
    )


@router.get("/admin/dealerships/{dealership_id}/invoices/{invoice_id}.pdf")
async def admin_invoice_pdf(
    dealership_id: str,
    invoice_id: str,
    current: dict = Depends(_dep_require_admin),
):
    return await _stream_invoice_pdf_response(invoice_id, dealership_id)


@router.get("/billing/my-invoice/{invoice_id}.pdf")
async def dealer_invoice_pdf(
    invoice_id: str,
    current: dict = Depends(_dep_current_user),
):
    """Dealer-scoped PDF stream — the caller can only view their own
    dealership's invoices."""
    dealership_id = current.get("dealership_id")
    if not dealership_id:
        raise HTTPException(403, "Not linked to a dealership.")
    return await _stream_invoice_pdf_response(invoice_id, dealership_id)


async def _generate_invoice_for_dealer(dealership_id: str, year: int, month: int, current_user_id: str) -> Optional[dict]:
    """Internal helper — creates the invoice doc + PDF + email in the
    same way the admin endpoint does. Returns None when there is no
    billable activity in the period (safe for the scheduler to call
    for every dealership without spamming empty invoices). Extracted
    so the monthly cron can reuse the exact same code path.
    """
    d = await _db.dealerships.find_one({"id": dealership_id})
    if not d:
        return None
    start = datetime(year, month, 1, tzinfo=timezone.utc)
    end = datetime(year + (1 if month == 12 else 0), 1 if month == 12 else month + 1, 1, tzinfo=timezone.utc)
    # Skip if we've already generated an invoice for this period.
    existing = await _db.dealer_invoices.find_one({
        "dealership_id": dealership_id,
        "period_start": start.date().isoformat(),
    })
    if existing:
        return None
    line_items: list[dict] = []
    subtotal_cents = 0
    async for s in _db.submissions.find(
        {"dealership_id": dealership_id, "retracted": {"$ne": True},
         "billing_charge_cents": {"$gt": 0},
         "priced_at": {"$gte": start.isoformat(), "$lt": end.isoformat()}},
        {"_id": 0, "reference": 1, "billing_charge_cents": 1, "make_name": 1, "model_name": 1, "year": 1, "priced_at": 1},
    ).sort("priced_at", 1):
        desc = f"{s.get('reference', '')} · {s.get('year', '')} {s.get('make_name', '')} {s.get('model_name', '')}"
        line_items.append({"type": "submission", "reference": s.get("reference"),
                           "date": (s.get("priced_at") or "").split("T")[0],
                           "description": desc.strip(),
                           "amount_cents": int(s.get("billing_charge_cents") or 0)})
        subtotal_cents += int(s.get("billing_charge_cents") or 0)
    async for v in _db.vin_report_orders.find(
        {"dealership_id": dealership_id, "billing_charge_cents": {"$gt": 0},
         "created_at": {"$gte": start.isoformat(), "$lt": end.isoformat()}},
        {"_id": 0, "reference": 1, "report_type": 1, "vin": 1, "billing_charge_cents": 1, "created_at": 1},
    ).sort("created_at", 1):
        line_items.append({"type": "vin_report", "reference": v.get("reference"),
                           "date": (v.get("created_at") or "").split("T")[0],
                           "description": f"VIN report ({v.get('report_type', '')}) · {v.get('vin', '')}".strip(),
                           "amount_cents": int(v.get("billing_charge_cents") or 0)})
        subtotal_cents += int(v.get("billing_charge_cents") or 0)
    if subtotal_cents <= 0:
        return None
    company = await _get_company_settings()
    vat_percent = float(company.get("vat_rate_percent") or 15.0)
    vat_cents = int(round(subtotal_cents * (vat_percent / 100.0)))
    total_cents = subtotal_cents + vat_cents
    reference = await _next_ref("inv_seq", "INV")
    doc = {
        "id": str(uuid.uuid4()), "reference": reference, "dealership_id": dealership_id,
        "period_start": start.date().isoformat(),
        "period_end": (end - timedelta(days=1)).date().isoformat(),
        "period_label": start.strftime("%B %Y"),
        "line_items": line_items,
        "subtotal_cents": subtotal_cents, "vat_cents": vat_cents,
        "vat_rate_percent": vat_percent, "total_cents": total_cents,
        "total_paid_cents": 0, "status": "outstanding",
        "generated_at": _now_utc(), "generated_by": current_user_id,
    }
    # PDF is regenerated on demand via the streaming endpoint; skip
    # Cloudinary (raw PDFs are 401-blocked by default policy).
    await _db.dealer_invoices.insert_one(doc)
    to_addr = (d.get("accounts_contact") or {}).get("email")
    if to_addr and _send_email:
        try:
            await _send_email(
                to=to_addr,
                subject=f"Invoice {reference} — {doc['period_label']} — {company['trading_name']}",
                html=_invoice_email_html(doc, d, company, None),
            )
            await _db.dealer_invoices.update_one({"id": doc["id"]},
                {"$set": {"emailed_to": to_addr, "emailed_at": _now_utc()}})
            doc["emailed_to"] = to_addr
        except Exception as e:
            logger.warning("Invoice email failed: %s", e)
    return doc


async def run_monthly_invoice_batch() -> dict:
    """Called by the scheduler on the 1st of each month at 09:00 SAST.
    Generates invoices for every dealership for the PRIOR calendar
    month. Idempotent: `_generate_invoice_for_dealer` skips
    dealerships that already have an invoice for the target period.
    Also safely callable ad-hoc via `POST /admin/billing/run-monthly-batch`.
    """
    now = datetime.now(timezone.utc)
    # Prior month
    year, month = (now.year - 1, 12) if now.month == 1 else (now.year, now.month - 1)
    generated = 0
    skipped = 0
    async for d in _db.dealerships.find({}, {"_id": 0, "id": 1}):
        try:
            res = await _generate_invoice_for_dealer(d["id"], year, month, current_user_id="system:cron")
            if res:
                generated += 1
            else:
                skipped += 1
        except Exception as e:
            logger.warning("Monthly invoice for %s failed: %s", d["id"], e)
    logger.info("Monthly invoice batch: %s generated, %s skipped (period=%s-%02d)", generated, skipped, year, month)
    return {"generated": generated, "skipped": skipped, "year": year, "month": month}


@router.post("/admin/billing/run-monthly-batch")
async def admin_run_monthly_batch(current: dict = Depends(_dep_require_admin)):
    """Manual trigger for the same batch the scheduler runs on the 1st
    of every month. Handy for catching up if the app was down at
    month-end, or for an initial back-fill after enabling the feature.
    """
    return await run_monthly_invoice_batch()


def _build_invoice_pdf(invoice: dict, dealership: dict, company: dict) -> bytes:
    styles = getSampleStyleSheet()
    body: list = []
    meta = Table(
        [["Invoice:", invoice["reference"]],
         ["Period:", invoice["period_label"]],
         ["Date issued:", (invoice["generated_at"] or _now_utc()).split("T")[0]]],
        colWidths=[35 * mm, 100 * mm],
    )
    meta.setStyle(TableStyle([
        ("FONTNAME", (0, 0), (0, -1), "Helvetica-Bold"),
        ("BOTTOMPADDING", (0, 0), (-1, -1), 3),
    ]))
    body.append(meta)
    body.append(Spacer(1, 10))
    # Line items
    rows = [["#", "Date", "Description", "Amount"]]
    for i, li in enumerate(invoice["line_items"], 1):
        rows.append([str(i), li["date"], Paragraph(li["description"], styles["BodyText"]), _rand(li["amount_cents"])])
    items = Table(rows, colWidths=[10 * mm, 22 * mm, 118 * mm, 30 * mm], repeatRows=1)
    items.setStyle(TableStyle([
        ("BACKGROUND", (0, 0), (-1, 0), _rlcolors.HexColor("#0F172A")),
        ("TEXTCOLOR", (0, 0), (-1, 0), _rlcolors.HexColor("#FFFFFF")),
        ("FONTNAME", (0, 0), (-1, 0), "Helvetica-Bold"),
        ("GRID", (0, 0), (-1, -1), 0.25, _rlcolors.HexColor("#E5E7EB")),
        ("ALIGN", (0, 0), (0, -1), "CENTER"),
        ("ALIGN", (3, 0), (3, -1), "RIGHT"),
        ("VALIGN", (0, 0), (-1, -1), "MIDDLE"),
        ("FONTSIZE", (0, 0), (-1, -1), 9),
        ("LEFTPADDING", (0, 0), (-1, -1), 4),
        ("RIGHTPADDING", (0, 0), (-1, -1), 4),
        ("TOPPADDING", (0, 0), (-1, -1), 3),
        ("BOTTOMPADDING", (0, 0), (-1, -1), 3),
    ]))
    body.append(items)
    body.append(Spacer(1, 8))
    totals, _, _, _ = _totals_table(invoice["subtotal_cents"], invoice.get("vat_rate_percent", 15.0))
    body.append(totals)
    body.append(Spacer(1, 12))
    body.append(Paragraph(
        f"<b>Please use reference <font color='#B45309'>{invoice['reference']}</font> when making payment.</b>",
        styles["BodyText"],
    ))
    return _render_pdf(f"TAX INVOICE — {invoice['period_label']}", body, company, dealership)


def _invoice_email_html(invoice: dict, dealership: dict, company: dict, pdf_url: Optional[str]) -> str:
    # `pdf_url` is now always None (Cloudinary blocks raw PDF
    # delivery). The dealer downloads the PDF from within the app
    # instead — the streaming endpoint requires auth so we can't
    # embed a public link in the email. If in future we add a
    # public signed-URL flow it can be passed here.
    app_url = os.environ.get("EXPO_PUBLIC_APP_URL") or os.environ.get("APP_PUBLIC_URL") or ""
    link = ""
    if app_url:
        base = app_url.rstrip("/")
        link = f"<p><a href='{base}/billing'>Log in and open the Billing tab to download your PDF</a></p>"
    elif pdf_url:
        link = f"<p><a href='{pdf_url}'>Download invoice PDF</a></p>"
    contact_name = (dealership.get("accounts_contact") or {}).get("name") or "there"
    return f"""
<div style="font-family:Arial,Helvetica,sans-serif;font-size:14px;color:#0F172A;">
  <h2 style="margin:0 0 10px;">Invoice {invoice['reference']}</h2>
  <p>Hello {contact_name},</p>
  <p>Please find your invoice for the period <b>{invoice['period_label']}</b> below.</p>
  <p><b>Total due:</b> {_rand(invoice['total_cents'])}<br/>
     <b>Reference to use:</b> {invoice['reference']}</p>
  {link}
  <p>Thanks,<br/>{company['trading_name']}<br/>Accounts</p>
</div>
"""


# ---------------------------------------------------------------------------
# Statement (full ledger for the dealership)
# ---------------------------------------------------------------------------
@router.get("/admin/dealerships/{dealership_id}/statement.pdf")
async def admin_statement_pdf(
    dealership_id: str,
    current: dict = Depends(_dep_require_admin),
):
    d = await _db.dealerships.find_one({"id": dealership_id})
    if not d:
        raise HTTPException(404, "Dealership not found")
    company = await _get_company_settings()
    # Collect everything (deposit-request concept removed Aug 2026 —
    # payments are now either invoice allocations or standalone
    # deposit top-ups).
    invoices = await _db.dealer_invoices.find({"dealership_id": dealership_id}, {"_id": 0}).sort("generated_at", 1).to_list(1000)
    payments = await _db.dealer_payments.find({"dealership_id": dealership_id}, {"_id": 0}).sort("recorded_at", 1).to_list(2000)
    refunds = await _db.deposit_refunds.find({"dealership_id": dealership_id}, {"_id": 0}).sort("recorded_at", 1).to_list(1000)

    events: list[tuple[str, str, str, int]] = []  # (iso_ts, kind, description, delta_cents)
    for pay in payments:
        if pay.get("invoice_id"):
            kind = "Payment (invoice)"
            desc = f"Payment received · ref {pay.get('bank_reference', '')} (against invoice)"
        else:
            kind = "Deposit top-up"
            desc = f"Deposit top-up · ref {pay.get('bank_reference', '')}"
        events.append((pay.get("recorded_at") or "", kind, desc, +int(pay["amount_cents"])))
    for inv in invoices:
        events.append((inv.get("generated_at") or "", "Invoice raised", f"{inv['reference']} · {inv['period_label']}", 0))
    for rf in refunds:
        events.append((rf.get("recorded_at") or "", "Deposit refund", rf.get("reference", ""), -int(rf["amount_cents"])))

    # Also, unbilled usage as an aggregated line so the balance ties up.
    wallet = await _recompute_wallet(dealership_id)
    usage_cents = wallet["usage_cents"]
    if usage_cents:
        events.append((_now_utc(), "Cumulative usage debits", "Submissions + VIN report fees", -usage_cents))

    events.sort(key=lambda e: e[0])
    running = 0
    rows = [["Date", "Type", "Description", "Debit", "Credit", "Balance"]]
    for ts, kind, desc, delta in events:
        running += delta
        debit = "" if delta >= 0 else _rand(-delta)
        credit = _rand(delta) if delta > 0 else ""
        rows.append([ts.split("T")[0] if ts else "", kind, desc, debit, credit, _rand(running)])
    styles = getSampleStyleSheet()
    tbl = Table(rows, colWidths=[22 * mm, 30 * mm, 78 * mm, 20 * mm, 20 * mm, 22 * mm], repeatRows=1)
    tbl.setStyle(TableStyle([
        ("BACKGROUND", (0, 0), (-1, 0), _rlcolors.HexColor("#0F172A")),
        ("TEXTCOLOR", (0, 0), (-1, 0), _rlcolors.HexColor("#FFFFFF")),
        ("FONTNAME", (0, 0), (-1, 0), "Helvetica-Bold"),
        ("GRID", (0, 0), (-1, -1), 0.25, _rlcolors.HexColor("#E5E7EB")),
        ("ALIGN", (3, 1), (5, -1), "RIGHT"),
        ("FONTSIZE", (0, 0), (-1, -1), 8.5),
        ("TOPPADDING", (0, 0), (-1, -1), 2),
        ("BOTTOMPADDING", (0, 0), (-1, -1), 2),
    ]))
    body = [tbl, Spacer(1, 12), Paragraph(
        f"<b>Wallet balance as at {date.today().isoformat()}: {_rand(wallet['balance_cents'])}</b>",
        styles["BodyText"],
    )]
    pdf = _render_pdf("STATEMENT OF ACCOUNT", body, company, d)
    return Response(content=pdf, media_type="application/pdf", headers={
        "Content-Disposition": f"inline; filename=statement_{d['name'].replace(' ','_')}_{date.today().isoformat()}.pdf",
    })


# ---------------------------------------------------------------------------
# Debtors Report — live snapshot of what every dealership owes.
#
# For each dealership we compute:
#   • wallet_balance_cents   — the running ledger (credits − debits).
#                              A positive value means we hold prepaid
#                              deposit for them; negative means they
#                              have consumed more than they've paid
#                              (only possible for arrears dealers).
#   • outstanding_invoiced   — sum of (total_cents − total_paid_cents)
#                              for every invoice with status != paid.
#   • amount_owed            — max(0, −wallet_balance_cents), i.e. the
#                              cash they'd need to send today to clear
#                              their ledger. Positive-wallet dealers
#                              show R 0 here.
#
# The PDF lists everyone but sorts biggest-owed first so admin can
# triage collections. A grand total sits at the bottom.
# ---------------------------------------------------------------------------
@router.get("/admin/billing/debtors-report.pdf")
async def admin_debtors_report_pdf(
    current: dict = Depends(_dep_require_admin),
):
    company = await _get_company_settings()
    rows: list[dict] = []
    async for d in _db.dealerships.find({}, {"_id": 0}).sort("name", 1):
        # Always recompute so the snapshot is truthful even if the
        # cached number is stale.
        wallet = await _recompute_wallet(d["id"])
        # Sum outstanding invoice balances
        outstanding_cents = 0
        async for inv in _db.dealer_invoices.find(
            {"dealership_id": d["id"], "status": {"$ne": "paid"}},
            {"_id": 0, "total_cents": 1, "total_paid_cents": 1},
        ):
            outstanding_cents += max(0, int(inv.get("total_cents") or 0) - int(inv.get("total_paid_cents") or 0))
        wallet_balance = int(wallet.get("balance_cents") or 0)
        # "Amount owed today" — what the dealer would need to pay to
        # bring their ledger to zero. Anything above zero on the
        # wallet means we owe them (or they're pre-loaded); we only
        # care about the deficit here.
        amount_owed_cents = max(0, -wallet_balance)
        rows.append({
            "id": d["id"],
            "name": d.get("name") or "(unnamed)",
            "contact_name": (d.get("accounts_contact") or {}).get("name") or "",
            "contact_email": (d.get("accounts_contact") or {}).get("email") or "",
            "wallet_balance_cents": wallet_balance,
            "outstanding_cents": outstanding_cents,
            "amount_owed_cents": amount_owed_cents,
            "pay_in_arrears": bool(d.get("pay_in_arrears")),
            "active": d.get("active", True),
        })

    # Sort: highest amount owed first, then largest outstanding invoice, then name.
    rows.sort(key=lambda r: (-r["amount_owed_cents"], -r["outstanding_cents"], r["name"].lower()))

    styles = getSampleStyleSheet()
    header_style = ParagraphStyle("dhead", parent=styles["Normal"], fontSize=8.5, textColor=_rlcolors.HexColor("#FFFFFF"), fontName="Helvetica-Bold")
    cell_style = ParagraphStyle("dcell", parent=styles["Normal"], fontSize=8.5, leading=11)
    small = ParagraphStyle("dsmall", parent=styles["Normal"], fontSize=7.5, leading=10, textColor=_rlcolors.HexColor("#64748B"))

    table_rows: list[list] = [[
        Paragraph("Dealership", header_style),
        Paragraph("Accounts contact", header_style),
        Paragraph("Terms", header_style),
        Paragraph("Wallet", header_style),
        Paragraph("Outstanding\ninvoices", header_style),
        Paragraph("Amount owed", header_style),
    ]]

    grand_wallet = 0
    grand_outstanding = 0
    grand_owed = 0
    for r in rows:
        contact_lines = []
        if r["contact_name"]:
            contact_lines.append(r["contact_name"])
        if r["contact_email"]:
            contact_lines.append(f"<font color='#64748B'>{r['contact_email']}</font>")
        contact_cell = Paragraph("<br/>".join(contact_lines) or "—", cell_style)
        terms = "Credit (arrears)" if r["pay_in_arrears"] else "Prepaid"
        if not r["active"]:
            terms += "<br/><font color='#B91C1C'>Inactive</font>"
        table_rows.append([
            Paragraph(f"<b>{r['name']}</b>", cell_style),
            contact_cell,
            Paragraph(terms, cell_style),
            Paragraph(_rand(r["wallet_balance_cents"]), cell_style),
            Paragraph(_rand(r["outstanding_cents"]) if r["outstanding_cents"] else "—", cell_style),
            Paragraph(
                f"<b>{_rand(r['amount_owed_cents'])}</b>" if r["amount_owed_cents"] else "—",
                cell_style,
            ),
        ])
        grand_wallet += r["wallet_balance_cents"]
        grand_outstanding += r["outstanding_cents"]
        grand_owed += r["amount_owed_cents"]

    # Total row
    table_rows.append([
        Paragraph("<b>TOTAL</b>", cell_style),
        Paragraph(f"<font color='#64748B'>{len(rows)} dealerships</font>", cell_style),
        Paragraph("", cell_style),
        Paragraph(f"<b>{_rand(grand_wallet)}</b>", cell_style),
        Paragraph(f"<b>{_rand(grand_outstanding)}</b>", cell_style),
        Paragraph(f"<b>{_rand(grand_owed)}</b>", cell_style),
    ])

    tbl = Table(
        table_rows,
        colWidths=[42 * mm, 48 * mm, 22 * mm, 24 * mm, 26 * mm, 28 * mm],
        repeatRows=1,
    )
    tbl.setStyle(TableStyle([
        ("BACKGROUND", (0, 0), (-1, 0), _rlcolors.HexColor("#0F172A")),
        ("GRID", (0, 0), (-1, -1), 0.25, _rlcolors.HexColor("#E5E7EB")),
        ("VALIGN", (0, 0), (-1, -1), "TOP"),
        ("ALIGN", (3, 1), (5, -1), "RIGHT"),
        ("TOPPADDING", (0, 0), (-1, -1), 3),
        ("BOTTOMPADDING", (0, 0), (-1, -1), 3),
        # Total row styling
        ("BACKGROUND", (0, -1), (-1, -1), _rlcolors.HexColor("#F1F5F9")),
        ("LINEABOVE", (0, -1), (-1, -1), 0.8, _rlcolors.HexColor("#0F172A")),
    ]))

    now = datetime.now(timezone.utc)
    intro = Paragraph(
        f"<b>Snapshot generated:</b> {now.strftime('%Y-%m-%d %H:%M UTC')}<br/>"
        f"<b>Dealerships in report:</b> {len(rows)}<br/>"
        "<i>Amount owed = negative wallet balance (i.e. cash the dealer needs to send to clear their ledger). "
        "Positive wallets are prepaid and owe nothing today.</i>",
        small,
    )
    body = [intro, Spacer(1, 8), tbl]

    # A single-dealership _pdf_header expects a dealership dict — use
    # a stub since the "BILL TO" side is meaningless on an aggregate
    # report. The header block still renders the company (Fourbuy)
    # info on the left.
    stub_dealership = {"name": "ALL DEALERSHIPS", "address": ""}
    pdf = _render_pdf("DEBTORS REPORT — LIVE SNAPSHOT", body, company, stub_dealership)
    filename = f"debtors_report_{date.today().isoformat()}.pdf"
    return Response(
        content=pdf,
        media_type="application/pdf",
        headers={"Content-Disposition": f"inline; filename={filename}"},
    )


# ---------------------------------------------------------------------------
# Overview / Summary endpoints
# ---------------------------------------------------------------------------
@router.get("/admin/dealerships/{dealership_id}/billing-summary")
async def admin_billing_summary(
    dealership_id: str,
    current: dict = Depends(_dep_require_admin),
):
    d = await _db.dealerships.find_one({"id": dealership_id}, {"_id": 0})
    if not d:
        raise HTTPException(404, "Dealership not found")
    wallet = await _recompute_wallet(dealership_id)
    invoices = await _db.dealer_invoices.find({"dealership_id": dealership_id}, {"_id": 0}).sort("generated_at", -1).to_list(200)
    payments = await _db.dealer_payments.find({"dealership_id": dealership_id}, {"_id": 0}).sort("recorded_at", -1).to_list(500)
    refunds = await _db.deposit_refunds.find({"dealership_id": dealership_id}, {"_id": 0}).sort("recorded_at", -1).to_list(200)
    pay_in_arrears = bool(d.get("pay_in_arrears"))
    return {
        "dealership": {
            "id": d["id"], "name": d.get("name"), "address": d.get("address"),
            "vat_no": d.get("vat_no"), "company_reg_no": d.get("company_reg_no"),
            "accounts_contact": d.get("accounts_contact") or {},
            "active": d.get("active", True),
            "pay_in_arrears": pay_in_arrears,
        },
        "wallet": {
            "balance_zar": cents_to_zar(wallet["balance_cents"]),
            "credits_zar": cents_to_zar(wallet["total_credits_cents"]),
            "usage_zar": cents_to_zar(wallet["usage_cents"]),
            "refunds_zar": cents_to_zar(wallet["refunds_cents"]),
            "suspended": (not pay_in_arrears) and wallet["balance_cents"] <= 0,
            "pay_in_arrears": pay_in_arrears,
        },
        "invoices": invoices,
        "payments": payments,
        "refunds": refunds,
    }


class BillingTermsUpdate(BaseModel):
    pay_in_arrears: bool


@router.patch("/admin/dealerships/{dealership_id}/billing-terms")
async def admin_update_billing_terms(
    dealership_id: str,
    payload: BillingTermsUpdate,
    current: dict = Depends(_dep_require_admin),
):
    """Toggle whether a dealership operates on credit terms
    (`pay_in_arrears=True`) or prepaid-wallet terms (default). When
    on credit terms the wallet-depleted guard is bypassed on all
    write endpoints — submissions, VIN reports and Get Cover can go
    ahead regardless of balance."""
    d = await _db.dealerships.find_one({"id": dealership_id}, {"_id": 0, "id": 1, "name": 1})
    if not d:
        raise HTTPException(404, "Dealership not found")
    await _db.dealerships.update_one(
        {"id": dealership_id},
        {"$set": {"pay_in_arrears": bool(payload.pay_in_arrears), "billing_terms_updated_at": _now_utc()}},
    )
    logger.info(
        "Admin %s set pay_in_arrears=%s for dealership %s (%s)",
        current.get("email"), payload.pay_in_arrears, dealership_id, d.get("name"),
    )
    return {"dealership_id": dealership_id, "pay_in_arrears": bool(payload.pay_in_arrears)}


@router.get("/admin/billing/overview")
async def admin_billing_overview(current: dict = Depends(_dep_require_admin)):
    dealerships = await _db.dealerships.find({}, {"_id": 0}).sort("name", 1).to_list(1000)
    rows = []
    for d in dealerships:
        # Only recompute occasionally to keep the overview cheap; use cached value if present.
        balance = int(d.get("wallet_balance_cents") or 0)
        if "wallet_balance_cents" not in d:
            w = await _recompute_wallet(d["id"])
            balance = w["balance_cents"]
        pay_in_arrears = bool(d.get("pay_in_arrears"))
        rows.append({
            "id": d["id"],
            "name": d.get("name"),
            "accounts_contact": d.get("accounts_contact") or {},
            "wallet_balance_zar": cents_to_zar(balance),
            "wallet_usage_zar": cents_to_zar(d.get("wallet_usage_cents") or 0),
            "wallet_credits_zar": cents_to_zar(d.get("wallet_credits_cents") or 0),
            "pay_in_arrears": pay_in_arrears,
            "suspended": (not pay_in_arrears) and balance <= 0,
        })
    return {"dealerships": rows}


@router.get("/billing/my-summary")
async def dealer_billing_my_summary(current: dict = Depends(_dep_current_user)):
    dealership_id = current.get("dealership_id")
    if not dealership_id:
        return {"wallet": {"balance_zar": 0, "suspended": False, "pay_in_arrears": False}, "invoices": [], "payments": []}
    d = await _db.dealerships.find_one({"id": dealership_id}, {"_id": 0, "pay_in_arrears": 1}) or {}
    pay_in_arrears = bool(d.get("pay_in_arrears"))
    wallet = await _recompute_wallet(dealership_id)
    invoices = await _db.dealer_invoices.find(
        {"dealership_id": dealership_id},
        {"_id": 0, "line_items": 0},  # line items are heavy; PDF has them.
    ).sort("generated_at", -1).to_list(120)
    payments = await _db.dealer_payments.find(
        {"dealership_id": dealership_id},
        {"_id": 0},
    ).sort("recorded_at", -1).to_list(120)
    return {
        "wallet": {
            "balance_zar": cents_to_zar(wallet["balance_cents"]),
            "credits_zar": cents_to_zar(wallet["total_credits_cents"]),
            "usage_zar": cents_to_zar(wallet["usage_cents"]),
            "suspended": (not pay_in_arrears) and wallet["balance_cents"] <= 0,
            "pay_in_arrears": pay_in_arrears,
        },
        "invoices": invoices,
        "payments": payments,
    }


__all__ = [
    "router",
    "init_billing_module",
    "assert_dealership_active",
    "zar_to_cents",
    "cents_to_zar",
    "run_monthly_invoice_batch",
    "start_monthly_invoice_scheduler",
]


# ---------------------------------------------------------------------------
# Monthly invoice scheduler (Aug 2026).
#
# A tiny in-process asyncio loop that fires `run_monthly_invoice_batch`
# once per calendar month, on the 1st, covering the prior month. Uses
# a lightweight sentinel document in `billing_scheduler` to guarantee
# we only invoice once per month even if the server restarts on the
# 1st. Sleeping in ~15 minute checks keeps the drift bounded to
# under a coffee-break so the invoices land close to midnight local
# time without pounding the event loop.
# ---------------------------------------------------------------------------
import asyncio as _billing_asyncio  # avoid clashes with server.py imports


async def _monthly_scheduler_loop() -> None:
    """Long-running task. Cancelled cleanly on FastAPI shutdown."""
    logger.info("Monthly invoice scheduler started")
    while True:
        try:
            now = datetime.now(timezone.utc)
            # Only actually invoice on the 1st of the month. Prior
            # month runs are stored under a `year-month` sentinel so
            # a same-day restart doesn't fire the batch twice.
            if now.day == 1:
                prev_year, prev_month = (now.year - 1, 12) if now.month == 1 else (now.year, now.month - 1)
                sentinel_key = f"monthly_invoice:{prev_year:04d}-{prev_month:02d}"
                already = await _db.billing_scheduler.find_one({"_id": sentinel_key})
                if not already:
                    logger.info("Monthly invoice batch triggered by scheduler (period=%s-%02d)", prev_year, prev_month)
                    try:
                        result = await run_monthly_invoice_batch()
                        await _db.billing_scheduler.update_one(
                            {"_id": sentinel_key},
                            {"$set": {"ran_at": _now_utc(), "result": result}},
                            upsert=True,
                        )
                    except Exception as e:
                        logger.exception("Monthly invoice batch failed: %s", e)
        except _billing_asyncio.CancelledError:
            raise
        except Exception as e:
            # Never let a bad iteration kill the loop.
            logger.warning("Monthly scheduler iteration errored: %s", e)
        # Sleep 15 minutes between polls. Cheap and reliable.
        try:
            await _billing_asyncio.sleep(15 * 60)
        except _billing_asyncio.CancelledError:
            raise


def start_monthly_invoice_scheduler() -> _billing_asyncio.Task:
    """Kick off the background scheduler. Idempotent — call once at
    FastAPI startup. Returns the task handle so callers can await
    cancellation on shutdown if desired.
    """
    task = _billing_asyncio.create_task(_monthly_scheduler_loop(), name="billing-monthly-scheduler")
    return task
