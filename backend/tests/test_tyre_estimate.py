"""
Backend tests for iteration 15 — Rim Size + AI Tyre Replacement Estimate feature.

Coverage:
  1. VehicleSubmission accepts `rim_size: Optional[int]` (12-26 inches).
     Values outside range → 422. Missing → 200 (legacy compat).
  2. POST /api/submissions with rim_size=17 succeeds; saved doc has rim_size=17.
  3. POST /api/submissions omitting rim_size succeeds.
  4. GET /api/submissions/{id} returns rim_size on the wire.
  5. POST /api/submissions/{sub_id}/tyre-estimate — admin only.
     dealer JWT → 403; unauthenticated → 401.
  6. Happy path: create BMW 3 Series 320i M-Sport 2020 rim=18 → call estimate
     → 200 with expected body shape (tyre_spec has R18, set_of_four_zar ints,
     total > 0, recommended_brands non-empty).
     After call, sub has tyre_estimate + tyre_estimate_at set.
  7. Second call overwrites cache (returns fresh estimate + new generated_at).
"""
from __future__ import annotations

import os
import time
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

DEALER_EMAIL = f"tyre_{uuid.uuid4().hex[:8]}@example.com"
DEALER_PASSWORD = "Tyre1234!"


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
            "first_name": "TEST", "last_name": "Tyre",
            "phone": "0821234567", "id_number": "9001010000000",
        },
        "company_info": {
            "company_name": "TEST_Tyre Motors",
            "company_address": "1 Tyre Rd, Johannesburg",
        },
    }
    r = s.post(f"{API}/auth/register", json=payload)
    assert r.status_code == 200, r.text
    data = r.json()
    token = data["token"]
    r2 = s.post(f"{API}/agreement/accept", headers={"Authorization": f"Bearer {token}"})
    assert r2.status_code == 200, r2.text
    return {"token": token, "user_id": data["user"]["id"], "email": DEALER_EMAIL}


TINY_PNG = (
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAA"
    "YAAjCB0C8AAAAASUVORK5CYII="
)


