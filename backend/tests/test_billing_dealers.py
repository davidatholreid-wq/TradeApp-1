"""
Backend tests for Fourbuy Billing + Dealer Management (Jan 2026).
Covers:
- Agreement accept/status
- Suspend/reactivate dealer (403 on login when inactive)
- Dealer edit (PATCH /admin/dealers/{id})
- Password reset (POST /admin/dealers/{id}/password)
- Submission gating (billing_accepted + agreement_accepted_at)
- Billing summary (GET /admin/billing) shape + math
- Admin dealers/submissions expose billable_* fields
"""
import os
import uuid
import pytest
import requests
from datetime import datetime, timezone

BASE_URL = "https://fourbuy-admin.preview.emergentagent.com"
API = f"{BASE_URL}/api"
ADMIN_EMAIL = "admin@fourbuy.co.za"
ADMIN_PASSWORD = "admin123"


TINY_PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII="


# ---------- Fixtures ----------
@pytest.fixture(scope="module")
def s():
    sess = requests.Session()
    sess.headers.update({"Content-Type": "application/json"})
    return sess


@pytest.fixture(scope="module")
def admin_token(s):
    r = s.post(f"{API}/auth/login", json={"email": ADMIN_EMAIL, "password": ADMIN_PASSWORD})
    assert r.status_code == 200, f"Admin login failed: {r.status_code} {r.text}"
    return r.json()["token"]


@pytest.fixture(scope="module")
def admin_h(admin_token):
    return {"Authorization": f"Bearer {admin_token}"}


@pytest.fixture(scope="module")
def new_dealer(s):
    """Register a brand-new dealer per test run (fresh agreement_accepted_at=None)."""
    email = f"test_billing_{uuid.uuid4().hex[:8]}@example.com"
    password = "Billing123!"
    payload = {
        "email": email,
        "password": password,
        "dealer_info": {"first_name": "Bill", "last_name": "Tester", "phone": "0821111111"},
        "company_info": {"company_name": "TEST_Billing Co", "company_address": "1 Test Rd"},
    }
    r = s.post(f"{API}/auth/register", json=payload)
    assert r.status_code == 200, f"Register failed: {r.text}"
    data = r.json()
    return {
        "id": data["user"]["id"],
        "email": email,
        "password": password,
        "token": data["token"],
    }


def dealer_headers(token):
    return {"Authorization": f"Bearer {token}"}


def _submission_payload(billing_accepted=True):
    return {
        "make_id": "x", "make_name": "TEST_Make",
        "model_id": "y", "model_name": "TEST_Model",
        "derivative_id": "z", "derivative_name": "TEST_Deriv",
        "mileage": 50000, "year": 2020,
        "factory_warranty": True, "condition": 8,
        "accident_damage": False, "colour": "White",
        "license_disk_data": "%TEST%",
        "photos": {"front": TINY_PNG, "side_right": TINY_PNG, "rear": TINY_PNG,
                   "side_left": TINY_PNG, "interior": TINY_PNG},
        "billing_accepted": billing_accepted,
    }


# ---------- 1. Admin login ----------
def test_admin_login_ok(admin_token):
    assert admin_token


# ---------- 2. GET /admin/dealers exposes fee/sla + billable fields ----------
def test_admin_dealers_has_billing_fields(s, admin_h, new_dealer):
    r = s.get(f"{API}/admin/dealers", headers=admin_h)
    assert r.status_code == 200
    body = r.json()
    assert body.get("fee_zar") == 50.0
    assert body.get("sla_hours") == 24
    dealers = body["dealers"]
    assert len(dealers) >= 1
    # Every dealer row has active + billable_count + billable_total_zar
    for d in dealers:
        assert "active" in d and isinstance(d["active"], bool)
        assert "billable_count" in d
        assert "billable_total_zar" in d
        assert "password_hash" not in d
        assert "_id" not in d
    # Our fresh dealer is present
    assert any(d["id"] == new_dealer["id"] for d in dealers)


# ---------- 3. Agreement flow ----------
def test_agreement_status_starts_false(s, new_dealer):
    r = s.get(f"{API}/agreement/status", headers=dealer_headers(new_dealer["token"]))
    assert r.status_code == 200
    body = r.json()
    assert body["accepted"] is False
    assert body["accepted_at"] is None
    assert body["fee_zar"] == 50.0
    assert body["sla_hours"] == 24


