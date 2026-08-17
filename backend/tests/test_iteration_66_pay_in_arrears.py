"""Iteration 66 — Admin "Pay in Arrears" toggle.

Verifies:
  1. PATCH /api/admin/dealerships/{id}/billing-terms
      - admin toggles both ways -> returns {dealership_id, pay_in_arrears}
      - non-admin -> 403
      - unknown dealership -> 404
  2. Arrears ON + wallet <= 0:
      - POST /api/submissions does NOT return 402 (wallet-depleted).
      - POST /api/vin-reports/order does NOT return 402.
  3. Arrears OFF + wallet <= 0:
      - POST /api/submissions -> 402 (existing behavior preserved).
  4. Response-shape additions on:
      - GET /api/admin/dealerships/{id}/billing-summary
      - GET /api/admin/billing/overview
      - GET /api/billing/my-summary
"""
from __future__ import annotations

import os
import uuid

import pytest
import requests

BASE_URL = os.environ.get("EXPO_PUBLIC_BACKEND_URL", "").rstrip("/") or \
    os.environ.get("EXPO_BACKEND_URL", "").rstrip("/")
assert BASE_URL, "EXPO_PUBLIC_BACKEND_URL/EXPO_BACKEND_URL must be set"

ADMIN_EMAIL = "admin@fourbuy.co.za"
ADMIN_PASSWORD = "admin123"

# Dealer whose dealership currently has wallet balance = 0 (Mini Test Motors).
DEALER_EMAIL = "minitest@example.com"
DEALER_PASSWORD = "Mini1234!"
DEALER_DEALERSHIP_ID = "3e18c809-2803-4124-aeaa-9b0bc9cd3998"


# ---------------------------------------------------------------------------
# Fixtures
# ---------------------------------------------------------------------------
def _login(email: str, password: str) -> str:
    r = requests.post(
        f"{BASE_URL}/api/auth/login",
        json={"email": email, "password": password},
        timeout=20,
    )
    assert r.status_code == 200, f"login {email} failed: {r.status_code} {r.text}"
    return r.json()["token"]


@pytest.fixture(scope="session")
def admin_token() -> str:
    return _login(ADMIN_EMAIL, ADMIN_PASSWORD)


@pytest.fixture(scope="session")
def dealer_token() -> str:
    return _login(DEALER_EMAIL, DEALER_PASSWORD)


@pytest.fixture(scope="session")
def admin_headers(admin_token):
    return {"Authorization": f"Bearer {admin_token}", "Content-Type": "application/json"}


@pytest.fixture(scope="session")
def dealer_headers(dealer_token):
    return {"Authorization": f"Bearer {dealer_token}", "Content-Type": "application/json"}


@pytest.fixture(autouse=True)
def _reset_arrears_after_test(admin_headers):
    """Ensure the dealer's dealership goes back to pay_in_arrears=False
    after every test so nothing leaks between tests / test runs."""
    yield
    try:
        requests.patch(
            f"{BASE_URL}/api/admin/dealerships/{DEALER_DEALERSHIP_ID}/billing-terms",
            headers=admin_headers,
            json={"pay_in_arrears": False},
            timeout=15,
        )
    except Exception:
        pass


# ---------------------------------------------------------------------------
# 1. PATCH /admin/dealerships/{id}/billing-terms
# ---------------------------------------------------------------------------
class TestBillingTermsEndpoint:
    def test_toggle_on(self, admin_headers):
        r = requests.patch(
            f"{BASE_URL}/api/admin/dealerships/{DEALER_DEALERSHIP_ID}/billing-terms",
            headers=admin_headers,
            json={"pay_in_arrears": True},
            timeout=15,
        )
        assert r.status_code == 200, r.text
        body = r.json()
        assert body == {"dealership_id": DEALER_DEALERSHIP_ID, "pay_in_arrears": True}

    def test_toggle_off(self, admin_headers):
        # first flip ON
        requests.patch(
            f"{BASE_URL}/api/admin/dealerships/{DEALER_DEALERSHIP_ID}/billing-terms",
            headers=admin_headers, json={"pay_in_arrears": True}, timeout=15,
        )
        r = requests.patch(
            f"{BASE_URL}/api/admin/dealerships/{DEALER_DEALERSHIP_ID}/billing-terms",
            headers=admin_headers, json={"pay_in_arrears": False}, timeout=15,
        )
        assert r.status_code == 200, r.text
        assert r.json() == {"dealership_id": DEALER_DEALERSHIP_ID, "pay_in_arrears": False}

    def test_non_admin_forbidden(self, dealer_headers):
        r = requests.patch(
            f"{BASE_URL}/api/admin/dealerships/{DEALER_DEALERSHIP_ID}/billing-terms",
            headers=dealer_headers, json={"pay_in_arrears": True}, timeout=15,
        )
        assert r.status_code == 403, f"expected 403, got {r.status_code}: {r.text}"

    def test_unknown_dealership_404(self, admin_headers):
        r = requests.patch(
            f"{BASE_URL}/api/admin/dealerships/{uuid.uuid4()}/billing-terms",
            headers=admin_headers, json={"pay_in_arrears": True}, timeout=15,
        )
        assert r.status_code == 404, r.text


