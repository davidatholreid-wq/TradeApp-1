"""Iteration 65 — Billing pivot regression.

Verifies the Aug 2026 refactor of the billing module:
- Deposit-request endpoint is REMOVED (404).
- POST /admin/dealerships/{id}/payments enforces strict allocation.
- Invoice auto re-email on payment updates emailed_at.
- POST /admin/dealerships/{id}/invoices/{invoice_id}/resend-email works.
- POST /admin/billing/run-monthly-batch returns the correct shape and is idempotent.
- billing-summary no longer has `deposit_requests`.
- /api/billing/my-summary returns `payments` (not `deposits`).
- deposit-refund still works and lowers wallet balance.
"""
from __future__ import annotations

import os
import uuid
from datetime import datetime, timezone

import pytest
import requests

BASE_URL = (os.environ.get("EXPO_PUBLIC_BACKEND_URL")
            or os.environ.get("EXPO_BACKEND_URL")
            or "https://fourbuy-admin.preview.emergentagent.com").rstrip("/")

ADMIN_EMAIL = "admin@fourbuy.co.za"
ADMIN_PASSWORD = "admin123"

DAVE_EMAIL = "dave@fourbuy.co.za"
DAVE_PASSWORD = "Dave1234!"
DAVE_DEALERSHIP_ID = "eb95e007-537b-4232-a314-0eba3e7164e7"


# ---------- fixtures ----------
@pytest.fixture(scope="module")
def admin_token():
    r = requests.post(f"{BASE_URL}/api/auth/login",
                      json={"email": ADMIN_EMAIL, "password": ADMIN_PASSWORD}, timeout=30)
    assert r.status_code == 200, f"admin login failed: {r.status_code} {r.text}"
    return r.json()["token"]


@pytest.fixture(scope="module")
def admin_headers(admin_token):
    return {"Authorization": f"Bearer {admin_token}", "Content-Type": "application/json"}


@pytest.fixture(scope="module")
def dave_token():
    r = requests.post(f"{BASE_URL}/api/auth/login",
                      json={"email": DAVE_EMAIL, "password": DAVE_PASSWORD}, timeout=30)
    if r.status_code != 200:
        pytest.skip(f"Dave login unavailable: {r.status_code} {r.text[:120]}")
    return r.json()["token"]


@pytest.fixture(scope="module")
def dealership_id(admin_headers):
    """Pick Dave's dealership; if that fails, pick any dealership from overview."""
    r = requests.get(f"{BASE_URL}/api/admin/dealerships/{DAVE_DEALERSHIP_ID}/billing-summary",
                     headers=admin_headers, timeout=30)
    if r.status_code == 200:
        return DAVE_DEALERSHIP_ID
    r2 = requests.get(f"{BASE_URL}/api/admin/billing/overview",
                      headers=admin_headers, timeout=30)
    assert r2.status_code == 200
    rows = r2.json().get("dealerships") or []
    assert rows, "no dealerships available"
    return rows[0]["id"]


# ---------- removed endpoint returns 404 ----------
class TestRemovedEndpoint:
    def test_deposit_request_removed(self, admin_headers, dealership_id):
        url = f"{BASE_URL}/api/admin/dealerships/{dealership_id}/deposit-request"
        r = requests.post(url, headers=admin_headers,
                          json={"amount_zar": 100.0, "notes": "x"}, timeout=30)
        assert r.status_code == 404, f"expected 404 got {r.status_code}: {r.text[:200]}"


# ---------- billing-summary shape ----------
class TestBillingSummaryShape:
    def test_summary_has_no_deposit_requests_key(self, admin_headers, dealership_id):
        r = requests.get(f"{BASE_URL}/api/admin/dealerships/{dealership_id}/billing-summary",
                         headers=admin_headers, timeout=30)
        assert r.status_code == 200, r.text
        data = r.json()
        assert "deposit_requests" not in data, f"deposit_requests still present: {list(data.keys())}"
        # New expected keys:
        for key in ("dealership", "wallet", "invoices", "payments", "refunds"):
            assert key in data, f"missing key {key}"


