"""
Backend tests for iteration 14 — four-pillar condition rating overhaul.

Task:
  POST /api/submissions now REQUIRES four pillar ratings (1-10 ints):
      mechanical_condition, cosmetic_condition, interior_condition, history_condition
  exterior_condition / tyre_condition are OPTIONAL (legacy).
  The persisted document must contain the four pillars AND the legacy
  `condition` alias = round((m+c+i+h)/4).
  GET /api/submissions/{id} must return the four pillars.
  Bogus values (0, 11) rejected 422.
  Regressions: dealer-photos endpoint, /api/admin/submissions bucket filters,
  /api/admin/billing must all still 200.
  LEGACY submissions with only exterior/interior/tyre must still fetch OK.
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

DEALER_EMAIL = f"pillars_{uuid.uuid4().hex[:8]}@example.com"
DEALER_PASSWORD = "Pillars1!"


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
            "first_name": "TEST", "last_name": "Pillars",
            "phone": "0821234567", "id_number": "9001010000000",
        },
        "company_info": {
            "company_name": "TEST_Pillars Motors",
            "company_address": "1 Pillar Rd, Johannesburg",
        },
    }
    r = s.post(f"{API}/auth/register", json=payload)
    assert r.status_code == 200, r.text
    data = r.json()
    token = data["token"]
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
    """Modern four-pillar payload."""
    return {
        "make": "Toyota", "fuel_type": "Petrol", "year_of_production": 2020,
        "transmission": "Automatic", "model": "Hilux", "derivative": "2.4 GD-6 RB SR",
        "year_registered": 2020,
        "colour": "White", "vin": "TBC", "engine_number": "TBC",
        "license_disk_data": "%TEST%LICENSE_DISK%DATA%",
        # The four pillars (required)
        "mechanical_condition": 8,
        "cosmetic_condition": 5,
        "interior_condition": 9,
        "history_condition": 3,
        "windscreen_condition": "Perfect",
        "service_history": "Full Service History with Agents",
        "last_service_date": "2025-07-01", "last_service_mileage": 42000,
        "photos": {
            "front": TINY_PNG, "driver_side": TINY_PNG, "passenger_side": TINY_PNG,
            "rear": TINY_PNG, "interior": TINY_PNG,
        },
        "mileage": 55000,
        "paint_evidence": False, "paint_quality": None,
        "accident_damage": False, "accident_damage_types": [],
        "reconditioning_items": [], "billing_accepted": True,
    }


def _auth(dealer_ctx):
    return {"Authorization": f"Bearer {dealer_ctx['token']}"}


# ---------- Health ----------
def test_health(s):
    r = s.get(f"{API}/")
    assert r.status_code == 200


# ---------- 1) Four pillars are required ----------
class TestPillarsRequired:
    @pytest.mark.parametrize(
        "field",
        ["mechanical_condition", "cosmetic_condition", "interior_condition", "history_condition"],
    )
    def test_missing_pillar_rejected_422(self, s, dealer_ctx, field):
        body = _base_payload()
        del body[field]
        r = s.post(f"{API}/submissions", json=body, headers=_auth(dealer_ctx))
        assert r.status_code == 422, f"Expected 422 when {field} missing, got {r.status_code}: {r.text}"

    def test_all_four_present_succeeds(self, s, dealer_ctx):
        body = _base_payload()
        r = s.post(f"{API}/submissions", json=body, headers=_auth(dealer_ctx))
        assert r.status_code == 200, r.text


# ---------- 2) exterior/tyre optional; legacy clients still succeed ----------
class TestLegacyFieldsOptional:
    def test_omitting_exterior_and_tyre_succeeds(self, s, dealer_ctx):
        body = _base_payload()
        # These two are not in the base payload -> stays absent
        assert "exterior_condition" not in body
        assert "tyre_condition" not in body
        r = s.post(f"{API}/submissions", json=body, headers=_auth(dealer_ctx))
        assert r.status_code == 200, r.text
        sub = r.json()["submission"]
        # They should exist in the doc but be null.
        assert sub.get("exterior_condition") in (None, 0)
        assert sub.get("tyre_condition") in (None, 0)

    def test_legacy_client_sending_exterior_and_tyre_still_ok(self, s, dealer_ctx):
        body = _base_payload()
        body["exterior_condition"] = 7
        body["tyre_condition"] = 5
        r = s.post(f"{API}/submissions", json=body, headers=_auth(dealer_ctx))
        assert r.status_code == 200, r.text
        sub = r.json()["submission"]
        assert sub["exterior_condition"] == 7
        assert sub["tyre_condition"] == 5


# ---------- 3) Persisted doc contains pillars + legacy condition alias ----------
class TestPersistedShape:
    def test_pillars_and_condition_alias(self, s, dealer_ctx):
        body = _base_payload()
        # 8+5+9+3 = 25 / 4 = 6.25 -> round() = 6
        body["mechanical_condition"] = 8
        body["cosmetic_condition"] = 5
        body["interior_condition"] = 9
        body["history_condition"] = 3
        r = s.post(f"{API}/submissions", json=body, headers=_auth(dealer_ctx))
        assert r.status_code == 200, r.text
        sub = r.json()["submission"]
        assert sub["mechanical_condition"] == 8
        assert sub["cosmetic_condition"] == 5
        assert sub["interior_condition"] == 9
        assert sub["history_condition"] == 3
        # Legacy alias = rounded average (Python round() = banker's, but round(6.25)=6 either way)
        expected = round((8 + 5 + 9 + 3) / 4)
        assert sub["condition"] == expected, f"condition alias expected {expected}, got {sub['condition']}"

    def test_condition_alias_various(self, s, dealer_ctx):
        # 10,10,10,10 -> 10
        body = _base_payload()
        body.update(mechanical_condition=10, cosmetic_condition=10,
                    interior_condition=10, history_condition=10)
        r = s.post(f"{API}/submissions", json=body, headers=_auth(dealer_ctx))
        assert r.status_code == 200
        assert r.json()["submission"]["condition"] == 10

        # 7,7,7,7 -> 7
        body = _base_payload()
        body.update(mechanical_condition=7, cosmetic_condition=7,
                    interior_condition=7, history_condition=7)
        r = s.post(f"{API}/submissions", json=body, headers=_auth(dealer_ctx))
        assert r.status_code == 200
        assert r.json()["submission"]["condition"] == 7


# ---------- 4) GET returns all four pillars ----------
class TestGetPillars:
    def test_get_returns_four_pillars(self, s, dealer_ctx):
        body = _base_payload()
        body.update(mechanical_condition=4, cosmetic_condition=6,
                    interior_condition=8, history_condition=2)
        r = s.post(f"{API}/submissions", json=body, headers=_auth(dealer_ctx))
        assert r.status_code == 200
        sub_id = r.json()["id"]

        r2 = s.get(f"{API}/submissions/{sub_id}", headers=_auth(dealer_ctx))
        assert r2.status_code == 200, r2.text
        sub = r2.json()["submission"]
        assert sub["mechanical_condition"] == 4
        assert sub["cosmetic_condition"] == 6
        assert sub["interior_condition"] == 8
        assert sub["history_condition"] == 2
        assert "_id" not in sub


# ---------- 5) Bogus values rejected 422 ----------
class TestBogusRejected:
    @pytest.mark.parametrize("bad", [0, -1, 11, 100])
    def test_out_of_range_rejected(self, s, dealer_ctx, bad):
        body = _base_payload()
        body["mechanical_condition"] = bad
        r = s.post(f"{API}/submissions", json=body, headers=_auth(dealer_ctx))
        assert r.status_code == 422, f"Expected 422 for mech={bad}, got {r.status_code}"

    def test_string_rejected(self, s, dealer_ctx):
        body = _base_payload()
        body["cosmetic_condition"] = "foo"
        r = s.post(f"{API}/submissions", json=body, headers=_auth(dealer_ctx))
        assert r.status_code == 422

    @pytest.mark.parametrize(
        "field", ["cosmetic_condition", "interior_condition", "history_condition"]
    )
    def test_each_pillar_rejects_zero(self, s, dealer_ctx, field):
        body = _base_payload()
        body[field] = 0
        r = s.post(f"{API}/submissions", json=body, headers=_auth(dealer_ctx))
        assert r.status_code == 422


# ---------- 6) Regression sweeps ----------
class TestRegression:
    def test_admin_submissions_ok(self, s, admin_token):
        r = s.get(f"{API}/admin/submissions",
                  headers={"Authorization": f"Bearer {admin_token}"})
        assert r.status_code == 200
        assert "submissions" in r.json()

    @pytest.mark.parametrize("bucket", ["incoming", "priced", "archived"])
    def test_admin_submissions_bucket_filters(self, s, admin_token, bucket):
        r = s.get(
            f"{API}/admin/submissions",
            params={"bucket": bucket},
            headers={"Authorization": f"Bearer {admin_token}"},
        )
        assert r.status_code == 200, r.text
        assert "submissions" in r.json()

    def test_admin_billing_ok(self, s, admin_token):
        r = s.get(
            f"{API}/admin/billing",
            params={"month": "2026-02"},
            headers={"Authorization": f"Bearer {admin_token}"},
        )
        assert r.status_code == 200

    def test_dealer_photos_endpoint_ok(self, s, dealer_ctx):
        r = s.get(f"{API}/dealer/photos", headers=_auth(dealer_ctx))
        assert r.status_code in (200, 404)

    def test_legacy_seeded_submission_still_fetches(self, s, admin_token):
        """
        Legacy submissions (FB-000001 etc) only have exterior/interior/tyre.
        Admin should be able to open them via GET without 500-ing.
        """
        r = s.get(f"{API}/admin/submissions",
                  headers={"Authorization": f"Bearer {admin_token}"})
        assert r.status_code == 200
        subs = r.json()["submissions"]
        legacy_only = [
            x for x in subs
            if x.get("exterior_condition") is not None
            and x.get("mechanical_condition") is None
        ]
        if not legacy_only:
            pytest.skip("No legacy-only submissions currently in DB")
        target = legacy_only[0]
        r2 = s.get(
            f"{API}/submissions/{target['id']}",
            headers={"Authorization": f"Bearer {admin_token}"},
        )
        assert r2.status_code == 200, r2.text
        sub = r2.json()["submission"]
        # Legacy pillars should still be there
        assert sub.get("exterior_condition") is not None
        # And no _id leak
        assert "_id" not in sub