def test_submission_without_agreement_409(s, new_dealer):
    r = s.post(f"{API}/submissions", json=_submission_payload(True),
               headers=dealer_headers(new_dealer["token"]))
    assert r.status_code == 409, f"Expected 409 (agreement required), got {r.status_code}: {r.text}"


def test_agreement_accept(s, new_dealer):
    r = s.post(f"{API}/agreement/accept", headers=dealer_headers(new_dealer["token"]))
    assert r.status_code == 200
    assert r.json().get("accepted_at")
    # Status now true
    r2 = s.get(f"{API}/agreement/status", headers=dealer_headers(new_dealer["token"]))
    assert r2.status_code == 200
    assert r2.json()["accepted"] is True
    assert r2.json()["accepted_at"]


# ---------- 4. Submission gating on billing_accepted ----------
def test_submission_without_billing_accepted_400(s, new_dealer):
    # Agreement already accepted in prior test
    payload = _submission_payload(billing_accepted=False)
    r = s.post(f"{API}/submissions", json=payload,
               headers=dealer_headers(new_dealer["token"]))
    assert r.status_code == 400, f"Expected 400, got {r.status_code}: {r.text}"


@pytest.fixture(scope="module")
def created_submission(s, new_dealer):
    """Create a valid submission (after agreement)."""
    payload = _submission_payload(billing_accepted=True)
    r = s.post(f"{API}/submissions", json=payload,
               headers=dealer_headers(new_dealer["token"]))
    assert r.status_code == 200, f"Submission create failed: {r.status_code} {r.text}"
    body = r.json()
    assert body["submission"]["status"] == "pending"
    # billing_accepted_at should be stamped
    assert body["submission"].get("billing_accepted_at")
    return body["id"]


def test_create_submission_ok(created_submission):
    assert created_submission


# ---------- 5. Suspend / re-activate dealer ----------
def test_suspend_dealer_blocks_login(s, admin_h, new_dealer):
    # Suspend
    r = s.post(f"{API}/admin/dealers/{new_dealer['id']}/active",
               json={"active": False}, headers=admin_h)
    assert r.status_code == 200
    assert r.json()["active"] is False

    # Login should fail 403
    r2 = s.post(f"{API}/auth/login",
                json={"email": new_dealer["email"], "password": new_dealer["password"]})
    assert r2.status_code == 403, f"Expected 403 on suspended login, got {r2.status_code} {r2.text}"
    assert "suspend" in r2.text.lower() or "contact fourbuy" in r2.text.lower()

    # Reactivate
    r3 = s.post(f"{API}/admin/dealers/{new_dealer['id']}/active",
                json={"active": True}, headers=admin_h)
    assert r3.status_code == 200
    assert r3.json()["active"] is True

    # Login succeeds again
    r4 = s.post(f"{API}/auth/login",
                json={"email": new_dealer["email"], "password": new_dealer["password"]})
    assert r4.status_code == 200
    # Refresh token for later tests
    new_dealer["token"] = r4.json()["token"]
    # Response includes agreement_accepted_at + active
    user = r4.json()["user"]
    assert user.get("active") is True
    assert user.get("agreement_accepted_at")


# ---------- 6. PATCH /admin/dealers/{id} ----------
def test_patch_dealer_phone(s, admin_h, new_dealer):
    r = s.patch(f"{API}/admin/dealers/{new_dealer['id']}",
                json={"phone": "0999999999"}, headers=admin_h)
    assert r.status_code == 200
    updated = r.json()["dealer"]
    assert updated["dealer_info"]["phone"] == "0999999999"

    # Verify via /auth/me
    r2 = s.get(f"{API}/auth/me", headers=dealer_headers(new_dealer["token"]))
    assert r2.status_code == 200
    assert r2.json()["user"]["dealer_info"]["phone"] == "0999999999"


def test_patch_dealer_empty_400(s, admin_h, new_dealer):
    r = s.patch(f"{API}/admin/dealers/{new_dealer['id']}", json={}, headers=admin_h)
    assert r.status_code == 400


