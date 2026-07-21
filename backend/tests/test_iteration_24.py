"""Regression tests for iteration 24: admin pricing endpoint and Kredo CarTrust order endpoint.

Only covers the two backend regression items requested:
1) POST /api/admin/submissions/{id}/price records price + price_history, GET returns status=priced
2) POST /api/kredo/cartrust/order is reachable, auth-protected (401 without bearer), and either
   returns a pending order or a documented Kredo error for a real submission with a VIN.
"""

import os
import time
import uuid

import pytest
import requests

BASE_URL = os.environ["EXPO_BACKEND_URL"].rstrip("/")
ADMIN_EMAIL = "admin@fourbuy.co.za"
ADMIN_PASSWORD = "admin123"
DEALER_EMAIL = "minitest@example.com"
DEALER_PASSWORD = "Mini1234!"


# --- Auth helpers -----------------------------------------------------------
def _login(email: str, password: str) -> str:
    r = requests.post(
        f"{BASE_URL}/api/auth/login",
        json={"email": email, "password": password},
        timeout=30,
    )
    r.raise_for_status()
    return r.json()["token"]


@pytest.fixture(scope="module")
def admin_token() -> str:
    return _login(ADMIN_EMAIL, ADMIN_PASSWORD)


@pytest.fixture(scope="module")
def dealer_token() -> str:
    return _login(DEALER_EMAIL, DEALER_PASSWORD)


def _auth(token: str) -> dict:
    return {"Authorization": f"Bearer {token}", "Content-Type": "application/json"}


# --- Submission seeding -----------------------------------------------------
def _create_test_submission(dealer_token: str, with_vin: bool = True) -> str:
    """Register agreement then submit a minimal valid submission for the dealer."""
    requests.post(
        f"{BASE_URL}/api/agreement/accept",
        headers=_auth(dealer_token),
        json={},
        timeout=30,
    )
    payload = {
        "make": "Toyota",
        "model": "Corolla",
        "derivative": "TEST_regression 1.8",
        "fuel_type": "Petrol",
        "transmission": "Automatic",
        "year_of_production": 2020,
        "year_registered": 2020,
        "mileage": 55000,
        "colour": "White",
        "mechanical_condition": 8,
        "cosmetic_condition": 8,
        "interior_condition": 8,
        "history_condition": 8,
        "windscreen_condition": "Perfect",
        "service_history": "Full Service History with Agents",
        "paint_evidence": False,
        "accident_damage": False,
        "photos": {},
        "billing_accepted": True,
    }
    if with_vin:
        payload["vin"] = f"AHT{uuid.uuid4().hex[:14].upper()}"
        payload["engine_number"] = "ENG" + uuid.uuid4().hex[:8].upper()
        # A synthetic license disc barcode payload with a registration.
        payload["license_disk_data"] = (
            "%TEST%%TESTREG%%TEST%%TEST%1%%GP%%CA123456%1234567890%%"
            f"{payload['vin']}%ENG123%2025-12-31%%DISC001%"
        )
    r = requests.post(
        f"{BASE_URL}/api/submissions",
        headers=_auth(dealer_token),
        json=payload,
        timeout=60,
    )
    assert r.status_code in (200, 201), f"Submit failed: {r.status_code} {r.text[:200]}"
    return r.json()["submission"]["id"]