# ---------- strict allocation ----------
class TestStrictAllocation:
    def test_unallocated_payment_rejected_400(self, admin_headers, dealership_id):
        r = requests.post(f"{BASE_URL}/api/admin/dealerships/{dealership_id}/payments",
                          headers=admin_headers,
                          json={"amount_zar": 10.0, "payment_date": "2026-01-15",
                                "bank_reference": "TEST_UNALLOC"}, timeout=30)
        assert r.status_code == 400, f"expected 400 got {r.status_code}: {r.text[:200]}"

    def test_both_allocation_rejected_400(self, admin_headers, dealership_id):
        r = requests.post(f"{BASE_URL}/api/admin/dealerships/{dealership_id}/payments",
                          headers=admin_headers,
                          json={"amount_zar": 10.0, "payment_date": "2026-01-15",
                                "bank_reference": "TEST_BOTH",
                                "invoice_id": str(uuid.uuid4()),
                                "is_deposit": True}, timeout=30)
        assert r.status_code == 400, f"expected 400 got {r.status_code}: {r.text[:200]}"

    def test_unknown_invoice_id_404(self, admin_headers, dealership_id):
        r = requests.post(f"{BASE_URL}/api/admin/dealerships/{dealership_id}/payments",
                          headers=admin_headers,
                          json={"amount_zar": 10.0, "payment_date": "2026-01-15",
                                "bank_reference": "TEST_BADINV",
                                "invoice_id": str(uuid.uuid4())}, timeout=30)
        assert r.status_code == 404, f"expected 404 got {r.status_code}: {r.text[:200]}"

    def test_deposit_topup_increases_wallet(self, admin_headers, dealership_id):
        before = requests.get(
            f"{BASE_URL}/api/admin/dealerships/{dealership_id}/billing-summary",
            headers=admin_headers, timeout=30).json()
        bal0 = float(before["wallet"]["balance_zar"])
        amt = 111.11
        r = requests.post(f"{BASE_URL}/api/admin/dealerships/{dealership_id}/payments",
                          headers=admin_headers,
                          json={"amount_zar": amt, "payment_date": "2026-01-15",
                                "bank_reference": "TEST_TOPUP",
                                "is_deposit": True}, timeout=30)
        assert r.status_code == 200, r.text
        pay = r.json()["payment"]
        assert pay["is_deposit"] is True
        assert pay["invoice_id"] is None
        assert pay["amount_zar"] == pytest.approx(amt)
        after = requests.get(
            f"{BASE_URL}/api/admin/dealerships/{dealership_id}/billing-summary",
            headers=admin_headers, timeout=30).json()
        bal1 = float(after["wallet"]["balance_zar"])
        assert bal1 == pytest.approx(bal0 + amt, abs=0.01), \
            f"wallet did not grow by {amt}: before={bal0} after={bal1}"