def test_patch_dealer_email_collision_409(s, admin_h, new_dealer):
    # Try to change to admin's email
    r = s.patch(f"{API}/admin/dealers/{new_dealer['id']}",
                json={"email": ADMIN_EMAIL}, headers=admin_h)
    assert r.status_code == 409


# ---------- 7. Password reset ----------
def test_password_reset(s, admin_h, new_dealer):
    new_pw = "NewBill123!"
    r = s.post(f"{API}/admin/dealers/{new_dealer['id']}/password",
               json={"new_password": new_pw}, headers=admin_h)
    assert r.status_code == 200

    # Old password fails
    r2 = s.post(f"{API}/auth/login",
                json={"email": new_dealer["email"], "password": new_dealer["password"]})
    assert r2.status_code == 401

    # New password works
    r3 = s.post(f"{API}/auth/login",
                json={"email": new_dealer["email"], "password": new_pw})
    assert r3.status_code == 200
    new_dealer["password"] = new_pw
    new_dealer["token"] = r3.json()["token"]


# ---------- 8. Admin submissions include billable flag ----------
def test_admin_submissions_billable_flag(s, admin_h, created_submission):
    r = s.get(f"{API}/admin/submissions", headers=admin_h)
    assert r.status_code == 200
    subs = r.json()["submissions"]
    assert len(subs) >= 1
    for sub in subs:
        assert "billable" in sub, "each submission must expose 'billable'"
        assert isinstance(sub["billable"], bool)


# ---------- 9. Price then verify billing report ----------
def test_price_submission_and_billing_report(s, admin_h, admin_token, new_dealer, created_submission):
    # Price the submission (should be within 24h, so billable=True)
    r = s.post(f"{API}/admin/submissions/{created_submission}/price",
               json={"price": 250000, "notes": "TEST"}, headers=admin_h)
    assert r.status_code == 200, f"Pricing failed: {r.text}"
    data = r.json()
    assert data["status"] == "priced"

    # Fetch billing for current month
    today = datetime.now(timezone.utc)
    month = f"{today.year:04d}-{today.month:02d}"
    r2 = s.get(f"{API}/admin/billing", params={"month": month}, headers=admin_h)
    assert r2.status_code == 200
    body = r2.json()
    assert body["fee_zar"] == 50.0
    assert body["sla_hours"] == 24
    assert body["month"] == month
    assert "rows" in body and "totals" in body
    # Our dealer must appear in rows
    my_row = next((row for row in body["rows"] if row["dealer_id"] == new_dealer["id"]), None)
    assert my_row is not None, "Freshly-priced submission should appear in billing rows"
    assert my_row["priced_count"] >= 1
    assert my_row["billable_count"] >= 1
    # amount == billable_count * 50
    assert my_row["amount_zar"] == round(my_row["billable_count"] * 50.0, 2)
    # Every item[].billable is bool; the item we just priced should be billable
    ours = next((it for it in my_row["items"] if it["id"] == created_submission), None)
    assert ours is not None
    assert ours["billable"] is True

    # Totals math sanity
    totals = body["totals"]
    assert totals["amount_zar"] == round(totals["billable_count"] * 50.0, 2)


# ---------- 10. Bad month string ----------
def test_billing_bad_month_400(s, admin_h):
    r = s.get(f"{API}/admin/billing", params={"month": "bad-month"}, headers=admin_h)
    assert r.status_code == 400


# ---------- 11. Auth/me exposes new fields ----------
def test_auth_me_exposes_active_and_agreement(s, new_dealer):
    r = s.get(f"{API}/auth/me", headers=dealer_headers(new_dealer["token"]))
    assert r.status_code == 200
    user = r.json()["user"]
    assert "active" in user
    assert "agreement_accepted_at" in user
    assert user["active"] is True
    assert user["agreement_accepted_at"]


# ---------- 12. Cleanup fixture ----------
def test_zz_cleanup(s, admin_h, new_dealer):
    """Delete the test dealer (also cascades submissions)."""
    r = s.delete(f"{API}/admin/dealers/{new_dealer['id']}", headers=admin_h)
    assert r.status_code == 200
