"""VIN Reports — Suzuki catalog + CarTrust ordering flow tests.

Covers the Jan 2026 changes:
  * GET /api/vin-reports/makes merges db.makes + Outvin + Porsche/Ferrari
    so Suzuki appears alongside admin catalog makes.
  * POST /api/vin-reports/order supports report_type=kredo_cartrust with
    plate + mileage validation and returns async_pending on success.
"""
import os
import pytest
import requests

BASE_URL = os.environ.get("EXPO_PUBLIC_BACKEND_URL") or os.environ.get("EXPO_BACKEND_URL")
assert BASE_URL, "EXPO_PUBLIC_BACKEND_URL not set"
BASE_URL = BASE_URL.rstrip("/")

DEALER_EMAIL = "minitest@example.com"
DEALER_PASSWORD = "password"


@pytest.fixture(scope="module")
def dealer_token():
    """Log in as dealer; register once if login fails."""
    s = requests.Session()
    r = s.post(
        f"{BASE_URL}/api/auth/login",
        json={"email": DEALER_EMAIL, "password": DEALER_PASSWORD},
        timeout=30,
    )
    if r.status_code != 200:
        # Try to register (might not exist yet)
        s.post(
            f"{BASE_URL}/api/auth/register",
            json={
                "email": DEALER_EMAIL,
                "password": DEALER_PASSWORD,
                "first_name": "Mini",
                "last_name": "Test",
                "phone": "0821234567",
                "company": "MiniTest Motors",
                "company_address": "1 Test St",
            },
            timeout=30,
        )
        r = s.post(
            f"{BASE_URL}/api/auth/login",
            json={"email": DEALER_EMAIL, "password": DEALER_PASSWORD},
            timeout=30,
        )
    if r.status_code != 200:
        pytest.skip(f"Dealer login failed: {r.status_code} {r.text[:200]}")
    tok = r.json().get("token") or r.json().get("access_token")
    if not tok:
        pytest.skip(f"No token in login response: {r.text[:200]}")
    return tok


@pytest.fixture(scope="module")
def dealer_headers(dealer_token):
    return {"Authorization": f"Bearer {dealer_token}", "Content-Type": "application/json"}


# ---------- Makes catalog ----------
class TestMakesCatalog:
    def test_makes_endpoint_returns_list(self, dealer_headers):
        r = requests.get(f"{BASE_URL}/api/vin-reports/makes", headers=dealer_headers, timeout=30)
        assert r.status_code == 200, r.text
        data = r.json()
        assert "makes" in data
        assert isinstance(data["makes"], list)
        assert len(data["makes"]) >= 12, f"expected >=12 makes, got {len(data['makes'])}"

    def test_suzuki_in_makes(self, dealer_headers):
        r = requests.get(f"{BASE_URL}/api/vin-reports/makes", headers=dealer_headers, timeout=30)
        makes_upper = [str(m).upper() for m in r.json()["makes"]]
        assert "SUZUKI" in makes_upper, f"Suzuki missing from makes: {makes_upper}"

    def test_porsche_ferrari_appended(self, dealer_headers):
        r = requests.get(f"{BASE_URL}/api/vin-reports/makes", headers=dealer_headers, timeout=30)
        makes_upper = [str(m).upper() for m in r.json()["makes"]]
        assert "PORSCHE" in makes_upper
        assert "FERRARI" in makes_upper

    def test_admin_catalog_makes_present(self, dealer_headers):
        r = requests.get(f"{BASE_URL}/api/vin-reports/makes", headers=dealer_headers, timeout=30)
        makes_upper = [str(m).upper() for m in r.json()["makes"]]
        for expected in ["AUDI", "BMW", "FORD", "HONDA", "HYUNDAI", "KIA", "MAZDA",
                          "MERCEDES-BENZ", "NISSAN", "SUZUKI", "TOYOTA", "VOLKSWAGEN"]:
            assert expected in makes_upper, f"{expected} missing from makes"


# ---------- Available reports for Suzuki ----------
class TestAvailableForSuzuki:
    def test_available_suzuki_contains_cartrust_and_vin_history(self, dealer_headers):
        r = requests.get(
            f"{BASE_URL}/api/vin-reports/available?make=Suzuki",
            headers=dealer_headers, timeout=30,
        )
        assert r.status_code == 200, r.text
        data = r.json()
        assert data["make"] == "Suzuki"
        ids = [rep["id"] for rep in data["reports"]]
        assert "vin_history" in ids, f"vin_history missing from Suzuki reports: {ids}"
        assert "kredo_cartrust" in ids, f"kredo_cartrust missing from Suzuki reports: {ids}"


# ---------- CarTrust order validation ----------
class TestCarTrustOrderValidation:
    VIN = "WBADT43424G023381"

    def test_missing_registration_returns_400(self, dealer_headers):
        r = requests.post(
            f"{BASE_URL}/api/vin-reports/order",
            headers=dealer_headers,
            json={
                "make": "BMW",
                "vin": self.VIN,
                "report_type": "kredo_cartrust",
                "mileage": 45000,
                # no registration_number
            },
            timeout=30,
        )
        assert r.status_code == 400, f"expected 400, got {r.status_code}: {r.text[:300]}"
        detail = str(r.json().get("detail", "")).lower()
        assert "registration" in detail, detail

    def test_zero_mileage_returns_400(self, dealer_headers):
        r = requests.post(
            f"{BASE_URL}/api/vin-reports/order",
            headers=dealer_headers,
            json={
                "make": "BMW",
                "vin": self.VIN,
                "report_type": "kredo_cartrust",
                "registration_number": "CA123456",
                "mileage": 0,
            },
            timeout=30,
        )
        assert r.status_code == 400, f"expected 400, got {r.status_code}: {r.text[:300]}"
        detail = str(r.json().get("detail", "")).lower()
        assert "mileage" in detail, detail

    def test_valid_cartrust_returns_pending_or_kredo_error(self, dealer_headers):
        r = requests.post(
            f"{BASE_URL}/api/vin-reports/order",
            headers=dealer_headers,
            json={
                "make": "BMW",
                "vin": self.VIN,
                "report_type": "kredo_cartrust",
                "registration_number": "CA123456",
                "mileage": 45000,
                "vehicle_condition": "Used",
            },
            timeout=60,
        )
        # Accept 200 async_pending or 502 with Kredo error, but NOT 500/RuntimeError
        assert r.status_code in (200, 502), f"unexpected status {r.status_code}: {r.text[:400]}"
        if r.status_code == 200:
            body = r.json()
            assert body.get("async_pending") is True, f"async_pending missing: {body}"
            assert body.get("order", {}).get("status") == "pending"
            assert body["order"].get("report_type") == "kredo_cartrust"
        else:
            detail = str(r.json().get("detail", "")).lower()
            assert "kredo" in detail or "cartrust" in detail, f"expected Kredo error, got {detail}"
            assert "runtimeerror" not in detail


# ---------- Regression: vin_history still works ----------
class TestVinHistoryRegression:
    def test_vin_history_order_no_500(self, dealer_headers):
        r = requests.post(
            f"{BASE_URL}/api/vin-reports/order",
            headers=dealer_headers,
            json={
                "make": "BMW",
                "vin": "WBADT43424G023381",
                "report_type": "vin_history",
            },
            timeout=60,
        )
        # Success (200), no-data (404), or vendor error (502) all acceptable.
        # 500 (unhandled exception) is NOT acceptable.
        assert r.status_code in (200, 404, 502), f"unexpected {r.status_code}: {r.text[:300]}"