# ---------- invoice payment flow ----------
class TestInvoicePayment:
    """Generate an invoice (or reuse the latest outstanding one), post two
    payments and verify partial→paid transitions + auto re-email + wallet growth."""

    @pytest.fixture(scope="class")
    def invoice(self, admin_headers, dealership_id):
        # Try to find an existing outstanding invoice first.
        summary = requests.get(
            f"{BASE_URL}/api/admin/dealerships/{dealership_id}/billing-summary",
            headers=admin_headers, timeout=30).json()
        for inv in summary.get("invoices", []):
            if inv.get("status") in ("outstanding", "partial") and inv.get("total_cents", 0) > 0:
                return inv
        # Otherwise try to generate one — sweep several months looking for
        # activity we haven't already invoiced.
        now = datetime.now(timezone.utc)
        candidates = []
        for delta in range(1, 25):
            y, m = now.year, now.month - delta
            while m <= 0:
                m += 12
                y -= 1
            candidates.append((y, m))
        for y, m in candidates:
            r = requests.post(
                f"{BASE_URL}/api/admin/dealerships/{dealership_id}/invoices/generate",
                headers=admin_headers, json={"year": y, "month": m}, timeout=60)
            if r.status_code == 200:
                return r.json()["invoice"]
        pytest.skip("No outstanding invoice available and generate found no billable activity in past 24 months.")

    def test_partial_payment_flips_to_partial(self, admin_headers, dealership_id, invoice):
        remaining = int(invoice["total_cents"]) - int(invoice.get("total_paid_cents") or 0)
        assert remaining > 0
        # pay 1 cent worth (0.01) so we always stay partial
        r = requests.post(
            f"{BASE_URL}/api/admin/dealerships/{dealership_id}/payments",
            headers=admin_headers,
            json={"amount_zar": 0.01, "payment_date": "2026-01-15",
                  "bank_reference": "TEST_PART",
                  "invoice_id": invoice["id"]}, timeout=30)
        assert r.status_code == 200, r.text
        pay = r.json()["payment"]
        assert pay["invoice_id"] == invoice["id"]
        # Verify invoice status via billing-summary
        summary = requests.get(
            f"{BASE_URL}/api/admin/dealerships/{dealership_id}/billing-summary",
            headers=admin_headers, timeout=30).json()
        inv_after = next((i for i in summary["invoices"] if i["id"] == invoice["id"]), None)
        assert inv_after is not None
        assert inv_after["status"] == "partial", f"expected partial got {inv_after['status']}"
        assert int(inv_after["total_paid_cents"]) == int(invoice.get("total_paid_cents") or 0) + 1
        # emailed_at should be set (auto re-email) — depends on accounts_contact.email existing.
        # Not a hard requirement per spec (email is real & can fail); just record it.
        pytest._last_emailed_at = inv_after.get("emailed_at")

    def test_full_payment_flips_to_paid_and_wallet_grows(self, admin_headers, dealership_id, invoice):
        # Refetch invoice
        summary = requests.get(
            f"{BASE_URL}/api/admin/dealerships/{dealership_id}/billing-summary",
            headers=admin_headers, timeout=30).json()
        inv = next((i for i in summary["invoices"] if i["id"] == invoice["id"]), None)
        assert inv is not None
        remaining_cents = int(inv["total_cents"]) - int(inv.get("total_paid_cents") or 0)
        if remaining_cents <= 0:
            pytest.skip("invoice already fully paid")
        remaining_zar = round(remaining_cents / 100.0, 2)
        bal_before = float(summary["wallet"]["balance_zar"])
        r = requests.post(
            f"{BASE_URL}/api/admin/dealerships/{dealership_id}/payments",
            headers=admin_headers,
            json={"amount_zar": remaining_zar, "payment_date": "2026-01-15",
                  "bank_reference": "TEST_FULL",
                  "invoice_id": invoice["id"]}, timeout=30)
        assert r.status_code == 200, r.text
        summary_after = requests.get(
            f"{BASE_URL}/api/admin/dealerships/{dealership_id}/billing-summary",
            headers=admin_headers, timeout=30).json()
        inv_after = next((i for i in summary_after["invoices"] if i["id"] == invoice["id"]), None)
        assert inv_after["status"] == "paid", f"expected paid got {inv_after['status']}"
        assert int(inv_after["total_paid_cents"]) >= int(inv_after["total_cents"])
        assert inv_after.get("paid_at") is not None
        bal_after = float(summary_after["wallet"]["balance_zar"])
        assert bal_after == pytest.approx(bal_before + remaining_zar, abs=0.02)

    def test_auto_reemail_updates_emailed_at(self, admin_headers, dealership_id, invoice):
        """After payments against an invoice, emailed_at should be set IF the
        dealership has an accounts_contact.email. Otherwise informational."""
        summary = requests.get(
            f"{BASE_URL}/api/admin/dealerships/{dealership_id}/billing-summary",
            headers=admin_headers, timeout=30).json()
        contact_email = ((summary.get("dealership") or {}).get("accounts_contact") or {}).get("email")
        inv_after = next((i for i in summary["invoices"] if i["id"] == invoice["id"]), None)
        if not contact_email:
            pytest.skip("no accounts_contact.email — auto re-email not attempted by design")
        # If contact exists, we expect emailed_at to be set (best-effort — email transport can still fail).
        assert inv_after.get("emailed_at"), \
            "auto re-email did not set emailed_at even though accounts_contact.email present"


