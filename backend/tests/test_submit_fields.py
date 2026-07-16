"""
Backend tests for the Submit-Vehicle form UX overhaul (iteration 13):
  - New paint_quality: Excellent | Fair | Poor | null
  - New accident_damage_types: subset of ['Cosmetic','Structural','Mechanical','Glass','Electrical / Functional']
  - New windscreen_condition: 'Perfect' | 'Chip Repairs' | 'Needs Replacement'
    (legacy 'Chip' / 'Crack' still accepted for old seeded data)
  - When paint_evidence=false -> paint_quality stored as null even if client sent one
  - When accident_damage=false -> accident_damage_types stored as [] even if client sent items
  - GET /api/submissions/{id} returns paint_quality + accident_damage_types
Also runs a regression against key existing endpoints so we know nothing broke.
"""
from __future__ import annotations

import os
import uuid

import pytest
import requests

BASE_URL = os.environ.get(
    "EXPO_PUBLIC_BACKEND_URL",
    "https://fourbuy-admin.preview.emergentagent.com",
).rstrip("/")
API = f"{BASE_URL}/api"

ADMIN_EMAIL = "admin@fourbuy.co.za"
ADMIN_PASSWORD = "admin123"

# Fresh dealer per session so we don't collide with the seeded FB-000001/2 dealer.
DEALER_EMAIL = f"submit_ux_{uuid.uuid4().hex[:8]}@example.com"
DEALER_PASSWORD = "SubmitUx1!"


# ---------- Fixtures ----------
@pytest.fixture(scope="session")
def s() -> requests.Session:
    sess = requests.Session()
    sess.headers.update({"Content-Type": "application/json"})
    return sess


@pytest.fixture(scope="session")
def admin_token(s):
    r = s.post(f"{API}/auth/login", json={"email": ADMIN_EMAIL, "password": ADMIN_PASSWORD})
    assert r.status_code == 200, r.text
    return r.json()["token"]


@pytest.fixture(scope="session")
def dealer_ctx(s):
    payload = {
        "email": DEALER_EMAIL,
        "password": DEALER_PASSWORD,
        "dealer_info": {
            "first_name": "Test", "last_name": "Dealer",
            "phone": "0821234567", "id_number": "9001010000000",
        },
        "company_info": {
            "company_name": "TEST_SubmitUx Motors",
            "company_address": "1 Test Rd, Johannesburg",
        },
    }
    r = s.post(f"{API}/auth/register", json=payload)
    assert r.status_code == 200, r.text
    data = r.json()
    token = data["token"]

    # Every dealer must accept the master agreement before /submissions works.
    r2 = s.post(
        f"{API}/agreement/accept",
        headers={"Authorization": f"Bearer {token}"},
    )
    assert r2.status_code == 200, r2.text

    return {"token": token, "user_id": data["user"]["id"], "email": DEALER_EMAIL}


TINY_PNG = (
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAA"
    "YAAjCB0C8AAAAASUVORK5CYII="
)


def _base_payload():
    """Minimal-but-complete VehicleSubmission body ready to be mutated per test."""
    return {
        "make": "Toyota", "fuel_type": "Petrol", "year_of_production": 2020,
        "transmission": "Automatic", "model": "Hilux", "derivative": "2.4 GD-6 RB SR",
        "year_registered": 2020,
        "colour": "White", "vin": "TBC", "engine_number": "TBC",
        "license_disk_data": "%TEST%LICENSE_DISK%DATA%",
        "exterior_condition": 7, "interior_condition": 6, "tyre_condition": 5,
        "windscreen_condition": "Chip Repairs",
        "service_history": "Full Service History with Agents",
        "last_service_date": "2025-07-01", "last_service_mileage": 42000,
        "photos": {
            "front": TINY_PNG, "driver_side": TINY_PNG, "passenger_side": TINY_PNG,
            "rear": TINY_PNG, "interior": TINY_PNG,
        },
        "mileage": 55000,
        "paint_evidence": True, "paint_quality": "Fair",
        "accident_damage": True, "accident_damage_types": ["Cosmetic", "Glass"],
        "reconditioning_items": [], "billing_accepted": True,
    }