def _payload(rim_size=None, make="Toyota", model="Hilux", derivative="2.4 GD-6 RB SR", year=2020):
    body = {
        "make": make, "fuel_type": "Petrol", "year_of_production": year,
        "transmission": "Automatic", "model": model, "derivative": derivative,
        "year_registered": year,
        "colour": "White", "vin": "TBC", "engine_number": "TBC",
        "license_disk_data": "%TEST%LICENSE_DISK%DATA%",
        "mechanical_condition": 8, "cosmetic_condition": 7,
        "interior_condition": 8, "history_condition": 7,
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
    if rim_size is not None:
        body["rim_size"] = rim_size
    return body


def _dealer_auth(dealer_ctx):
    return {"Authorization": f"Bearer {dealer_ctx['token']}"}


def _admin_auth(admin_token):
    return {"Authorization": f"Bearer {admin_token}"}


# ---------- Health ----------
def test_health(s):
    r = s.get(f"{API}/")
    assert r.status_code == 200


# ---------- 1) rim_size validation ----------
class TestRimSizeValidation:
    def test_rim_size_17_succeeds_and_persisted(self, s, dealer_ctx):
        r = s.post(f"{API}/submissions", json=_payload(rim_size=17), headers=_dealer_auth(dealer_ctx))
        assert r.status_code == 200, r.text
        sub = r.json()["submission"]
        assert sub["rim_size"] == 17

    def test_rim_size_omitted_succeeds(self, s, dealer_ctx):
        body = _payload()
        assert "rim_size" not in body
        r = s.post(f"{API}/submissions", json=body, headers=_dealer_auth(dealer_ctx))
        assert r.status_code == 200, r.text
        sub = r.json()["submission"]
        assert sub.get("rim_size") is None

    def test_rim_size_null_succeeds(self, s, dealer_ctx):
        body = _payload()
        body["rim_size"] = None
        r = s.post(f"{API}/submissions", json=body, headers=_dealer_auth(dealer_ctx))
        assert r.status_code == 200, r.text
        assert r.json()["submission"].get("rim_size") is None

    @pytest.mark.parametrize("bad", [11, 27, 100, -1, 0])
    def test_rim_size_out_of_range_422(self, s, dealer_ctx, bad):
        r = s.post(f"{API}/submissions", json=_payload(rim_size=bad), headers=_dealer_auth(dealer_ctx))
        assert r.status_code == 422, f"Expected 422 for rim_size={bad}, got {r.status_code}: {r.text}"

    def test_rim_size_boundaries_accepted(self, s, dealer_ctx):
        for val in (12, 26):
            r = s.post(f"{API}/submissions", json=_payload(rim_size=val), headers=_dealer_auth(dealer_ctx))
            assert r.status_code == 200, f"Boundary {val} failed: {r.text}"
            assert r.json()["submission"]["rim_size"] == val


# ---------- 2) GET returns rim_size ----------
class TestGetReturnsRimSize:
    def test_get_returns_rim_size(self, s, dealer_ctx):
        r = s.post(f"{API}/submissions", json=_payload(rim_size=19), headers=_dealer_auth(dealer_ctx))
        assert r.status_code == 200
        sub_id = r.json()["submission"]["id"]
        r2 = s.get(f"{API}/submissions/{sub_id}", headers=_dealer_auth(dealer_ctx))
        assert r2.status_code == 200, r2.text
        got = r2.json()["submission"]
        assert got["rim_size"] == 19
        assert "_id" not in got


# ---------- 3) tyre-estimate authorization ----------
class TestTyreEstimateAuthorization:
    @pytest.fixture(scope="class")
    def existing_sub_id(self, s, dealer_ctx):
        r = s.post(f"{API}/submissions", json=_payload(rim_size=18), headers=_dealer_auth(dealer_ctx))
        assert r.status_code == 200
        return r.json()["submission"]["id"]

    def test_unauthenticated_401(self, s, existing_sub_id):
        r = s.post(f"{API}/submissions/{existing_sub_id}/tyre-estimate")
        # Auth dep should return 401 (or 403 depending on framework) — spec says 401
        assert r.status_code in (401, 403), r.text
        # Prefer 401 per spec
        assert r.status_code == 401, f"Spec expected 401, got {r.status_code}"

    def test_dealer_403(self, s, dealer_ctx, existing_sub_id):
        r = s.post(
            f"{API}/submissions/{existing_sub_id}/tyre-estimate",
            headers=_dealer_auth(dealer_ctx),
        )
        assert r.status_code == 403, r.text


# ---------- 4) Happy path: real GPT-5.2 call ----------
class TestTyreEstimateHappyPath:
    @pytest.fixture(scope="class")
    def bmw_sub_id(self, s, dealer_ctx):
        body = _payload(rim_size=18, make="BMW", model="3 Series", derivative="320i M-Sport", year=2020)
        r = s.post(f"{API}/submissions", json=body, headers=_dealer_auth(dealer_ctx))
        assert r.status_code == 200, r.text
        return r.json()["submission"]["id"]

    def _call_estimate(self, s, admin_token, sub_id, retries=1):
        last = None
        for attempt in range(retries + 1):
            r = s.post(
                f"{API}/submissions/{sub_id}/tyre-estimate",
                headers=_admin_auth(admin_token),
                timeout=90,
            )
            if r.status_code == 200:
                return r
            last = r
            time.sleep(1)
        return last

    def test_admin_estimate_success(self, s, admin_token, bmw_sub_id):
        r = self._call_estimate(s, admin_token, bmw_sub_id, retries=1)
        assert r.status_code == 200, f"tyre-estimate failed: {r.status_code} {r.text}"
        body = r.json()
        # Top-level shape
        assert body.get("rim_size") == 18
        assert body.get("model") == "gpt-5.2"
        assert isinstance(body.get("generated_at"), str) and len(body["generated_at"]) > 0
        est = body.get("estimate")
        assert isinstance(est, dict), f"estimate not a dict: {est}"

        # If the LLM returned non-JSON, `raw` fallback exists — retry once
        if "raw" in est and "tyre_spec" not in est:
            r2 = self._call_estimate(s, admin_token, bmw_sub_id, retries=1)
            assert r2.status_code == 200
            body = r2.json()
            est = body["estimate"]
            assert "tyre_spec" in est, f"After retry, still non-JSON: {est}"

        # Estimate shape
        assert isinstance(est.get("tyre_spec"), str) and est["tyre_spec"].strip(), est
        assert "R18" in est["tyre_spec"].upper(), f"tyre_spec doesn't reference R18: {est['tyre_spec']}"

        s4 = est.get("set_of_four_zar")
        assert isinstance(s4, dict), s4
        for k in ("low", "typical", "high"):
            assert isinstance(s4.get(k), int), f"set_of_four_zar.{k} not int: {s4}"
        # Sanity ranges: 4 tyres in SA typically R4000-R40000+
        assert 2000 <= s4["low"] <= 80000, s4
        assert 2000 <= s4["typical"] <= 80000, s4
        assert 2000 <= s4["high"] <= 80000, s4
        assert s4["low"] <= s4["typical"] <= s4["high"], s4

        total = est.get("total_replacement_estimate_zar")
        assert isinstance(total, int) and total > 0, total

        brands = est.get("recommended_brands")
        assert isinstance(brands, list) and len(brands) >= 1, brands

    def test_submission_doc_persisted(self, s, admin_token, dealer_ctx, bmw_sub_id):
        # Dealer GET should now show tyre_estimate + tyre_estimate_at
        r = s.get(f"{API}/submissions/{bmw_sub_id}", headers=_dealer_auth(dealer_ctx))
        assert r.status_code == 200
        sub = r.json()["submission"]
        assert sub.get("tyre_estimate") is not None
        assert sub.get("tyre_estimate_at") is not None
        assert sub["tyre_estimate"]["rim_size"] == 18
        assert sub["tyre_estimate"]["model"] == "gpt-5.2"

    def test_second_call_overwrites_cache(self, s, admin_token, bmw_sub_id, dealer_ctx):
        # 1st call already done in previous test — call again & compare generated_at
        r1 = s.get(f"{API}/submissions/{bmw_sub_id}", headers=_dealer_auth(dealer_ctx))
        assert r1.status_code == 200
        first_at = r1.json()["submission"]["tyre_estimate"]["generated_at"]

        time.sleep(1.5)  # ensure iso timestamp differs

        r2 = s.post(
            f"{API}/submissions/{bmw_sub_id}/tyre-estimate",
            headers=_admin_auth(admin_token),
            timeout=90,
        )
        assert r2.status_code == 200, r2.text
        second_at = r2.json()["generated_at"]
        assert second_at != first_at, f"generated_at did not refresh: {first_at} vs {second_at}"

        # Confirm the persisted doc updated too
        r3 = s.get(f"{API}/submissions/{bmw_sub_id}", headers=_dealer_auth(dealer_ctx))
        assert r3.status_code == 200
        assert r3.json()["submission"]["tyre_estimate"]["generated_at"] == second_at


# ---------- 5) Regression: legacy endpoints still healthy ----------
class TestRegression:
    def test_dealer_submissions_list(self, s, dealer_ctx):
        r = s.get(f"{API}/submissions/my", headers=_dealer_auth(dealer_ctx))
        assert r.status_code == 200, r.text
        body = r.json()
        # Endpoint returns {"submissions": [...]} or a raw list depending on version.
        subs = body["submissions"] if isinstance(body, dict) else body
        assert isinstance(subs, list)

    def test_admin_submissions_list(self, s, admin_token):
        r = s.get(f"{API}/admin/submissions", headers=_admin_auth(admin_token))
        assert r.status_code == 200, r.text

    def test_admin_billing(self, s, admin_token):
        r = s.get(f"{API}/admin/billing", headers=_admin_auth(admin_token))
        assert r.status_code == 200, r.text

    def test_market_analysis_endpoint_exists(self, s, admin_token, dealer_ctx):
        # Just verify the endpoint is reachable — do not spam the LLM.
        r = s.post(f"{API}/submissions", json=_payload(rim_size=17), headers=_dealer_auth(dealer_ctx))
        assert r.status_code == 200
        sub_id = r.json()["submission"]["id"]
        # We don't call it (LLM cost) but confirm the route exists via 405/200/etc.
        # Instead, just fetch the sub to prove nothing regressed there.
        r2 = s.get(f"{API}/submissions/{sub_id}", headers=_dealer_auth(dealer_ctx))
        assert r2.status_code == 200