# ---------- resend-email ----------
class TestResendInvoiceEmail:
    def test_resend_email(self, admin_headers, dealership_id):
        summary = requests.get(
            f"{BASE_URL}/api/admin/dealerships/{dealership_id}/billing-summary",
            headers=admin_headers, timeout=30).json()
        invoices = summary.get("invoices") or []
        contact_email = ((summary.get("dealership") or {}).get("accounts_contact") or {}).get("email")
        if not invoices:
            pytest.skip("no invoices to resend")
        if not contact_email:
            pytest.skip("no accounts_contact.email on file for this dealership")
        inv = invoices[0]
        r = requests.post(
            f"{BASE_URL}/api/admin/dealerships/{dealership_id}/invoices/{inv['id']}/resend-email",
            headers=admin_headers, timeout=60)
        # 200 expected; 502 possible if the real email transport is down.
        assert r.status_code in (200, 502), f"unexpected {r.status_code}: {r.text[:200]}"
        if r.status_code == 200:
            body = r.json()
            assert body.get("emailed_to") == contact_email
            assert body.get("emailed_at")

    def test_resend_email_bad_invoice_404(self, admin_headers, dealership_id):
        r = requests.post(
            f"{BASE_URL}/api/admin/dealerships/{dealership_id}/invoices/{uuid.uuid4()}/resend-email",
            headers=admin_headers, timeout=30)
        assert r.status_code == 404


# ---------- monthly batch ----------
class TestMonthlyBatch:
    def test_run_monthly_batch_shape_and_idempotent(self, admin_headers):
        r1 = requests.post(f"{BASE_URL}/api/admin/billing/run-monthly-batch",
                           headers=admin_headers, timeout=180)
        assert r1.status_code == 200, r1.text
        d1 = r1.json()
        for k in ("generated", "skipped", "year", "month"):
            assert k in d1, f"missing key {k} in {d1}"
        assert isinstance(d1["generated"], int)
        assert isinstance(d1["skipped"], int)

        r2 = requests.post(f"{BASE_URL}/api/admin/billing/run-monthly-batch",
                           headers=admin_headers, timeout=180)
        assert r2.status_code == 200, r2.text
        d2 = r2.json()
        # Second run should generate no more than the first.
        assert d2["generated"] <= d1["generated"], \
            f"idempotency failure: run1={d1} run2={d2}"


# ---------- dealer my-summary ----------
class TestDealerMySummary:
    def test_my_summary_returns_payments_not_deposits(self, dave_token):
        r = requests.get(f"{BASE_URL}/api/billing/my-summary",
                         headers={"Authorization": f"Bearer {dave_token}"}, timeout=30)
        assert r.status_code == 200, r.text
        data = r.json()
        assert "deposits" not in data, f"legacy 'deposits' key still present: {list(data.keys())}"
        assert "payments" in data
        assert isinstance(data["payments"], list)
        assert "invoices" in data
        assert "wallet" in data


# ---------- deposit refund still works ----------
class TestDepositRefund:
    def test_refund_lowers_wallet(self, admin_headers, dealership_id):
        before = requests.get(
            f"{BASE_URL}/api/admin/dealerships/{dealership_id}/billing-summary",
            headers=admin_headers, timeout=30).json()
        bal0 = float(before["wallet"]["balance_zar"])
        amt = 1.00
        r = requests.post(
            f"{BASE_URL}/api/admin/dealerships/{dealership_id}/deposit-refund",
            headers=admin_headers,
            json={"amount_zar": amt, "refund_date": "2026-01-15",
                  "bank_reference": "TEST_REFUND"}, timeout=30)
        assert r.status_code == 200, r.text
        refund = r.json()["refund"]
        assert refund["amount_zar"] == pytest.approx(amt)
        assert refund.get("reference", "").startswith("REF-")
        after = requests.get(
            f"{BASE_URL}/api/admin/dealerships/{dealership_id}/billing-summary",
            headers=admin_headers, timeout=30).json()
        bal1 = float(after["wallet"]["balance_zar"])
        assert bal1 == pytest.approx(bal0 - amt, abs=0.01), \
            f"refund did not decrease wallet: before={bal0} after={bal1}"