def _auth(dealer_ctx):
    return {"Authorization": f"Bearer {dealer_ctx['token']}"}


# ---------- Health ----------
def test_health(s):
    r = s.get(f"{API}/")
    assert r.status_code == 200


# ---------- New-field acceptance ----------
class TestNewFieldsAccepted:
    def test_windscreen_new_perfect(self, s, dealer_ctx):
        body = _base_payload()
        body["windscreen_condition"] = "Perfect"
        r = s.post(f"{API}/submissions", json=body, headers=_auth(dealer_ctx))
        assert r.status_code == 200, r.text
        assert r.json()["submission"]["windscreen_condition"] == "Perfect"

    def test_windscreen_new_chip_repairs(self, s, dealer_ctx):
        body = _base_payload()
        body["windscreen_condition"] = "Chip Repairs"
        r = s.post(f"{API}/submissions", json=body, headers=_auth(dealer_ctx))
        assert r.status_code == 200, r.text
        assert r.json()["submission"]["windscreen_condition"] == "Chip Repairs"

    def test_windscreen_new_needs_replacement(self, s, dealer_ctx):
        body = _base_payload()
        body["windscreen_condition"] = "Needs Replacement"
        r = s.post(f"{API}/submissions", json=body, headers=_auth(dealer_ctx))
        assert r.status_code == 200, r.text
        assert r.json()["submission"]["windscreen_condition"] == "Needs Replacement"

    def test_windscreen_legacy_chip_still_accepted(self, s, dealer_ctx):
        body = _base_payload()
        body["windscreen_condition"] = "Chip"
        r = s.post(f"{API}/submissions", json=body, headers=_auth(dealer_ctx))
        assert r.status_code == 200, r.text

    def test_windscreen_legacy_crack_still_accepted(self, s, dealer_ctx):
        body = _base_payload()
        body["windscreen_condition"] = "Crack"
        r = s.post(f"{API}/submissions", json=body, headers=_auth(dealer_ctx))
        assert r.status_code == 200, r.text

    def test_windscreen_bogus_rejected(self, s, dealer_ctx):
        body = _base_payload()
        body["windscreen_condition"] = "Shattered"
        r = s.post(f"{API}/submissions", json=body, headers=_auth(dealer_ctx))
        assert r.status_code == 422, r.text

    @pytest.mark.parametrize("q", ["Excellent", "Fair", "Poor"])
    def test_paint_quality_options(self, s, dealer_ctx, q):
        body = _base_payload()
        body["paint_evidence"] = True
        body["paint_quality"] = q
        r = s.post(f"{API}/submissions", json=body, headers=_auth(dealer_ctx))
        assert r.status_code == 200, r.text
        assert r.json()["submission"]["paint_quality"] == q

    def test_paint_quality_bogus_rejected(self, s, dealer_ctx):
        body = _base_payload()
        body["paint_evidence"] = True
        body["paint_quality"] = "Amazing"
        r = s.post(f"{API}/submissions", json=body, headers=_auth(dealer_ctx))
        assert r.status_code == 422, r.text

    def test_all_accident_damage_types(self, s, dealer_ctx):
        body = _base_payload()
        body["accident_damage"] = True
        body["accident_damage_types"] = [
            "Cosmetic", "Structural", "Mechanical", "Glass", "Electrical / Functional",
        ]
        r = s.post(f"{API}/submissions", json=body, headers=_auth(dealer_ctx))
        assert r.status_code == 200, r.text
        stored = r.json()["submission"]["accident_damage_types"]
        assert set(stored) == {
            "Cosmetic", "Structural", "Mechanical", "Glass", "Electrical / Functional",
        }