# ---------------------------------------------------------------------------
# 2. Arrears ON bypasses the 402 wallet-depleted guard.
# ---------------------------------------------------------------------------
def _minimal_submission_payload() -> dict:
    """Payload that passes Pydantic validation and reaches the 402
    wallet-check inside the endpoint. If we get past that guard the
    later `service_history is required` guardrail will produce a 400
    (arrears mode) which is a perfectly acceptable non-402 response
    for this test — we do NOT want the submission to actually persist.
    """
    return {
        "make": "Toyota",
        "fuel_type": "Petrol",
        "year_of_production": 2020,
        "transmission": "Automatic",
        "model": "Corolla",
        "derivative": "1.8",
        "year_registered": 2020,
        "colour": "White",
        "vin": "TESTVINARREARS001",
        "photos": {},
        "mileage": 50000,
        "billing_accepted": True,
        # Deliberately omit service_history so we get a 400 AFTER the
        # 402 guard — this proves the guard bypassed without actually
        # writing a submission to the DB.
    }


def _vin_report_payload() -> dict:
    return {
        "make": "Toyota",
        "vin": "TESTVIN12345",
        "report_type": "vin_history",
    }


class TestArrearsOnBypasses402:
    def test_submission_bypasses_402(self, admin_headers, dealer_headers):
        # arm arrears ON
        r = requests.patch(
            f"{BASE_URL}/api/admin/dealerships/{DEALER_DEALERSHIP_ID}/billing-terms",
            headers=admin_headers, json={"pay_in_arrears": True}, timeout=15,
        )
        assert r.status_code == 200

        # sanity — wallet should still be <= 0 for a meaningful test
        overview = requests.get(
            f"{BASE_URL}/api/admin/billing/overview", headers=admin_headers, timeout=15,
        ).json()["dealerships"]
        me = next(x for x in overview if x["id"] == DEALER_DEALERSHIP_ID)
        assert me["wallet_balance_zar"] <= 0, f"precondition failed — wallet is {me['wallet_balance_zar']}"
        assert me["pay_in_arrears"] is True
        assert me["suspended"] is False, "arrears ON must clear suspended flag"

        # Fire the create-submission call.
        r = requests.post(
            f"{BASE_URL}/api/submissions",
            headers=dealer_headers,
            json=_minimal_submission_payload(),
            timeout=30,
        )
        assert r.status_code != 402, f"402 wallet-depleted must NOT fire with arrears ON. Body={r.text}"

    def test_vin_report_bypasses_402(self, admin_headers, dealer_headers):
        requests.patch(
            f"{BASE_URL}/api/admin/dealerships/{DEALER_DEALERSHIP_ID}/billing-terms",
            headers=admin_headers, json={"pay_in_arrears": True}, timeout=15,
        )
        r = requests.post(
            f"{BASE_URL}/api/vin-reports/order",
            headers=dealer_headers,
            json=_vin_report_payload(),
            timeout=30,
        )
        assert r.status_code != 402, f"402 must NOT fire with arrears ON. Body={r.text}"