# --- Test A: admin price endpoint ------------------------------------------
class TestAdminPrice:
    def test_price_persists_and_history_recorded(self, admin_token, dealer_token):
        sub_id = _create_test_submission(dealer_token, with_vin=False)
        try:
            price = 123456
            r = requests.post(
                f"{BASE_URL}/api/admin/submissions/{sub_id}/price",
                headers=_auth(admin_token),
                json={"price": price, "notes": "TEST_regression offer", "change_comment": "initial"},
                timeout=30,
            )
            assert r.status_code == 200, f"Price call failed: {r.status_code} {r.text[:200]}"

            # GET verifies persistence — status flips to priced + price_history appended.
            g = requests.get(
                f"{BASE_URL}/api/submissions/{sub_id}",
                headers=_auth(admin_token),
                timeout=30,
            )
            assert g.status_code == 200
            sub = g.json()["submission"]
            assert sub["status"] == "priced"
            assert sub["price"] == price
            assert sub.get("price_notes") == "TEST_regression offer"
            history = sub.get("price_history") or []
            assert len(history) >= 1
            latest = history[-1]
            assert latest["new_price"] == price
            assert latest["action"] == "offer"
            assert latest["admin_name"]
        finally:
            # Cleanup — hard delete the test submission
            requests.delete(
                f"{BASE_URL}/api/admin/submissions/{sub_id}",
                headers=_auth(admin_token),
                timeout=30,
            )


# --- Test B: Kredo CarTrust order endpoint ---------------------------------
class TestKredoCartrustOrder:
    def test_requires_bearer(self):
        r = requests.post(
            f"{BASE_URL}/api/kredo/cartrust/order",
            headers={"Content-Type": "application/json"},
            json={"submission_id": "does-not-matter"},
            timeout=30,
        )
        assert r.status_code == 401, f"Expected 401 without bearer, got {r.status_code}"

    def test_bad_submission_returns_404(self, admin_token):
        r = requests.post(
            f"{BASE_URL}/api/kredo/cartrust/order",
            headers=_auth(admin_token),
            json={"submission_id": "definitely-not-a-real-id-9999"},
            timeout=30,
        )
        assert r.status_code == 404

    def test_missing_vin_returns_400(self, admin_token, dealer_token):
        sub_id = _create_test_submission(dealer_token, with_vin=False)
        try:
            r = requests.post(
                f"{BASE_URL}/api/kredo/cartrust/order",
                headers=_auth(admin_token),
                json={"submission_id": sub_id},
                timeout=30,
            )
            assert r.status_code == 400, f"Expected 400, got {r.status_code} {r.text[:200]}"
            assert "vin" in (r.json().get("detail") or "").lower()
        finally:
            requests.delete(
                f"{BASE_URL}/api/admin/submissions/{sub_id}",
                headers=_auth(admin_token),
                timeout=30,
            )

    def test_with_vin_hits_kredo_endpoint(self, admin_token, dealer_token):
        """With a valid VIN, the request should reach Kredo. Accept either
        200 (pending order) or a documented Kredo 4xx/5xx (per problem statement,
        Kredo may reject invalid VIN/plate — the important thing is our route is
        the one that's hit and returns a structured response, not that Kredo
        accepts the specific VIN)."""
        sub_id = _create_test_submission(dealer_token, with_vin=True)
        try:
            r = requests.post(
                f"{BASE_URL}/api/kredo/cartrust/order",
                headers=_auth(admin_token),
                json={"submission_id": sub_id},
                timeout=90,
            )
            # Endpoint reachable — must not be a 404 (wrong path) or 401 (mis-auth).
            assert r.status_code not in (401, 404, 405), (
                f"Unexpected status {r.status_code}: {r.text[:200]}"
            )
            # Success path: pending report record.
            if r.status_code == 200:
                data = r.json()
                assert data.get("status") == "pending"
                assert data.get("report", {}).get("status") == "pending"
                assert data.get("report", {}).get("vin")
            else:
                # Documented Kredo error path — must include a detail message.
                # 4xx from our layer or 502 (KredoAPIError -> _kredo_502).
                assert r.status_code in (400, 402, 422, 500, 502, 503), (
                    f"Unexpected status {r.status_code}: {r.text[:200]}"
                )
                body = r.json()
                assert "detail" in body
        finally:
            requests.delete(
                f"{BASE_URL}/api/admin/submissions/{sub_id}",
                headers=_auth(admin_token),
                timeout=30,
            )