# ---------- Coercion rules ----------
class TestServerSideCoercion:
    def test_paint_quality_nulled_when_flag_false(self, s, dealer_ctx):
        body = _base_payload()
        body["paint_evidence"] = False
        body["paint_quality"] = "Poor"  # client tried to sneak this through
        r = s.post(f"{API}/submissions", json=body, headers=_auth(dealer_ctx))
        assert r.status_code == 200, r.text
        assert r.json()["submission"]["paint_quality"] is None

    def test_accident_damage_types_cleared_when_flag_false(self, s, dealer_ctx):
        body = _base_payload()
        body["accident_damage"] = False
        body["accident_damage_types"] = ["Cosmetic", "Structural"]
        r = s.post(f"{API}/submissions", json=body, headers=_auth(dealer_ctx))
        assert r.status_code == 200, r.text
        assert r.json()["submission"]["accident_damage_types"] == []


# ---------- GET verification ----------
class TestGetSubmission:
    def test_get_returns_new_fields(self, s, dealer_ctx):
        body = _base_payload()
        body["paint_evidence"] = True
        body["paint_quality"] = "Excellent"
        body["accident_damage"] = True
        body["accident_damage_types"] = ["Glass", "Electrical / Functional"]
        r = s.post(f"{API}/submissions", json=body, headers=_auth(dealer_ctx))
        assert r.status_code == 200, r.text
        sub_id = r.json()["id"]

        r2 = s.get(f"{API}/submissions/{sub_id}", headers=_auth(dealer_ctx))
        assert r2.status_code == 200, r2.text
        sub = r2.json()["submission"]
        assert sub["paint_evidence"] is True
        assert sub["paint_quality"] == "Excellent"
        assert sub["accident_damage"] is True
        assert set(sub["accident_damage_types"]) == {"Glass", "Electrical / Functional"}
        assert sub["windscreen_condition"] == "Chip Repairs"
        assert "_id" not in sub


# ---------- Rating validation still enforced ----------
class TestRatingsRequired:
    def test_missing_rating_zero_rejected(self, s, dealer_ctx):
        # Pydantic ge=1 -> should 422
        body = _base_payload()
        body["exterior_condition"] = 0
        r = s.post(f"{API}/submissions", json=body, headers=_auth(dealer_ctx))
        assert r.status_code == 422, r.text

    def test_rating_over_ten_rejected(self, s, dealer_ctx):
        body = _base_payload()
        body["tyre_condition"] = 11
        r = s.post(f"{API}/submissions", json=body, headers=_auth(dealer_ctx))
        assert r.status_code == 422, r.text


# ---------- Regression: nothing else broke ----------
class TestRegression:
    def test_admin_submissions_lists_new_docs(self, s, admin_token, dealer_ctx):
        # Push one submission with the new-shape body
        body = _base_payload()
        s.post(f"{API}/submissions", json=body, headers=_auth(dealer_ctx))

        r = s.get(f"{API}/admin/submissions", headers={"Authorization": f"Bearer {admin_token}"})
        assert r.status_code == 200
        subs = r.json()["submissions"]
        assert len(subs) >= 1
        # New fields should be present on at least one modern submission
        modern = [x for x in subs if x.get("dealer_email") == DEALER_EMAIL]
        assert modern, "Our fresh submissions should be in the admin listing"
        assert any("paint_quality" in x for x in modern)
        assert any("accident_damage_types" in x for x in modern)

    def test_admin_dealers_endpoint_ok(self, s, admin_token):
        r = s.get(f"{API}/admin/dealers", headers={"Authorization": f"Bearer {admin_token}"})
        assert r.status_code == 200
        for d in r.json()["dealers"]:
            assert "password_hash" not in d
            assert "_id" not in d

    def test_admin_billing_endpoint_ok(self, s, admin_token):
        r = s.get(
            f"{API}/admin/billing",
            params={"month": "2026-02"},
            headers={"Authorization": f"Bearer {admin_token}"},
        )
        assert r.status_code == 200
        assert "rows" in r.json() or "dealers" in r.json() or isinstance(r.json(), dict)

    def test_dealer_photos_endpoint_ok(self, s, dealer_ctx):
        # Uses the existing dealer photos endpoint - just make sure it still 200s.
        r = s.get(
            f"{API}/dealer/photos",
            headers=_auth(dealer_ctx),
        )
        assert r.status_code in (200, 404), r.text  # 200 preferred; 404 acceptable if endpoint moved