# ---------------------------------------------------------------------------
# 3. Arrears OFF + wallet <= 0 still returns 402 on submission.
# ---------------------------------------------------------------------------
class TestArrearsOffStill402:
    def test_submission_returns_402(self, admin_headers, dealer_headers):
        # Ensure OFF and wallet<=0.
        requests.patch(
            f"{BASE_URL}/api/admin/dealerships/{DEALER_DEALERSHIP_ID}/billing-terms",
            headers=admin_headers, json={"pay_in_arrears": False}, timeout=15,
        )
        overview = requests.get(
            f"{BASE_URL}/api/admin/billing/overview", headers=admin_headers, timeout=15,
        ).json()["dealerships"]
        me = next(x for x in overview if x["id"] == DEALER_DEALERSHIP_ID)
        assert me["wallet_balance_zar"] <= 0
        assert me["pay_in_arrears"] is False
        assert me["suspended"] is True

        r = requests.post(
            f"{BASE_URL}/api/submissions",
            headers=dealer_headers,
            json=_minimal_submission_payload(),
            timeout=30,
        )
        assert r.status_code == 402, f"expected 402 wallet-depleted, got {r.status_code}: {r.text}"


# ---------------------------------------------------------------------------
# 4. Response shapes.
# ---------------------------------------------------------------------------
class TestResponseShapes:
    def test_billing_summary_reflects_flag(self, admin_headers):
        # ON
        requests.patch(
            f"{BASE_URL}/api/admin/dealerships/{DEALER_DEALERSHIP_ID}/billing-terms",
            headers=admin_headers, json={"pay_in_arrears": True}, timeout=15,
        )
        r = requests.get(
            f"{BASE_URL}/api/admin/dealerships/{DEALER_DEALERSHIP_ID}/billing-summary",
            headers=admin_headers, timeout=15,
        )
        assert r.status_code == 200
        body = r.json()
        assert body["dealership"]["pay_in_arrears"] is True
        assert body["wallet"]["pay_in_arrears"] is True
        assert body["wallet"]["suspended"] is False, "suspended must be false when arrears is on"

        # OFF
        requests.patch(
            f"{BASE_URL}/api/admin/dealerships/{DEALER_DEALERSHIP_ID}/billing-terms",
            headers=admin_headers, json={"pay_in_arrears": False}, timeout=15,
        )
        r = requests.get(
            f"{BASE_URL}/api/admin/dealerships/{DEALER_DEALERSHIP_ID}/billing-summary",
            headers=admin_headers, timeout=15,
        )
        body = r.json()
        assert body["dealership"]["pay_in_arrears"] is False
        assert body["wallet"]["pay_in_arrears"] is False
        # This dealership is at R0 → suspended must be True with arrears off.
        assert body["wallet"]["suspended"] is True

    def test_admin_overview_row_contains_flag(self, admin_headers):
        # Toggle ON to have a distinguishable row.
        requests.patch(
            f"{BASE_URL}/api/admin/dealerships/{DEALER_DEALERSHIP_ID}/billing-terms",
            headers=admin_headers, json={"pay_in_arrears": True}, timeout=15,
        )
        r = requests.get(
            f"{BASE_URL}/api/admin/billing/overview", headers=admin_headers, timeout=15,
        )
        assert r.status_code == 200
        rows = r.json()["dealerships"]
        # Every row must have `pay_in_arrears`.
        for row in rows:
            assert "pay_in_arrears" in row, f"pay_in_arrears missing on row {row.get('id')}"
        me = next(x for x in rows if x["id"] == DEALER_DEALERSHIP_ID)
        assert me["pay_in_arrears"] is True
        assert me["suspended"] is False

    def test_dealer_my_summary_reflects_flag(self, admin_headers, dealer_headers):
        # ON
        requests.patch(
            f"{BASE_URL}/api/admin/dealerships/{DEALER_DEALERSHIP_ID}/billing-terms",
            headers=admin_headers, json={"pay_in_arrears": True}, timeout=15,
        )
        r = requests.get(
            f"{BASE_URL}/api/billing/my-summary", headers=dealer_headers, timeout=15,
        )
        assert r.status_code == 200
        w = r.json()["wallet"]
        assert w.get("pay_in_arrears") is True
        assert w.get("suspended") is False

        # OFF
        requests.patch(
            f"{BASE_URL}/api/admin/dealerships/{DEALER_DEALERSHIP_ID}/billing-terms",
            headers=admin_headers, json={"pay_in_arrears": False}, timeout=15,
        )
        r = requests.get(
            f"{BASE_URL}/api/billing/my-summary", headers=dealer_headers, timeout=15,
        )
        w = r.json()["wallet"]
        assert w.get("pay_in_arrears") is False
        assert w.get("suspended") is True
